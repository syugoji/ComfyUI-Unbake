/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * ComfyUI-Unbake の一部。**この行の意味**——著作権の所在を明示してある限り、
 * 後から別のライセンスを足せる。表示が無いまま配ると、それが言いづらくなる。
 */
import { t } from '../i18n/index.js';
import { resolveSamplerScheduler } from './genParamsMapper.js';
// **正規化は判定側と同じものを使う。** 別実装にすると、片方だけ直したときに
// 「導入済みと出るのに投入は拒否される」食い違いが復活する。
import { normalizeModelName } from './recipeMissingModels.js';
import { stripModelExtension } from './modelFileNames.js';
// **A1111 の資源欄を読むのは1箇所に閉じる。** 解析を書き足すと、
// `air` の有無で片方だけが読める、という食い違いがまた生まれる。
import { normalizeResources, parseA1111Parameters } from './a1111Parameters.js';
import { createRecipeWorkflowName } from './recipeWorkflowName.js';

const WORKFLOW_CONTAINER_KEYS = ['comfy', 'comfy_workflow', 'workflow'];
const LORA_TAG_PATTERN = /<lora:([^:>]+):\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*>/gi;
const REPLAY_MANIFEST_SCHEMA = 'lora-manager.replay-manifest';
const REPLAY_MANIFEST_VERSION = 1;

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function parseJsonObject(value) {
    if (!value) return null;
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value !== 'string') return null;

    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function normalizePromptContainer(value) {
    const parsed = parseJsonObject(value);
    if (!parsed) return null;

    if (parsed.prompt && typeof parsed.prompt === 'object' && !Array.isArray(parsed.prompt)) {
        return clone(parsed.prompt);
    }

    const nodes = Object.values(parsed);
    if (nodes.length > 0 && nodes.every(node => node && typeof node === 'object' && node.class_type)) {
        return clone(parsed);
    }

    return null;
}

function findEmbeddedPrompt(recipe) {
    const candidates = [
        recipe?.comfy,
        recipe?.comfy_prompt,
        recipe?.workflow,
        recipe?.metadata?.comfy,
        recipe?.metadata?.workflow,
        recipe?.raw_metadata?.comfy,
        recipe?.raw_metadata?.workflow,
        // **`generation_metadata.comfy` も見る**（2026-08-22 利用者の報告）。
        // Civitai から取り込んだ記録の一部は、グラフを**こちらにだけ**持っている。
        // 見ないと「チェックポイント情報がありません」と言ってしまう
        // ——実物にはノード14個の完全なグラフが在るのに、である。
        //
        // 実測（手元の347件）で**この経路だけを持つのは1件**。少ないが、
        // その1件は Wan の動画（`WanImageToVideo` → `SaveAnimatedWEBP`）で、
        // **動画の記録はこの形で来る**——母数は今後増える側。
        recipe?.generation_metadata?.comfy,
        recipe?.generation_metadata?.comfy_prompt,
        // **こちらが書いた記録は `prompt` に持つ**（2026-08-23 利用者の指摘）。
        // ComfyUI の出力を落とし込むと、記録は PNG の `prompt` チャンク
        // （API 形式のグラフ）をそのままこの名前で持つ。ここを見ていなかったので、
        // **ノード13個の完全なグラフと checkpoint と LoRA 5本を持つ記録が
        // 「再現不可・チェックポイント情報がありません」と出ていた**。
        //
        // **文字列のプロンプトを取り違えない。** `normalizePromptContainer` が
        // 「全部の値が `class_type` を持つ」ことを確かめるので、本文は通らない。
        recipe?.prompt,
    ];

    for (const candidate of candidates) {
        const prompt = normalizePromptContainer(candidate);
        if (prompt) return prompt;
    }

    return null;
}

function findA1111Parameters(recipe) {
    const candidates = [
        recipe?.a1111_parameters,
        recipe?.metadata?.a1111_parameters,
        recipe?.raw_metadata?.parameters,
    ];

    return candidates.find(value => typeof value === 'string' && value.trim()) || null;
}

function findCheckpointTemplate(recipe) {
    const images = recipe?.checkpoint?.civitai?.images;
    if (!Array.isArray(images)) return null;

    for (const image of images) {
        const meta = image?.meta;
        if (!meta) continue;

        for (const key of WORKFLOW_CONTAINER_KEYS) {
            const prompt = normalizePromptContainer(meta[key]);
            if (prompt) return prompt;
        }
    }

    return null;
}

function basename(path) {
    if (typeof path !== 'string') return '';
    const parts = path.replaceAll('\\', '/').split('/');
    return parts[parts.length - 1] || '';
}

function workflowRelativePath(path, preferredType = null) {
    if (typeof path !== 'string') return '';

    const normalized = path.replaceAll('\\', '/');
    const lower = normalized.toLowerCase();
    const markers = preferredType === 'Diffusion Model'
        ? ['/models/diffusion_models/', '/models/unet/']
        : preferredType === 'Model'
            ? ['/models/stable-diffusion/', '/models/checkpoints/']
            : ['/models/lora/', '/models/loras/', '/models/lycoris/'];

    for (const marker of markers) {
        const index = lower.lastIndexOf(marker);
        if (index !== -1) return normalized.slice(index + marker.length);
    }

    return basename(normalized);
}

/**
 * `objectInfo` から、そのノード・その入力が受け付ける選択肢の一覧を取り出す。
 * 一覧を持たない入力（数値・文字列）は `null` を返す。
 */
function catalogChoices(objectInfo, classType, field) {
    const spec = objectInfo?.[classType]?.input;
    for (const group of ['required', 'optional']) {
        const entry = spec?.[group]?.[field];
        if (!Array.isArray(entry)) continue;
        // 形が2通りある。**片方しか見ないと、そのノードだけ素通りする。**
        // 実測（2026-08-14）: `UpscaleModelLoader.model_name` は `['COMBO', {options}]`
        // で、`[[...]]` しか見ていなかったため揃え直しが一度も効かなかった。
        if (Array.isArray(entry[0])) return entry[0];
        if (entry[0] === 'COMBO' && Array.isArray(entry[1]?.options)) return entry[1].options;
    }
    return null;
}

/**
 * 既知モデル台帳から、要求名に一致する項目を引く（`filename` と `aliases` を見る）。
 * `recipeMissingModels.findCatalogEntry` と同じ規則。**規則を変えたら両方直す。**
 */
function findKnownModelEntry(catalog, name) {
    const key = normalizeModelName(name);
    if (!key) return null;
    return (catalog?.models || []).find(entry => {
        if (normalizeModelName(entry?.filename) === key) return true;
        return (entry?.aliases || []).some(alias => normalizeModelName(alias) === key);
    }) || null;
}

/** 末尾のファイル名。区切りは両方あり得る。 */
function catalogBasename(value) {
    return String(value).replaceAll('\\', '/').split('/').pop() || '';
}

/**
 * 拡張子を落とした名前。A1111 の記録は拡張子を持たない（`Hires upscaler: 4x-AnimeSharp`）。
 *
 * **一覧は `modelFileNames.js` が持つ。ここへ手書きしない。** 以前ここは
 * `safetensors|ckpt|pth|pt|bin|onnx` で **`.sft` を欠いており**、`ae.sft` と記録された
 * レシピが、導入済みの `ae.safetensors` が在るのに完全一致に失敗して投入ごと
 * 拒否されていた（実測 2026-08-16）。同じ一覧を判定側 `nameIsInstalled` と
 * 実行側 `catalogStem` の**両方**が使う——片方だけが拡張子を落とすと
 * 「導入済み」と表示しながら投入が拒否される（2026-08-14 に346件中296件が
 * 投入不能だった不具合と同じ形）。
 */
function catalogStem(value) {
    return stripModelExtension(catalogBasename(value));
}

/**
 * 組み上がったグラフのモデル名を、**ComfyUI が返す一覧の実文字列**へ揃える。
 *
 * **なぜ必要か。** `workflowRelativePath` はパスを `/` へ正規化する。照合のためには
 * 正しいが、その文字列がそのまま入力値として出ると、ComfyUI 側の一覧が
 * `Illustrious\anime\model.safetensors`（Windows の os.sep）なので**完全一致に失敗し、
 * `prompt_outputs_failed_validation` で投入すら拒否される**。
 * 実測（2026-08-14・346レシピ）: 296件が投入不能で、うち262件は**区切りの違いだけ**が原因。
 * `CheckpointLoaderSimple` は292件中86件しか一致せず、`LoraLoader` は836件中60件だった。
 * サブフォルダに置いたモデルを使うレシピは**一度も投入できていなかった**ことになる。
 *
 * **`\` を決め打ちにしない。** それでは Linux で逆に壊れる。ComfyUI が実際に返した
 * 文字列を正としてそこから引く。一致が無ければ**何もしない**——未導入のモデルは
 * `dropUnavailableLoras` や `missing` の担当で、ここで握りつぶすと不足が見えなくなる。
 *
 * **選択肢を持つ入力だけを触る。** `sampler_name` のような列挙は既に一覧の値なので
 * 素通りする（正規化しても一致先が変わらない）。
 */
function alignModelNamesToCatalog(prompt, objectInfo, knownModelCatalog = null) {
    if (!prompt || !objectInfo) return 0;
    const lower = value => String(value).toLowerCase();
    /**
     * 既知モデル台帳の別名で引く。**判定側と同じ情報源・同じ正規化を使う**
     * （`normalizeModelName` を import している）。片方だけが別名を解決すると、
     * 「導入済み」と表示しながら投入が拒否される状態になる。
     */
    const aliasRule = value => {
        const entry = findKnownModelEntry(knownModelCatalog, value);
        if (!entry?.filename) return null;
        const key = normalizeModelName(entry.filename);
        return choice => normalizeModelName(choice) === key;
    };
    // 緩い順に試し、**候補がちょうど1つのときだけ**採る。
    // 曖昧なまま当てると別のモデルで生成して「再現した」と言うことになる
    // （実測の危険例: `RealESRGAN_x4` と `RealESRGAN_x4plus` は stem で衝突しうる）。
    const RULES = [
        value => choice => lower(choice.replaceAll('\\', '/')) === lower(String(value).replaceAll('\\', '/')),
        value => choice => lower(catalogBasename(choice)) === lower(catalogBasename(value)),
        value => choice => lower(catalogStem(choice)) === lower(catalogStem(value)),
        aliasRule,
    ];
    let realigned = 0;
    for (const node of Object.values(prompt)) {
        const inputs = node?.inputs;
        if (!inputs || typeof inputs !== 'object') continue;
        for (const [field, value] of Object.entries(inputs)) {
            if (typeof value !== 'string' || !value) continue;
            const choices = catalogChoices(objectInfo, node.class_type, field);
            if (!choices || choices.includes(value)) continue;
            const strings = choices.filter(choice => typeof choice === 'string');
            for (const rule of RULES) {
                const predicate = rule(value);
                if (!predicate) continue;
                const hits = strings.filter(predicate);
                if (hits.length !== 1) continue;
                inputs[field] = hits[0];
                realigned += 1;
                break;
            }
        }
    }
    return realigned;
}

function loraLookupName(value) {
    return stripModelExtension(basename(String(value || ''))).trim().toLowerCase();
}

function loraCompactName(value) {
    return loraLookupName(value).replace(/[^a-z0-9]+/g, '');
}

function loraNameTokens(value) {
    const genericTokens = new Set([
        'lora', 'locon', 'style', 'model', 'version', 'sd', 'sdxl', 'xl',
        'pony', 'illustrious', 'safetensors', 'safetensor', 'checkpoint',
    ]);
    return stripModelExtension(basename(String(value || '')))
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(token => token.length >= 2
            && !genericTokens.has(token)
            && !/^v?\d+(?:\.\d+)?$/.test(token));
}

function bigramDice(left, right) {
    if (left === right) return 1;
    if (left.length < 2 || right.length < 2) return 0;

    const counts = new Map();
    for (let index = 0; index < left.length - 1; index += 1) {
        const pair = left.slice(index, index + 2);
        counts.set(pair, (counts.get(pair) || 0) + 1);
    }

    let intersection = 0;
    for (let index = 0; index < right.length - 1; index += 1) {
        const pair = right.slice(index, index + 2);
        const count = counts.get(pair) || 0;
        if (count > 0) {
            intersection += 1;
            counts.set(pair, count - 1);
        }
    }
    return (2 * intersection) / (left.length + right.length - 2);
}

function loraNameSimilarity(left, right) {
    const leftCompact = loraCompactName(left);
    const rightCompact = loraCompactName(right);
    if (!leftCompact || !rightCompact) return 0;
    if (leftCompact === rightCompact) return 1;

    const shorter = leftCompact.length <= rightCompact.length ? leftCompact : rightCompact;
    const longer = shorter === leftCompact ? rightCompact : leftCompact;
    const lengthRatio = shorter.length / longer.length;
    let score = 0;
    if (shorter.length >= 6 && longer.includes(shorter)) {
        score = 0.82 + (0.16 * lengthRatio);
    }

    const leftTokens = new Set(loraNameTokens(left));
    const rightTokens = new Set(loraNameTokens(right));
    if (leftTokens.size > 0 && rightTokens.size > 0) {
        const common = [...leftTokens].filter(token => rightTokens.has(token)).length;
        const containment = common / Math.min(leftTokens.size, rightTokens.size);
        const union = new Set([...leftTokens, ...rightTokens]).size;
        const jaccard = union ? common / union : 0;
        score = Math.max(score, (0.72 * containment) + (0.28 * jaccard));
    }

    return Math.max(score, bigramDice(leftCompact, rightCompact) * 0.9);
}

function loraCandidateNames(lora) {
    const aliases = [
        ...(Array.isArray(lora?.aliases) ? lora.aliases : []),
        ...(Array.isArray(lora?.promptAliases) ? lora.promptAliases : []),
    ];
    const civitai = lora?.civitai || {};
    const apiFiles = Array.isArray(civitai.files) ? civitai.files.map(file => file?.name) : [];
    return [
        lora?.file_name,
        lora?.filename,
        lora?.name,
        lora?.modelName,
        lora?.modelVersionName,
        civitai?.name,
        civitai?.model?.name,
        ...apiFiles,
        ...aliases,
    ].filter(Boolean);
}

function getLoraStrength(lora, fallback = 1) {
    const candidates = [lora?.weight, lora?.strength];
    const value = candidates.find(candidate => Number.isFinite(Number(candidate)));
    return value === undefined ? fallback : Number(value);
}

function getLoraStrengths(lora, fallback = 1) {
    const shared = getLoraStrength(lora, fallback);
    const model = Number.isFinite(Number(lora?.strength_model))
        ? Number(lora.strength_model)
        : shared;
    const clip = Number.isFinite(Number(lora?.strength_clip))
        ? Number(lora.strength_clip)
        : shared;
    return { model, clip };
}

function extractPromptLoras(prompt) {
    if (typeof prompt !== 'string') return { text: prompt, loras: [] };

    const loras = [];
    const text = prompt.replace(LORA_TAG_PATTERN, (tag, rawName, rawStrength) => {
        const name = String(rawName || '').trim();
        const strength = Number(rawStrength);
        if (name && Number.isFinite(strength)) loras.push({ name, strength });
        return '';
    }).replace(/\s{2,}/g, ' ').trim();

    return { text, loras };
}


/**
 * `BREAK` を取り除く。**ComfyUI には BREAK が実装されていない。**
 *
 * A1111 / Forge は `BREAK` をチャンク境界（次の75トークン枠へ送る指示）として
 * 消費するが、ComfyUI の `comfy/sd1_clip.py` に BREAK の文字列は1つも無く、
 * トークナイザへそのまま渡る。実測で `BREAK` は CLIP BPE のトークン id 2568 の
 * **1トークンとして条件付けに混入する**。
 *
 * 実測: 346件中 **20ファイル・44出現**。同コーパスの正プロンプトは平均166トークンで
 * 317件中278件（87.7%）が75トークン超なので、作者が境界を置いた意図は実在する。
 *
 * ここでは**ゴミトークンを消すところまで**にする。境界そのものを再現するには
 * CLIPTextEncode を分割して ConditioningConcat で結合する必要があり、
 * ノードが増えて退行リスクが上がるので分けて扱う。
 */
function stripBreakKeyword(value) {
    // 語境界を必ず付ける。付けないと BREAKFAST / OUTBREAK まで壊す。
    if (!/\bBREAK\b/.test(value)) return value;
    return value
        .replace(/\s*\bBREAK\b\s*/g, ', ')
        .replace(/(?:\s*,\s*){2,}/g, ', ')
        .replace(/^\s*,\s*/, '')
        .replace(/\s*,\s*$/, '');
}

/**
 * ゼロ幅文字などの混入だけを落とす。**BREAK はここでは消さない。**
 * smZ があるかどうかで扱いが変わるので、条件付けを組む側で決める。
 */
function cleanPromptText(value) {
    if (typeof value !== 'string') return value;
    return value.replace(/(?:\u200b|â)/g, '').trim();
}

function getReplayManifest(recipe, options = {}, warnings = null) {
    const manifest = options.replayManifest ?? recipe?.replay_manifest ?? null;
    if (!manifest) return null;
    if (manifest.schema !== REPLAY_MANIFEST_SCHEMA || manifest.version !== REPLAY_MANIFEST_VERSION) {
        throw new Error(t('core.recipeWorkflowBuilder.1'));
    }
    if (!Array.isArray(manifest.required_resources)
        || !Array.isArray(manifest.advisory_resources)
        || !Array.isArray(manifest.errors)) {
        throw new Error(t('core.recipeWorkflowBuilder.2'));
    }
    if (manifest.errors.length > 0) {
        // **throw しない。** 以前はここで例外を投げて再現自体を止めていたが、
        // manifest は「厳密な保証」の道具であって、無ければレシピ台帳から
        // 近似で組める（実測: throw していた16件は全件カタログ経路で組め、
        // 10件はそのまま compatible になった）。保証できない事実は警告で残す。
        const detail = manifest.errors
            .map(error => error?.message || error?.code)
            .filter(Boolean)
            .join(' / ');
        /*
         * **壊れた requirement だけを落として、残りは使う。**
         *
         * 以前は errors が1件でもあると manifest ごと捨てていた。すると
         * `promptAuthoritative` のカタログ経路へ落ち、**インラインタグに載っていない
         * 構造化台帳が消える**（実測: 90688298 は台帳4本→グラフ1本、31588386 は 9→4）。
         *
         * 落とす対象は `resolution.status === 'missing_recipe_resource'` の
         * requirement だけにする。**名前で照合しない**——required_resources の名前は
         * `resource.name` の下にあり、トップレベルの `name` は存在しないので、
         * 名前照合で書くと**全件が落ちて keep が空になり、黙って従来どおり null を返す**
         * （2026-08-19 実測: グラフ変化0件で気づいた）。
         *
         * 実測（2026-08-19・errors ありの16件）: requirement 72件のうち
         * `missing_recipe_resource` は **13件**で、残る59件（`recipe_match` 51 /
         * `inline_only` 8）は解決できている。**1本の不整合で59本の記録を捨てていた。**
         *
         * `LORA_STRENGTH_CONFLICT` は requirement 自体は解決しており、強度の出所が
         * 競合しているだけなので**落とさない**（manifest が `expected` で優先順位により
         * 選んだ値をそのまま使う）。強度の選び方そのものは別候補の論点。
         */
        /*
         * **エラーが名指しする資源が required_resources の中に見つかるときだけ manifest を使う。**
         *
         * 2026-08-19 の盲検で `31588386`（ok）が退行した。機序はこうだった:
         * `LORA_IDENTITY_AMBIGUOUS` の `Styles\ExpressiveH` は**曖昧なので
         * required_resources に載っていない**。従来は manifest ごと捨てて台帳経路へ落ち、
         * 台帳の `Expressive_H-000001`(0.8) が採用されていた。manifest を採用すると
         * **その LoRA が丸ごと消える**（4本→3本）。
         *
         * つまり「台帳の推測」を「manifest の沈黙」と取り替えていた。
         * **required_resources に現れないエラーは、採用した時点で情報が減る。**
         */
        const resourceNames = new Set(manifest.required_resources.flatMap(resource => [
            resource?.resource?.name,
            resource?.resource?.file_name,
            ...(resource?.resource?.promptAliases || []),
        ].filter(Boolean).map(name => String(name).trim().toLowerCase())));
        const errorNames = manifest.errors.flatMap(error => {
            const evidence = Array.isArray(error?.evidence) ? error.evidence : [error?.evidence];
            return evidence.map(item => (item && typeof item === 'object' ? item.name : null))
                .filter(Boolean).map(name => String(name).trim().toLowerCase());
        });
        /*
         * **union（候補[9]）と併用するので、修復不能でも manifest を捨てない。**
         * manifest に載らなかった LoRA は union がカタログ側から補うため、
         * 「manifest の沈黙で情報が減る」という退行の機序が塞がれている。
         * errorNames が空のときだけ、名指しできないので従来どおり捨てる。
         */
        const unrepairable = errorNames.length === 0;
        if (unrepairable) {
            if (Array.isArray(warnings)) {
                warnings.push(
                    t('core.recipeWorkflowBuilder.3', { p1: detail || 'Unknown manifest error' })
                );
            }
            return null;
        }

        const BROKEN_STATUS = new Set(['missing_recipe_resource']);
        const keep = manifest.required_resources
            .filter(resource => !BROKEN_STATUS.has(resource?.resolution?.status));
        const dropped = manifest.required_resources.length - keep.length;

        if (Array.isArray(warnings)) {
            /* **0件のときに「一部」と書かない。** 実測で `一部（0件）` という文が出ていた。 */
            warnings.push(dropped
                ? t('core.recipeWorkflowBuilder.4', { p1: dropped, p2: detail || 'Unknown manifest error' })
                : t('core.recipeWorkflowBuilder.5', { p1: detail || 'Unknown manifest error' }));
        }
        /* 全部落ちるなら manifest として意味が無いので従来どおり捨てる。 */
        if (!keep.length) return null;
        return { ...manifest, required_resources: keep, errors: [] };
    }
    return manifest;
}

/**
 * manifest 由来の LoRA と、カタログ経路の LoRA を **union** にする。
 *
 * **置き換えていたのを改めた（2026-08-19）。** `manifestLoras` が非空なら
 * カタログ側を丸ごと捨てていたので、**manifest に載っていない LoRA は必ず落ちていた**。
 * 載っていない理由は「不要だから」ではない——`LORA_IDENTITY_AMBIGUOUS` のように
 * **manifest が一意に決められなかったもの**も載らない。
 *
 * 実例（`Civitai_Recipe_31588386`）: インラインタグ6本のうち `Styles\ExpressiveH` が曖昧で
 * required_resources に無く、manifest を採ると 4本→3本になった。台帳には
 * `Expressive_H-000001`（強度0.8）があり、従来の経路ではそれが使われていた。
 *
 * **manifest 側を優先し、カタログ側にしか無いものを後ろへ足す。**
 * manifest は「厳密な保証」の側なので、同じファイルを指すなら manifest の強度を採る。
 */
function unionManifestWithCatalog(manifestLoras, catalogLoras, warnings, isInstalledName = null) {
    const manifest = Array.isArray(manifestLoras) ? manifestLoras : [];
    const catalog = Array.isArray(catalogLoras) ? catalogLoras : [];
    if (!manifest.length) return catalog;

    const key = entry => String(getResourceFilename(entry) || '')
        .replaceAll('\\', '/').toLowerCase();
    const have = new Set(manifest.map(key).filter(Boolean));
    const extra = catalog.filter(entry => {
        const k = key(entry);
        if (!k || have.has(k)) return false;
        /*
         * **手元に無いカタログ資源は重ねない。**
         *
         * union の目的は「manifest が一意に決められなかった **手元にある** LoRA を拾う」ことなので、
         * 導入されていないものを足しても後段の `dropUnavailableLoras` が外すだけで、
         * グラフは変わらないまま**厳密再現の監査だけが落ちる**
         * （`advisory` の `recipe_catalog_only` を必須入力として数えてしまう）。
         *
         * union 導入前はここでカタログを丸ごと捨てていたので、
         * この絞り込みは**以前の挙動へ寄せる方向**であり、拾う側の利得は失わない。
         */
        if (typeof isInstalledName === 'function' && !isInstalledName(getResourceFilename(entry))) {
            return false;
        }
        return true;
    });
    if (extra.length && Array.isArray(warnings)) {
        warnings.push(
            t('core.recipeWorkflowBuilder.6', { p1: extra.length })
        );
    }
    return manifest.concat(extra);
}

/**
 * **同定できないまま残った manifest 要求を落とす。**
 *
 * `resolution.status === 'inline_only'` の要求は「インラインタグからしか分かっていない」状態で、
 * 名前が手元のどのファイルも指さないなら**それ以上どうにもならない**。
 * 後段の `dropUnavailableLoras` がどのみち外すので、グラフは変わらない。
 * 変わるのは説明だけで、**外した理由を「未導入」と誤って説明しなくなる**。
 *
 * `mergePromptLoras` がタグ名を同定できず台帳へ退避したときにだけ呼ぶこと。
 * 常に呼ぶと、**本当に手元に無い LoRA の警告まで消える**。
 */
function dropUnidentifiableManifestLoras(manifestLoras, isInstalledName) {
    if (!Array.isArray(manifestLoras) || typeof isInstalledName !== 'function') return manifestLoras;
    return manifestLoras.filter(entry => {
        const filename = getResourceFilename(entry);
        return !filename || isInstalledName(filename);
    });
}

function requiredManifestLoras(manifest) {
    if (!manifest) return null;
    const required = manifest.required_resources.filter(
        item => item?.required === true && item?.kind === 'lora'
    );
    const seenIds = new Set();
    const seenFilenames = new Set();
    return required.map(item => {
        const id = String(item?.requirement_id || '').trim();
        const status = String(item?.resolution?.status || '');
        const resource = item?.resource;
        const model = Number(item?.expected?.strength_model);
        const clip = Number(item?.expected?.strength_clip);
        if (!id || seenIds.has(id)) {
            throw new Error(t('core.recipeWorkflowBuilder.7', { p1: id || 'Unknown' }));
        }
        if (!['recipe_match', 'inline_only'].includes(status)
            || !resource || typeof resource !== 'object') {
            throw new Error(t('core.recipeWorkflowBuilder.8', { p1: id }));
        }
        if (!Number.isFinite(model) || !Number.isFinite(clip)) {
            throw new Error(t('core.recipeWorkflowBuilder.9', { p1: id }));
        }
        const workflowFilename = getResourceFilename(resource);
        const filenameKey = workflowFilename.replaceAll('\\', '/').toLowerCase();
        if (!workflowFilename || seenFilenames.has(filenameKey)) {
            throw new Error(t('core.recipeWorkflowBuilder.10', { p1: workflowFilename || id }));
        }
        seenIds.add(id);
        seenFilenames.add(filenameKey);
        return {
            ...resource,
            weight: model,
            strength: model,
            strength_model: model,
            strength_clip: clip,
            _replayRequirement: {
                schema_version: REPLAY_MANIFEST_VERSION,
                required: true,
                id,
                manifest_hash: manifest.manifest_hash || '',
            },
        };
    });
}

/**
 * インラインタグ（`<lora:name:weight>`）と、レシピの構造化台帳を突き合わせる。
 *
 * `promptAuthoritative` は「このタグ列が、この画像で実際に使われた LoRA の全体である」
 * という前提で、**タグに現れない台帳エントリを落とす**ためのもの。
 * その推論は**タグ名と台帳を比べられたときにだけ**成り立つ。
 *
 * @param {(name: string) => boolean} [isInstalledName]
 *   タグ名が手元のファイルを指すかを返す判定器（`objectInfo` 由来）。
 *   渡さないと「タグが同定の情報を持たない」場合を見分けられない。
 */
/**
 * A1111 の `Civitai resources:` が**LoRA として名指しした版ID**（2026-08-27）。
 *
 * **タグに無い＝使っていない、が成り立たない形が実在する。** Civitai の生成画面は
 * インラインタグを**一部の LoRA にしか書かない**が、`Civitai resources:` には
 * 使った全部を版ID付きで並べる。実測（`Civitai_Recipe_77742180`）:
 *
 *   プロンプトのタグ ……… `<lora:tove-nikke-richy-v1_ixl:1>` の **1本だけ**
 *   `Civitai resources` … LoRA **4本**（版ID 1056404 / 1135769 / 1373674 / 1809862）
 *   レシピの台帳 ………… **同じ4本**（版IDが完全一致）
 *
 * タグを唯一の権威として扱った結果、**4本中3本が黙って落ちた**
 * （748cm 0.45・Kawaii tech 0.9・Velvet's Mythic 0.7）。改造 LoRA Manager が
 * 出した絵は4本とも積んでおり、**そこが「再現した絵が違う」の正体だった。**
 *
 * **添字で対応付けない**（`a1111Parameters.js` が既に警告している罠）。
 * 突き合わせるのは**版IDだけ**で、これは一意である。
 */
function declaredLoraVersionIds(rawA1111Parameters) {
    const out = new Set();
    if (!rawA1111Parameters) return out;
    let parsed = null;
    try { parsed = parseA1111Parameters(rawA1111Parameters); } catch { return out; }
    if (!parsed?.ok) return out;
    for (const resource of normalizeResources(parsed.resources)) {
        if (resource?.kind !== 'lora') continue;
        const id = Number(resource.modelVersionId);
        if (Number.isFinite(id) && id > 0) out.add(id);
    }
    return out;
}

function mergePromptLoras(
    recipeLoras,
    promptLoras,
    {
        promptAuthoritative = false, isInstalledName = null, warnings = null,
        declaredVersionIds = null,
    } = {}
) {
    const result = Array.isArray(recipeLoras) ? recipeLoras.map(lora => ({ ...lora })) : [];
    const structuredCount = result.length;
    const matchedStructuredIndexes = new Set();
    const byName = new Map();
    const fuzzyClaimedIndexes = new Set();
    result.forEach((lora, index) => {
        for (const candidate of loraCandidateNames(lora)) {
            const key = loraCompactName(candidate);
            if (key) byName.set(key, index);
        }
    });

    for (const tagged of promptLoras) {
        const key = loraCompactName(tagged.name);
        let existingIndex = byName.get(key);
        if (existingIndex === undefined && key.length >= 6) {
            // Fuzzy matching is only safe against structured recipe resources.
            // Prompt tags added earlier in this loop are independent inputs;
            // similarly named tags (for example Korean/Taiwan Doll Likeness)
            // must not collapse into one loader.
            const ranked = result.slice(0, structuredCount)
                .map((lora, index) => ({
                    index,
                    score: Math.max(0, ...loraCandidateNames(lora)
                        .map(candidate => loraNameSimilarity(tagged.name, candidate))),
                }))
                .filter(candidate => !fuzzyClaimedIndexes.has(candidate.index))
                .sort((left, right) => right.score - left.score);
            const best = ranked[0];
            const runnerUp = ranked[1];
            if (best?.score >= 0.62 && (!runnerUp || best.score - runnerUp.score >= 0.12)) {
                existingIndex = best.index;
                fuzzyClaimedIndexes.add(existingIndex);
            }
        }
        if (existingIndex !== undefined) {
            if (existingIndex < structuredCount) matchedStructuredIndexes.add(existingIndex);
            // The inline tag is the explicit per-image setting, so it wins over
            // a generic resource strength stored in the recipe.
            result[existingIndex].weight = tagged.strength;
            const aliases = new Set(result[existingIndex].promptAliases || []);
            aliases.add(tagged.name);
            result[existingIndex].promptAliases = [...aliases];
            byName.set(key, existingIndex);
            continue;
        }

        result.push({
            name: tagged.name,
            file_name: tagged.name,
            weight: tagged.strength,
        });
        byName.set(key, result.length - 1);
    }

    if (promptAuthoritative && promptLoras.length > 0) {
        /*
         * **タグ名が同定の情報を1つも持たないなら、台帳を捨てない。**
         *
         * 2026-08-19 実測（`Civitai_Recipe_135983323`）: インラインタグが
         * `<lora:f9673cde-88aa-4e9d-ac3d-c571b107755b:0.5>` のような **UUID 名**で、
         * 台帳の名前（`ponyv3_ill01_2_adamW-000017` 等）とは一致しない。
         * すると matched が0件になり、ここで**台帳8本が全部落ちて**
         * 代わりに手元に無い UUID 名の仮エントリ8本が残り、
         * 最終的に `dropUnavailableLoras` が全部外して **LoRA 0本で再現**していた
         * （警告は「未導入のLoRA8件」と出るが、8本とも手元にある）。
         *
         * 「タグに無い＝この画像では使っていない」と読めるのは、
         * **タグ名と台帳を比べられたとき**だけである。1件も指せず、かつ
         * どのタグ名も手元のファイルを指さないなら、比較は成立しておらず、
         * 落とす根拠が無い。**この場合は台帳をそのまま使う。**
         *
         * 台帳の強度はタグの重みと一致することを実測で確認している
         * （`135983323` の8本すべてで順番・重みとも一致）。したがって
         * 台帳へ退避しても重みは失われない。
         *
         * 条件は**両方**要る。片方（matched===0）だけで退避すると、
         * 台帳とは別の（しかし導入済みの）LoRA をタグが指しているレシピで、
         * 実際に使われた LoRA を捨てて台帳側を復活させてしまう。
         */
        const anyTagInstalled = typeof isInstalledName === 'function'
            && promptLoras.some(tagged => isInstalledName(tagged.name));
        if (structuredCount > 0 && matchedStructuredIndexes.size === 0 && !anyTagInstalled) {
            if (Array.isArray(warnings)) {
                warnings.push(
                    t('core.recipeWorkflowBuilder.11', { p1: promptLoras.length, p2: structuredCount })
                );
            }
            const fallback = result.slice(0, structuredCount);
            /*
             * **manifest 側にも同じ仮エントリが載っている**ので、退避したことを呼び出し側へ伝える。
             * 伝えないと、manifest 由来の同じ UUID がローダとして生え、
             * 後段の `dropUnavailableLoras` が外して「未導入のLoRA8件」と警告する——
             * **グラフは正しいのに、劣化したという嘘の説明が付く**。
             */
            fallback.promptTagsUnidentifiable = true;
            return fallback;
        }
        /*
         * **A1111 自身が名指しした LoRA は落とさない**（2026-08-27）。
         *
         * タグを唯一の権威にできるのは「タグに無い＝使っていない」が読めるときだけ。
         * `Civitai resources:` が版ID付きで並べているなら、**それは同じ A1111
         * メタデータの中の、より完全な申告**である。タグの役目は
         * **どれを使ったか**ではなく**そのタグが指す1本の重み**にしかならない。
         */
        const declared = declaredVersionIds instanceof Set ? declaredVersionIds : null;
        const keptByDeclaration = new Set();
        if (declared && declared.size > 0) {
            result.forEach((lora, index) => {
                if (index >= structuredCount || matchedStructuredIndexes.has(index)) return;
                const id = Number(lora?.modelVersionId);
                if (Number.isFinite(id) && declared.has(id)) keptByDeclaration.add(index);
            });
        }
        const kept = result.filter((_, index) => (
            index >= structuredCount
            || matchedStructuredIndexes.has(index)
            || keptByDeclaration.has(index)
        ));
        /*
         * **落としたことを黙らせない。** ここは長らく無言で、実測では
         * 4本中3本が消えた絵に**警告が1行も付いていなかった**
         * ——絵が違うことに気づいても、原因を画面から辿る道が無い。
         */
        const dropped = structuredCount - result
            .slice(0, structuredCount)
            .filter((_, index) => matchedStructuredIndexes.has(index) || keptByDeclaration.has(index))
            .length;
        if (dropped > 0 && Array.isArray(warnings)) {
            warnings.push(t('core.recipeWorkflowBuilder.86', { p1: dropped, p2: structuredCount }));
        }
        return kept;
    }
    return result;
}

function civitaiFile(resource, preferredType = null) {
    const files = resource?.civitai?.files;
    if (!Array.isArray(files) || files.length === 0) return null;

    if (preferredType) {
        const typed = files.find(file => String(file?.type || '').toLowerCase() === preferredType.toLowerCase());
        if (typed) return typed;
    }

    return files.find(file => file?.primary) || files[0];
}

export function getResourceFilename(resource, preferredType = null) {
    if (!resource) return '';

    const apiFile = civitaiFile(resource, preferredType);
    const candidates = [
        resource.inLibrary ? resource.localPath : null,
        resource.file_name,
        resource.filename,
        resource.localPath,
        resource.file_path,
        apiFile?.name,
    ];

    let filename = '';
    for (const candidate of candidates) {
        filename = workflowRelativePath(candidate, preferredType);
        if (filename) break;
    }

    if (filename && !/\.[a-z0-9]{2,16}$/i.test(filename)) {
        const apiName = basename(apiFile?.name);
        if (apiName && apiName.toLowerCase().startsWith(filename.toLowerCase())) {
            filename = apiName;
        } else {
            filename += '.safetensors';
        }
    }

    return filename;
}

// \u6f5c\u5728\u7a7a\u9593\u306f 1/8 \u30b9\u30b1\u30fc\u30eb\u306a\u306e\u3067\u3001ComfyUI \u306e Empty*LatentImage \u306f
// \u5185\u90e8\u3067 `width // 8` \u306b\u5207\u308a\u6368\u3066\u308b\u3002\u8a18\u9332\u5024\u3092\u305d\u306e\u307e\u307e\u6e21\u3059\u3068\u3001\u5ba3\u8a00\u3057\u305f\u5bf8\u6cd5\u3068
// \u5b9f\u969b\u306b\u51fa\u308b\u753b\u7d20\u6570\u304c\u305a\u308c\u308b\uff08\u5b9f\u6e2c: 8\u306e\u500d\u6570\u3067\u306a\u3044\u8a18\u9332\u5024\u304c\u5b58\u5728\u3057\u3001
// 84334115 \u306e `2305x1537` \u306f\u4fdd\u5b58\u30ce\u30fc\u30c9\u3078**\u624b\u5165\u529b\u3055\u308c\u305f\u98fe\u308a\u5024**\u3060\u3063\u305f\uff09\u3002
// \u4e0b\u6d41\u3068\u540c\u3058\u5207\u308a\u6368\u3066\u3092\u3053\u3053\u3067\u6e08\u307e\u305b\u3001\u5ba3\u8a00\u3068\u5b9f\u7269\u3092\u4e00\u81f4\u3055\u305b\u308b\u3002
function snapToLatentGrid(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return Math.max(8, Math.floor(numeric / 8) * 8);
}

function parseSize(size) {
    let raw = null;
    if (typeof size === 'string') {
        const match = size.match(/(\d+)\s*[xX\u00d7,]\s*(\d+)/);
        if (match) raw = { width: Number(match[1]), height: Number(match[2]) };
    } else if (Array.isArray(size) && size.length >= 2) {
        raw = { width: Number(size[0]), height: Number(size[1]) };
    } else if (size && typeof size === 'object') {
        raw = { width: Number(size.width), height: Number(size.height) };
    }
    if (!raw) return null;
    const width = snapToLatentGrid(raw.width);
    const height = snapToLatentGrid(raw.height);
    if (!width || !height) return null;
    return { width, height };
}

// SDXL \u7cfb\u306e\u6a19\u6e96\u30d0\u30b1\u30c3\u30c8\u3002\u30a2\u30b9\u30da\u30af\u30c8\u6bd4\u3057\u304b\u5206\u304b\u3089\u306a\u3044\u3068\u304d\u306e\u7740\u5730\u70b9\u306b\u4f7f\u3046\u3002
const SDXL_BUCKETS = [
    { width: 1024, height: 1024 }, { width: 1152, height: 896 }, { width: 896, height: 1152 },
    { width: 1216, height: 832 }, { width: 832, height: 1216 }, { width: 1344, height: 768 },
    { width: 768, height: 1344 }, { width: 1536, height: 640 }, { width: 640, height: 1536 },
];

function bucketForAspect(width, height) {
    const target = Number(width) / Number(height);
    if (!Number.isFinite(target) || target <= 0) return null;
    let best = null;
    let bestGap = Infinity;
    for (const bucket of SDXL_BUCKETS) {
        const gap = Math.abs(Math.log(bucket.width / bucket.height) - Math.log(target));
        if (gap < bestGap) { bestGap = gap; best = bucket; }
    }
    return best;
}

/**
 * \u751f\u6210\u5bf8\u6cd5\u3092\u6c7a\u3081\u308b\u3002**\u6839\u62e0\u306e\u5f37\u3044\u9806\u306b\u843d\u3068\u3059\u3002**
 *
 * \u4ee5\u524d\u306f `parseSize(gen.size) || { width: 1024, height: 1024 }` \u306e1\u884c\u3067\u3001
 * size \u304c\u7121\u3044\u30ec\u30b7\u30d4\u306f\u7121\u6761\u4ef6\u306b\u6b63\u65b9\u5f62\u306b\u306a\u3063\u3066\u3044\u305f\u3002\u5b9f\u6e2c: size \u6b20\u843d\u306f346\u4ef6\u4e2d106\u4ef6
 * \uff0830.6%\uff09\u3067\u3001\u305d\u306e\u3046\u3061**\u30d7\u30ec\u30d3\u30e5\u30fc\u304c\u6b63\u65b9\u5f62\u306a\u306e\u306f16\u4ef6\u3060\u3051**\u3002\u3064\u307e\u308a
 * \u6b8b\u308a90\u4ef6\uff0885%\uff09\u306f\u6700\u521d\u304b\u3089\u30a2\u30b9\u30da\u30af\u30c8\u6bd4\u3092\u53d6\u308a\u9055\u3048\u3066\u518d\u73fe\u3057\u3066\u3044\u305f\u3002
 *
 * \u30d7\u30ec\u30d3\u30e5\u30fc\u753b\u50cf\u306f\u5143\u751f\u6210\u306e\u51fa\u529b\u305d\u306e\u3082\u306e\u306a\u306e\u3067\u3001\u5bf8\u6cd5\u306e\u7d76\u5bfe\u5024\u306f
 * \uff08hires\u5f8c\u306a\u306e\u3067\uff09\u5f53\u3066\u306b\u306a\u3089\u306a\u3044\u304c\u3001**\u30a2\u30b9\u30da\u30af\u30c8\u6bd4\u306f\u4e00\u6b21\u8cc7\u6599**\u3068\u3057\u3066\u4f7f\u3048\u308b\u3002
 */
function previewAspect(recipe) {
    const preview = recipe?.preview_size || recipe?.previewSize;
    const width = Number(preview?.width);
    const height = Number(preview?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return width / height;
}

/**
 * 記録寸法の縦横が入れ替わっていないか、プレビューの比率で検算する。
 *
 * 実測1件（84334115 / 652affc2）: 記録は `2305x1537`（横長）だが、
 * プレビューは 480x720（縦長）。しかも **1537/2305 = 0.6668 ≒ 480/720** で、
 * 入れ替えると一致する。この値は `Save Image w/Metadata` ノードへ手入力された
 * 飾り値で、8の倍数ですらなかった。そのまま使うと**90°転置した絵**が出る。
 *
 * 「入れ替えると合う」ときだけ入れ替える。単に合わないだけなら触らない
 * （プレビューはクロップされている可能性があり、比率は根拠として弱い）。
 */
function correctTransposedSize(size, recipe, warnings) {
    const aspect = previewAspect(recipe);
    if (!aspect || !size) return size;

    const asIs = Math.abs(Math.log((size.width / size.height) / aspect));
    const swapped = Math.abs(Math.log((size.height / size.width) / aspect));
    // 現状が十分ずれていて、かつ入れ替えると明確に合う場合だけ。
    if (asIs > 0.05 && swapped < 0.02 && swapped < asIs) {
        if (Array.isArray(warnings)) {
            warnings.push(
                t('core.recipeWorkflowBuilder.12', { p1: size.width, p2: size.height, p3: size.height, p4: size.width })
            );
        }
        return { width: size.height, height: size.width };
    }
    return size;
}

function resolveTargetSize(recipe, gen, warnings) {
    const recorded = parseSize(gen?.size);
    if (recorded) return correctTransposedSize(recorded, recipe, warnings);

    // gen_params \u306b\u7121\u304f\u3066\u3082 A1111 \u539f\u6587\u306b\u306f `Size:` \u304c\u6b8b\u3063\u3066\u3044\u308b\u3053\u3068\u304c\u3042\u308b
    // \uff08\u5b9f\u6e2c: size \u6b20\u843d106\u4ef6\u306e\u3046\u306143\u4ef6\uff09\u3002\u53d6\u308a\u3053\u307c\u3059\u7406\u7531\u304c\u7121\u3044\u3002
    const fromParameters = parseSize(parameterValue(findA1111Parameters(recipe), 'Size'));
    if (fromParameters) return fromParameters;

    // Civitai の resource-stack グラフには出力寸法が書いてある（18件中18件）。
    // プレビュー比率からの推定より、記録値のほうが当然強い。
    const stackSize = parseSize(parseResourceStackGraph(findA1111Parameters(recipe))?.size);
    if (stackSize) return stackSize;

    const preview = recipe?.preview_size || recipe?.previewSize;
    const previewWidth = Number(preview?.width);
    const previewHeight = Number(preview?.height);
    if (Number.isFinite(previewWidth) && Number.isFinite(previewHeight)
        && previewWidth > 0 && previewHeight > 0) {
        const bucket = bucketForAspect(previewWidth, previewHeight);
        if (bucket) {
            if (Array.isArray(warnings)) {
                warnings.push(
                    t('core.recipeWorkflowBuilder.80', { p1: previewWidth, p2: previewHeight, p3: bucket.width, p4: bucket.height })
                );
            }
            return { ...bucket };
        }
    }

    if (Array.isArray(warnings)) {
        warnings.push(t('core.recipeWorkflowBuilder.81'));
    }
    return { width: 1024, height: 1024 };
}

function normalizedClassType(value) {
    return String(value || '').replace(/[^a-z0-9]+/gi, '').toLowerCase();
}

/**
 * 「白紙の latent を作るノード」かどうか。
 *
 * 判定は3箇所（denoise=1 の強制／記録サイズの適用／単一バッチ最適化）で
 * 使われていたが、それぞれが生の class_type に対する `/Empty.*LatentImage/i`
 * を持っていた。生文字列で見るため **`Empty Latent Image` のように空白の入る
 * 表示名を取りこぼし**、3箇所が別々に育つと「denoise だけ変わって寸法は
 * 変わらない」ような段ごとのねじれが出る。正規化して1箇所に集約する。
 *
 * 動画用の Empty*LatentVideo 系は対象外（寸法の意味が違う）。
 */
function isEmptyLatentClass(classType) {
    const normalized = normalizedClassType(classType);
    if (!normalized.startsWith('empty')) return false;
    if (normalized.includes('latentvideo') || normalized.includes('latentaudio')) return false;
    return normalized.includes('latentimage');
}

function filenameFromName(value) {
    const name = basename(String(value || '').trim());
    if (!name || /^none|automatic$/i.test(name)) return '';
    return /\.[a-z0-9]{2,16}$/i.test(name) ? name : `${name}.safetensors`;
}

function parameterValue(parameters, key) {
    if (typeof parameters !== 'string') return '';
    const match = parameters.match(new RegExp(`(?:^|[,\\n]\\s*)${key}\\s*:\\s*([^,\\r\\n]+)`, 'i'));
    return match?.[1]?.trim() || '';
}

/**
 * `a1111_parameters` が Civitai の resource-stack（ComfyUI API形式のグラフ）
 * だったときに、そこから再現条件を取り出す。
 *
 * **このグラフは今まで一度も読まれていなかった。** 実測346件中18件が該当し、
 * グラフには揃っているのに `gen_params` へ写っていない項目がこれだけある:
 *
 *   scheduler   15件中 **15件** 欠落
 *   denoise     15件中 **15件** 欠落
 *   出力寸法    18件中 **16件** 欠落
 *   LoRAの strength_clip   32本が strength_model と別値なのに潰れていた
 *
 * つまり「記録が無いので推定した」と言っていた項目の多くは、**記録はあった**。
 *
 * 18件すべてが `LoadImage`(http URL) → 拡大 → `VAEEncode` → KSampler(denoise<1)
 * という**入力画像を描き直す構成**で、記録寸法は拡大後の最終寸法にあたる。
 */
function parseResourceStackGraph(parameters) {
    if (typeof parameters !== 'string' || !parameters.trim().startsWith('{')) return null;
    let graph;
    try {
        graph = JSON.parse(parameters);
    } catch {
        return null;
    }
    if (!graph || typeof graph !== 'object') return null;

    const result = {
        sampler: null, scheduler: null, steps: null, cfg: null, seed: null,
        denoise: null, size: null, sourceImage: null, upscaler: null,
        loraStrengths: new Map(),
    };
    let sawNode = false;
    let scaleSize = null;
    let latentSize = null;

    for (const node of Object.values(graph)) {
        if (!node || typeof node !== 'object') continue;
        const classType = node.class_type;
        const inputs = node.inputs;
        if (!classType || !inputs || typeof inputs !== 'object') continue;
        sawNode = true;

        if (classType === 'KSampler' || classType === 'KSamplerAdvanced') {
            if (typeof inputs.sampler_name === 'string') result.sampler = inputs.sampler_name;
            if (typeof inputs.scheduler === 'string') result.scheduler = inputs.scheduler;
            if (Number.isFinite(Number(inputs.steps))) result.steps = Number(inputs.steps);
            if (Number.isFinite(Number(inputs.cfg))) result.cfg = Number(inputs.cfg);
            if (Number.isFinite(Number(inputs.seed))) result.seed = Number(inputs.seed);
            if (Number.isFinite(Number(inputs.denoise))) result.denoise = Number(inputs.denoise);
        } else if (classType === 'ImageScale' || classType === 'ImageScaleBy') {
            if (Number.isFinite(Number(inputs.width))) {
                scaleSize = { width: Number(inputs.width), height: Number(inputs.height) };
            }
        } else if (isEmptyLatentClass(classType)) {
            if (Number.isFinite(Number(inputs.width))) {
                latentSize = { width: Number(inputs.width), height: Number(inputs.height) };
            }
        } else if (classType === 'UpscaleModelLoader') {
            // **拡大器はここにしか書かれていないことがある。**
            // `hiresUpscalerName` は A1111 の `Hires upscaler` 欄と
            // `generation_metadata.upscalers` しか見ていなかったが、
            // stack グラフのレシピは**どちらも持たない**（実測 2026-08-11:
            // stack グラフ18件のうち `generation_metadata.upscalers` を持つのは0件。
            // 一方で18件すべてが UpscaleModelLoader を持つ）。
            // 読まないと拡大器名が空になり `usesPixelHiresUpscaler` が false を返して
            // **単純な lanczos 拡大**へ落ちる。ESRGAN 系と lanczos では質感が違う。
            if (typeof inputs.model_name === 'string' && inputs.model_name.trim()) {
                result.upscaler = inputs.model_name.trim();
            }
        } else if (classType === 'LoadImage' && typeof inputs.image === 'string'
            && /^https?:\/\//i.test(inputs.image)) {
            result.sourceImage = inputs.image;
        } else if (classType === 'LoraLoader') {
            // lora_name は `urn:air:<base>:lora:civitai:<modelId>@<versionId>`。
            // versionId が recipe.loras[].modelVersionId と一対一で対応する。
            const air = String(inputs.lora_name || '').match(/civitai:(\d+)@(\d+)/i);
            if (!air) continue;
            const model = Number(inputs.strength_model);
            const clip = Number(inputs.strength_clip);
            result.loraStrengths.set(Number(air[2]), {
                model: Number.isFinite(model) ? model : null,
                clip: Number.isFinite(clip) ? clip : null,
            });
        }
    }
    if (!sawNode) return null;

    // 拡大後の寸法が最終出力。無ければ latent の寸法。
    result.size = scaleSize || latentSize;
    return result;
}

/**
 * プロンプト中の素の embedding 名を、ComfyUI が読める `embedding:名前` にする。
 *
 * **A1111 と ComfyUI で解決規則が違う。** A1111 は `lazypos` と書くだけで
 * 同名の embedding を読み込むが、ComfyUI の CLIPTextEncode は
 * `embedding:lazypos` と明示しない限り**ただの単語として扱う**。
 * 元画像が A1111 で作られていれば素の名前で書かれているので、そのまま渡すと
 * embedding の効果が丸ごと消える。品質補正系（lazypos / EasyNegative 等）が
 * 効かなくなるので、絵が薄く・情報量が少なくなる。
 *
 * 実測: embeddings を持つ75件のうち **39件・71トークン**が素の名前のままで、
 * 一度も読み込まれていなかった。
 *
 * 置き換えるのは `recipe.embeddings[]` に実在する名前だけで、**書かれている側
 * （ポジ／ネガ）はそのまま**にする。群Bで消したのは「ネガ側の embedding を
 * ポジ側へ勝手に足していた」注入であって、これはその逆の取りこぼしにあたる。
 */
/**
 * 導入済み埋め込みの basename を取り出す。
 *
 * ComfyUI の `/api/embeddings` は `Illustrious\style\lazypos` のように
 * サブフォルダ付きで返すが、**`embedding:lazypos` はサブフォルダ配下でも解決する**
 * （`comfy/sd1_clip.py` の `expand_directory_list` が `os.walk` で再帰する）。
 * よって当てるべきは basename。
 *
 * 3文字以下は誤爆が怖いので落とす（普通の単語と衝突しやすい）。
 */
function installedEmbeddingBasenames(embeddings) {
    if (!Array.isArray(embeddings)) return [];
    const names = new Set();
    for (const entry of embeddings) {
        const base = String(entry || '').split(/[\\/]/).pop().trim();
        if (base.length >= 4) names.add(base);
    }
    return [...names];
}

/**
 * @param extraNames レシピが記録していないが**導入済みで、かつ記録の生成器が
 *   裸の名前を解決していた**とき渡す名前。呼び出し側が
 *   `recordResolvesBareEmbeddings` を通してから渡すこと。
 */
function qualifyEmbeddingNames(text, recipe, warnings, extraNames = []) {
    if (typeof text !== 'string' || !text) return text;
    const recorded = (Array.isArray(recipe?.embeddings) ? recipe.embeddings : [])
        .filter(entry => entry && typeof entry === 'object' && !entry.exclude)
        .map(entry => String(entry.file_name || '').trim())
        .filter(Boolean);
    // レシピの記録を先に当てる（そちらが本来の根拠）。導入済み一覧は補いでしかない。
    const seen = new Set(recorded.map(name => name.toLowerCase()));
    const names = [...recorded];
    for (const name of extraNames) {
        const key = String(name).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        names.push(String(name));
    }
    if (names.length === 0) return text;

    let result = text;
    const qualified = [];
    for (const name of names) {
        if (!name) continue;
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        /*
         * 既に `embedding:` が付いているものは触らない。
         *
         * **後ろの `:` は「より長い名前の一部」と「A1111の重み記法」の両方になる。**
         * 旧実装は後読みの除外集合に `:` を入れていたため、`(name:0.8)` の形が
         * 一度も直らなかった（実測 `(CyberRealistic_Negative-neg:0.8)`）。
         * A1111 では重み付きでも埋め込みとして解決するので、**重みが続くときだけ
         * 通す**——`:` の次が数字か小数点なら重み、そうでなければ `foo:bar` の
         * 一部とみなして触らない。
         */
        const bare = new RegExp(
            `(?<!embedding:)(?<![\\w:./\\\\-])${escaped}(?![\\w./\\\\-])(?!:(?![0-9.]))`, 'gi');
        if (!bare.test(result)) continue;
        bare.lastIndex = 0;
        result = result.replace(bare, `embedding:${name}`);
        qualified.push(name);
    }
    if (qualified.length > 0 && Array.isArray(warnings)) {
        warnings.push(
            t('core.recipeWorkflowBuilder.13', { p1: qualified.length, p2: qualified.join(' / ') })
        );
    }
    return result;
}

/**
 * LoRA の強度が**どこかに記録されているか**を判定する。
 *
 * 強度の出所は、テキストに現れるものだけではない:
 *   a) プロンプト中の `<lora:name:0.6>` タグ
 *   b) `a1111_parameters` の resource-stack グラフ
 *   c) `Civitai resources:` マーカー
 *   d) A1111拡張の `lora weights: "0.4,0.7"`（applyA1111LoraWeights が読む）
 *   e) 埋め込みComfyUIグラフの LoraLoader
 *   f) **Civitai API の `resources[].weight`**（同期スクリプトが
 *      `res.get("weight", 1.0)` で読む。テキストには一切現れない）
 *
 * f があるため「テキストに根拠が無い＝既定値」とは言えない。実測: テキスト根拠の
 * 無い49件のうち28件は強度がばらついており、それは API 由来の記録値だった。
 *
 * 既定値で埋めた痕跡は「**全本が同じ値**」であること（解析経路の 1.0、
 * 同期スクリプトが新規補完で入れる 0.8）。この形にだけ絞る。実測49件→9件。
 */
function loraWeightsAreRecorded(recipe, loras) {
    const parameters = findA1111Parameters(recipe) || '';
    if (parameters.trim().startsWith('{')) return true;
    if (/Civitai resources/i.test(parameters)) return true;
    if (/lora\s*weights\s*:/i.test(parameters)) return true;
    const prompt = recipe?.gen_params?.prompt || '';
    if (/<lora:/i.test(parameters) || /<lora:/i.test(prompt)) return true;
    // 埋め込みグラフがあれば、そこの LoraLoader が出所。
    if (findEmbeddedPrompt(recipe)) return true;
    // 値がばらついているなら API 由来の記録。既定の一括埋めではない。
    const strengths = (Array.isArray(loras) ? loras : []).map(lora => getLoraStrengths(lora).model);
    return new Set(strengths).size > 1;
}

// 記録が無い強度の上限。**最適値ではなく、実走で全件が成立した値**。
//
// 当初は一律 0.6 にしていたが、それは smZ（A1111互換パーサ）を入れる前の測定で、
// 破綻の一因は条件付け側だった。smZ 適用後に測り直すと 0.85 まで上げられ、
// 95077448 のように密度が要るレシピが 0.6 では細部不足になることが判った。
const UNRECORDED_LORA_PEAK_CAP = 0.85;
// 合計の予算。13本×0.85=11.05 は崩れ、13本×0.6=7.8 は成立したので 8 を採る。
const UNRECORDED_LORA_SUM_BUDGET = 8;

/**
 * 記録の無い強度をそのまま重ねない。
 *
 * **実測（3レシピ・強度倍率を 1.0〜0.2 で掃引）**:
 *   LoRA 2本（98385997）  x1.0・x0.85 で潰れる → x0.7 以下は成立
 *   LoRA 3本（95077448）  x1.0・x0.85・x0.7 で潰れる → x0.6 以下は成立
 *   LoRA 13本（54095009） x1.0・x0.85 で潰れる → x0.7 以下は成立
 *
 * 本数では説明できない（13本より3本のほうが弱い倍率で壊れた）。効いているのは
 * 個々の LoRA の強さで、法則は3件からは決められない。**3件すべてで安全だった
 * 0.6 を上限に採る**。最適値ではなく、壊れないことが確かめられた値である。
 *
 * 1本だけのレシピには掛けない。1.0 は Civitai の既定値で重ね合わせも起きず、
 * かつ手元に実行できる1本レシピが無く測れていないため（未検証の値を動かさない）。
 */
function capUnrecordedLoraStrengths(loras, recipe, warnings) {
    const resources = Array.isArray(loras) ? loras : [];
    if (resources.length < 2) return resources;
    // ユーザーがレシピ詳細で明示的に調整した強度は「既定で埋めた値」ではない。
    // 1本でも調整があれば、そのセットはユーザーの意思として尊重する。
    if (resources.some(lora => lora?.user_override)) return resources;
    if (loraWeightsAreRecorded(recipe, resources)) return resources;

    const strengths = resources.map(lora => getLoraStrengths(lora));
    const peak = Math.max(...strengths.map(item => Math.max(item.model, item.clip)));
    const total = strengths.reduce((sum, item) => sum + Math.max(item.model, item.clip), 0);
    if (!Number.isFinite(peak) || peak <= 0) return resources;

    // **一律に切り落とさず、セット全体へ同じ倍率を掛ける。**
    // 個別にクランプすると 1.0/0.5/0.3 が 0.6/0.5/0.3 になり、
    // 作者が意図した本同士の比が崩れる。倍率なら比が残る。
    //
    // 上限は2つ課す。**1本あたり**と**合計**で効く条件が違うため、
    // どちらか片方だけでは4件の実測すべてを満たせなかった:
    //
    //   95077448 (3本) 1.0で最良・0.6では細部不足     → 1本あたり 0.85 で通る
    //   93089381 (3本) 1.0で破綻・0.85以下で成立      → 1本あたり 0.85 で通る
    //   98385997 (2本) 1.0で暗く濁る・0.85以下で成立  → 1本あたり 0.85 で通る
    //   54095009 (13本) 0.85でも崩れ・0.6で成立       → 合計 8 で 0.62倍まで下がる
    //
    // 本数では説明できない（同じ3本で 1.0 の可否が割れる）ので、
    // 「1本が支配しない」かつ「モデルへの総摂動が予算を超えない」の2条件にする。
    const scale = Math.min(
        UNRECORDED_LORA_PEAK_CAP / peak,
        UNRECORDED_LORA_SUM_BUDGET / Math.max(total, 1e-9),
        1
    );
    if (scale >= 1) return resources;

    const result = resources.map((lora, index) => ({
        ...lora,
        strength_model: Math.round(strengths[index].model * scale * 1000) / 1000,
        strength_clip: Math.round(strengths[index].clip * scale * 1000) / 1000,
    }));

    if (Array.isArray(warnings)) {
        const reason = (UNRECORDED_LORA_SUM_BUDGET / Math.max(total, 1e-9))
            < (UNRECORDED_LORA_PEAK_CAP / peak)
            ? t('core.recipeWorkflowBuilder.14', { p1: UNRECORDED_LORA_SUM_BUDGET })
            : t('core.recipeWorkflowBuilder.15', { p1: UNRECORDED_LORA_PEAK_CAP });
        warnings.push(
            t('core.recipeWorkflowBuilder.16', { p1: resources.length, p2: peak, p3: reason, p4: scale.toFixed(2) })
        );
    }
    return result;
}

/** グラフに記録された per-LoRA の強度をレシピの素材へ写す。 */
function applyStackLoraStrengths(loras, stack) {
    const resources = Array.isArray(loras) ? loras : [];
    if (!stack || stack.loraStrengths.size === 0 || resources.length === 0) return resources;
    return resources.map(lora => {
        const versionId = Number(lora?.modelVersionId ?? lora?.id);
        const recorded = stack.loraStrengths.get(versionId);
        if (!recorded) return lora;
        return {
            ...lora,
            ...(recorded.model === null ? {} : { strength_model: recorded.model }),
            ...(recorded.clip === null ? {} : { strength_clip: recorded.clip }),
        };
    });
}

function applyA1111LoraWeights(loras, parameters) {
    const resources = Array.isArray(loras) ? loras : [];
    if (!parameters || resources.length === 0) return resources;

    const match = parameters.match(/(?:^|[,\n]\s*)lora\s*weights\s*:\s*"([^"]+)"/i);
    if (!match) return resources;
    const weights = match[1].split(',').map(value => Number(value.trim()));
    if (weights.length !== resources.length || weights.some(value => !Number.isFinite(value))) {
        return resources;
    }
    return resources.map((lora, index) => ({ ...lora, weight: weights[index] }));
}

/**
 * Forge は外部VAEを `VAE:` ではなく **`Module N:` 欄**へ書く。
 *
 * `Module N:` を読む箇所は製品に1つも無く（2026-08-19 に grep で確認）、
 * 指定された外部VAEは黙って無視されて**チェックポイントの焼き込みVAE**へ落ちていた。
 * SDXL の外部VAE（sdxl-vae / fp16-fix）と焼き込みVAEでは彩度と色被りが違う。
 *
 * **`AddNet Module N:` と `Hires Module N:` を拾わないこと。** 前者は
 * sd-webui-additional-networks（値は `LoRA`）、後者は hires 段のUI欄（値は
 * `Use same choices`）で、どちらも外部VAEではない。行頭かカンマ直後に限定する。
 *
 * **VAE 以外のモジュールを拾わないこと。** 同じ欄にテキストエンコーダ
 * （`t5xxl_fp16` / `clip_l` / `qwen_3_06b_base`）も書かれる。名前に `vae` を
 * 含むものだけを候補にする。
 */
function moduleVaeNames(recipe) {
    const params = findA1111Parameters(recipe);
    if (!params) return [];
    return [...String(params).matchAll(/(?:^|[,\n]\s*)Module \d+:\s*([^,\n]+)/g)]
        .map(match => match[1].trim())
        .filter(value => value && /vae/i.test(value));
}

function recipeVaeName(recipe, options = null, warnings = null) {
    const gen = recipe?.gen_params || {};
    const direct = filenameFromName(
        gen.vae || gen.vae_name || parameterValue(findA1111Parameters(recipe), 'VAE')
    );
    if (direct) {
        /*
         * **記録された `VAE:` も「導入済みだと確かめられたとき」だけ使う。**
         *
         * 下の `Module N:` 経路には既にこの判定があるのに、**直接指定の側には無かった**。
         * 2026-08-19 実測: `135983323` の記録は `VAE: illustriousXLV20_v10.safetensors` で、
         * これは**チェックポイント名**である（Forge は焼き込みVAEをこう書く）。
         * そのまま VAELoader へ渡すと ComfyUI が `value_not_in_list` を返し、
         * **プロンプト全体が拒否される**——そのノードだけ落ちるのではない。
         * 全346レシピで同じ理由の拒否が3件あった（`135983323` / `3969838` / `5017014`）。
         *
         * 落ちるくらいなら焼き込みVAEのままの方がまし（絵は出る）。判定できないとき
         * （`objectInfo` を渡さない呼び出し）は従来どおりそのまま返す。
         *
         * **UNet単体系統では落とさない。** Qwen / Flux はチェックポイントが無く、
         * VAE を空にすると焼き込みへ落ちる先が無い。この系統は別経路
         * （`architecture.vaeName`）が正で、そちらは `options` 無しで呼ばれるため
         * ここには来ない。念のため明示的に除外しておく。
         */
        const choices = nodeChoices(options?.objectInfo, 'VAELoader', 'vae_name');
        const checkable = Array.isArray(choices) && choices.every(choice => typeof choice === 'string');
        if (!checkable || unetArchitecture(recipe) || nameIsInstalled(choices, direct)) return direct;
        if (Array.isArray(warnings)) {
            warnings.push(
                t('core.recipeWorkflowBuilder.17', { p1: direct })
            );
        }
        return '';
    }

    /*
     * **`Module N:` 由来は「導入済みだと確かめられたとき」だけ使う。**
     *
     * 2026-08-19 実測: `101756637` の記録は `sdxlVAE_sdxlVAE` だが手元に無く、
     * そのまま渡したら ComfyUI が `value_not_in_list` で**投入ごと拒否**した。
     * 落ちるくらいなら焼き込みVAEのままの方がまし（絵は出る）。
     *
     * `objectInfo` を渡せない呼び出し（`unetArchitecture`）では **`Module N:` を使わない**。
     * Qwen / Flux は `architecture.vaeName` が正で、そこを動かすと
     * 「当たるのは SDXL の2件だけ」という安全条件を破る。
     */
    /*
     * **UNet単体系統では `Module N:` を使わない。**
     *
     * 2026-08-19 実測: Qwen の記録は `Module 1: qwen_image_vae` で、これは名前に `vae` を
     * 含み導入もされているため素通りし、**architecture 由来の VAELoader に加えて2本目が生えた**
     * （VAELoader が 1→2 本）。候補の安全条件「動くのは SDXL の2件だけ」を破る。
     * この系統は `architecture.vaeName` が正しい出所なので、記録側を足す余地が無い。
     */
    if (unetArchitecture(recipe)) return '';
    const choices = nodeChoices(options?.objectInfo, 'VAELoader', 'vae_name');
    if (!choices || !choices.every(choice => typeof choice === 'string')) return '';
    for (const requested of moduleVaeNames(recipe)) {
        const hit = choices.find(choice => nameIsInstalled([choice], requested));
        if (hit) {
            if (Array.isArray(warnings)) {
                warnings.push(t('core.recipeWorkflowBuilder.18', { p1: requested, p2: hit }));
            }
            return hit;
        }
        if (Array.isArray(warnings)) {
            warnings.push(
                t('core.recipeWorkflowBuilder.19', { p1: requested })
            );
        }
    }
    return '';
}

/**
 * UNet単体で配られるモデルの構成表。
 *
 * `CheckpointLoaderSimple` は `models/checkpoints` しか見ない。Anima のように
 * UNet・テキストエンコーダ・VAE が別ファイルで配られるモデルは
 * `models/unet` に入るので、チェックポイントとして読もうとすると
 * **導入済みなのに「未導入モデル」**と判定される。
 *
 * 実測（2026-08-10 / 全346レシピ）: この形が16件あった
 * （Anima 5 / Krea 2 4 / ZImageTurbo 1 ほか）。`anima_baseV10.safetensors` は
 * `ComfyUI/models/unet/Anima/anime/` に実在するのに不足扱いだった。
 *
 * 構成は**推測せず、同じ系統のレシピが持つ実際のワークフローから採る**。
 * Anima は3件の comfy_prompt がいずれも
 * UNETLoader + CLIPLoader(qwen_3_06b_base) + VAELoader(qwen_image_vae) だった。
 * CLIP の `type` だけは記録が割れており（qwen_image 1件 / stable_diffusion 2件）、
 * Qwen-Image 系として正しい `qwen_image` を採る。
 *
 * Krea 2 / ZImageTurbo は手元に実物の構成が無いので表に入れない。
 * 憶測で足すと、動かないグラフを「再現できる」と表示することになる。
 */
const UNET_ARCHITECTURES = [
    {
        family: /anima/i,
        clipName: 'qwen_3_06b_base.safetensors',
        clipType: 'qwen_image',
        vaeName: 'qwen_image_vae.safetensors',
    },
    // Krea 2 / Z-Image は Civitai 側が拡散モデルしか配らないので、構成は
    // Comfy-Org の公式再梱包と ComfyUI 本体のソースから採った。
    //   Comfy-Org/Krea-2        → text_encoders/qwen3vl_4b_bf16 + vae/qwen_image_vae
    //   Comfy-Org/z_image_turbo → split_files/text_encoders/qwen_3_4b + vae/ae
    // type は comfy/sd.py の分岐が根拠。KREA2 は QWEN3VL_4B との組でのみ成立し
    // （:1633）、Z-Image は QWEN3_4B なら flux 系以外のどの type でも
    // z_image のトークナイザへ落ちる（:1599-1605）。
    {
        family: /krea\s*2/i,
        clipName: 'qwen3vl_4b_bf16.safetensors',
        clipType: 'krea2',
        vaeName: 'qwen_image_vae.safetensors',
    },
    {
        family: /z[\s_-]*image/i,
        clipName: 'qwen_3_4b.safetensors',
        // 公式テンプレート image_z_image.json は `lumina2` を指定する。
        // comfy/sd.py:1599-1605 を読む限り QWEN3_4B は flux 系以外のどの type でも
        // 同じトークナイザへ落ちるが、検証済みの値に揃える。
        clipType: 'lumina2',
        vaeName: 'ae.safetensors',
        latentClass: 'EmptySD3LatentImage',
    },
    // Qwen-Image と Chroma は ComfyUI 同梱の公式テンプレートで
    // `ModelSamplingAuraFlow` を挟んでいる（image_qwen_image.json は shift 3.1、
    // image_chroma_text_to_image.json は 1）。省くと出力が変わるので、
    // 表に shift を持たせて再現側でも挟む。
    {
        family: /^qwen/i,
        clipName: 'qwen_2.5_vl_7b_fp8_scaled.safetensors',
        clipType: 'qwen_image',
        vaeName: 'qwen_image_vae.safetensors',
        modelSamplingShift: 3.1,
        latentClass: 'EmptySD3LatentImage',
    },
    // HiDream はエンコーダ4本を QuadrupleCLIPLoader で読む
    // （公式テンプレート hidream_i1_dev.json / hidream_i1_fast.json）。
    {
        family: /hidream/i,
        clipNames: [
            'clip_l_hidream.safetensors',
            'clip_g_hidream.safetensors',
            't5xxl_fp8_e4m3fn_scaled.safetensors',
            'llama_3.1_8b_instruct_fp8_scaled.safetensors',
        ],
        vaeName: 'ae.safetensors',
        latentClass: 'EmptySD3LatentImage',
    },
    {
        family: /chroma/i,
        clipName: 't5xxl_fp8_e4m3fn_scaled.safetensors',
        clipType: 'chroma',
        vaeName: 'ae.safetensors',
        modelSamplingShift: 1,
        latentClass: 'EmptySD3LatentImage',
    },
];

function unetArchitecture(recipe) {
    const checkpoint = recipe?.checkpoint || {};
    const family = [recipe?.base_model, checkpoint.baseModel, checkpoint.base_model]
        .find(value => typeof value === 'string' && value.trim()) || '';
    const entry = UNET_ARCHITECTURES.find(item => item.family.test(family));
    if (!entry) return null;

    // **手元に無くても系統で決める。**
    // 以前は「実際に unet 側へ置かれているか」を条件にしていたが、それだと
    // まだ落としていない新規ユーザーには UNet 構成が組まれず、不足が
    // チェックポイント1件しか出ない。落とした後で初めてテキストエンコーダが
    // 現れるので、**ダウンロードが2往復になり、最初に表示される総容量も過少**
    // になる（実測 2026-08-10 / Krea 2: 12GB と表示され、実際は +8.3GB 必要）。
    //
    // どこへ落ちるかはバックエンドが既に系統で決めている
    // （`DIFFUSION_MODEL_BASE_MODELS` に Anima / Krea 2 / ZImageTurbo がある）ので、
    // 判定の根拠を揃える。
    //
    // ただし**実物が checkpoints 側に在るならそちらを信じる**。利用者が
    // 単一チェックポイント版を持っている場合まで UNet 構成にはしない。
    const path = String(checkpoint.localPath || '').replaceAll('\\', '/').toLowerCase();
    if (path && /\/checkpoints\//.test(path)) return null;
    return entry;
}

/**
 * 標準構成のチェックポイント読み込みを、UNet3点セットへ差し替える。
 *
 * 実物（Anima 3件の comfy_prompt）は、ローダ以外は標準構成と同じ形だった
 * （EmptyLatentImage + CLIPTextEncode + KSampler + VAEDecode、guidance ノード無し）。
 * なので土台は流用し、`['1',0]=MODEL / ['1',1]=CLIP / ['1',2]=VAE` の参照だけ
 * 新しい3ノードへ繋ぎ替える。
 */
function applyUnetArchitecture(prompt, recipe, warnings) {
    const architecture = unetArchitecture(recipe);
    if (!architecture || !prompt?.['1']) return;
    const unetName = getResourceFilename(recipe?.checkpoint, 'Diffusion Model')
        || getResourceFilename(recipe?.checkpoint, 'Model');
    if (!unetName) return;

    const clipId = nextNodeId(prompt);
    const vaeId = String(Number(clipId) + 1);
    prompt['1'] = {
        inputs: { unet_name: unetName, weight_dtype: 'default' },
        class_type: 'UNETLoader',
        _meta: { title: 'Load Diffusion Model' },
    };
    // エンコーダが複数要る系統（HiDream）は QuadrupleCLIPLoader で読む。
    prompt[clipId] = Array.isArray(architecture.clipNames)
        ? {
            inputs: Object.fromEntries(
                architecture.clipNames.map((name, index) => [`clip_name${index + 1}`, name])
            ),
            class_type: 'QuadrupleCLIPLoader',
            _meta: { title: 'QuadrupleCLIPLoader' },
        }
        : {
            inputs: { clip_name: architecture.clipName, type: architecture.clipType, device: 'default' },
            class_type: 'CLIPLoader',
            _meta: { title: 'Load CLIP' },
        };
    prompt[vaeId] = {
        inputs: { vae_name: recipeVaeName(recipe) || architecture.vaeName },
        class_type: 'VAELoader',
        _meta: { title: 'Load VAE' },
    };
    /*
     * **記録された `Shift:` を読む案は撤回した（2026-08-19・実測）。**
     *
     * 記録に `Shift: 3` を持つ3件へ `ModelSamplingAuraFlow(shift=3.0)` を挿して撮ったが、
     * **3件とも画素が完全一致**した（`two_builder_metrics_2026-08-19.json`）。
     * 現行はこのノードを挿しておらず、挿しても絵が動かない
     * ＝ **モデル自身の既定シフトが既に記録値と同じ**。
     * `improvement_deadends_2026-08-18.json` の同じ趣旨の記録が正しかった。
     *
     * **graph hash が変わったことを効果の証拠にしない。** ここでそれを踏んだ。
     */
    const samplingId = architecture.modelSamplingShift ? String(Number(vaeId) + 1) : null;
    for (const node of Object.values(prompt)) {
        for (const [key, value] of Object.entries(node?.inputs || {})) {
            if (!Array.isArray(value) || String(value[0]) !== '1') continue;
            if (Number(value[1]) === 1) node.inputs[key] = [clipId, 0];
            else if (Number(value[1]) === 2) node.inputs[key] = [vaeId, 0];
            else if (samplingId) node.inputs[key] = [samplingId, 0];
        }
    }
    if (samplingId) {
        prompt[samplingId] = {
            inputs: { model: ['1', 0], shift: architecture.modelSamplingShift },
            class_type: 'ModelSamplingAuraFlow',
            _meta: { title: 'ModelSamplingAuraFlow' },
        };
    }
    // latent の種別も系統で決まる（実測: Qwen-Image / Chroma / Z-Image / HiDream の
    // 公式テンプレートはいずれも EmptySD3LatentImage）。
    if (architecture.latentClass) {
        for (const node of Object.values(prompt)) {
            if (/^empty.*latentimage$/i.test(String(node?.class_type).replace(/[^a-z0-9]/gi, ''))) {
                node.class_type = architecture.latentClass;
            }
        }
    }
    if (Array.isArray(warnings)) {
        // **エンコーダは1本とは限らない。** HiDream は4本を QuadrupleCLIPLoader で
        // 読むので `clipNames` を持ち `clipName` は無い。グラフ側は両方を見ているのに
        // ここだけ単数しか見ておらず、利用者向けの文言が
        // 「テキストエンコーダ（undefined）」になっていた（実測1件）。
        const clipNames = Array.isArray(architecture.clipNames)
            ? architecture.clipNames
            : [architecture.clipName].filter(Boolean);
        warnings.push(
            t('core.recipeWorkflowBuilder.20', { p1: unetName, p2: clipNames.join(t('core.sep.list')), p3: architecture.vaeName })
        );
    }
}

function isFluxRecipe(recipe) {
    const checkpoint = recipe?.checkpoint || {};
    const declaredFamily = [
        recipe?.base_model,
        checkpoint.baseModel,
        checkpoint.base_model,
    ].find(value => typeof value === 'string' && value.trim());
    if (declaredFamily) return declaredFamily.toLowerCase().includes('flux');

    const fallbackIdentity = [
        checkpoint.name,
        checkpoint.localPath,
        recipe?.gen_params?.model,
    ].filter(Boolean).join(' ').toLowerCase();
    return fallbackIdentity.includes('flux');
}

/**
 * Flux.1 と Flux.2 は別物。同じ構成で組んではいけない。
 *
 * `isFluxRecipe` は名前に "flux" が入れば真なので、**Flux.2 のレシピにも
 * Flux.1 の構成（t5xxl + clip_l の DualCLIPLoader・`ae.safetensors`）が
 * 当たっていた**（実測 2026-08-10 / Flux.2 D・Flux.2 Klein 4B）。
 *
 * ComfyUI 同梱の公式テンプレート `image_flux2.json` によると Flux.2 は
 *   CLIPLoader(mistral_3_small_flux2_bf16.safetensors, type=flux2)   ← 単体
 *   VAELoader(flux2 専用VAE)
 *   EmptyFlux2LatentImage                                            ← 専用latent
 *   FluxGuidance                                                     ← これは共通
 * で、エンコーダもVAEもlatentノードも Flux.1 と違う。
 */
function fluxVariant(recipe) {
    if (!isFluxRecipe(recipe)) return null;
    const checkpoint = recipe?.checkpoint || {};
    // **宣言された系統が最優先。** ファイル名まで一緒くたに見ると、
    // `Flux.1 D` のレシピが `flux2-dev.safetensors` を指しているだけで
    // Flux.2 判定になる（実際にその取り違えを一度作った）。
    const declaredFamily = [
        recipe?.base_model,
        checkpoint.baseModel,
        checkpoint.base_model,
    ].find(value => typeof value === 'string' && value.trim());
    if (declaredFamily) {
        return /flux[\s._-]*2/i.test(declaredFamily) ? 'flux2' : 'flux1';
    }

    const fallbackIdentity = [checkpoint.name, checkpoint.localPath, recipe?.gen_params?.model]
        .filter(Boolean).join(' ').toLowerCase();
    return /flux[\s._-]*2/.test(fallbackIdentity) ? 'flux2' : 'flux1';
}

function requiresStructuredA1111(parameters) {
    if (typeof parameters !== 'string' || !parameters.trim()) return false;
    const size = parameterValue(parameters, 'Size');
    if (!parseSize(size)) return true;
    return [
        /\bVersion\s*:\s*ComfyUI\b/i,
        /\bVAE\s*:/i,
        /\bHires (?:upscale|upscaler|steps)\s*:/i,
        /\bADetailer\b/i,
        /\bTiled Diffusion\b/i,
        /\b(?:FreeU|Refiner|AutomaticVAE|LoRA\s*weights|MultiDiffusion|PAG|Segment)\b/i,
        /<segment\b/i,
        /\bworkflow\s*:/i,
        /\(None,?\)x\(None,?\)/i,
    ].some(pattern => pattern.test(parameters));
}

/**
 * 「元は img2img の出力」を示す形かどうか。
 *
 * A1111 は hires を有効にしたときだけ `Hires upscale` / `Hires resize` を
 * 書く。したがって **`Denoising strength` があるのに Hires 系が無い**なら
 * `enable_hr=False`、つまり **入力画像に対する img2img** の記録である。
 * そこに記録された `Size` は入力画像を経た**出力**の寸法で、白紙から
 * 1段で引ける実績ではない。実測 27件（a1111_parameters を持つ312件中）。
 *
 * 入力画像そのものは残っていないので再現はできない。**黙って白紙から
 * 引くのをやめ、一致しないことを明示する**のがここでできる正しいこと。
 */
function looksLikeImg2ImgOutput(parameters) {
    if (typeof parameters !== 'string' || !parameters.trim()) return false;
    if (!/\bDenoising strength\s*:/i.test(parameters)) return false;
    return !/\bHires (?:upscale|resize)\s*:/i.test(parameters);
}

function a1111CompatibilityFeatures(parameters) {
    const patterns = [
        ['VAE', /\bVAE\s*:/i],
        ['hires', /\bHires (?:upscale|upscaler|steps|resize)\s*:/i],
        ['img2img', /\bDenoising strength\s*:/i],
        ['ADetailer', /\bADetailer\b/i],
        ['Tiled Diffusion', /\bTiled Diffusion\b/i],
        ['FreeU', /\bFreeU\b/i],
        ['Refiner', /\bRefiner\b/i],
        ['LoRA weights', /\bLoRA\s*weights\b/i],
        ['Segment', /(?:\bSegment\b|<segment\b)/i],
        ['PAG', /\bPAG\b/i],
    ];
    return patterns.filter(([, pattern]) => pattern.test(parameters || '')).map(([label]) => label);
}

/**
 * 最後の段が大きすぎるとき、比率を保って縮める（2026-08-25 利用者の指示）。
 *
 * **記録どおりの寸法では復号できない機械が在る。** 実測（`civitai_87384188`）:
 * 2段目 2560x3712（約9.5メガピクセル）で、分割復号にしても VAE が
 * 読み込みと解放を往復して**進まなくなった**——`/interrupt` は効かず、
 * 再起動でしか戻らない。その記録では**絵が1枚も出ない。**
 *
 * **小さくても出るほうが、出ないより使える。** ただし記録より小さいので、
 * **縮めたことは必ず言う**（黙って縮めると、次に比べたときの差が説明できない）。
 *
 * `maxPixels` が 0 以下・数でない場合は**何もしない**（縮めない選択）。
 *
 * @returns {boolean} 縮めたか
 */
function capReplayPixels(prompt, maxPixels, warnings) {
    const cap = Number(maxPixels);
    if (!Number.isFinite(cap) || cap <= 0) return false;

    const decode = Object.values(prompt)
        .find(node => String(node?.class_type || '') === 'VAEDecodeTiled');
    if (!decode) return false;

    // 縮める相手は**画素で寸法を持っている節**。潜在の側を触ると、
    // 途中の段と食い違って繋がらなくなる。
    const scaler = Object.values(prompt)
        .filter(node => Number(node?.inputs?.width) > 0 && Number(node?.inputs?.height) > 0)
        .sort((a, b) => (b.inputs.width * b.inputs.height) - (a.inputs.width * a.inputs.height))[0];
    if (!scaler) return false;

    const width = Number(scaler.inputs.width);
    const height = Number(scaler.inputs.height);
    const pixels = width * height;
    if (pixels <= cap) return false;

    // **8の倍数へ落とす。** 潜在は 1/8 なので、半端だと段の途中で丸められる。
    const ratio = Math.sqrt(cap / pixels);
    const round8 = (value) => Math.max(8, Math.round((value * ratio) / 8) * 8);
    const nextWidth = round8(width);
    const nextHeight = round8(height);
    scaler.inputs.width = nextWidth;
    scaler.inputs.height = nextHeight;

    // 収まったので、**分割せずに復号する**（分割こそが止まる形だった）。
    decode.class_type = 'VAEDecode';
    for (const key of ['tile_size', 'overlap', 'temporal_size', 'temporal_overlap']) {
        delete decode.inputs[key];
    }
    if (decode._meta) decode._meta.title = 'VAE Decode';

    warnings.push(t('core.recipeWorkflowBuilder.cappedSize', {
        p1: width, p2: height, p3: nextWidth, p4: nextHeight,
    }));
    return true;
}

function vaeDecodeInputs(samples, vae, pixelCount) {
    if (pixelCount <= 4_500_000) return { inputs: { samples, vae }, class_type: 'VAEDecode' };
    return {
        inputs: {
            samples,
            vae,
            tile_size: 512,
            overlap: 64,
            temporal_size: 64,
            temporal_overlap: 8,
        },
        class_type: 'VAEDecodeTiled',
    };
}

/**
 * Civitai のジョブ記録は、使った拡大器を URN で書く。
 *
 * 実測（2026-08-10 / 346レシピ）: `generation_metadata.upscalers` に現れる URN は
 * 33件すべてが `civitai:147759@164821` で、Civitai API で照会すると
 * Upscaler「Remacri」の Original 版だった。ローカルには remacri_original.pth が
 * 導入済みで、ComfyUI の UpscaleModelLoader からも選べる。
 *
 * この欄を読まないと拡大器名が空文字になり、`usesPixelHiresUpscaler` が false を
 * 返して**単純な lanczos 拡大**へ落ちる。ESRGAN 系の拡大と lanczos では
 * 質感がはっきり違うので、元画像と見比べたときに差として出る。
 */
const CIVITAI_UPSCALER_BY_VERSION = new Map([
    ['164821', 'Remacri'],
]);

/**
 * 「記録されている数値」を順に探す。**未記録を 0 と読まない**ための関数。
 *
 * `Number(null)` も `Number('')` も 0 を返し、`Number.isFinite` は true を返す。
 * 素直に書くと未記録が 0 という有効値として通ってしまう。
 */
function firstRecordedNumber(...values) {
    for (const value of values) {
        if (value === null || value === undefined || value === '') continue;
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function recordedUpscalers(recipe) {
    const list = recipe?.generation_metadata?.upscalers;
    return Array.isArray(list) ? list : [];
}

function upscalerNameFromRecord(value) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    // 生のファイル名（ComfyUI グラフ由来）はそのまま使える。
    if (!/^urn:/i.test(text)) return text;
    const match = /civitai:(\d+)@(\d+)/i.exec(text);
    if (!match) return '';
    return CIVITAI_UPSCALER_BY_VERSION.get(match[2]) || '';
}

function hiresUpscalerName(recipe, warnings) {
    const direct = String(
        recipe?.gen_params?.hires_upscaler
        || parameterValue(findA1111Parameters(recipe), 'Hires upscaler')
        || ''
    ).trim();
    if (direct) return direct;

    // stack グラフ（`a1111_parameters` が JSON のもの）は拡大器をグラフの中にしか
    // 持たない。URN → 名前 → ローカル実体の対応は既にあるので、読み口だけ足す。
    const stackUpscaler = upscalerNameFromRecord(
        parseResourceStackGraph(findA1111Parameters(recipe))?.upscaler
    );
    if (stackUpscaler) return stackUpscaler;

    for (const entry of recordedUpscalers(recipe)) {
        const name = upscalerNameFromRecord(entry);
        if (name) return name;
        if (Array.isArray(warnings)) {
            warnings.push(
                t('core.recipeWorkflowBuilder.21', { p1: entry })
            );
        }
    }
    return '';
}

function usesPixelHiresUpscaler(name) {
    if (!name || /^(?:none|latent|nearest|nearest-exact|bilinear|bicubic|area|bislerp)$/i.test(name)) {
        return false;
    }
    return /(?:4x|esrgan|realesr|ultrasharp|remacri|swinir|upscal)/i.test(name);
}

/**
 * A1111 が書く拡大モデルの名前 → 配布ファイル名の**別名表**。
 *
 * ---
 *
 * **同じモデルが2つの名前を持っている。** A1111 は `R-ESRGAN 4x+ Anime6B` と書き、
 * 同じ物のファイル名は `RealESRGAN_x4plus_anime_6B.pth`。字面が違うので、
 * **手元に在るのに「未導入モデル」と判定されていた**——実測（2026-08-21）で
 * 記録346件のうち7件がこれだけを理由に「不足」に落ちており、
 * `R-ESRGAN 4x+ Anime6B` は不足モデル名の**第1位（6件）**だった。
 *
 * 表に無い名前は、下の `resolveInstalledUpscaler` が**手元の一覧と突き合わせて**探す。
 */
const UPSCALER_ALIASES = [
    [/^r[-_ ]?esrgan\s*4x\+?\s*anime\s*6?b$/i, 'RealESRGAN_x4plus_anime_6B'],
    [/^r[-_ ]?esrgan\s*4x\+?$/i, 'RealESRGAN_x4plus'],
    [/^r[-_ ]?esrgan\s*2x\+?$/i, 'RealESRGAN_x2'],
    [/remacri/i, 'remacri_original'],
];

/** 比較用に潰した名前（区切り・拡張子・大小を落とす）。 */
function upscalerKey(value) {
    return String(value || '')
        .replaceAll('\\', '/').split('/').pop()
        .replace(/\.(pth|safetensors|ckpt|bin|onnx)$/i, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

/**
 * 記録が指す拡大モデルを、**手元に在るファイル名**へ解決する。
 *
 * **見つからなければ null を返す。** 呼び手はそのとき拡大モデルを使わない道
 * （lanczos）へ倒す——**無い物を指すノードを組むと、ComfyUI が投入ごと拒む**ので、
 * 「少し違う絵が出る」ではなく「1枚も出ない」になってしまう。
 *
 * @param {string} name 記録に書かれた名前
 * @param {string[]|null} installed `/object_info` から採った導入済みの一覧
 */
function resolveInstalledUpscaler(name, installed) {
    const wanted = String(name || '');
    if (!wanted) return null;
    const list = Array.isArray(installed) ? installed : [];
    const byKey = new Map(list.map(item => [upscalerKey(item), item]));

    // 1. そのまま（拡張子・フォルダ違いも潰して見る）
    const direct = byKey.get(upscalerKey(wanted));
    if (direct) return direct;

    // 2. 別名表
    for (const [pattern, canonical] of UPSCALER_ALIASES) {
        if (!pattern.test(wanted.trim())) continue;
        const found = byKey.get(upscalerKey(canonical));
        if (found) return found;
    }

    // 3. 手元が判らないなら、名前をそのまま渡す（今までの挙動）。
    //    **判っていて見つからなかったときだけ null。**
    if (list.length === 0) return wanted;
    return null;
}

function embeddedPromptNeedsRebuild(prompt, recipe) {
    if (!isFluxRecipe(recipe)) return false;
    const hasCheckpointLoader = Object.values(prompt).some(
        node => normalizedClassType(node?.class_type) === 'checkpointloadersimple'
    );
    const path = String(recipe?.checkpoint?.localPath || '').replaceAll('\\', '/').toLowerCase();
    return hasCheckpointLoader && (path.includes('/diffusion_models/') || path.includes('/unet/'));
}

function inlineLegacyConstants(prompt, warnings) {
    const replacements = new Map();
    for (const [id, node] of Object.entries(prompt)) {
        const type = normalizedClassType(node?.class_type);
        if (!['int', 'float', 'string'].includes(type)) continue;
        const raw = node?.inputs?.Number ?? node?.inputs?.number ?? node?.inputs?.value
            ?? node?.inputs?.String ?? node?.inputs?.string;
        let value = raw;
        if (type === 'int') value = Number.parseInt(raw, 10);
        if (type === 'float') value = Number.parseFloat(raw);
        if ((type === 'int' || type === 'float') && !Number.isFinite(value)) continue;
        replacements.set(String(id), value);
    }
    if (replacements.size === 0) return;
    for (const node of Object.values(prompt)) {
        for (const [key, value] of Object.entries(node?.inputs || {})) {
            if (Array.isArray(value) && replacements.has(String(value[0]))) {
                node.inputs[key] = replacements.get(String(value[0]));
            }
        }
    }
    for (const id of replacements.keys()) delete prompt[id];
    warnings.push(t('core.recipeWorkflowBuilder.22', { p1: replacements.size }));
}

// Civitai/A1111 use -1 to mean "random seed".  ComfyUI validates sampler
// seeds as unsigned integers, so pass a safe non-negative value instead.
function normalizeSeed(value, fallback = 0) {
    const seed = Number(value);
    if (!Number.isFinite(seed) || seed < 0) return fallback;
    return Math.trunc(seed);
}

/**
 * `generation_metadata.workflow` のラベルから hires 段を復元する。
 *
 * **実測: `img2img-hires`(18) / `txt2img-hires`(3) / `img2img-upscale`(1) /
 * `img2img:hires-fix`(1) の計23件で、`gen_params.hires_upscale` が全件空。**
 * ラベルには「拡大して描き直した」と書いてあるのに、再現は必ず単段になっていた。
 * ベンチでも B_hires_label の層だけ帯域比が 0.336〜1.709 と広く割れる。
 *
 * 記録されているもの: 段の存在（ラベル）と、17/23件の `denoise`。
 * 記録されていないもの: **倍率**。コーパスの `Hires upscale` 分布は
 * 1.5 が17件・2.0 が16件で拮抗しており、どちらとも決められない。
 * 画素数が4倍になる 2.0 は OOM の危険が高いので **1.5 を採り、推定である旨を
 * 警告へ出す**。最適値ではなく安全側の既定である。
 *
 * プレビューは**最終出力**なので、そこから推定した寸法は最終側にあたる。
 * よって **1段目は最終 ÷ 倍率**にする。最終寸法は動かさずに段だけが増える。
 */
const HIRES_LABEL_PATTERN = /(?:hires|upscale)/i;
const ESTIMATED_HIRES_SCALE = 1.5;

/**
 * 2段目（拡大して描き直す工程）があったかを、記録から判定する。
 *
 * 以前は `workflow` ラベルが `hires` / `upscale` を含むかだけを見ていた。
 * **実測（2026-08-10 / 346レシピ）**: 2段目の証拠を持つのは46件だが、
 * ラベルに出るのは23件で、**ちょうど半分を取りこぼしていた**
 * （87384187・87945242・87384188・76279046 などが該当）。
 *
 * ラベルが無くても、Civitai のジョブ記録には拡大器（`upscalers`）と
 * `denoise` が残っている。ただし **`denoise` がちょうど 1 の6件は別物**で、
 * そちらは拡大器名が URN ではなく生のファイル名（RealESRGAN_x4plus_anime_6B.pth 等）＝
 * ComfyUI グラフから抽出したメタであり、1段目の KSampler の denoise が写っているだけ。
 * 2段目を足す根拠にはならないので `denoise < 1` を条件に入れて切り分ける。
 *
 * 拡大器を条件に含めるのは寸法の解釈のためでもある。拡大器の無い img2img
 * （実測1件・99248640 / 1280x1856 / denoise 0.65）は**元画像と同寸法の描き直し**で、
 * 記録寸法を「1段目」と読んで拡大すると寸法が二重に増える。
 */
function hiresLabelHint(recipe) {
    const meta = recipe?.generation_metadata;
    if (!meta || typeof meta !== 'object') return null;
    const rawDenoise = Number(meta.denoise);
    const denoise = Number.isFinite(rawDenoise) ? rawDenoise : null;

    const label = meta.workflow;
    if (typeof label === 'string' && HIRES_LABEL_PATTERN.test(label)) {
        return { label, denoise };
    }

    if (denoise === null || denoise >= 1) return null;
    if (recordedUpscalers(recipe).length === 0) return null;
    const shown = typeof label === 'string' && label ? label : t('core.recipeWorkflowBuilder.23');
    return { label: t('core.recipeWorkflowBuilder.24', { p1: shown, p2: denoise }), denoise };
}

/**
 * 返り値: { size, hiresScale, denoise } — hires を足さない場合は size のみ元のまま。
 */
function applyHiresLabelHint(recipe, gen, size, warnings, options = {}) {
    const recorded = Number(gen?.hires_upscale);
    if (Number.isFinite(recorded) && recorded > 1) return { size, hiresScale: recorded, denoise: null };

    const hint = hiresLabelHint(recipe);
    if (!hint || !size) return { size, hiresScale: null, denoise: null };

    // **推定倍率を外から差し替えられるようにしてある（既定は不変）。**
    //
    // `ESTIMATED_HIRES_SCALE = 1.5` は「コーパスで 1.5:17件 / 2.0:16件と拮抗しており、
    // OOM を避けて安全側を採った」値で、**最適値ではない**と上のコメントが明記している。
    // 件ごとにどちらが近いかを実測するには倍率だけを振る必要がある。
    //
    // **`gen.hires_upscale` へ 2.0 を注入する方法は使えない。** 上の早期 return が
    // `denoise: null` を返すので、**倍率と denoise の2軸が同時に動く**。
    // 測りたい軸だけを反転するには、ここで差し替える。
    //
    // **優先順位は「実験 > 保存された決定 > 既定」。**
    // `options.hiresScale` は掃引が値を強制するための入口なので、保存済みの上書きより強い
    // （そうしないと、既に上書きが入っている件だけ掃引が空振りする）。
    // `replay_overrides` の `hires_scale` は、件ごとに人間が確かめて保存した決定である。
    const savedScale = Number(replayOverrideValue(recipe, 'hires_scale'));
    const scale = Number.isFinite(Number(options.hiresScale)) && Number(options.hiresScale) > 1
        ? Number(options.hiresScale)
        : (Number.isFinite(savedScale) && savedScale > 1 ? savedScale : ESTIMATED_HIRES_SCALE);
    if (Number.isFinite(savedScale) && savedScale > 1
        && !(Number.isFinite(Number(options.hiresScale)) && Number(options.hiresScale) > 1)
        && Array.isArray(warnings)) {
        warnings.push(
            t('core.recipeWorkflowBuilder.25', { p1: savedScale })
        );
    }

    // **記録寸法は「最終」ではなく「1段目」。**
    //
    // 以前はプレビュー画像が最終出力であることを根拠に、記録寸法を最終と読んで
    // ÷1.5 を1段目にしていた。これは記録の意味を取り違えている。
    //
    // 一次資料（forge / modules/processing.py）:
    //   :751   `"Size": f"{p.width}x{p.height}"`      ← hires **前**の寸法を書く
    //   :1248  `hr_upscale_to_x = int(self.width * self.hr_scale)`  ← 最終は Size×倍率
    // Civitai のジョブ記録も同じで、**実測（2026-08-10）では sourceImage を持つ
    // 22件すべてが「ジョブ寸法 == sourceImage 寸法」**だった。sourceImage は
    // 2パス目の入力＝1段目の出力なので、記録寸法は1段目にあたる。
    //
    // 取り違えると 832x1216 のレシピで1段目が 552x808（0.45M画素）になる。
    // SDXL の学習域は約1M画素で、そこを大きく下回ると細部がそもそも生成されず、
    // あとから拡大しても戻らない。これが「質感が元画像と違う」の主因だった。
    //
    // 倍率だけは記録が無いため 1.5 の推定のまま（警告に明記する）。
    const finalWidth = snapToLatentGrid(size.width * scale);
    const finalHeight = snapToLatentGrid(size.height * scale);
    if (!finalWidth || !finalHeight) return { size, hiresScale: null, denoise: null };

    if (Array.isArray(warnings)) {
        warnings.push(
            t('core.recipeWorkflowBuilder.26', { p1: hint.label, p2: size.width, p3: size.height, p4: finalWidth, p5: finalHeight, p6: scale })
            + (hint.denoise === null ? '' : t('core.recipeWorkflowBuilder.27', { p1: hint.denoise }))
        );
    }
    return { size, hiresScale: scale, denoise: hint.denoise };
}

/**
 * img2img の記録寸法を、白紙から描き起こせる寸法へ落として2段構成にする。
 *
 * **実測（2026-08-10 / 30137354・16714245・29213825）**: 記録どおりの
 * 1248x1824 等を白紙から1段で描くと、頭が2つに割れる・胴が伸びるといった
 * 人体破綻が出た。シードを3通り振っても3件×3枚すべてで再現したので、
 * ガチャ外れではなく構造的。因子を切り分けると、
 *
 *   現状(1248x1824 + LoRA) → 破綻
 *   832x1216 へ縮小 + LoRA → **正常**
 *   1248x1824 で LoRA なし → 正常
 *
 * となり、**寸法が支配的**だった（LoRA は作者の意図なので外さない）。
 *
 * img2img の `Size` は入力画像を経た**出力**の寸法で、白紙から1段で
 * そこへ到達した実績ではない。元は「下絵 → 拡大 → 描き直し」なので、
 * こちらも同じ形（適正寸法で描く → 記録寸法へ拡大 → 記録の denoise で
 * 描き直す）にすれば、最終寸法を保ったまま破綻を避けられる。
 */
const SDXL_TRAINED_PIXELS = 1024 * 1024;

/**
 * 「入力画像から描き直した記録」であることの根拠を探す。
 *
 * 以前は A1111 の `Denoising strength:` という**文字列**だけを見ていた。
 * だが Civitai のジョブ記録はその文字列を持たず、入力画像を
 * `sourceImage`（ジョブ記録側）や resource-stack グラフの入力に置く。
 * **実測（2026-08-10 / 84033146）**: denoise 0.65 の入力画像つき記録なのに
 * この判定を素通りし、記録寸法 1280x1856（2.37M画素）を白紙から1段で
 * 描いていた。SDXL の学習域の2倍以上で、描き込み量が元と揃わない。
 */
function img2imgReconstructionEvidence(recipe) {
    const parameters = findA1111Parameters(recipe);
    if (looksLikeImg2ImgOutput(parameters)) {
        return { denoise: firstRecordedNumber(parameterValue(parameters, 'Denoising strength')) };
    }

    const stack = parseResourceStackGraph(parameters);
    const meta = recipe?.generation_metadata;
    const metaSource = meta && typeof meta === 'object' ? meta.sourceImage : null;
    if (!stack?.sourceImage && !metaSource) return null;
    return { denoise: firstRecordedNumber(stack?.denoise, meta?.denoise) };
}

function applyImg2ImgReconstruction(recipe, gen, hint, warnings) {
    // 既に2段（hires）が組まれるならそちらに任せる。段を二重に増やさない。
    if (hint.hiresScale) return hint;
    const size = hint.size;
    if (!size?.width || !size?.height) return hint;

    const evidence = img2imgReconstructionEvidence(recipe);
    if (!evidence) return hint;

    const pixels = size.width * size.height;
    if (pixels <= SDXL_TRAINED_PIXELS * 1.2) return hint;

    const scale = Math.sqrt(pixels / SDXL_TRAINED_PIXELS);
    const base = {
        width: snapToLatentGrid(size.width / scale),
        height: snapToLatentGrid(size.height / scale),
    };
    if (!base.width || !base.height) return hint;

    // A1111 由来のレシピは gen.denoising_strength を必ず持ち、そちらが優先される。
    // Civitai のジョブ記録は持たないので、記録側の denoise をここから渡す。
    const recordedDenoise = evidence.denoise;
    if (Array.isArray(warnings)) {
        warnings.push(
            t('core.recipeWorkflowBuilder.28', { p1: size.width, p2: size.height, p3: base.width, p4: base.height, p5: recordedDenoise ?? 0.35 })
        );
    }
    return { size: base, hiresScale: scale, denoise: recordedDenoise };
}

function standardPrompt(recipe, warnings, options = {}) {
    const gen = recipe?.gen_params || {};
    const resolvedSize = resolveTargetSize(recipe, gen, warnings);
    // ラベルだけが hires を示すレシピは、ここで1段目を縮めて2段構成へ回す。
    let hiresHint = applyHiresLabelHint(recipe, gen, resolvedSize, warnings, options);
    // img2img の記録寸法をそのまま白紙へ渡すと人体が壊れる。同じく2段へ回す。
    hiresHint = applyImg2ImgReconstruction(recipe, gen, hiresHint, warnings);
    const size = hiresHint.size;
    const diffusionName = getResourceFilename(recipe?.checkpoint, 'Diffusion Model')
        || filenameFromName(gen.model);
    const checkpointName = getResourceFilename(recipe?.checkpoint, 'Model')
        || filenameFromName(gen.model);
    const vaeName = recipeVaeName(recipe, options, warnings);
    const steps = Number.isFinite(Number(gen.steps)) ? Number(gen.steps) : 20;
    const cfg = Number.isFinite(Number(gen.cfg_scale)) ? Number(gen.cfg_scale) : 7;

    if (!checkpointName && !diffusionName) {
        throw new Error(t('core.recipeWorkflowBuilder.29'));
    }
    if (recipe?.generation_source === 'reconstructed' && !String(gen.prompt || '').trim()) {
        throw new Error(t('core.recipeWorkflowBuilder.30'));
    }

    const flux = fluxVariant(recipe);
    if (flux) {
        // Flux.2 はエンコーダ・VAE・latentノードが Flux.1 と違う
        // （公式テンプレート image_flux2.json より）。
        const isFlux2 = flux === 'flux2';
        const fluxVae = vaeName || (isFlux2 ? 'flux2-vae.safetensors' : 'ae.safetensors');
        const latentClass = isFlux2 ? 'EmptyFlux2LatentImage' : 'EmptySD3LatentImage';
        const clipLoader = isFlux2
            ? {
                inputs: {
                    // 公式テンプレートは bf16(35.6GB) と fp8(18.0GB) の2種。実用側を既定にする。
                    clip_name: 'mistral_3_small_flux2_fp8.safetensors',
                    type: 'flux2',
                    device: 'default',
                },
                class_type: 'CLIPLoader',
                _meta: { title: 'Load CLIP (Flux.2)' },
            }
            : {
                inputs: {
                    clip_name1: 't5xxl_fp8_e4m3fn_scaled.safetensors',
                    clip_name2: 'clip_l.safetensors',
                    type: 'flux',
                },
                class_type: 'DualCLIPLoader',
                _meta: { title: 'DualCLIPLoader' },
            };
        const decode = vaeDecodeInputs(['8', 0], ['3', 0], size.width * size.height);
        return {
            '1': {
                inputs: { unet_name: diffusionName, weight_dtype: 'default' },
                class_type: 'UNETLoader',
                _meta: { title: 'Load Diffusion Model' },
            },
            '2': clipLoader,
            '3': {
                inputs: { vae_name: fluxVae },
                class_type: 'VAELoader',
                _meta: { title: 'Load VAE' },
            },
            '4': {
                inputs: { text: gen.prompt || '', clip: ['2', 0] },
                class_type: 'CLIPTextEncode',
                _meta: { title: 'CLIP Text Encode (Positive Prompt)' },
            },
            '5': {
                inputs: { text: gen.negative_prompt || '', clip: ['2', 0] },
                class_type: 'CLIPTextEncode',
                _meta: { title: 'CLIP Text Encode (Negative Prompt)' },
            },
            '6': {
                inputs: { conditioning: ['4', 0], guidance: cfg || 3.5 },
                class_type: 'FluxGuidance',
                _meta: { title: 'Flux Guidance' },
            },
            '7': {
                inputs: { width: size.width, height: size.height, batch_size: 1 },
                class_type: latentClass,
                _meta: { title: isFlux2 ? 'Empty Flux.2 Latent Image' : 'Empty SD3 Latent Image' },
            },
            '8': {
                inputs: {
                    seed: normalizeSeed(gen.seed), steps, cfg: 1,
                    sampler_name: 'euler', scheduler: 'normal', denoise: 1,
                    model: ['1', 0], positive: ['6', 0], negative: ['5', 0],
                    latent_image: ['7', 0],
                },
                class_type: 'KSampler',
                _meta: { title: 'KSampler' },
            },
            '9': {
                ...decode,
                _meta: { title: decode.class_type === 'VAEDecodeTiled' ? 'VAE Decode (Tiled)' : 'VAE Decode' },
            },
            '10': {
                inputs: { filename_prefix: createRecipeWorkflowName(recipe), images: ['9', 0] },
                class_type: 'SaveImage',
                _meta: { title: 'Save Image' },
            },
        };
    }

    const decode = vaeDecodeInputs(['5', 0], ['1', 2], size.width * size.height);
    const prompt = {
        '1': {
            inputs: { ckpt_name: checkpointName },
            class_type: 'CheckpointLoaderSimple',
            _meta: { title: 'Load Checkpoint' },
        },
        '2': {
            inputs: { text: gen.prompt || '', clip: ['1', 1] },
            class_type: 'CLIPTextEncode',
            _meta: { title: 'CLIP Text Encode (Positive Prompt)' },
        },
        '3': {
            inputs: { text: gen.negative_prompt || '', clip: ['1', 1] },
            class_type: 'CLIPTextEncode',
            _meta: { title: 'CLIP Text Encode (Negative Prompt)' },
        },
        '4': {
            inputs: { width: size.width, height: size.height, batch_size: 1 },
            class_type: 'EmptyLatentImage',
            _meta: { title: 'Empty Latent Image' },
        },
        '5': {
            inputs: {
                seed: normalizeSeed(gen.seed),
                steps,
                cfg,
                sampler_name: 'euler',
                scheduler: 'normal',
                // This reconstructed graph is txt2img and starts from an empty
                // latent. A1111's denoising strength usually belongs to a
                // hires/img2img pass and produces a flat image here when < 1.
                denoise: 1,
                model: ['1', 0],
                positive: ['2', 0],
                negative: ['3', 0],
                latent_image: ['4', 0],
            },
            class_type: 'KSampler',
            _meta: { title: 'KSampler' },
        },
        '6': {
            ...decode,
            _meta: { title: decode.class_type === 'VAEDecodeTiled' ? 'VAE Decode (Tiled)' : 'VAE Decode' },
        },
        '7': {
            inputs: { filename_prefix: createRecipeWorkflowName(recipe), images: ['6', 0] },
            class_type: 'SaveImage',
            _meta: { title: 'Save Image' },
        },
    };

    if (vaeName) {
        prompt['8'] = {
            inputs: { vae_name: vaeName },
            class_type: 'VAELoader',
            _meta: { title: 'Load VAE' },
        };
        prompt['6'].inputs.vae = ['8', 0];
    }

    const hiresScale = Number(hiresHint.hiresScale ?? gen.hires_upscale);
    if (Number.isFinite(hiresScale) && hiresScale > 1) {
        const upscalerName = hiresUpscalerName(recipe, warnings);
        const hiresSamplerInputs = {
            ...prompt['5'].inputs,
            seed: normalizeSeed(gen.seed) + 1,
            steps: Number.isFinite(Number(gen.hires_steps)) ? Number(gen.hires_steps) : steps,
            cfg: Number.isFinite(Number(gen.hires_cfg_scale)) ? Number(gen.hires_cfg_scale) : cfg,
            // **null を 0 に化けさせない。**
            //
            // `Number(null)` は 0 で、`Number.isFinite(0)` は true。よって
            // denoise の記録が無いレシピ（hiresHint.denoise === null）では
            // 既定値 0.35 へ落ちず、**2段目の denoise が 0** になっていた。
            // denoise 0 の2段目は再描画を一切せず、拡大しただけの絵を返す。
            // 実測（2026-08-10 / 38650172・100654903）で両方とも 0 だった。
            denoise: firstRecordedNumber(gen.denoising_strength, hiresHint.denoise) ?? 0.35,
        };

        // **latent 空間で拡大しない。**
        //
        // A1111 の `Hires upscaler: Latent`（および None）を ComfyUI の
        // LatentUpscaleBy（bislerp）で再現すると、輪郭が溶けて虹色のにじみが出る。
        // 両者は実装が違い、A1111 で成立していた denoise 0.2〜0.25 では
        // ComfyUI 側のにじみを直しきれない。
        //
        // **実測（2026-08-10 / 43282673 / seed 111 固定）**: 同じ denoise 0.25 で
        //   latent 拡大 → 腕が肉塊化、リボンと手指が溶ける
        //   画素拡大（lanczos）→ 手指が描かれ、質感も戻る
        // 画素空間へ一度戻してから lanczos で拡大する方が元の見た目に近い。
        // **手元に在る名前へ解決する。** 無ければ拡大モデルを使わない道へ倒す
        // ——無い物を指すノードを組むと、ComfyUI が投入ごと拒んで**1枚も出ない**。
        // lanczos だけの拡大なら絵は出る（元とは少し違う＝「近似」）。
        const installedUpscalers = catalogChoices(options?.objectInfo, 'UpscaleModelLoader', 'model_name');
        const resolvedUpscaler = usesPixelHiresUpscaler(upscalerName)
            ? resolveInstalledUpscaler(upscalerName, installedUpscalers)
            : null;
        if (usesPixelHiresUpscaler(upscalerName) && !resolvedUpscaler) {
            warnings.push(t('core.recipeWorkflowBuilder.upscalerMissing', { name: upscalerName }));
        }
        const useModelUpscaler = Boolean(resolvedUpscaler);
        {
            const vaeReference = [...prompt['6'].inputs.vae];
            const modelId = nextNodeId(prompt);
            const upscaleId = String(Number(modelId) + 1);
            const resizeId = String(Number(modelId) + 2);
            const encodeId = String(Number(modelId) + 3);
            const samplerId = String(Number(modelId) + 4);
            const decodeId = String(Number(modelId) + 5);
            const targetWidth = Math.max(8, Math.round((size.width * hiresScale) / 8) * 8);
            const targetHeight = Math.max(8, Math.round((size.height * hiresScale) / 8) * 8);
            const finalDecode = vaeDecodeInputs(
                [samplerId, 0],
                vaeReference,
                targetWidth * targetHeight
            );
            if (useModelUpscaler) {
                prompt[modelId] = {
                    inputs: { model_name: resolvedUpscaler },
                    class_type: 'UpscaleModelLoader',
                    _meta: { title: `Load Hires Upscaler: ${upscalerName}` },
                };
                prompt[upscaleId] = {
                    inputs: { upscale_model: [modelId, 0], image: ['6', 0] },
                    class_type: 'ImageUpscaleWithModel',
                    _meta: { title: 'Image Hires Upscale (Model)' },
                };
            }
            prompt[resizeId] = {
                inputs: {
                    image: useModelUpscaler ? [upscaleId, 0] : ['6', 0],
                    upscale_method: 'lanczos',
                    width: targetWidth, height: targetHeight, crop: 'disabled',
                },
                class_type: 'ImageScale',
                _meta: { title: 'Resize to Hires Target' },
            };
            prompt[encodeId] = {
                inputs: { pixels: [resizeId, 0], vae: vaeReference },
                class_type: 'VAEEncode',
                _meta: { title: 'VAE Encode (Hires)' },
            };
            prompt[samplerId] = {
                inputs: { ...hiresSamplerInputs, latent_image: [encodeId, 0] },
                class_type: 'KSampler',
                _meta: { title: 'KSampler (Hires pass)' },
            };
            prompt[decodeId] = {
                ...finalDecode,
                _meta: {
                    title: finalDecode.class_type === 'VAEDecodeTiled'
                        ? 'VAE Decode (Hires Tiled)'
                        : 'VAE Decode (Hires)',
                },
            };
            prompt['7'].inputs.images = [decodeId, 0];
        }
    }

    const clipSkip = Number(gen.clip_skip);
    // **CLIP Skip は CLIP にしか意味がない。**
    // `CLIPSetLastLayer` は CLIP のテキストエンコーダの層を後ろから打ち切る操作で、
    // UNet単体で配られる系統（Anima / Krea 2 / Z-Image / HiDream など）が使う
    // Qwen3・T5・Llama 系のエンコーダには対応する構造が無い。それでも掛けると
    // 条件付けが壊れ、**絵が丸ごと別物になるか単色に潰れる**。
    //
    // 実測（2026-08-10 / 346レシピ）: 該当は3件で、3件ともユーザーが劣化を報告していた
    // （136735734・136356918「完全に異なる画像」／133495148「単色の画像」）。
    // いずれも Anima で、`qwen_3_06b_base.safetensors` を読む `CLIPLoader` に
    // `stop_at_clip_layer: -2` が掛かっていた。**報告に無い該当は0件**なので、
    // この変更で退化しうるレシピは存在しない。
    //
    // 同じ判定は smZ の差し替え側（`applyA1111PromptParser`）に既に入っている。
    // そちらは「Qwen3 に unhook が無い」で実行時に落ちるので気づけたが、
    // こちらは**落ちずに絵だけ壊れる**ため長く残っていた。
    const isUnetFamily = Boolean(unetArchitecture(recipe));
    if (Number.isInteger(clipSkip) && clipSkip > 1 && !isUnetFamily) {
        const id = nextNodeId(prompt);
        prompt[id] = {
            inputs: { clip: ['1', 1], stop_at_clip_layer: -clipSkip },
            class_type: 'CLIPSetLastLayer',
            _meta: { title: `CLIP Skip ${clipSkip}` },
        };
        prompt['2'].inputs.clip = [id, 0];
        prompt['3'].inputs.clip = [id, 0];
    } else if (Number.isInteger(clipSkip) && clipSkip > 1 && isUnetFamily
        && Array.isArray(warnings)) {
        warnings.push(
            t('core.recipeWorkflowBuilder.31', { p1: clipSkip })
        );
    }

    applyUnetArchitecture(prompt, recipe, warnings);
    return prompt;
}

/**
 * SDE系サンプラーで scheduler の記録が無いとき、既定の `normal` を使わない。
 *
 * **実測（2026-08-09 / Civitai_Recipe_95077448 / sampler=dpmpp_3m_sde）**:
 * scheduler だけを振り、seed 3通り × 4種で12枚を実走した。隣接画素差の平均
 * （砂嵐ほど高い）は
 *
 *   normal        13.64 / 13.69 / 14.05   ← 3/3 が砂嵐
 *   karras         5.67 /  6.50 /  7.44
 *   exponential    6.70 /  7.29 /  7.42
 *   sgm_uniform    5.90 /  6.55 /  7.16
 *
 * 正常な生成の対照は 4.58 と 7.95。**重なりゼロで分離する**。
 * 崩壊は scheduler が `normal` のときだけ起きる。
 *
 * ただし**既定そのものは倒さない**。`normal` はコーパス848 KSampler中458で
 * 実行され、崩壊は10（約2%）。全体の既定を変えると現在正常な448枚が動く。
 * A1111 は DPM++ 系の "Automatic" を Karras に対応させるので、
 * **SDE系かつ scheduler 未記録のときだけ** karras にする。
 * 手元346件での該当は12件、SDE以外の220件は変わらない。
 */
// A1111 / Forge が「スケジュール未指定」を表す語。サンプラー名でもスケジューラ名でもない。
const SCHEDULE_PLACEHOLDERS = new Set(['automatic', 'undefined', 'none', 'default', '']);

// サンプラー表示名の末尾に付くスケジュール語（旧A1111表記）。
const TRAILING_SCHEDULE = /\s+(karras|exponential|sgm\s*uniform|simple|normal|beta|ddim\s*uniform|kl\s*optimal|linear\s*quadratic|automatic|alt)$/i;

/**
 * sampler と scheduler を**別々に**解決する。
 *
 * 従来は `[sampler, scheduler].join(' ')` の1本を対応表に当てていた。
 * A1111 は `Sampler: Euler a` と `Schedule type: Automatic` を別フィールドで
 * 書くので、連結すると `Euler a Automatic` という表に無い語になり
 * **sampler が null に落ちる**。null だと標準テンプレの `euler` が残る。
 *
 * 実測: sampler の記録がある320件のうち **35件（10.9%）** がこれで解決に失敗。
 * 内訳 `Euler a Automatic` 16件 / `DPM++ 2M Karras karras` 10件 ほか。
 * `euler_ancestral → euler` は ancestral のノイズ再注入が消えるので、
 * **テクスチャの粒が減る方向**の取り違えになる。
 */
function resolveSamplerAndScheduler(samplerValue, schedulerValue, warnings) {
    const samplerText = String(samplerValue || '').trim();
    const schedulerText = String(schedulerValue || '').trim();

    let fromSampler = resolveSamplerScheduler(samplerText);
    // 末尾の付随語を**解決できるまで繰り返し**切り離す。
    // `DPM++ 2M alt Karras` は 'Karras' を1語剥がしても `DPM++ 2M alt` のままで
    // 表に無く、'alt' も剥がして初めて `DPM++ 2M` に届く。
    if (!fromSampler.sampler) {
        let head = samplerText;
        const stripped = [];
        while (TRAILING_SCHEDULE.test(head)) {
            stripped.unshift(head.match(TRAILING_SCHEDULE)[1]);
            head = head.replace(TRAILING_SCHEDULE, '').trim();
            const retry = resolveSamplerScheduler(head);
            if (!retry.sampler) continue;
            // 剥がした語のうち、スケジューラとして解釈できるものだけ拾う
            // （`alt` はサンプラーの変種名でスケジューラではない）。
            const recovered = stripped
                .map(word => resolveSamplerScheduler(word).scheduler)
                .find(Boolean);
            fromSampler = { sampler: retry.sampler, scheduler: retry.scheduler || recovered || null };
            break;
        }
    }

    const placeholder = SCHEDULE_PLACEHOLDERS.has(schedulerText.toLowerCase());
    const fromScheduler = placeholder ? { sampler: null, scheduler: null }
        : resolveSamplerScheduler(schedulerText);

    const resolved = {
        // 明示された Schedule type を、サンプラー名に含まれる語より優先する。
        sampler: fromSampler.sampler || fromScheduler.sampler || null,
        scheduler: fromScheduler.scheduler || fromSampler.scheduler || null,
    };

    // **黙って euler へ落とさない。** 解決できなかったこと自体が情報。
    if (samplerText && !resolved.sampler && Array.isArray(warnings)) {
        warnings.push(
            t('core.recipeWorkflowBuilder.32', { p1: samplerText })
        );
    }
    return resolved;
}

function applySdeSchedulerDefault(resolved, warnings, recipe = null) {
    if (!resolved || resolved.scheduler) return resolved;
    if (!/(?:^|_)sde(?:$|_)/i.test(String(resolved.sampler || ''))) return resolved;

    // **karras を当てられるのは SD / SDXL 系まで。**
    // 上の実測（2026-08-09）は Illustrious のレシピで取ったもので、対象は
    // epsilon / v-prediction のモデルだった。UNet単体で配られる系統
    // （Anima / Krea 2 / Z-Image / HiDream）はフローマッチングで、
    // シグマの並べ方がまるで違う。ここに karras を当てると**絵が出ない**。
    //
    // 実測（2026-08-11 / `Civitai_Recipe_133495148`・Anima・er_sde・1536x2304）:
    // 同じ seed で scheduler だけを振ると、karras は**ほぼ単色で人体がうっすら
    // 見えるだけ**の失敗画像になり、simple では完全な絵になった。ユーザーの
    // 報告文も「ほぼ単色で薄ーく人体が見える。明らかに失敗」。
    //
    // simple を採るのは同梱の公式テンプレートの実測値。
    // `image_anima_base_v1.json` / `image_anima_preview.json` はいずれも
    // KSampler が `er_sde` + `simple`。
    //
    // 影響範囲（実測 2026-08-11 / 346レシピ）: karras 既定が当たるのは4件で、
    // うち UNet単体系統は**この1件だけ**。残り3件は Illustrious なので
    // 従来どおり karras のままにする（**報告に無いレシピは1件も動かない**）。
    const flowMatching = Boolean(recipe && unetArchitecture(recipe));
    resolved.scheduler = flowMatching ? 'simple' : 'karras';
    if (Array.isArray(warnings)) {
        warnings.push(
            flowMatching
                ? t('core.recipeWorkflowBuilder.33', { p1: resolved.sampler })
                : t('core.recipeWorkflowBuilder.34', { p1: resolved.sampler })
        );
    }
    return resolved;
}

function samplerUsesEmptyLatent(prompt, inputs) {
    const latentReference = inputs?.latent_image;
    if (!Array.isArray(latentReference) || latentReference.length === 0) return false;

    const latentNode = prompt[String(latentReference[0])];
    return isEmptyLatentClass(latentNode?.class_type);
}

/**
 * この KSampler が「2段目（hires / refine）」かどうかを**構造で**判定する。
 *
 * 従来は `_meta.title` に 'hires' が含まれるかだけを見ていた。これは自前で
 * 付けたタイトル（`KSampler (Hires pass)`）にしか当たらないので、**他人が
 * 組んだ埋め込みグラフの2本目 KSampler は必ず1段目扱い**になっていた。
 * その結果 `hires_steps` / `hires_cfg_scale` が反映されず、さらに
 * `denoising_strength` が1段目と2段目の**両方**へ同じ値で入っていた。
 *
 * 構造で見る: latent の上流を遡り、拡大ノード（ImageScale / LatentUpscale /
 * UpscaleModelLoader 経由の画像拡大など）か VAEEncode を通っていれば2段目。
 * 白紙 latent に直結していれば1段目。
 */
function isHiresSampler(prompt, node, inputs) {
    if (String(node?._meta?.title || '').toLowerCase().includes('hires')) return true;

    const visited = new Set();
    const queue = [];
    for (const value of Object.values(inputs || {})) {
        if (Array.isArray(value) && value.length) queue.push(String(value[0]));
    }
    while (queue.length) {
        const id = queue.shift();
        if (visited.has(id)) continue;
        visited.add(id);
        const upstream = prompt?.[id];
        if (!upstream) continue;
        const normalized = normalizedClassType(upstream.class_type);
        if (UPSCALE_CLASS_PATTERN.test(normalized) || normalized === 'vaeencode') return true;
        // 白紙 latent まで遡れたらそこで打ち切る（1段目の証拠）。
        if (isEmptyLatentClass(upstream.class_type)) continue;
        for (const value of Object.values(upstream.inputs || {})) {
            if (Array.isArray(value) && value.length) queue.push(String(value[0]));
        }
    }
    return false;
}

/**
 * 組み上がったグラフに「何を描くか」の指示が残っているかを確かめる。
 *
 * プロンプトが `<lora:...>` タグだけのレシピが実在する（実測1件・107813957）。
 * 元テキストは232文字あるのでプロンプト欠落の検査を素通りするが、タグを
 * 除いた本文は空で、**空の条件づけで生成すると単色の画像が出る**。
 * 生成できたように見えて中身が無いのが一番たちが悪いので、組んだ後の
 * 実テキストで判定する（除去前の長さで判定すると必ず取り逃がす）。
 *
 * 空のlatentから描き起こす場合に限る。img2img は元画像が情報を持つので、
 * プロンプトが空でも成立しうる。
 */
function assertConditioningIsUsable(prompt) {
    const entries = Object.entries(prompt || {});
    // smZ CLIPTextEncode は正規化しても 'smzcliptextencode' で、完全一致では
    // 拾えない（A1111由来のレシピは全てこちらへ差し替わるので取り逃がす）。
    const textNodes = entries.filter(
        ([, node]) => normalizedClassType(node?.class_type).endsWith('cliptextencode')
    );
    if (textNodes.length === 0) return;
    const hasText = textNodes.some(([, node]) => String(node?.inputs?.text || '').trim());
    if (hasText) return;

    const startsFromEmptyLatent = entries.some(([, node]) =>
        ['EmptyLatentImage', 'EmptySD3LatentImage'].includes(node?.class_type)
    );
    if (!startsFromEmptyLatent) return;

    throw new Error(
        t('core.recipeWorkflowBuilder.35')
    );
}

/**
 * サンプラーの `positive` / `negative` から辿って、その文字を書いているノードを返す。
 *
 * **並び順では決めない。** 記録の要約は「最初の CLIPTextEncode」を正としていて、
 * 負の側が先に並ぶグラフでは入れ替わる。線は入れ替わらない。
 */
function entryForConditioning(prompt, textNodes, positive) {
    const reference = findConditioningReference(prompt, positive);
    if (!Array.isArray(reference)) return null;
    const id = String(reference[0]);
    return textNodes.find(([nodeId]) => String(nodeId) === id) || null;
}

/**
 * グラフの文字を書き換える。**中身のあるものを空で潰さない。**
 *
 * 記録側が空なのは「本当に空だった」ではなく**抽出できていない**ことが多い
 * ——実測（2026-08-24）で、自作 PNG の記録は負のプロンプトを1件も持っていなかった
 * （`summarizePrompt` が抜いていなかった）。グラフには本物が残っているので、
 * 空で上書きすると**手元にある正解を捨てて再現を外す**ことになる。
 */
function writePromptText(entry, text, warnings, role) {
    const next = String(text ?? '');
    const current = String(entry?.[1]?.inputs?.text ?? '');
    if (!next.trim() && current.trim()) {
        warnings?.push?.(t('core.recipeWorkflowBuilder.keptGraphText', { role }));
        return;
    }
    entry[1].inputs.text = next;
}

function patchGenerationParameters(prompt, recipe, warnings, source) {
    const gen = recipe?.gen_params || {};
    const promptLoras = extractPromptLoras(gen.prompt);
    const entries = Object.entries(prompt);
    const textNodes = entries.filter(([, node]) => normalizedClassType(node?.class_type) === 'cliptextencode');
    let positiveNode = textNodes.find(([, node]) => {
        const title = String(node?._meta?.title || '').toLowerCase();
        return title.includes('positive') && !title.includes('negative');
    });
    let negativeNode = textNodes.find(([, node]) => String(node?._meta?.title || '').toLowerCase().includes('negative'));

    // **題名で決まらないときは、サンプラーの線を辿る。**
    // 並び順で決めると、負の側が先に並んでいるグラフで**正負が入れ替わる**
    // ——同じ種・同じ設定なのに絵が変わり、しかもどこが違うのか読めない
    // （2026-08-24 実機 `ComfyUI_00444_`）。
    positiveNode ||= entryForConditioning(prompt, textNodes, true);
    negativeNode ||= entryForConditioning(prompt, textNodes, false);
    positiveNode ||= textNodes[0];
    negativeNode ||= textNodes.find(entry => entry !== positiveNode) || textNodes[1];

    if (positiveNode && typeof promptLoras.text === 'string') {
        writePromptText(positiveNode, promptLoras.text, warnings, 'positive');
    }
    if (negativeNode && typeof gen.negative_prompt === 'string') {
        writePromptText(negativeNode, gen.negative_prompt, warnings, 'negative');
    }

    // resource-stack グラフは scheduler を持っている（該当15件は gen_params 側が
    // 全件欠落していた）。記録があるなら推定より優先する。
    const stack = parseResourceStackGraph(findA1111Parameters(recipe));
    const schedulerHint = gen.scheduler
        || stack?.scheduler
        || parameterValue(findA1111Parameters(recipe), 'Schedule type');
    const resolvedSampler = resolveSamplerAndScheduler(
        gen.sampler || stack?.sampler, schedulerHint, warnings
    );
    applySdeSchedulerDefault(resolvedSampler, warnings, recipe);
    for (const [, node] of entries) {
        const inputs = node?.inputs;
        if (!inputs || typeof inputs !== 'object') continue;

        if (/KSampler/i.test(node.class_type || '')) {
            const isHiresPass = isHiresSampler(prompt, node, inputs);
            if ('seed' in inputs) {
                const sourceSeed = Number.isFinite(Number(gen.seed)) ? gen.seed : inputs.seed;
                inputs.seed = normalizeSeed(sourceSeed) + (isHiresPass ? 1 : 0);
            }
            const requestedSteps = isHiresPass && Number.isFinite(Number(gen.hires_steps))
                ? gen.hires_steps : gen.steps;
            const requestedCfg = isHiresPass && Number.isFinite(Number(gen.hires_cfg_scale))
                ? gen.hires_cfg_scale : gen.cfg_scale;
            if (Number.isFinite(Number(requestedSteps)) && 'steps' in inputs) inputs.steps = Number(requestedSteps);
            if (Number.isFinite(Number(requestedCfg)) && 'cfg' in inputs && !isFluxRecipe(recipe)) {
                inputs.cfg = Number(requestedCfg);
            }
            if ('denoise' in inputs) {
                if (samplerUsesEmptyLatent(prompt, inputs)) {
                    // 白紙 latent 始まりへ denoise<1 を入れると平坦になる。ここは死守。
                    inputs.denoise = 1;
                } else {
                    // resource-stack グラフの denoise は既に読んでいたのに、
                    // 警告文にしか使われず KSampler へ届いていなかった（実測15件）。
                    //
                    // **`Number(null)` は 0 を返す。** 記録グラフが KSampler を
                    // 持たない純粋な拡大ジョブ（実測2件・80035215 / 103599474）では
                    // stack.denoise が null で、それが 0 として書き込まれ、
                    // 2段目が再描画を一切しなくなっていた。
                    const recordedDenoise = firstRecordedNumber(gen.denoising_strength, stack?.denoise);
                    if (recordedDenoise !== null) inputs.denoise = recordedDenoise;
                }
            }
            if (resolvedSampler.sampler && 'sampler_name' in inputs) inputs.sampler_name = resolvedSampler.sampler;
            if (resolvedSampler.scheduler && 'scheduler' in inputs) inputs.scheduler = resolvedSampler.scheduler;
        }

        if (normalizedClassType(node.class_type) === 'randomnoise' && 'noise_seed' in inputs) {
            const sourceSeed = Number.isFinite(Number(gen.seed)) ? gen.seed : inputs.noise_seed;
            inputs.noise_seed = normalizeSeed(sourceSeed);
        }
    }

    applyRecordedSize(prompt, entries, recipe, gen, warnings, source);
}

// 元グラフが多段（base → 拡大 → 仕上げ）で組まれている印。
// 記録された `Size` は**最終出力**の寸法なので、これがある場合に
// 1段目の latent へ流し込むと base 解像度そのものが膨らむ。
//
// **Empty latent の本数では数えない。** 実測: 00879715 は EmptyLatentImage を
// 4本持つが KSampler へ繋がるのは1本だけで、残り3本（1216x832 / 1408x704 /
// 1024x1024）は解像度プリセットの置き物。本数で判定すると単段のグラフを
// 多段と誤認して、記録サイズが本物の latent へ届かなくなる。
// 実測で多段だった17件は、拡大ノードの存在だけで全件拾える。
const UPSCALE_CLASS_PATTERN =
    /(?:upscale|highres|hiresfix|ultimatesdupscale|imagescale|iterativeupscale|supir)/i;

function isMultiStageGraph(prompt) {
    return Object.values(prompt || {})
        .some(node => UPSCALE_CLASS_PATTERN.test(normalizedClassType(node?.class_type)));
}

function applyRecordedSize(prompt, entries, recipe, gen, warnings, source) {
    const parsed = parseSize(gen?.size);
    if (!parsed) return;
    // 埋め込みグラフ側にも、転置された記録寸法が流れ込む経路がある。
    const size = correctTransposedSize(parsed, recipe, warnings);

    // **守るのは他人が組んだ埋め込みグラフだけ。**
    // standard / a1111 は自前で組んでおり hires 2段でも寸法が既に正しい。
    // checkpoint-template はチェックポイント同梱のサンプル由来で、寸法は
    // レシピと無関係なので**上書きが必要**。ここを一緒くたにすると、
    // 正常な2段構成すべてに警告が出て本当に危ない件が埋もれる。
    // **source を問わず、多段グラフには触らない。**
    // 当初は embedded だけ守っていたが、ラベル由来で hires 2段を組んだ
    // standard 経路でも、ここが1段目を最終寸法へ戻してしまい段が無意味になった。
    // 自前で組んだ standard では latent と gen.size が一致するので、
    // 触らないことによる損失は無い（適用しても no-op）。
    if (isMultiStageGraph(prompt)) {
        if (Array.isArray(warnings)) {
            warnings.push(
                t('core.recipeWorkflowBuilder.36', { p1: size.width, p2: size.height })
            );
        }
        return;
    }

    for (const [, node] of entries) {
        if (!isEmptyLatentClass(node?.class_type)) continue;
        // inputs を持たないノードで `in` 演算子を使うと TypeError で
        // buildRecipeWorkflow ごと落ちる。同じ関数の KSampler 側ループには
        // 同等のガードがあるのに、ここには無かった。
        const inputs = node?.inputs;
        if (!inputs || typeof inputs !== 'object') continue;
        // **ノードリンクを数値で潰さない。**
        // width/height が [nodeId, slot] の形なら、寸法は別ノードが決めている
        // （実測8件。うち743d1c03 は解像度計算ノードが真値で、記録サイズの方が誤り）。
        // 数値で上書きすると、そのノードが担っていた関係が消える。
        if ('width' in inputs && !Array.isArray(inputs.width)) {
            inputs.width = size.width;
        }
        if ('height' in inputs && !Array.isArray(inputs.height)) {
            inputs.height = size.height;
        }
    }
}

function patchCheckpoint(prompt, checkpoint) {
    const checkpointFilename = getResourceFilename(checkpoint, 'Model');
    const diffusionFilename = getResourceFilename(checkpoint, 'Diffusion Model') || checkpointFilename;
    if (!checkpointFilename && !diffusionFilename) return;

    for (const node of Object.values(prompt)) {
        if (!node?.inputs) continue;
        const type = normalizedClassType(node.class_type);
        if (type === 'checkpointloadersimple' && checkpointFilename) {
            node.inputs.ckpt_name = checkpointFilename;
        } else if (type === 'unetloader' && diffusionFilename) {
            node.inputs.unet_name = diffusionFilename;
        }
    }
}

function nextNodeId(prompt) {
    const numericIds = Object.keys(prompt).map(Number).filter(Number.isFinite);
    return String((numericIds.length ? Math.max(...numericIds) : 0) + 1);
}

function sameReference(value, reference) {
    return Array.isArray(value)
        && value.length >= 2
        && String(value[0]) === String(reference[0])
        && Number(value[1]) === Number(reference[1]);
}

function replaceReferences(prompt, oldReference, newReference) {
    for (const node of Object.values(prompt)) {
        for (const [key, value] of Object.entries(node?.inputs || {})) {
            if (sameReference(value, oldReference)) node.inputs[key] = [...newReference];
        }
    }
}

function findLoaderReferences(prompt) {
    const entries = Object.entries(prompt);
    const checkpointLoader = entries.find(([, node]) => normalizedClassType(node?.class_type) === 'checkpointloadersimple');
    if (checkpointLoader) {
        const clipLayer = entries.find(([, node]) => normalizedClassType(node?.class_type) === 'clipsetlastlayer');
        return {
            model: [checkpointLoader[0], 0],
            clip: clipLayer ? [clipLayer[0], 0] : [checkpointLoader[0], 1],
        };
    }

    const modelLoader = entries.find(([, node]) => ['unetloader', 'modelloader'].includes(normalizedClassType(node?.class_type)));
    const clipLoader = entries.find(([, node]) => ['cliploader', 'dualcliploader'].includes(normalizedClassType(node?.class_type)));
    return {
        model: modelLoader ? [modelLoader[0], 0] : null,
        clip: clipLoader ? [clipLoader[0], 0] : null,
    };
}

function isLoraLoaderClass(value) {
    const type = normalizedClassType(value);
    return type.startsWith('loraloader') || type.startsWith('loadlora');
}

function nodeChoices(objectInfo, classType, inputName) {
    const spec = objectInfo?.[classType]?.input?.required?.[inputName]
        ?? objectInfo?.[classType]?.input?.optional?.[inputName];
    if (Array.isArray(spec?.[0])) return spec[0];
    if (spec?.[0] === 'COMBO' && Array.isArray(spec?.[1]?.options)) return spec[1].options;
    return null;
}

function nameIsInstalled(choices, requested) {
    const norm = value => String(value || '').replaceAll('\\', '/').toLowerCase();
    const base = value => norm(value).split('/').at(-1) || '';
    // 実行側 `catalogStem` と**同じ関数**を使う（片方だけ落とすと判定と実行がずれる）。
    const bare = value => stripModelExtension(base(value));
    const wanted = norm(requested);
    return choices.some(choice => norm(choice) === wanted
        || base(choice) === base(requested)
        || bare(choice) === bare(requested));
}

/**
 * 手元に無い LoRA をグラフから外し、モデル／CLIP の線を繋ぎ直す。
 *
 * これまでは未導入の LoRA を名指ししたまま返していたので、ComfyUI が
 * そのノードで落ち、**1本足りないだけでレシピ全体が実行不能**だった。
 * ベースモデル（チェックポイント・UNet・CLIP・VAE）が無ければ何も描けないが、
 * LoRA は外せば描ける。外したことは警告に残す（絵は確実に変わるため）。
 *
 * 実測（2026-08-10 / 全346レシピ）: 未導入モデルの内訳は
 * LoraLoader 38 / CheckpointLoader 17 / VAELoader 7 / UpscaleModelLoader 6 /
 * CLIPLoader 4 / UNETLoader 2 / SAMLoader 1。LoRAが最多だった。
 */
function dropUnavailableLoras(prompt, objectInfo, warnings) {
    if (!objectInfo || !prompt) return [];
    const dropped = [];
    for (const [id, node] of Object.entries(prompt)) {
        if (!isLoraLoaderClass(node?.class_type)) continue;
        const requested = node?.inputs?.lora_name;
        if (typeof requested !== 'string' || !requested.trim()) continue;
        const choices = nodeChoices(objectInfo, node.class_type, 'lora_name');
        if (!choices || !choices.every(choice => typeof choice === 'string')) continue;
        if (nameIsInstalled(choices, requested)) continue;

        // 出力0=MODEL、出力1=CLIP。参照している側を、この節の入力へ繋ぎ替える。
        const passthrough = [node.inputs.model, node.inputs.clip];
        for (const other of Object.values(prompt)) {
            for (const [key, value] of Object.entries(other?.inputs || {})) {
                if (!Array.isArray(value) || String(value[0]) !== String(id)) continue;
                const replacement = passthrough[Number(value[1]) || 0];
                if (replacement === undefined) continue;
                other.inputs[key] = replacement;
            }
        }
        delete prompt[id];
        dropped.push(String(requested).replaceAll('\\', '/').split('/').at(-1));
    }
    if (dropped.length > 0 && Array.isArray(warnings)) {
        warnings.push(
            t('core.recipeWorkflowBuilder.37', { p1: dropped.length, p2: dropped.join('、') })
        );
    }
    return dropped;
}

/**
 * その節が**運んでいる** LoRA の名前（`lora_name` 以外の入れ物）。
 *
 * 実データ（`Lora Loader (LoraManager)`）は2通りで持っている:
 *   `text`  … `<lora:名前:強さ> <lora:名前:強さ> …`
 *   `loras` … `{"__value__": [{name, strength, …}, …]}`
 *
 * **どちらか片方だけを読まない。** 片方が空の書き手が在ると、
 * 「運んでいない」と読んで**同じ LoRA をもう一度足す**ことになる。
 */
function carriedLoraNames(node) {
    const out = new Set();
    const inputs = node?.inputs || {};

    const list = inputs.loras;
    const entries = Array.isArray(list) ? list
        : (Array.isArray(list?.__value__) ? list.__value__ : []);
    for (const entry of entries) {
        const name = loraCompactName(entry?.name || entry?.lora_name || entry?.file_name);
        if (name) out.add(name);
    }

    const text = typeof inputs.text === 'string' ? inputs.text : '';
    for (const match of text.matchAll(/<lora:([^:>]+)(?::[^>]*)?>/gi)) {
        const name = loraCompactName(match[1]);
        if (name) out.add(name);
    }
    return [...out];
}

/**
 * 運搬ノードを、標準の `LoraLoader` の連なりへ開く（2026-08-25 利用者の指示）。
 *
 * **導入されていないときだけ開く。** 在るならそのまま使う——同じ節を使えば
 * 絵は必ず同じで、開くと**こちらの組み方が絵に効く余地**ができる。
 *
 * **絵を変えない条件は3つ。** 順番・強さ（model と clip を別に）・
 * 切ってある分を当てないこと。LoRA は重みを順に当てる操作なので、
 * 同じ順で同じ強さなら、1節でまとめても連ねても結果は同じになる。
 *
 * @returns {boolean} 開いたか
 */
function expandCarriedLoras(prompt, objectInfo, warnings) {
    // **在るかどうかは宿主に聞く。** 名前で決め打ちすると、別名で入れている
    // 環境で「無い」と読んで開いてしまう。
    const installed = (type) => Boolean(objectInfo?.[type]);
    const carriers = Object.entries(prompt).filter(([, node]) => {
        const type = String(node?.class_type || '');
        if (!type || installed(type)) return false;
        return looksLikeLoraCarrier(node);
    });
    if (!carriers.length) return false;

    let nextId = nextNodeId(prompt);
    for (const [carrierId, carrier] of carriers) {
        const entries = carriedLoraEntries(carrier);
        let modelRef = carrier.inputs?.model;
        let clipRef = carrier.inputs?.clip;
        if (!Array.isArray(modelRef) || !Array.isArray(clipRef)) continue;

        for (const entry of entries) {
            const id = String(nextId);
            nextId += 1;
            prompt[id] = {
                inputs: {
                    lora_name: entry.name,
                    strength_model: entry.model,
                    strength_clip: entry.clip,
                    model: modelRef,
                    clip: clipRef,
                },
                class_type: 'LoraLoader',
                // **開いた印。** これが無いと、この後の `insertLoras` が
                // 記録側の強さで**上書きして絵を変える**。
                _meta: { title: `LoRA: ${entry.name}`, unbake_expanded_lora: true },
            };
            modelRef = [id, 0];
            clipRef = [id, 1];
        }

        // 運搬ノードを見ていた所を、連なりの末尾へ繋ぎ替える。
        for (const node of Object.values(prompt)) {
            for (const [key, value] of Object.entries(node?.inputs || {})) {
                if (!Array.isArray(value) || String(value[0]) !== String(carrierId)) continue;
                node.inputs[key] = value[1] === 1 ? [...clipRef] : [...modelRef];
            }
        }
        delete prompt[carrierId];
        warnings.push(entries.length
            // **0本のときは「開いた」とは言わない。** 節が1つも増えていないのに
            // 「連なりへ開きました」と言うと、増えた物を探すことになる。
            ? t('core.recipeWorkflowBuilder.expandedLoras', {
                p1: String(carrier.class_type || ''), p2: entries.length,
            })
            : t('core.recipeWorkflowBuilder.bypassedLoraCarrier', {
                p1: String(carrier.class_type || ''),
            }));
    }
    return true;
}

/**
 * 運搬ノードの形か。**名前では決めない**（別名で入れている環境が在る）。
 *
 * 形の条件は2つ: LoRA の名簿（`loras` か `<lora:…>` の文字列）を持ち、
 * **model と clip を受けて返す**こと。
 *
 * **0本でも運搬ノードは運搬ノード**（2026-08-25 実機 `civitai_128202934`）。
 * 元は「1本以上持っていること」を条件にしていたので、**空の運搬ノードだけが
 * 残って、グラフ全体が組み直しになる**——1本以上なら開くのに、0本だと丸ごと
 * 捨てる、という筋の通らない差になっていた。0本なら素通しにするだけでよい。
 */
function looksLikeLoraCarrier(node) {
    const inputs = node?.inputs || {};
    const holds = 'loras' in inputs
        || (typeof inputs.text === 'string' && /<lora:/i.test(inputs.text));
    return holds && Array.isArray(inputs.model) && Array.isArray(inputs.clip);
}

/** 運搬ノードが持っている1本ずつ（名前・model の強さ・clip の強さ）。 */
function carriedLoraEntries(node) {
    const inputs = node?.inputs || {};
    const raw = inputs.loras;
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.__value__) ? raw.__value__ : null);
    if (list) {
        return list
            // **切ってある分は当てない。** 当てると絵が変わる。
            .filter(entry => entry && entry.active !== false)
            .map(entry => ({
                name: String(entry.name || entry.lora_name || entry.file_name || ''),
                model: Number(entry.strength ?? entry.strength_model ?? 1),
                clip: Number(entry.clipStrength ?? entry.strength_clip ?? entry.strength ?? 1),
            }))
            .filter(entry => entry.name);
    }
    // `text` しか持たない書き手。`<lora:名前:強さ>`（clip は同じ強さ）。
    const text = typeof inputs.text === 'string' ? inputs.text : '';
    return [...text.matchAll(/<lora:([^:>]+)(?::([^:>]*))?(?::([^>]*))?>/gi)].map(match => ({
        name: String(match[1] || ''),
        model: Number(match[2] ?? 1) || 1,
        clip: Number(match[3] ?? match[2] ?? 1) || 1,
    })).filter(entry => entry.name);
}

function insertLoras(prompt, loras, warnings, source = null) {
    const candidates = (Array.isArray(loras) ? loras : [])
        .map(lora => ({ ...lora, workflowFilename: getResourceFilename(lora) }))
        .filter(lora => lora.workflowFilename
            && (!lora.isDeleted || lora.inLibrary || lora._replayRequirement?.required === true));
    const availableLoras = [];
    const seenResources = new Set();
    for (const lora of candidates) {
        const key = loraCompactName(lora.workflowFilename);
        if (!key || seenResources.has(key)) continue;
        seenResources.add(key);
        availableLoras.push(lora);
    }
    if (availableLoras.length === 0) return;

    const existing = Object.values(prompt).filter(node => isLoraLoaderClass(node?.class_type));
    /** 記録のグラフ側の強度を採った本数（下で1行にまとめて言う）。 */
    let keptGraphStrengths = 0;
    const pendingLoras = [];
    for (const lora of availableLoras) {
        const names = loraCandidateNames(lora).map(loraCompactName).filter(Boolean);
        names.push(loraCompactName(lora.workflowFilename));
        const matched = existing.find(node => {
            const current = loraCompactName(node?.inputs?.lora_name);
            return current && names.includes(current);
        });
        // **1つの節が何本も運ぶ形が在る。** LoRA Manager の運搬ノードは
        // `lora_name` を持たず、`text`（`<lora:名前:強さ>`）と `loras.__value__`
        // に名前を入れている——`lora_name` だけを見ていたので**一致せず、
        // 同じ LoRA をもう一度足していた**（2026-08-25 実機
        // `civitai_137676446`: 元は1節で8本なのに、組んだ後は9節=二重掛け）。
        //
        // **運ばれている分は、既に当たっている。** 触らず、足さない
        // ——強さを書き換える口が無いので、当て直すこともできない。
        if (!matched && existing.some(node => carriedLoraNames(node).some(name => names.includes(name)))) {
            continue;
        }
        if (!matched) {
            pendingLoras.push(lora);
            continue;
        }
        const strengths = getLoraStrengths(lora);
        // 名前は実ファイル名へ直す（拡張子や下位フォルダが無いと選べない）。
        matched.inputs.lora_name = lora.workflowFilename;
        /*
         * **既に在るローダの強さは、記録側の数字で書き換えない。**
         *
         * 元からそうなっていたのは**運搬ノードから開いた分**だけだった
         * （開く前は1節の中に在った値で、そのまま当たっていた）。
         * **同じ理由が、記録が持つ生成グラフそのものにも当てはまる**
         * ——`comfy_prompt` は「その絵を実際に出したグラフ」で、
         * 一覧の `loras` はそこから作った**要約**にすぎない。
         *
         * 実測（2026-08-27・`civitai_128383826`「絵が改造 LoRA Manager から変わった」）:
         *
         *     ノード26 rimixO                    グラフ 0.4 → 要約 1.0 で上書き
         *     ノード30 Dramatic Lighting Slider  グラフ 3.0 → 要約 1.0 で上書き
         *
         * 要約は2本とも `strength: 1` を持っており、**桁が違う**。
         * 3.0 で当てた絵を 1.0 で出せば、当然まったく別の絵になる。
         */
        // **前半は今は後半に含まれる**（運搬ノードは埋め込みグラフにしか無いので、
        // 変異させても赤くならない）。残すのは、運搬の展開が組み直し経路でも
        // 起こるようになった日に守りが消えないため——**今それが効いている、
        // とは読まないこと。**
        const keepGraphStrength = matched._meta?.unbake_expanded_lora || source === 'embedded';
        if (!keepGraphStrength) {
            if ('strength_model' in matched.inputs) matched.inputs.strength_model = strengths.model;
            if ('strength_clip' in matched.inputs) matched.inputs.strength_clip = strengths.clip;
        } else if (source === 'embedded' && !matched._meta?.unbake_expanded_lora) {
            // **黙って守らない。** 要約と食い違うときは、どちらを採ったかを言う。
            // **数えてから1行だけ出す**——1件ずつ出すと同じ文が並び、
            // 何本食い違ったのかがかえって読めなくなる。
            const inGraph = Number(matched.inputs?.strength_model);
            if (Number.isFinite(inGraph) && Number.isFinite(strengths.model)
                && inGraph !== strengths.model) {
                keptGraphStrengths += 1;
            }
        }
        matched._meta ||= {};
        matched._meta.lora_aliases = [...new Set(loraCandidateNames(lora).map(String))];
        if (lora._replayRequirement) {
            matched._meta.replay_requirement = { ...lora._replayRequirement };
        }
    }
    if (keptGraphStrengths > 0 && Array.isArray(warnings)) {
        warnings.push(t('core.recipeWorkflowBuilder.87', { p1: keptGraphStrengths }));
    }
    if (pendingLoras.length === 0) return;

    const references = findLoaderReferences(prompt);
    if (!references.model || !references.clip) {
        warnings.push(t('core.recipeWorkflowBuilder.38'));
        return;
    }

    let nextId = nextNodeId(prompt);
    let modelReference = references.model;
    let clipReference = references.clip;
    const originalModelReference = [...references.model];
    const originalClipReference = [...references.clip];

    for (const lora of pendingLoras) {
        const id = nextId;
        nextId = String(Number(nextId) + 1);
        const strengths = getLoraStrengths(lora);
        prompt[id] = {
            inputs: {
                model: [...modelReference],
                clip: [...clipReference],
                lora_name: lora.workflowFilename,
                strength_model: strengths.model,
                strength_clip: strengths.clip,
            },
            class_type: 'LoraLoader',
            _meta: {
                title: `Load LoRA: ${lora.name || lora.workflowFilename}`,
                // Preserve every known recipe-side name through the backend so
                // A1111 tags can be rewritten to the exact ComfyUI library path.
                lora_aliases: [...new Set(loraCandidateNames(lora).map(String))],
                ...(lora._replayRequirement
                    ? { replay_requirement: { ...lora._replayRequirement } }
                    : {}),
            },
        };
        modelReference = [id, 0];
        clipReference = [id, 1];
    }

    const insertedIds = new Set(pendingLoras.map((_, index) => String(Number(nextId) - pendingLoras.length + index)));
    const originalNodes = Object.fromEntries(Object.entries(prompt).filter(([id]) => !insertedIds.has(id)));
    replaceReferences(originalNodes, originalModelReference, modelReference);
    replaceReferences(originalNodes, originalClipReference, clipReference);
}

function objectInfoOutputs(prompt, objectInfo) {
    return Object.entries(prompt).filter(([, node]) => {
        const info = objectInfo?.[node?.class_type];
        return info?.output_node === true
            || ['saveimage', 'previewimage'].includes(normalizedClassType(node?.class_type));
    });
}

function imageSinkCandidates(prompt, objectInfo) {
    return Object.entries(prompt).filter(([, node]) => {
        if (!Array.isArray(node?.inputs?.images)) return false;
        const type = String(node?.class_type || '');
        return !objectInfo?.[type] || /(?:save|saver|output|prompt)/i.test(type);
    });
}

function collectReachableNodeIds(prompt, roots) {
    const reachable = new Set();
    const pending = roots.map(String);
    while (pending.length > 0) {
        const id = pending.pop();
        if (reachable.has(id) || !prompt[id]) continue;
        reachable.add(id);
        for (const value of Object.values(prompt[id]?.inputs || {})) {
            if (Array.isArray(value) && value.length >= 2 && prompt[String(value[0])]) {
                pending.push(String(value[0]));
            }
        }
    }
    return reachable;
}

function embeddedGraphProblems(prompt, objectInfo, rootIds) {
    const reachable = collectReachableNodeIds(prompt, rootIds);
    const missingNodes = new Set();
    const missingInputs = new Set();
    for (const id of reachable) {
        const node = prompt[id];
        const info = objectInfo?.[node?.class_type];
        if (!info) {
            missingNodes.add(String(node?.class_type || 'Unknown'));
            continue;
        }
        const required = info?.input?.required || {};
        for (const key of Object.keys(required)) {
            if (!(key in (node.inputs || {})) || node.inputs[key] === undefined || node.inputs[key] === null) {
                missingInputs.add(`${node.class_type}.${key}`);
            }
        }
    }
    return { reachable, missingNodes: [...missingNodes], missingInputs: [...missingInputs] };
}

function canBuildStandardRecipe(recipe) {
    const hasPrompt = String(recipe?.gen_params?.prompt || '').trim().length > 0;
    const hasModel = Boolean(
        getResourceFilename(recipe?.checkpoint, 'Model')
        || getResourceFilename(recipe?.checkpoint, 'Diffusion Model')
        || filenameFromName(recipe?.gen_params?.model)
    );
    return hasPrompt && hasModel;
}

function isFourChannelCheckpointRecipe(recipe) {
    const family = [
        recipe?.base_model,
        recipe?.checkpoint?.baseModel,
        recipe?.checkpoint?.base_model,
        recipe?.gen_params?.model,
    ].filter(Boolean).join(' ').toLowerCase();
    return /sdxl|illustrious|noobai|pony/.test(family);
}

function repairAmbiguousAeVae(prompt, recipe, warnings) {
    if (!isFourChannelCheckpointRecipe(recipe)) return;
    const checkpointLoaders = Object.entries(prompt).filter(([, node]) =>
        /checkpointloader/i.test(String(node?.class_type || ''))
    );
    if (checkpointLoaders.length !== 1) return;
    const checkpointVae = [checkpointLoaders[0][0], 2];

    for (const [vaeId, node] of Object.entries(prompt)) {
        if (normalizedClassType(node?.class_type) !== 'vaeloader') continue;
        const compactName = String(node?.inputs?.vae_name || '')
            .replace(/\\/g, '/')
            .split('/').at(-1)
            .replace(/\.[^.]+$/, '')
            .replace(/[^a-z0-9]+/gi, '')
            .toLowerCase();
        if (compactName !== 'ae') continue;

        let replaced = false;
        for (const otherNode of Object.values(prompt)) {
            for (const [key, value] of Object.entries(otherNode?.inputs || {})) {
                if (!sameReference(value, [vaeId, 0])) continue;
                otherNode.inputs[key] = [...checkpointVae];
                replaced = true;
            }
        }
        if (!replaced) continue;
        delete prompt[vaeId];
        warnings.push(
            t('core.recipeWorkflowBuilder.39')
        );
    }
}

/**
 * `PreviewImage` しか出力が無いグラフを `SaveImage` へ替える。
 *
 * PreviewImage は ComfyUI の **temp** へ書くので、再現画像はディスクに残らず
 * レシピへ紐付けることもできない。元ワークフローの作者にとっては
 * 「見て確認するだけ」で正しいが、こちらの用途は再現物を残すこと。
 *
 * **実測（2026-08-10 / 全340レシピをビルダーに通した結果）**: SaveImage を
 * 持つのが312件に対し、PreviewImage しか無いのが4件
 * （102803746 / 13180695 / 101481681 / 101479920）。実際に 13180695 を生成すると
 * `ComfyUI_temp_axjib_00001_.png` として temp に出ていた。
 *
 * SaveImage が1つでもあるグラフには触らない（作者が出し分けている）。
 */
/**
 * 埋め込みグラフの出力名を、**守るべき出し分けが無いときだけ**記録の名前にする。
 *
 * **原則は「作者の出し分けを壊さない」。** だから触るのは、
 * **`SaveImage` がちょうど1つで、その接頭辞が ComfyUI の既定（`ComfyUI`）**の
 * ときだけにする——既定値は「決めていない」のと同じで、守るべき意図が無い。
 *
 * **実測（2026-08-20・実データ346件）**: 埋め込みグラフ23件のうち、
 * `SaveImage` が2つ以上のものは **0件**、既定のままが **18件**、
 * 残り5件は `PreviewImage` から昇格させた際にこちらが名前を付けたもの。
 * つまりこの規則で18件が `civitai_<id>` になり、**出し分けは1件も壊さない**。
 *
 * 名前が既定のままだと、再現した絵が `ComfyUI_00356_.png` として出て、
 * **他のどの絵とも見分けが付かない**（実機で確認した）。
 */
function nameDefaultSaveOutputs(prompt, recipe, ownOutputs = false) {
    if (!prompt || typeof prompt !== 'object') return;
    const saves = Object.values(prompt)
        .filter(node => normalizedClassType(node?.class_type) === 'saveimage');
    if (saves.length !== 1) return;
    const node = saves[0];
    const current = String(node?.inputs?.filename_prefix ?? '');
    /*
     * **こちらが投げる回は、こちらの名前で保存する**（2026-08-26 実機）。
     *
     * 「作者が決めた行き先を上書きしない」は、**人が開いて回すグラフ**の話。
     * Unbake が自分で投げた回まで作者の行き先へ落とすと、**出した絵を自分で
     * 見つけられない**——実機では `Anima/2026-08-17/hshi` へ落ちて、
     * 記録に紐づかず「絵は出ませんでした」と言い続けていた。
     *
     * 開く側（`openWorkflowInComfy`）は元のグラフをそのまま渡すので、
     * **人が見るグラフの行き先は変わらない。**
     */
    if (ownOutputs) {
        node.inputs = { ...node.inputs, filename_prefix: createRecipeWorkflowName(recipe) };
        return;
    }
    // **既定以外は触らない。** 作者が決めた行き先を上書きしない。
    //
    // 一度 `ComfyUI_00042` のような連番付きも「既定」に含めたが、**それは誤り
    // だった**——そう見えた5件は埋め込みグラフの既定ではなく、
    // **ローカル画像から取り込んだ記録**で、題（＝元のファイル名）が
    // そのまま名前になっていただけ。**誤った実測に基づく規則は残さない。**
    if (current !== 'ComfyUI') return;
    node.inputs = { ...node.inputs, filename_prefix: createRecipeWorkflowName(recipe) };
}

function persistPreviewOnlyOutputs(prompt, recipe, warnings) {
    if (!prompt || typeof prompt !== 'object') return;
    const nodes = Object.entries(prompt);
    if (nodes.some(([, node]) => normalizedClassType(node?.class_type) === 'saveimage')) return;

    const previews = nodes.filter(
        ([, node]) => normalizedClassType(node?.class_type) === 'previewimage'
    );
    if (previews.length === 0) return;

    for (const [, node] of previews) {
        node.class_type = 'SaveImage';
        node.inputs = {
            ...node.inputs,
            filename_prefix: createRecipeWorkflowName(recipe),
        };
        node._meta = { ...(node._meta || {}), title: 'Save Image (preview promoted)' };
    }
    if (Array.isArray(warnings)) {
        warnings.push(
            t('core.recipeWorkflowBuilder.40')
        );
    }
}

// ---------------------------------------------------------------------------
// 未導入ノードの役割を核ノードで肩代わりする
// ---------------------------------------------------------------------------

/**
 * **定数を配るだけの未導入ノード。** 出力を値へ畳んでノードごと消す。
 *
 * 実測（2026-08-19・346レシピ）: 未導入ノード67種のうち19種はこの役割で、11レシピに現れる。
 * 値さえ正しく運べば**絵は1画素も変わらない**ので、肩代わりの中で最も安全な組である。
 *
 * **名前の一覧と形の検査を両方かける。** 名前だけで畳むと、たまたま単一の
 * スカラ入力を持つ別種のノード（サンプラーの変種など）まで畳んでしまう。
 */
const CONSTANT_NODE_ALIASES = new Set([
    'string literal', 'int literal', 'cfg literal', 'float literal',
    'int literal (image saver)', 'cfg literal (image saver)',
    'easy int', 'easy string', 'easy float', 'easy seed',
    'seed', 'seed generator', 'seed (rgthree)', 'seed generator (image saver)',
    'seed everywhere',
]);

/**
 * **表示するだけの未導入ノード。** 誰も出力を使っていないときだけ消す。
 * 使われているなら値の出所なので、消すと線が切れる。
 */
/**
 * **どのノードパックを入れれば元のグラフのまま動くか**（2026-08-26 利用者の指示）。
 *
 * 「不足ノード: X」とだけ言われても、**何を入れればよいか判らない**。
 * 名前が判るものは名前で言う——判らないものは黙る（推測で名前を出すと、
 * 入れても直らないものを入れさせることになる）。
 */
const NODE_PACKS = new Map([
    ['power lora loader (rgthree)', 'rgthree-comfy'],
    ['display any (rgthree)', 'rgthree-comfy'],
    ['joinstringmulti', 'ComfyUI-KJNodes'],
    ['showtext|pysssss', 'ComfyUI-Custom-Scripts'],
    ['easy showanything', 'ComfyUI-Easy-Use'],
]);

/** 不足しているノードから、入れるべきパックの名前を集める。**重複は畳む。** */
export function packsFor(classNames) {
    const packs = new Set();
    for (const name of classNames || []) {
        const pack = NODE_PACKS.get(String(name).trim().toLowerCase());
        if (pack) packs.add(pack);
    }
    return [...packs];
}

const DISPLAY_ONLY_ALIASES = new Set([
    'showtext|pysssss', 'easy showanything', 'preview any', 'display any (rgthree)',
]);

/**
 * **核ノードの言い換え。** 入出力の並びが核と同じものだけを載せる。
 * 出力の本数が違うもの（`… with Name` 系は名前の文字列出力が増える）は載せない——
 * 番号でつないでいる線がずれる。
 */
const CORE_NODE_ALIASES = new Map([
    ['echocheckpointloadersimple', 'CheckpointLoaderSimple'],
]);

/** その id を参照している入力があるか。 */
function isReferenced(prompt, id) {
    for (const node of Object.values(prompt)) {
        for (const value of Object.values(node?.inputs || {})) {
            if (Array.isArray(value) && String(value[0]) === String(id)) return true;
        }
    }
    return false;
}

/**
 * `[id, slot]` の参照を**値**へ置き換える。
 * 既存の `replaceReferences` は参照から参照への繋ぎ替えなので別物である
 * （名前が近いので、片方を直すときにもう片方と取り違えないこと）。
 */
function inlineReferencesToValue(prompt, id, value) {
    for (const node of Object.values(prompt)) {
        for (const [key, input] of Object.entries(node?.inputs || {})) {
            if (Array.isArray(input) && String(input[0]) === String(id)) node.inputs[key] = value;
        }
    }
}

/**
 * 未導入ノードのうち、役割を核ノードで肩代わりできるものを置き換える。
 *
 * **導入済みのノードには触らない。** `objectInfo` に有るものは作者の意図どおり動くので、
 * 言い換える理由が無い。ここが緩むと、動いているグラフを黙って書き換えることになる。
 *
 * 肩代わりできなかったものは残る → 従来どおり `embeddedGraphProblems` が拾い、
 * 標準構成への作り直しになる。**部分的に代替して黙って通すことはしない。**
 */
/**
 * `Power Lora Loader (rgthree)` を `LoraLoader` の連鎖へ**等価変換**する。
 *
 * 2026-08-26 の実機で見つけた。`civitai_139981506` はこのノードで **7本の
 * LoRA を束ねて**いて、落とすと当然まったく違う絵になる（利用者の報告
 * 「かなり異なる画像が生成された」）。
 *
 * **等価だと言えるから変換する。** このノードは `lora_N` を順に適用して
 * `MODEL` と `CLIP` を返すだけで、`LoraLoader` を数珠つなぎにしたものと
 * 同じ計算をする。実物の形（実測）:
 *
 *     { model: ["44",0], clip: ["45",0],
 *       lora_1: { on: true, lora: "x.safetensors", strength: 0.5 }, … }
 *
 * **`on: false` は入れない。** 切ってある LoRA を効かせると、
 * 「同じ材料なのに絵が違う」という一番読みにくい形になる。
 *
 * **`strengthTwo` が在ればそれを CLIP 側に使う。** 無ければ両方 `strength`
 * ——このノードは既定で両方を同じ値にする。
 *
 * @returns {{converted: number, loras: string[]}} 変換した本数と名前
 */
export function expandPowerLoraLoader(prompt, objectInfo) {
    const installed = name => !objectInfo || Object.prototype.hasOwnProperty.call(objectInfo, name);
    // **`LoraLoader` が無ければ触らない。** 置き換え先が無いのに崩すと、
    // 元のグラフより悪くなる。
    if (!installed('LoraLoader')) return { converted: 0, loras: [] };

    const out = { converted: 0, loras: [] };
    for (const [id, node] of Object.entries(prompt || {})) {
        if (String(node?.class_type || '').trim().toLowerCase() !== 'power lora loader (rgthree)') {
            continue;
        }
        const inputs = node?.inputs || {};
        let model = inputs.model;
        let clip = inputs.clip;
        if (!Array.isArray(model) || !Array.isArray(clip)) continue;

        // `lora_1`, `lora_2`, … を番号順に。**順番が効き方を決める。**
        const entries = Object.entries(inputs)
            .filter(([key, value]) => /^lora_[0-9]+$/.test(key) && value && typeof value === 'object')
            .sort((a, b) => Number(a[0].slice(5)) - Number(b[0].slice(5)));

        let nextId = Math.max(0, ...Object.keys(prompt).map(Number).filter(Number.isFinite)) + 1;
        for (const [, entry] of entries) {
            if (entry.on === false) continue;
            const name = String(entry.lora || '').trim();
            if (!name || name.toLowerCase() === 'none') continue;
            const strength = Number(entry.strength);
            const clipStrength = Number(entry.strengthTwo ?? entry.strength);
            const linkId = String(nextId);
            nextId += 1;
            prompt[linkId] = {
                inputs: {
                    lora_name: name,
                    strength_model: Number.isFinite(strength) ? strength : 1,
                    strength_clip: Number.isFinite(clipStrength) ? clipStrength : 1,
                    model,
                    clip,
                },
                class_type: 'LoraLoader',
                _meta: { title: `LoraLoader (${name})` },
            };
            model = [linkId, 0];
            clip = [linkId, 1];
            out.converted += 1;
            out.loras.push(name);
        }

        // **元のノードを指していた線を、連鎖の端へ付け替える。**
        // 0番は MODEL、1番は CLIP（このノードの出力の並び）。
        for (const other of Object.values(prompt)) {
            for (const [key, value] of Object.entries(other?.inputs || {})) {
                if (!Array.isArray(value) || String(value[0]) !== String(id)) continue;
                other.inputs[key] = Number(value[1]) === 1 ? clip : model;
            }
        }
        delete prompt[id];
    }
    return out;
}

/**
 * **絵に届かないノードを落とす**（2026-08-26 実機で必要になった）。
 *
 * `civitai_139981506` は `JoinStringMulti` を持っていて、その出力は
 * `PreviewAny` にしか行っていない——**絵には1ミリも影響しない**。それでも
 * 「不足ノード」として数えられ、**グラフを丸ごと捨てて標準構成へ落ちて**いた。
 * その巻き添えで、せっかく開いた LoRA 7本も消えていた。
 *
 * **どれが絵に効くかは ComfyUI 自身が知っている。** `/object_info` の
 * `output_node` が真のノードから**逆向きに辿った先**が、絵を作るのに要る全部。
 * そこに入らないものは、消しても出る絵は変わらない。
 *
 * **根が1つも見つからなければ何もしない。** 判らないときに消すと、
 * 消してはいけないものを消す。
 *
 * @returns {{dropped: number, classes: string[]}}
 */
export function pruneNodesNotFeedingOutput(prompt, objectInfo) {
    const out = { dropped: 0, classes: [] };
    if (!prompt || !objectInfo || typeof objectInfo !== 'object') return out;

    /*
     * **根は「絵を出す口」だけ。** `output_node` が真なだけでは足りない
     * ——`PreviewAny` のような**文字を見るための口**も真になるので、
     * そこから逆に辿ると表示専用の枝まで「要る」ことになる（実機でそうなった）。
     *
     * 絵を出す口は**絵を受け取っている**。入力に `images` / `image` の線が
     * 在るかどうかで見分ける——種類名の一覧を持たずに済み、知らない
     * 保存ノードでも当たる。
     */
    const takesImage = (node) => Object.entries(node?.inputs || {})
        .some(([key, value]) => Array.isArray(value) && /^images?$/.test(key));
    const roots = Object.entries(prompt)
        .filter(([, node]) => objectInfo[node?.class_type]?.output_node === true
            && takesImage(node))
        .map(([id]) => String(id));
    if (!roots.length) return out;

    const needed = new Set();
    const stack = [...roots];
    while (stack.length) {
        const id = stack.pop();
        if (needed.has(id)) continue;
        needed.add(id);
        for (const value of Object.values(prompt[id]?.inputs || {})) {
            if (Array.isArray(value) && value.length >= 1) stack.push(String(value[0]));
        }
    }

    for (const id of Object.keys(prompt)) {
        if (needed.has(String(id))) continue;
        out.classes.push(String(prompt[id]?.class_type || ''));
        delete prompt[id];
        out.dropped += 1;
    }
    return out;
}

/**
 * 文字列を出すだけのノードから、その値を読む。**読めなければ null。**
 *
 * `PrimitiveStringMultiline` のように、線の入力が無く文字の入力が1つだけの
 * ノードを対象にする。2つ以上あるものは、どれが出力の値か決められない。
 */
function constantStringOf(node) {
    const entries = Object.entries(node?.inputs || {}).filter(([key]) => !key.startsWith('_'));
    if (entries.some(([, value]) => Array.isArray(value))) return null;
    const strings = entries.filter(([, value]) => typeof value === 'string');
    if (strings.length !== 1) return null;
    return strings[0][1];
}

/**
 * `JoinStringMulti` を、**連結済みの文字列**へ畳む（2026-08-26 実機）。
 *
 * `civitai_139981506` はこれで**プロンプト本文を組み立てて**いた:
 *
 *     316 + 317 → 315(JoinStringMulti) → 314(PreviewAny/素通し)
 *              → 354(CLIPTextEncode).text → KSampler.positive
 *
 * **飾りではない。** 落とすとプロンプトごと消えるので、グラフを丸ごと捨てる
 * しかなくなっていた——その巻き添えで LoRA 7本も消えていた。
 *
 * 中身は「入力を `delimiter` で繋ぐ」だけなので、**入力が全部その場で読める
 * 定数なら、繋いだ結果を直に置ける**。読めないものが1つでも在れば触らない
 * ——途中まで畳むと、繋がる順も中身も変わる。
 *
 * `return_list: true` は扱わない（返るものが文字列ではなく並びになる）。
 *
 * @returns {{folded: number}}
 */
export function inlineJoinStringMulti(prompt, objectInfo) {
    const out = { folded: 0 };
    if (!prompt) return out;
    const installed = name => Boolean(objectInfo)
        && Object.prototype.hasOwnProperty.call(objectInfo, name);
    if (installed('JoinStringMulti')) return out;

    for (const [id, node] of Object.entries(prompt)) {
        if (String(node?.class_type || '').trim().toLowerCase() !== 'joinstringmulti') continue;
        const inputs = node?.inputs || {};
        if (inputs.return_list === true) continue;

        const count = Number(inputs.inputcount);
        const wanted = Number.isFinite(count) && count > 0 ? count : 0;
        const delimiter = typeof inputs.delimiter === 'string' ? inputs.delimiter : '';

        const parts = [];
        let readable = true;
        for (let index = 1; index <= Math.max(wanted, 1); index += 1) {
            const value = inputs[`string_${index}`];
            if (value === undefined || value === null) continue;
            if (typeof value === 'string') { parts.push(value); continue; }
            if (!Array.isArray(value)) { readable = false; break; }
            const source = prompt[String(value[0])];
            const constant = constantStringOf(source);
            if (constant === null) { readable = false; break; }
            parts.push(constant);
        }
        if (!readable) continue;

        inlineReferencesToValue(prompt, id, parts.join(delimiter));
        delete prompt[id];
        out.folded += 1;
    }
    return out;
}

function substituteMissingNodes(prompt, objectInfo, warnings) {
    if (!prompt || !objectInfo || typeof objectInfo !== 'object') return;
    const installed = name => Object.prototype.hasOwnProperty.call(objectInfo, name);
    const done = { constants: 0, dropped: 0, aliased: 0 };

    // **文字を繋ぐだけのノードは、繋いだ結果に畳む**（2026-08-26）。
    // 実機ではこれがプロンプト本文を組み立てていて、落とすと本文ごと消えた。
    if (!installed('JoinStringMulti')) {
        const folded = inlineJoinStringMulti(prompt, objectInfo);
        if (folded.folded > 0) {
            warnings.push(t('core.recipeWorkflowBuilder.joinString', { count: folded.folded }));
        }
    }

    // **絵に届かないノードを先に落とす**（2026-08-26）。
    // 残すと「不足ノード」に数えられ、**グラフを丸ごと捨てる**ことになる
    // ——実機では表示専用の枝1本のために LoRA 7本が消えていた。
    pruneNodesNotFeedingOutput(prompt, objectInfo);

    // **束ねる LoRA ノードは、落とさずに開く**（2026-08-26）。
    // 落とすと LoRA がまるごと消えて、まったく違う絵になる。
    if (!installed('Power Lora Loader (rgthree)')) {
        const expanded = expandPowerLoraLoader(prompt, objectInfo);
        if (expanded.converted > 0) {
            warnings.push(t('core.recipeWorkflowBuilder.powerLora', {
                count: expanded.converted, list: expanded.loras.join('、'),
            }));
        }
    }

    for (const [id, node] of Object.entries(prompt)) {
        const cls = String(node?.class_type || '');
        if (!cls || installed(cls)) continue;
        const key = cls.trim().toLowerCase();

        if (CORE_NODE_ALIASES.has(key)) {
            const target = CORE_NODE_ALIASES.get(key);
            if (installed(target)) {
                node.class_type = target;
                node._meta = { ...(node._meta || {}), title: `${target} (substituted)` };
                done.aliased += 1;
            }
            continue;
        }

        if (DISPLAY_ONLY_ALIASES.has(key)) {
            if (!isReferenced(prompt, id)) { delete prompt[id]; done.dropped += 1; }
            continue;
        }

        if (CONSTANT_NODE_ALIASES.has(key)) {
            /*
             * **形の検査**: 線の入力が無く、スカラの入力がちょうど1つ。
             * 2つ以上あるものは、どの出力がどの値かを名前から決められないので触らない
             * （`Width/Height Literal` や `mxSlider2D` がこれに当たる）。
             */
            const entries = Object.entries(node?.inputs || {})
                .filter(([k]) => !k.startsWith('_'));
            if (entries.some(([, v]) => Array.isArray(v))) continue;
            const scalars = entries.filter(([, v]) => typeof v === 'number' || typeof v === 'string');
            if (scalars.length !== 1) continue;
            inlineReferencesToValue(prompt, id, scalars[0][1]);
            delete prompt[id];
            done.constants += 1;
        }
    }

    const parts = [];
    if (done.constants) parts.push(t('core.recipeWorkflowBuilder.41', { p1: done.constants }));
    if (done.aliased) parts.push(t('core.recipeWorkflowBuilder.42', { p1: done.aliased }));
    if (done.dropped) parts.push(t('core.recipeWorkflowBuilder.43', { p1: done.dropped }));
    if (parts.length && Array.isArray(warnings)) {
        warnings.push(
            t('core.recipeWorkflowBuilder.44', { p1: parts.join(t('core.sep.list')) })
        );
    }
}

function validateOrRepairEmbeddedPrompt(prompt, recipe, objectInfo, warnings) {
    if (!objectInfo || typeof objectInfo !== 'object') return { prompt, rebuilt: false };

    let roots = objectInfoOutputs(prompt, objectInfo).map(([id]) => id);
    const sinks = imageSinkCandidates(prompt, objectInfo);
    const unusableSinks = sinks.filter(([, node]) => objectInfo?.[node.class_type]?.output_node !== true);
    let addedOutput = false;
    if (roots.length === 0 || unusableSinks.length > 0) {
        const candidate = (unusableSinks.at(-1) || sinks.at(-1));
        if (candidate) {
            const id = nextNodeId(prompt);
            prompt[id] = {
                inputs: {
                    filename_prefix: createRecipeWorkflowName(recipe),
                    images: [...candidate[1].inputs.images],
                },
                class_type: 'SaveImage',
                _meta: { title: 'Save Image (repaired output)' },
            };
            roots = [id];
            addedOutput = true;
        }
    }

    if (roots.length === 0) {
        throw new Error(t('core.recipeWorkflowBuilder.45'));
    }

    /*
     * **作り直す前に、肩代わりできるものを片付ける。**
     * ここを通さないと、定数を配るだけのノードが1つ欠けただけで
     * グラフ全体を捨てて標準構成へ落ちる。
     */
    substituteMissingNodes(prompt, objectInfo, warnings);
    const problems = embeddedGraphProblems(prompt, objectInfo, roots);
    if (problems.missingNodes.length > 0 || problems.missingInputs.length > 0) {
        const details = [
            problems.missingNodes.length ? t('core.recipeWorkflowBuilder.46', { p1: problems.missingNodes.join('、') }) : '',
            problems.missingInputs.length ? t('core.recipeWorkflowBuilder.47', { p1: problems.missingInputs.join('、') }) : '',
        ].filter(Boolean).join(' / ');
        if (!canBuildStandardRecipe(recipe)) {
            const error = new Error(t('core.recipeWorkflowBuilder.48', { p1: details }));
            // **名前も構造で載せる**（2026-08-28）。文からは切り出せない
            // ——訳が1つ増えた日に、切り出しが黙って空になる。
            error.missingNodes = problems.missingNodes;
            throw error;
        }
        warnings.push(t('core.recipeWorkflowBuilder.49', { p1: details }));
        /*
         * **何が変わるのかを言う**（2026-08-26 利用者の指示）。
         *
         * 元は「標準構成へ再構築しました」だけで、**どれだけ違う絵になるのかが
         * 読めなかった**。実機では LoRA を束ねるノードが落ちて 7本ぶん効かず、
         * 「かなり異なる画像」になった——そうと判れば驚かずに済む。
         *
         * **入れるべきパックが判るものは、名前で言う。** 「不足ノード: X」だけ
         * では、何を入れればよいか判らない。
         */
        const packs = packsFor(problems.missingNodes);
        if (packs.length) {
            warnings.push(t('core.recipeWorkflowBuilder.packs', { list: packs.join('、') }));
        }
        // **この関数が持っているのは `objectInfo` だけ。** `options` は無い
        // ——`options` と書いて 21件が `options is not defined` で落ちた（実測 2026-08-21）。
        return {
            prompt: standardPrompt(recipe, warnings, { objectInfo }),
            rebuilt: true,
            // **手元に無いノードの名前を、文ではなく並びで返す。**
            missingNodes: problems.missingNodes,
        };
    }

    if (addedOutput) {
        for (const id of Object.keys(prompt)) {
            if (!problems.reachable.has(id)) delete prompt[id];
        }
        warnings.push(t('core.recipeWorkflowBuilder.50'));
    }
    return { prompt, rebuilt: false };
}

// ---------------------------------------------------------------------------
// ADetailer（顔・手の局所再描画）の復元
// ---------------------------------------------------------------------------

/**
 * 手元に導入済みの検出モデル名（`bbox/face_yolov8n.pt` 形式）へ寄せる対応表。
 * A1111 の ADetailer は自前のファイル名で記録するので、そのままでは
 * UltralyticsDetectorProvider の候補と一致しない。
 */
const DETECTOR_ALIASES = [
    [/^face_yolov8n/i, 'bbox/face_yolov8n.pt'],
    [/^face_yolov8s/i, 'bbox/face_yolov8s.pt'],
    [/^face_yolov9c/i, 'bbox/face_yolov9c.pt'],
    [/^hand_yolov8n/i, 'bbox/hand_yolov8n.pt'],
    [/^hand_yolov8s/i, 'bbox/hand_yolov8s.pt'],
    [/^hand_yolov9c/i, 'bbox/hand_yolov9c.pt'],
];

function resolveDetectorModel(name, objectInfo) {
    const raw = String(name || '').trim();
    if (!raw) return null;
    const available = objectInfo?.UltralyticsDetectorProvider?.input?.required?.model_name?.[0];
    const candidates = Array.isArray(available) ? available : null;

    const alias = DETECTOR_ALIASES.find(([pattern]) => pattern.test(raw))?.[1] || null;
    if (!candidates) return alias;
    if (candidates.includes(raw)) return raw;
    if (alias && candidates.includes(alias)) return alias;
    // 顔用が要るのに無い、といった取り違えを避けるため、同じ部位のものだけを探す。
    const part = /hand/i.test(raw) ? 'hand' : (/face/i.test(raw) ? 'face' : null);
    if (!part) return null;
    return candidates.find(item => item.toLowerCase().includes(part)) || null;
}

/**
 * 引用符で囲われた値を読む。
 *
 * `parameterValue` は `[^,\r\n]+` なので**カンマか改行で切れる**。ADetailer の
 * プロンプトは `"extremely detailed eyes, extremely detailed face, <lora:…>"` の形で
 * **カンマも改行も含む**ため、そちらでは先頭の1語しか取れない（実測: 9件すべてが
 * `"extremely detailed eyes` で切れていた）。
 */
function quotedParameterValue(parameters, key) {
    if (typeof parameters !== 'string') return '';
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const quoted = parameters.match(new RegExp(`(?:^|[,\\n]\\s*)${escaped}\\s*:\\s*"([^"]*)"`, 'i'));
    if (quoted) return quoted[1].trim();
    return parameterValue(parameters, key);
}

function parseAdetailerStages(parameters) {
    if (typeof parameters !== 'string' || !/ADetailer/i.test(parameters)) return [];
    // 1段目はサフィックス無し、2段目以降は `2nd` / `3rd`。
    const suffixes = ['', ' 2nd', ' 3rd'];
    const stages = [];
    for (const suffix of suffixes) {
        const read = key => parameterValue(parameters, `ADetailer ${key}${suffix}`);
        const readQuoted = key => quotedParameterValue(parameters, `ADetailer ${key}${suffix}`);
        const model = read('model');
        if (!model) continue;
        stages.push({
            model: model.replace(/^"|"$/g, '').trim(),
            confidence: Number(read('confidence')),
            denoise: Number(read('denoising strength')),
            maskBlur: Number(read('mask blur')),
            dilate: Number(read('dilate erode')),
            padding: Number(read('inpaint padding')),
            prompt: readQuoted('prompt'),
            negativePrompt: readQuoted('negative prompt'),
        });
    }
    return stages;
}

/**
 * ADetailer の記録から FaceDetailer 段を組み、最終画像の後ろへ挿す。
 *
 * **実測: ADetailer の記録は346件中45件（13%）あり、gen_params への転写も
 * 再現も0件だった。** 顔・手を検出して denoise 0.4 前後で描き直す工程で、
 * まさに描き込み量を稼ぐ段が丸ごと落ちていた。
 *
 * A1111 の ADetailer と Impact Pack の FaceDetailer は実装が違うので同一には
 * ならない。ここで写すのは**記録されている値だけ**にする:
 *   model → UltralyticsDetectorProvider.model_name
 *   confidence → bbox_threshold
 *   denoising strength → denoise
 *   mask blur → feather
 *   dilate erode → bbox_dilation
 *   inpaint padding → bbox_crop_factor（A1111のpaddingは画素、こちらは倍率なので
 *                     記録が無い扱いにして既定3.0のままにする）
 * steps / cfg / sampler / scheduler は本体と同じものを使う（ADetailer は
 * 既定で本体の設定を引き継ぐため）。
 */
// ---------------------------------------------------------------------------
// 群L: A1111系プロンプトの強調記法を、A1111互換パーサで解釈する
// ---------------------------------------------------------------------------

// 解釈差が目に見えて出る強さ。`(x:1.4)` 以上、または `(((x)))`（1.1^3）以上。
const HEAVY_EMPHASIS_PATTERN = /:(?:1\.[4-9]\d*|[2-9](?:\.\d+)?)\)|\(\(\(/;

/**
 * A1111/Civitai 由来のプロンプトを、ComfyUI 素の CLIPTextEncode でなく
 * smZ CLIPTextEncode（parser: A1111）で条件付けする。
 *
 * **機序（実測で確定）**: `(x:1.5)` の適用式が両者で違う。A1111系は埋め込みへ
 * 乗算した後に**平均を復元する**が、ComfyUI は空プロンプト基準の外挿で、
 * 重みが大きいほど条件付けが歪む。Civitai のオンサイト生成は resource-stack
 * グラフに `smZ CLIPTextEncode` を使っており、それが原本の解釈である。
 *
 * 実測（Civitai_Recipe_135935753 / `(translucent wings:2)` と `:1.5` を含む）:
 *
 *   暗部の B−R（元 +12.5）: 素の解釈 **-6.5**（赤茶に転ぶ）→ smZ **+13.1**
 *   帯域50%（元 2.1）:      素の解釈 **1.2** → smZ **2.0**
 *
 *   重みを1.15へ丸めた対照も +11.9 / 2.1 で一致した＝**重みの過剰適用が原因**。
 *   プロンプトを書き換えずに一致するのは smZ だけ。
 *   なお LoraLoader の strength_clip を 1 にする案は +19.4 へ悪化した（採らない）。
 *
 * 母集団: 強い強調（重み≥1.4 or 3重括弧）はプロンプトあり317件中 **62件**。
 *
 * ComfyUI 由来の埋め込みグラフには触らない — あちらは comfy 解釈こそが原本。
 */
/** 標準の CLIPTextEncode しか無い環境で、BREAK をゴミトークンにしないため落とす。 */
function stripBreakFromTextNodes(prompt, warnings) {
    let stripped = false;
    for (const node of Object.values(prompt)) {
        if (node?.class_type !== 'CLIPTextEncode') continue;
        const text = node.inputs?.text;
        if (typeof text !== 'string') continue;
        const cleaned = stripBreakKeyword(text);
        if (cleaned !== text) {
            node.inputs.text = cleaned;
            stripped = true;
        }
    }
    if (stripped && Array.isArray(warnings)) {
        warnings.push(
            t('core.recipeWorkflowBuilder.51')
        );
    }
}

/**
 * レシピに保存された**再現の上書き**を読む。
 *
 * **なぜ規則ではなく対象ごとの保存なのか。** smZ の当て外しは母集団では改善するが
 * 個別では退行する。2026-08-12 の実測（52件×3値=156枚・同一seed）では、
 * `smZ なし` を一律に当てると **改善10 / 退行17**、`mean_normalization: false` でも
 * **改善7 / 退行6** で、どちらも規則にならなかった。共通要素も7指標で探して全て分布が重なる。
 * **対象ごとに実測して保存するのが唯一の解**という結論はここから来ている。
 *
 * **形式は軸×値にしてある。** `D-20260811-01`（テンプレート＋軸の掃引機構）が
 * 「推奨組み合わせの蓄積」を LoRA／checkpoint 側へ保存するとき、**同じ形をそのまま使える**
 * ようにするため。軸を増やすときは `axis` を足すだけで、構造は変えない。
 *
 * ```json
 * "replay_overrides": {
 *   "schema": "lora-manager.replay-overrides",
 *   "version": 1,
 *   "entries": [
 *     { "axis": "text_encoder", "value": "no_mean_normalization",
 *       "measured_at": "2026-08-12", "confirmed_by": "human",
 *       "evidence": { "metric": "layout", "before": 0.303, "after": 0.990 } }
 *   ]
 * }
 * ```
 *
 * **`confirmed_by` を必須にはしない**が、人間が見ていない値を保存しないこと。
 * 自動採点は 0.5 未満の領域で目視と食い違った実測がある（`45249236` / `49640272`）。
 */
function replayOverrideValue(recipe, axis) {
    const entries = recipe?.replay_overrides?.entries;
    if (!Array.isArray(entries)) return null;
    for (const entry of entries) {
        if (entry?.axis === axis && typeof entry?.value === 'string') return entry.value;
    }
    return null;
}

function applyA1111PromptParser(prompt, recipe, objectInfo, warnings, source) {
    if (source === 'embedded') return;

    // **SD/SDXL 以外のテキストエンコーダには smZ を当てない。**
    // smZ CLIPTextEncode は CLIP に `unhook` があることを前提にしており、
    // Qwen3 系では `'Qwen3_06BModel' object has no attribute 'unhook'` で
    // 実行時に落ちる（実測 2026-08-10 / Civitai_Recipe_131241081・133999893）。
    // 実物の Anima ワークフロー3件はいずれも素の CLIPTextEncode だった。
    if (unetArchitecture(recipe)) {
        stripBreakFromTextNodes(prompt, warnings);
        return;
    }

    // **保存された上書きは、系統の安全判定より後・smZ の当て方の前に読む。**
    // 順番を逆にすると、smZ を当てると落ちる系統（Qwen3 等）へ上書きが割り込んで
    // 実行時エラーになる。**上書きは「どう当てるか」であって「当ててよいか」ではない。**
    const textEncoderOverride = replayOverrideValue(recipe, 'text_encoder');

    if (textEncoderOverride === 'nosmz') {
        // **smZ を積める環境でも、この件では積まない。**
        // 手術で smZ ノードを剥がすのではなく、**smZ が無い環境と同じ経路を通す**
        // ——BREAK の除去まで含めて挙動を一致させるため。剥がすだけだと BREAK が
        // ゴミトークンとして残り、実測した「smZなし」と違う絵になる。
        stripBreakFromTextNodes(prompt, warnings);
        if (Array.isArray(warnings)) {
            warnings.push(
                t('core.recipeWorkflowBuilder.52')
            );
        }
        return;
    }

    // BREAK の扱いは**由来ではなくノードで決まる**。smZ を積めるなら残し、
    // 標準の CLIPTextEncode しか無いなら落とす。ここを A1111 由来の判定より
    // 後ろに置くと、由来不明のレシピで BREAK がゴミトークンのまま通る。
    const hasSmz = Boolean(objectInfo?.['smZ CLIPTextEncode']);
    if (!hasSmz) {
        stripBreakFromTextNodes(prompt, warnings);
    }

    const isA1111Origin = Boolean(findA1111Parameters(recipe))
        || Boolean(recipe?.generation_metadata?.civitaiResources);
    if (!isA1111Origin) return;

    const promptTexts = [recipe?.gen_params?.prompt, recipe?.gen_params?.negative_prompt]
        .filter(value => typeof value === 'string')
        .join(' ');

    if (!objectInfo?.['smZ CLIPTextEncode']) {
        // 導入されていない環境では黙って歪めない。強い強調があるときだけ言う
        // （弱い強調でも差は出るが、警告が常時出ると本当に危ない件が埋もれる）。
        if (HEAVY_EMPHASIS_PATTERN.test(promptTexts) && Array.isArray(warnings)) {
            warnings.push(
                t('core.recipeWorkflowBuilder.53')
            );
        }
        return;
    }

    // **記録された Emphasis モードを読む。**
    //
    // **既定値は `Original`＝平均正規化あり**（一次資料 2026-08-12 確認・
    // `modules/shared_options.py` の `OptionInfo("Original", ..., infotext="Emphasis")`）。
    // 選択肢は4つで、平均を復元するのは `Original` だけ（`modules/sd_emphasis.py`）:
    //   None … 強調機構を無効化し `(x:1.1)` を literal として扱う
    //   Ignore … 強調された語をすべて強調なしとして扱う
    //   Original … 乗算後に `original_mean / new_mean` で平均を復元（既定）
    //   No norm … 乗算するが平均を復元しない
    //
    // 書き出しは「**強調記法があり かつ `Original` でない**」ときだけ
    // （`backend/text_processing/classic_engine.py` の
    //  `if any(x for x in texts if "(" in x or "[" in x) and self.emphasis.name != "Original"`）。
    // 読み戻す側も「記載が無く強調記法があれば `Original`」と補う（`modules/infotext_utils.py`）。
    // **したがって記載なし ⇒ `Original` ⇒ 平均正規化あり。下の式はこれと一致する。**
    //
    // **「両方が非既定として書かれているから既定は第三の値」という推論は誤り**だった
    // （`_measurements/emphasis_default_2026-08-12.md`）。実測312件の内訳は
    // 記載なし303 / `Original` 6 / `No norm` 3 で、**`Original` 6件はすべて `Version: classic`**
    // ＝既定でも書く別フォークが書いたもの。`No norm` 3件だけが上流の「非既定だから書いた」に当たる。
    // 記録が無い303件への一様な誤適用は**無い**。
    //
    // **`None` / `Ignore` は未対応**（どちらも下の式では「平均正規化あり」に落ちるが、
    // 機構としては強調そのものを止める指定）。**実データ0件**なので当てていない。
    // 件数は `scripts/measure_emphasis.mjs` が数える。増えたらここを直す。
    //
    // **`Original`（旧実装）は当てない。** smZNodes の
    // `use_old_emphasis_implementation` はこの版で壊れており、**必ず実行時に落ちる**。
    // 実測（2026-08-11）: 記録が `Original` の6件はいずれも修正後だけ実行エラーで、
    // 埋め込みを使う件は `past_classic_engine.py:51` の `embedding.vec.shape`、
    // 埋め込み0件の対照でも `TypeError: argument 'tokens': Can't extract 'str' to 'Vec'`。
    // 交絡（Original 6件はすべて埋め込みあり／No norm 3件はすべて埋め込み0）を
    // 切るため、埋め込み0件のレシピへ旧実装を強制する対照を1本取って確かめた。
    // **絵が少し違うことより、絵が出ないことの方が悪い。** 記録を読めない事実は警告で言う。
    const emphasis = parameterValue(findA1111Parameters(recipe), 'Emphasis');
    // 保存された上書きは記録より優先する。**記録は「作者が何をしたか」、上書きは
    // 「この環境で何が元画像に近かったか」**で、後者は実測と人間の目視を通っている。
    const overrideNoNorm = textEncoderOverride === 'no_mean_normalization';
    const meanNormalization = overrideNoNorm ? false : !/^no\s*norm$/i.test(emphasis);
    if (overrideNoNorm && Array.isArray(warnings)) {
        warnings.push(
            t('core.recipeWorkflowBuilder.54')
        );
    }
    if (/^original$/i.test(emphasis) && Array.isArray(warnings)) {
        warnings.push(
            t('core.recipeWorkflowBuilder.55')
        );
    }

    /*
     * **`smZ_steps` は歩数を渡す**（2026-08-27・改造 LoRA Manager との突き合わせ）。
     *
     * これを渡していなかったので、smZ の既定 **1** が当たっていた。効くのは
     * **プロンプト編集構文**（`[昼:夜:10]` のように途中で語を差し替える書き方）で、
     * 何歩目で切り替えるかをこの値で割る。1 のままだと**切り替えが起きない**。
     *
     * `civitai_77742180` の突き合わせでは、`filename_prefix` を除く実差が
     * **ここ1点だけ**だった（LoRA Manager は 30 を渡していた）。その記録は
     * 編集構文を持たないので絵は変わらないが、**持つ記録では変わる。**
     *
     * **歩数はグラフから読む。** 記録の `steps` を読み直すと、途中で縮めた
     * ときに食い違う——実際に投げるサンプラーが持っている値が正しい。
     */
    let steps = 0;
    for (const node of Object.values(prompt)) {
        const value = Number(node?.inputs?.steps);
        if (Number.isFinite(value) && value > steps) steps = value;
    }

    let swapped = 0;
    for (const node of Object.values(prompt)) {
        if (node?.class_type !== 'CLIPTextEncode') continue;
        const text = node.inputs?.text;
        const clip = node.inputs?.clip;
        node.class_type = 'smZ CLIPTextEncode';
        node.inputs = {
            text: typeof text === 'string' ? text : (text ?? ''),
            clip,
            parser: 'A1111',
            mean_normalization: meanNormalization,
            multi_conditioning: true,
            use_old_emphasis_implementation: false,
            with_SDXL: false,
            ascore: 6.0,
            width: 1024, height: 1024,
            crop_w: 0, crop_h: 0,
            target_width: 1024, target_height: 1024,
            text_g: '', text_l: '',
            // **最小は 1**（ノードの下限）。歩数が読めないグラフでは既定のまま。
            smZ_steps: steps > 0 ? steps : 1,
        };
        swapped++;
    }
    if (swapped > 0 && Array.isArray(warnings)) {
        warnings.push(
            t('core.recipeWorkflowBuilder.56', { p1: swapped })
        );
    }
}

/**
 * 記録されたノイズ源（A1111 の `RNG`）と、それに付随する再現専用の設定を
 * 再現グラフへ反映する。
 *
 * **機序（一次資料で確定）**: 初期潜在ノイズをどこで引くかが両者で違う。
 * ComfyUI は `comfy/sample.py` の `prepare_noise_inner` が `device="cpu"` 固定。
 * A1111/Forge は `modules/shared_options.py` の `randn_source` が **既定 GPU**
 * （CUDA の乱数器）で、`modules/processing.py` は**既定と違うときだけ**
 * `RNG:` を infotext へ書く。読み戻す側（`modules/infotext_utils.py`）も
 * 「記載が無ければ GPU」と解釈する。Forge には `forge_try_reproduce` で
 * CPU を強制する分岐があり、**両者が非互換であることを実装が認めている**。
 *
 * したがって同一 seed でも初期潜在が別物になる。オプションの説明文自身が
 * "changes seeds drastically"。実測（同一 seed の A/B・3本組）:
 *
 *   反証 A（挟まない）vs B（挟むが cpu）: **画素完全一致**
 *     → smZ Settings を挟むこと自体は無効果。差はノイズ源だけに帰せる。
 *   本命 A vs C（gpu）: 変化画素 94〜99.96%
 *   元画像との構造一致（正規化相互相関・48x72 の輝度格子）:
 *     `96496211` cpu 0.006 → gpu **0.986** ／ `130662221` cpu 0.076 → gpu **0.639**
 *
 * **一律に gpu を当ててはならない。** Civitai のオンサイト生成器は ComfyUI 系
 * なので CPU ノイズが原本で、当てると退行する（`99603291` cpu **0.999** → gpu 0.763）。
 * 記録に `RNG:` があるものはその値が正。無いものの扱いは由来で決める。
 *
 * **母集団比較では見えない。** A1111 由来312件のうち302件（96.8%）が
 * 「記載なし＝既定 GPU」で、一様にかかる要因は群間比較で検出できない。
 * 同一 seed の A/B だけが手がかりになる。
 */
const RECORDED_RNG_TO_SMZ = { CPU: 'cpu', GPU: 'gpu', NV: 'nv' };

/**
 * Civitai のオンサイト生成器が付けるジョブ項目。ローカルの A1111/Forge は
 * 書かない。生成器は ComfyUI 系なので、こちらの原本は CPU ノイズになる。
 */
const CIVITAI_JOB_KEYS = [
    'engine', 'process', 'quantity', 'aspectRatio',
    'browsingLevel', 'disablePoi', 'experimental', 'priority', 'nsfw',
];
const CIVITAI_JOB_KEY_THRESHOLD = 3;

function isCivitaiOnsiteGeneration(recipe) {
    const meta = recipe?.generation_metadata;
    if (!meta || typeof meta !== 'object') return false;
    const hits = CIVITAI_JOB_KEYS.filter(key => meta[key] !== undefined).length;
    return hits >= CIVITAI_JOB_KEY_THRESHOLD;
}

/**
 * 記録された乱数源。無ければ**由来が確かなときだけ** A1111 の既定 GPU と読む。
 *
 * **一律に既定を当ててはならない。** A1111 の既定は GPU だが、この題名の
 * 付き方をする記録には Civitai のオンサイト生成器（ComfyUI 系＝CPU ノイズ）が
 * 混ざっており、当てると退行する。実測（同一 seed の A/B・ユーザー目視）:
 *
 * **全71件をユーザーが目視した結果**（現状=A / 修正後=B / 差なし=C）:
 *   B 33件（うち24件は「元画像にかなり近い」）／ C 29件 ／ A 9件
 *   A の9件は `Version` が **ComfyUI が8件**。つまり元画像が ComfyUI 製で、
 *   あちらは CPU ノイズが原本。B 側で `Version: ComfyUI` は1件しかない。
 *   除外すると**退行8件を防ぎ、失う改善は1件**。
 *
 * したがって「ローカル由来」は次の3条件をすべて満たすものに限る。
 *   ① `Version:` がある（実装が自分の名前を書いている）
 *   ② その値が `ComfyUI` で始まらない
 *   ③ Civitai のジョブ項目が3個未満
 * 不明な群は動かさない — 動かす根拠が無いなら現状が既定である。
 */
function recordedNoiseSource(recipe) {
    const parameters = findA1111Parameters(recipe);
    if (!parameters) return null;

    const raw = parameterValue(parameters, 'RNG').toUpperCase();
    const recorded = RECORDED_RNG_TO_SMZ[raw] ?? null;
    if (recorded) return recorded;

    return isLocallyAuthoredRecord(recipe) ? 'gpu' : null;
}

/**
 * その記録を**ローカルの A1111 / Forge が書いたか**（乱数源の判定用・厳格版）。
 *
 * 上の3条件をそのまま関数にしたもので、**挙動は変えていない**。
 * この厳しさは 71枚の目視で較正されている（緩めると退行8件が戻る）ので、
 * 乱数源以外の用途で流用するときも**この関数自体は緩めない**。
 */
export function isLocallyAuthoredRecord(recipe) {
    const parameters = findA1111Parameters(recipe);
    if (!parameters) return false;
    const version = parameterValue(parameters, 'Version');
    if (!version) return false;
    if (/^comfyui/i.test(version)) return false;
    if (isCivitaiOnsiteGeneration(recipe)) return false;
    return true;
}

/** ComfyUI が書いた記録であることの決定的な徴候。どちらか1つで確定。 */
function isComfyUiAuthoredRecord(recipe) {
    const parameters = findA1111Parameters(recipe);
    if (parameters && /^comfyui/i.test(parameterValue(parameters, 'Version') || '')) return true;
    // 埋め込みワークフローを持っていれば、そのプロンプトは ComfyUI が書いたもの。
    return Boolean(findEmbeddedPrompt(recipe));
}

/** A1111 が書いた本文の書式（`Negative prompt:` 行＋`Steps:`／`Sampler:`）。 */
function hasA1111ParameterShape(recipe) {
    const parameters = findA1111Parameters(recipe);
    if (typeof parameters !== 'string' || !parameters) return false;
    return /(^|\n)\s*Negative prompt:/i.test(parameters)
        && /Steps:\s*\d+/i.test(parameters)
        && /Sampler:/i.test(parameters);
}

/**
 * その記録の生成器が**裸の埋め込み名を解決していたか**。
 *
 * **乱数源とは別の問いである。** あちらは「A1111 の既定 GPU を当ててよいか」で、
 * 判らない群に当てると実測で8件退行した。こちらは「`easynegative` と書いた語が
 * 埋め込みとして効いていたか」で、**A1111 系の書式で書かれていれば効いていた**。
 * 同じ述語を使い回すと、乱数源側の較正（71枚の目視）を壊すか、
 * 埋め込み側を過剰に絞るかのどちらかになる。実測では後者だった——
 * 厳格版だと該当28件中6件しか救えず、落ちる22件のうち20件は
 * **`Version:` の記載が無いだけ**で、18件は A1111 書式そのものだった。
 *
 * 除外は「ComfyUI が書いたと確定できるもの」と「Civitai オンサイト」だけにする。
 * ComfyUI では裸の語は最初から埋め込みではないので、当てると改悪になる
 * （実測3件が埋め込みワークフロー持ち・1件が `Version: ComfyUI`）。
 */
function recordResolvesBareEmbeddings(recipe) {
    if (isComfyUiAuthoredRecord(recipe)) return false;
    if (isCivitaiOnsiteGeneration(recipe)) return false;
    return isLocallyAuthoredRecord(recipe) || hasA1111ParameterShape(recipe);
}

/** smZ Settings は既定なしで pop する入力があるので、object_info の既定で全部埋める。 */
function smzSettingsDefaults(objectInfo) {
    const optional = objectInfo?.['smZ Settings']?.input?.optional;
    if (!optional) return null;
    const inputs = {};
    for (const [name, spec] of Object.entries(optional)) {
        const options = Array.isArray(spec) ? spec[1] : null;
        if (options && Object.prototype.hasOwnProperty.call(options, 'default')) {
            inputs[name] = options.default;
        } else if (Array.isArray(spec) && Array.isArray(spec[0])) {
            inputs[name] = spec[0][0];
        } else {
            inputs[name] = '';
        }
    }
    return inputs;
}

function applyRecordedNoiseSource(prompt, recipe, objectInfo, warnings, source) {
    // 埋め込みグラフは ComfyUI で作られたものなので、ComfyUI のノイズが原本。
    // ここへ挟むと、いま不良率 0.0% の群（実測22件）を壊す。
    if (source === 'embedded') return;

    const parameters = findA1111Parameters(recipe);
    if (!parameters) return;

    // **ノードを足すこと自体が無害なのは非 ancestral のときだけ**（実測）。
    // smZ Settings が在ると smZNodes は `default_noise_sampler` を自前の
    // 実装へ差し替えるので、ancestral / SDE 系では毎ステップのノイズ列が
    // 変わる。既定値のまま挟んだ対照は、非 ancestral（`dpmpp_2m`）では
    // **画素完全一致**だったが、`Euler a` では**変化画素 99.89%**で、
    // 元画像との構造一致は 0.328 → **0.152 へ悪化**した。
    //
    // したがって「記録された ENSD を渡したいから挟む」は割に合わない。
    // ENSD 単独のために乱数実装ごと入れ替えると、記録に無い変更の方が
    // 大きくなる。**乱数源を動かすときだけ挟み、ENSD はそこへ相乗りさせる。**
    //
    // なお `cpu` は ComfyUI の既定と**ビット一致**する（smZ 自身が
    // 「randn_source='cpu' は comfy.sample.prepare_noise を再現する」と明記し、
    // 非 ancestral の対照で画素一致を確認済み）。挟む理由が無い。
    const noiseSource = recordedNoiseSource(recipe);
    if (!noiseSource || noiseSource === 'cpu') return;
    // 記録そのものか、由来からの読みかを利用者へ区別して伝える。
    const wasRecorded = Boolean(parameterValue(parameters, 'RNG'));

    // smZ を当てない系統には挟まない（`applyA1111PromptParser` と同じ境界）。
    // CLIP でないエンコーダで smZ が落ちる実測があり、系統をまたいで既定を
    // 持ち出さない方針をここでも守る。
    if (unetArchitecture(recipe)) return;

    // **`nosmz` の上書きはこの節にも効かせる。** テキストエンコード側だけ smZ を外して
    // `smZ Settings` を残すと、**実測した「smZなし」と違う物ができる**。
    // このノードは存在するだけで `default_noise_sampler` を差し替え、ancestral / SDE で
    // 初期ノイズが変わる（対象16件中14件が ancestral）。前セッションはまさにこれを
    // 残したまま対照を取り、構造一致が 0.446 から動かないのを見て
    // 「smZ は効いている」と誤読しかけた。**2026-08-12 の実測で、smZ の害の本体は
    // 強調解釈でも平均正規化でもなくこの経路だと確定している**ので、外すなら両方外す。
    if (replayOverrideValue(recipe, 'text_encoder') === 'nosmz') return;

    const defaults = smzSettingsDefaults(objectInfo);
    if (!defaults) {
        warnings.push(
            t(wasRecorded ? 'core.recipeWorkflowBuilder.82' : 'core.recipeWorkflowBuilder.83', { p1: noiseSource.toUpperCase() })
        );
        return;
    }

    const samplers = Object.entries(prompt).filter(([, node]) => /ksampler/.test(normalizedClassType(node?.class_type)));
    if (samplers.length === 0) return;

    // ENSD は乱数源を渡すついでに相乗りさせる（単独では挟まない）。
    const ensd = firstRecordedNumber(parameterValue(parameters, 'ENSD'));
    const inputs = { ...defaults, RNG: noiseSource };
    if (ensd !== null) inputs.ENSD = ensd;

    // 同じ供給元は1つの Settings を共有する（段が増えても分岐させない）。
    const byModelRef = new Map();
    let nextId = 800;
    let applied = 0;
    for (const [, node] of samplers) {
        const modelRef = node.inputs?.model;
        if (!Array.isArray(modelRef)) continue;
        const key = `${modelRef[0]}:${modelRef[1]}`;
        if (!byModelRef.has(key)) {
            const id = String(nextId++);
            prompt[id] = {
                inputs: { ...inputs, '*': modelRef },
                class_type: 'smZ Settings',
                _meta: { title: `Settings (smZ) RNG=${noiseSource}` },
            };
            byModelRef.set(key, id);
            applied += 1;
        }
        node.inputs.model = [byModelRef.get(key), 0];
    }

    if (applied > 0 && Array.isArray(warnings)) {
        warnings.push(
            (wasRecorded
                ? t('core.recipeWorkflowBuilder.58', { p1: noiseSource.toUpperCase() })
                : t('core.recipeWorkflowBuilder.59'))
            + t(wasRecorded ? 'core.recipeWorkflowBuilder.84' : 'core.recipeWorkflowBuilder.85')
            + (ensd === null ? '' : t('core.recipeWorkflowBuilder.61', { p1: ensd }))
        );
    }
}

function insertAdetailerStages(prompt, recipe, warnings, objectInfo, resolvedSampler, gen,
                               installedEmbeddings = []) {
    const stages = parseAdetailerStages(findA1111Parameters(recipe));
    if (stages.length === 0) return;

    // 最終画像を出しているノードを探す（SaveImage / PreviewImage の入力元）。
    const sinks = Object.entries(prompt).filter(([, node]) =>
        /^(?:saveimage|previewimage|saveimagewebsocket)/.test(normalizedClassType(node?.class_type))
    );
    if (sinks.length === 0) return;
    const imageRef = sinks[0][1]?.inputs?.images;
    if (!Array.isArray(imageRef)) return;

    const modelRef = findInputReference(prompt, 'model');
    const clipRef = findInputReference(prompt, 'clip');
    const vaeRef = findInputReference(prompt, 'vae');
    const positiveRef = findConditioningReference(prompt, true);
    const negativeRef = findConditioningReference(prompt, false);
    if (!modelRef || !clipRef || !vaeRef || !positiveRef || !negativeRef) {
        warnings.push(t('core.recipeWorkflowBuilder.62'));
        return;
    }

    let nextId = 700;
    let current = imageRef;
    const applied = [];
    const skipped = [];
    const unappliedStageLoras = [];
    let stagePromptCount = 0;
    // 段専用プロンプトで埋め込み名を直した数。まとめて1件だけ警告する
    // （段ごとに出すと同じ文言が並び、riskCount の分類も重複して膨らむ）。
    let qualifiedStagePrompts = 0;

    for (const stage of stages) {
        const modelName = resolveDetectorModel(stage.model, objectInfo);
        if (!modelName) { skipped.push(stage.model); continue; }

        const detectorId = String(nextId++);
        const detailerId = String(nextId++);
        prompt[detectorId] = {
            class_type: 'UltralyticsDetectorProvider',
            inputs: { model_name: modelName },
            _meta: { title: `ADetailer detector (${stage.model})` },
        };

        // **段ごとの専用プロンプトを渡す。**
        // ADetailer は顔・手それぞれに専用のプロンプトを持てる（実測9件・
        // `"extremely detailed eyes, …"` `"finely drawn hand, …"`）。これまでは
        // 本体プロンプトをそのまま渡していたので、**顔の切り抜き段へシーン全体の
        // 記述を流し込んでいた**。記録に在るものを当てる。
        const stageConditioning = (text, isPositive) => {
            const raw = String(text ?? '').trim();
            if (!raw) return null;
            // `<lora:…>` は段ごとのLoRA鎖を組まないと当てられない。素のテキストへ
            // 残すとゴミトークンになるので落とし、当てられなかった事実を言う。
            const extracted = extractPromptLoras(raw);
            /*
             * **埋め込み名をここでも `embedding:` 形へ直す。**
             * 本体プロンプトは clean → qualify の順で通しているのに、段専用
             * プロンプトは clean しか通していなかった。A1111 は裸の名前を
             * 埋め込みとして解決するが ComfyUI は解決せず、**ただの単語として
             * トークン化する**——しかも未知のモデル名と違って `value_not_in_list`
             * を出さないので、**投入は通って絵だけが静かに変わる**。
             *
             * 実害が最も出るのがこの経路である。ADetailer は顔と手の描き直し段で、
             * そこへ渡る `lazyhand`（手を直す埋め込み）や `lazyneg` が丸ごと
             * 効いていなかった。実測7件・**うち6件（85.7%）が不良ラベル**
             * （母集団の基準不良率 21.1%）。
             */
            const cleaned = qualifyEmbeddingNames(
                cleanPromptText(extracted.text), recipe, null, installedEmbeddings).trim();
            if (cleaned !== cleanPromptText(extracted.text).trim()) qualifiedStagePrompts += 1;
            if (!cleaned) return null;
            if (extracted.loras.length > 0) {
                unappliedStageLoras.push(...extracted.loras.map(l => l?.name || l?.file_name).filter(Boolean));
            }
            const id = String(nextId++);
            prompt[id] = {
                class_type: 'CLIPTextEncode',
                inputs: { text: cleaned, clip: clipRef },
                _meta: { title: `ADetailer ${applied.length + 1} ${isPositive ? 'positive' : 'negative'}` },
            };
            return [id, 0];
        };
        const stagePositive = stageConditioning(stage.prompt, true) ?? positiveRef;
        const stageNegative = stageConditioning(stage.negativePrompt, false) ?? negativeRef;
        if (stagePositive !== positiveRef) stagePromptCount += 1;
        prompt[detailerId] = {
            class_type: 'FaceDetailer',
            inputs: {
                image: current,
                model: modelRef, clip: clipRef, vae: vaeRef,
                positive: stagePositive, negative: stageNegative,
                bbox_detector: [detectorId, 0],
                guide_size: 512, guide_size_for: true, max_size: 1024,
                seed: normalizeSeed(gen?.seed),
                steps: Number.isFinite(Number(gen?.steps)) ? Number(gen.steps) : 20,
                cfg: Number.isFinite(Number(gen?.cfg_scale)) ? Number(gen.cfg_scale) : 8,
                sampler_name: resolvedSampler?.sampler || 'euler',
                scheduler: resolvedSampler?.scheduler || 'normal',
                denoise: Number.isFinite(stage.denoise) ? stage.denoise : 0.4,
                feather: Number.isFinite(stage.maskBlur) ? stage.maskBlur : 5,
                noise_mask: true, force_inpaint: true,
                bbox_threshold: Number.isFinite(stage.confidence) ? stage.confidence : 0.5,
                bbox_dilation: Number.isFinite(stage.dilate) ? stage.dilate : 10,
                bbox_crop_factor: 3,
                sam_detection_hint: 'center-1', sam_dilation: 0, sam_threshold: 0.93,
                sam_bbox_expansion: 0, sam_mask_hint_threshold: 0.7,
                sam_mask_hint_use_negative: 'False',
                drop_size: 10, wildcard: '', cycle: 1,
            },
            _meta: { title: `ADetailer ${applied.length + 1}` },
        };
        current = [detailerId, 0];
        applied.push(`${stage.model} (denoise ${Number.isFinite(stage.denoise) ? stage.denoise : 0.4})`);
    }

    if (applied.length === 0) {
        warnings.push(
            t('core.recipeWorkflowBuilder.63', { p1: skipped.join(' / ') })
        );
        return;
    }

    // 最終出力を再描画後の画像へ差し替える。
    for (const [, node] of sinks) {
        if (sameReference(node.inputs?.images, imageRef)) node.inputs.images = current;
    }
    warnings.push(
        t('core.recipeWorkflowBuilder.64', { p1: applied.length, p2: applied.join(' / ') })
        + (stagePromptCount ? t('core.recipeWorkflowBuilder.65', { p1: stagePromptCount }) : '')
        + (skipped.length ? t('core.recipeWorkflowBuilder.66', { p1: skipped.length, p2: skipped.join(' / ') }) : '')
        + (qualifiedStagePrompts
            ? t('core.recipeWorkflowBuilder.67', { p1: qualifiedStagePrompts })
            : '')
    );
    if (unappliedStageLoras.length) {
        // 段ごとのLoRA鎖は組んでいないので、当てられなかった事実を黙って落とさない。
        warnings.push(
            t('core.recipeWorkflowBuilder.68', { p1: [...new Set(unappliedStageLoras)].join(' / ') })
        );
    }
}

/** グラフから MODEL / CLIP / VAE の供給元リンクを1つ拾う。 */
function findInputReference(prompt, kind) {
    const wanted = { model: 'model', clip: 'clip', vae: 'vae' }[kind];
    // KSampler / CLIPTextEncode / VAEDecode が実際に使っている参照を採る。
    for (const node of Object.values(prompt)) {
        const value = node?.inputs?.[wanted];
        if (Array.isArray(value) && value.length === 2) return value;
    }
    return null;
}

/** ポジ／ネガの CONDITIONING 参照を拾う。 */
function findConditioningReference(prompt, positive) {
    for (const node of Object.values(prompt)) {
        if (!/KSampler/i.test(node?.class_type || '')) continue;
        const value = node?.inputs?.[positive ? 'positive' : 'negative'];
        if (Array.isArray(value) && value.length === 2) return value;
    }
    return null;
}

function optimizeSingleBatchSlice(prompt, warnings) {
    for (const [sliceId, sliceNode] of Object.entries(prompt)) {
        if (normalizedClassType(sliceNode?.class_type) !== 'latentfrombatch') continue;
        const sourceRef = sliceNode?.inputs?.samples;
        const batchIndex = Number(sliceNode?.inputs?.batch_index);
        const length = Number(sliceNode?.inputs?.length ?? 1);
        if (!Array.isArray(sourceRef) || !Number.isInteger(batchIndex) || batchIndex < 0 || length !== 1) continue;
        const sourceNode = prompt[String(sourceRef[0])];
        if (!sourceNode || !isEmptyLatentClass(sourceNode.class_type)) continue;
        if (Number(sourceNode?.inputs?.batch_size) <= 1) continue;

        for (const node of Object.values(prompt)) {
            for (const [key, value] of Object.entries(node?.inputs || {})) {
                if (!sameReference(value, [sliceId, 0])) continue;
                node.inputs[key] = [...sourceRef];
                if (/KSampler/i.test(node.class_type || '')) {
                    if (Number.isFinite(Number(node.inputs.seed))) node.inputs.seed = normalizeSeed(node.inputs.seed) + batchIndex;
                    if (Number.isFinite(Number(node.inputs.noise_seed))) node.inputs.noise_seed = normalizeSeed(node.inputs.noise_seed) + batchIndex;
                }
            }
        }
        sourceNode.inputs.batch_size = 1;
        delete prompt[sliceId];
        warnings.push(t('core.recipeWorkflowBuilder.69', { p1: batchIndex + 1 }));
    }
}

export function buildRecipeWorkflow(recipe, options = {}) {
    if (!recipe || typeof recipe !== 'object') throw new Error('Recipe data is required');

    const warnings = [];
    /**
     * **手元に無かったノードの名前**（2026-08-28）。
     *
     * 名前は**環境ごとに違う**ので、表に持たない。ここで `object_info` と
     * 突き合わせて実際に無かった物だけを載せ、上へ返す。
     */
    let missingNodes = [];
    let replayManifest = getReplayManifest(recipe, options, warnings);
    const rawA1111Parameters = findA1111Parameters(recipe);
    const resourceStack = parseResourceStackGraph(rawA1111Parameters);
    const promptLoras = extractPromptLoras(recipe?.gen_params?.prompt);
    // 必須LoRAの整合が取れない manifest も、throw で全体を止めず
    // カタログ経路へ落とす（強度競合・重複ID等。厳密さより再現の継続を取る）。
    // manifest 自体も無効化する — 残すと embedded 経路の insertLoras スキップや
    // 監査が「壊れた manifest」を根拠に動いてしまう。
    let manifestLoras = null;
    try {
        manifestLoras = requiredManifestLoras(replayManifest);
    } catch (error) {
        warnings.push(
            t('core.recipeWorkflowBuilder.70', { p1: error.message })
        );
        replayManifest = null;
    }
    /*
     * レシピが記録していない埋め込みを、**導入済み一覧から補う**。
     *
     * A1111 は裸の名前を埋め込みとして解決するが ComfyUI はしない。記録側が
     * 名前を持っていなければ従来は直しようがなく、実測28件が素の単語のまま
     * 渡っていた（不良率 39.3% 対 対照 19.4%）。導入済み一覧を見れば補える。
     *
     * **ComfyUI 由来の記録には当てない。** あちらでは裸の語は最初から
     * 埋め込みではないので、当てると改悪になる。
     */
    const installedEmbeddings = recordResolvesBareEmbeddings(recipe)
        ? installedEmbeddingBasenames(options?.embeddings)
        : [];

    /*
     * **導入済み判定は実行側と同じ `nameIsInstalled` を使う。**
     * 別実装にすると「同定できた」と読んだものが投入で拒否される
     * （判定側と実行側で正規化を共有する）。
     */
    const loraNameChoices = nodeChoices(options?.objectInfo, 'LoraLoader', 'lora_name');
    const isInstalledLoraName = Array.isArray(loraNameChoices)
        && loraNameChoices.every(choice => typeof choice === 'string')
        ? name => nameIsInstalled(loraNameChoices, name)
        : null;
    const catalogLoras = mergePromptLoras(
        applyA1111LoraWeights(recipe.loras, rawA1111Parameters),
        promptLoras.loras,
        {
            promptAuthoritative: Boolean(rawA1111Parameters),
            isInstalledName: isInstalledLoraName,
            warnings,
            // **同じ A1111 メタデータの、より完全な申告。** タグに出てこない
            // LoRA でも、ここに版IDが在るなら使われている。
            declaredVersionIds: declaredLoraVersionIds(rawA1111Parameters),
        }
    );

    const effectiveRecipe = {
        ...recipe,
        gen_params: {
            ...(recipe.gen_params || {}),
            prompt: qualifyEmbeddingNames(
                cleanPromptText(promptLoras.text), recipe, warnings, installedEmbeddings
            ),
            negative_prompt: qualifyEmbeddingNames(
                cleanPromptText(recipe?.gen_params?.negative_prompt), recipe, warnings,
                installedEmbeddings
            ),
        },
        // **空配列で置き換えない。**
        // requiredManifestLoras() は `required === true && kind === 'lora'` だけを
        // 拾うので、A1111 メタデータに `Civitai resources:` マーカーが無いレシピでは
        // 該当0件になり `[]` を返す。`[] ?? x` は `[]` なので、そのまま渡すと
        // **レシピが持つ LoRA カタログごと消える**（実測: LoRA保有287件中65件=22.6%が
        // LoraLoader 0本で生成されていた。警告も出ないので気づけない）。
        //
        // 逆に manifest が LoRA を**増やす**ケースも実在する（8件。1→4, 1→5, 6→8）ので、
        // manifest を無視する方向の修正は退行する。**required が0件のときだけ**
        // カタログ経路へ落とす。
        loras: capUnrecordedLoraStrengths(
            applyStackLoraStrengths(
                unionManifestWithCatalog(
                    catalogLoras.promptTagsUnidentifiable
                        ? dropUnidentifiableManifestLoras(manifestLoras, isInstalledLoraName)
                        : manifestLoras,
                    catalogLoras,
                    warnings,
                    isInstalledLoraName
                ),
                resourceStack
            ),
            recipe,
            warnings
        ),
    };

    // **記録された強度が model/clip で別値なら、両方をそのまま使う。**
    // これまで `strength` 1つを両方へ入れていたため、実測32本で clip 側が
    // 潰れていた（例: model 0.35 / clip 1 が両方 0.35 になっていた）。
    if (resourceStack && resourceStack.loraStrengths.size > 0) {
        const differing = effectiveRecipe.loras.filter(lora =>
            Number.isFinite(Number(lora?.strength_model))
            && Number.isFinite(Number(lora?.strength_clip))
            && Number(lora.strength_model) !== Number(lora.strength_clip)
        ).length;
        if (differing > 0) {
            warnings.push(
                t('core.recipeWorkflowBuilder.71', { p1: differing })
            );
        }
    }

    // resource-stack の18件は全て「既存画像を拡大して描き直す」構成で、
    // 入力画像は Civitai 上のURLでしか指されていない。手元には無いので
    // 白紙から引くしかないが、**構図が一致しない理由は言える**。
    if (resourceStack?.sourceImage) {
        const denoise = resourceStack.denoise;
        warnings.push(
            t('core.recipeWorkflowBuilder.72', { p1: denoise ?? t('core.value.unknown') })
        );
    }

    // manifest が LoRA を1本も必須と言っていないのにレシピは持っている、という
    // 食い違いは、上のフォールバックで実害こそ消えるが**食い違い自体は残る**。
    // 黙って埋めると、再現がずれても原因を辿る手がかりが無くなるので明示する。
    //
    // ただし**元のワークフローをそのまま実行する場合は言わない**。グラフが
    // LoRA を明示的に並べているので、manifest の有無は再現に影響しない。
    // 実測（2026-08-10 / グラフを持つ66レシピ）: 48件がこの警告だけで
    // 「完全ワークフロー」から「互換再構築」へ降格していた。
    if ((!manifestLoras || manifestLoras.length === 0)
        && Array.isArray(recipe?.loras) && recipe.loras.length > 0
        && replayManifest
        && !findEmbeddedPrompt(effectiveRecipe)) {
        warnings.push(
            t('core.recipeWorkflowBuilder.73', { p1: recipe.loras.length })
        );
    }

    let source = 'standard';
    let prompt = findEmbeddedPrompt(effectiveRecipe);
    // **元からタイル分割だったのか、こちらが切り替えたのか。**
    // 後で注意を出すときに要る——実測（2026-08-25 `civitai_137676446`）で、
    // **記録そのものが `VAEDecodeTiled`（tile_size 224）で書かれていた**のに
    // 「大きいので切り替えました」と言っていた。**やっていないことを言わない。**
    const cameTiled = Boolean(prompt) && Object.values(prompt)
        .some(node => String(node?.class_type || '') === 'VAEDecodeTiled');
    let a1111Parameters = null;

    if (prompt) {
        if (embeddedPromptNeedsRebuild(prompt, effectiveRecipe)) {
            prompt = standardPrompt(effectiveRecipe, warnings, options);
            warnings.push(t('core.recipeWorkflowBuilder.74'));
        } else {
            source = 'embedded';
            inlineLegacyConstants(prompt, warnings);
            repairAmbiguousAeVae(prompt, effectiveRecipe, warnings);
            // **不足検査より前に開く。** ここが後ろだと、運搬ノードが
            // 「手元に無い節」として先に引っ掛かり、**グラフ全体が標準の形へ
            // 組み直される**——LoRA だけの話が、構図ごと別物になる。
            expandCarriedLoras(prompt, options?.objectInfo, warnings);
            const validated = validateOrRepairEmbeddedPrompt(
                prompt,
                effectiveRecipe,
                options.objectInfo,
                warnings
            );
            prompt = validated.prompt;
            if (validated.rebuilt) source = 'standard';
            // **どのノードが手元に無かったかを、上へ返す。**
            // 画面はこれで「入れれば直る」を印にできる（名前は環境ごとに違うので、
            // 表に持たず、**その場で測った物だけ**を渡す）。
            missingNodes = validated.missingNodes || [];
        }
    } else if (rawA1111Parameters) {
        const features = a1111CompatibilityFeatures(rawA1111Parameters);
        const originalPrompt = effectiveRecipe.gen_params.prompt;
        effectiveRecipe.gen_params.prompt = String(originalPrompt || '')
            .replace(/<segment\b[^>]*>/gi, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim();
        prompt = standardPrompt(effectiveRecipe, warnings, options);
        if (isFluxRecipe(effectiveRecipe) || requiresStructuredA1111(rawA1111Parameters)) {
            const detected = features.length ? `（${features.join('、')}）` : '';
            warnings.push(t('core.recipeWorkflowBuilder.75', { p1: detected }));
        } else {
            // Clean, complete A1111 metadata can use ComfyUI's native importer.
            source = 'a1111';
            a1111Parameters = rawA1111Parameters;
        }
        // **img2img の出力を白紙1段で引いていることを黙って通さない。**
        // `Denoising strength` があるのに Hires 系が無いのは enable_hr=False、
        // つまり入力画像に対する img2img の記録。そこに書かれた `Size` は
        // 入力画像を経た**出力**で、白紙から1段で到達した実績ではない。
        // 入力画像は残っていないので再現はできないが、一致しない理由は言える。
        if (looksLikeImg2ImgOutput(rawA1111Parameters)) {
            const strength = parameterValue(rawA1111Parameters, 'Denoising strength');
            // 寸法が過大なら applyImg2ImgReconstruction が2段へ回して別に警告を出す。
            // ここは「入力画像が無い＝構図は一致しない」という事実だけを伝える。
            warnings.push(
                t('core.recipeWorkflowBuilder.76', { p1: strength || t('core.value.unknown') })
            );
        }
    } else {
        prompt = findCheckpointTemplate(effectiveRecipe);
        if (prompt) {
            source = 'checkpoint-template';
            warnings.push(t('core.recipeWorkflowBuilder.77'));
        } else {
            prompt = standardPrompt(effectiveRecipe, warnings, options);
            warnings.push(t('core.recipeWorkflowBuilder.78'));
        }
    }

    patchCheckpoint(prompt, effectiveRecipe.checkpoint);
    patchGenerationParameters(prompt, effectiveRecipe, warnings, source);
    // A manifest-backed embedded graph is evidence, not a template. Never
    // inject a new branch; strict audit will reject missing/disconnected LoRAs.
    if (!(replayManifest && source === 'embedded')) {
        insertLoras(prompt, effectiveRecipe.loras, warnings, source);
    }
    // Standard/A1111 reconstruction can also create a VAELoader from an
    // ambiguous `VAE: ae` value. Run the 4ch checkpoint guard after every
    // construction path, not only when an embedded Comfy prompt was found.
    repairAmbiguousAeVae(prompt, effectiveRecipe, warnings);
    optimizeSingleBatchSlice(prompt, warnings);
    // ADetailer の再描画段は最後に足す。最終画像が確定してからでないと
    // 差し替え先を特定できない。
    // sampler は patchGenerationParameters の中と同じ手順で解き直す
    // （あちらのスコープには出せないが、純粋関数なので同じ結果になる）。
    insertAdetailerStages(
        prompt, effectiveRecipe, warnings, options.objectInfo,
        applySdeSchedulerDefault(resolveSamplerAndScheduler(
            effectiveRecipe.gen_params?.sampler || resourceStack?.sampler,
            effectiveRecipe.gen_params?.scheduler || resourceStack?.scheduler
        ), null, effectiveRecipe),
        effectiveRecipe.gen_params,
        installedEmbeddings
    );
    // A1111系プロンプトの強調記法は、smZ があれば A1111 互換パーサで解釈する。
    // FaceDetailer もこの conditioning を参照するので、ADetailer 挿入より後で
    // 差し替えても同じノードIDを見ている限り両方に効く。
    applyA1111PromptParser(prompt, effectiveRecipe, options.objectInfo, warnings, source);

    // 記録された乱数源（`RNG`）と ENSD を反映する。`applyA1111PromptParser` の
    // 後ろに置く — smZ CLIPTextEncode への差し替えは conditioning 側で、
    // こちらは model 経路なので互いに干渉しないが、順序を固定して読みやすくする。
    applyRecordedNoiseSource(prompt, effectiveRecipe, options.objectInfo, warnings, source);

    // レシピはLoRAを持っているのに、組み上がったワークフローにはLoRAを当てる
    // ノードが1つも無い、という状態を黙って返さない。上の `insertLoras` は
    // manifest 付きの embedded では意図的に飛ばすので（埋め込みグラフは
    // テンプレートではなく証拠として扱う）、埋め込みグラフ側にもLoRAが無いと
    // **LoRA無しで生成される**。ノード種別は問わずに数える（rgthree や
    // LoraManager 独自ローダーも「当てている」に含める）。
    if (Array.isArray(effectiveRecipe.loras) && effectiveRecipe.loras.length > 0
        && !Object.values(prompt).some(node => /lora/i.test(node?.class_type || ''))) {
        warnings.push(
            t('core.recipeWorkflowBuilder.79', { p1: effectiveRecipe.loras.length })
        );
    }

    // **投げる前に、重い形であることを言う**（2026-08-24 実機の報告
    // 「civitai_87384188 が生成できません」）。
    //
    // 画素が 4.5M を超えると、こちらは**わざと**タイル分割の復号へ切り替える
    // （そうしないと VRAM に載らない）。ところが実測では、この形は環境によって
    // **事実上止まる**——`/interrupt` が効かず、再起動でしか消えない。
    // どちらへ倒しても外れる場面が在るので、**黙って投げない**。
    const tiledDecode = Object.values(prompt)
        .find(node => String(node?.class_type || '') === 'VAEDecodeTiled');
    if (tiledDecode) {
        // **縮めて出せるなら、そうする**（2026-08-25 利用者の指示）。
        // 記録どおりの寸法では復号できない機械が在り、そこでは**絵が1枚も出ない**。
        // 小さくても出るほうが、出ないより使える——ただし**小さいことは必ず言う。**
        const shrunk = capReplayPixels(prompt, options?.maxReplayPixels, warnings);
        if (!shrunk) {
            // **数字は書かない。** 節の中の `width`/`height` から見積もっていたが、
            // 切り替えを決めた画素数とは**別物**で、実測 1 メガピクセルと出た記録が
            // タイル分割になっていた（2026-08-25）。**当てにならない数字を添えるより、
            // 形と打ち手だけを言う。**
            warnings.push(t(cameTiled
                ? 'core.recipeWorkflowBuilder.tiledDecodeFromRecord'
                : 'core.recipeWorkflowBuilder.tiledDecode'));
        }
    }

    assertConditioningIsUsable(prompt);
    // 未導入のLoRAは外して実行可能にする。ベースモデルと違い、無くても描ける。
    // 外した分は返り値に載せる。判定と詳細から消えると、**足りない事実ごと
    // 見えなくなり**、ダウンロードの導線も失われるため。
    const droppedLoras = dropUnavailableLoras(prompt, options?.objectInfo, warnings);
    persistPreviewOnlyOutputs(prompt, effectiveRecipe, warnings);
    // **昇格の後に呼ぶ。** 昇格で作った SaveImage には既に名前が付いているので、
    // ここは「元から在って既定のままだった1つ」だけに効く。
    nameDefaultSaveOutputs(prompt, effectiveRecipe, options?.ownOutputs === true);
    // **最後に、モデル名を ComfyUI が返す実文字列へ揃える。** ここまでの経路は
    // 照合のためにパスを `/` へ正規化しており、その文字列がそのまま入力値として
    // 出ていた。ComfyUI の検証は完全一致なので、Windows のようにサブフォルダを
    // `\` で返す環境では `value_not_in_list` で**投入すら拒否される**。
    const realignedModelNames = alignModelNamesToCatalog(
        prompt, options?.objectInfo, options?.knownModelCatalog);

    return {
        prompt,
        source,
        missingNodes,
        droppedLoras,
        realignedModelNames,
        warnings,
        a1111Parameters,
        a1111Checkpoint: a1111Parameters
            ? (getResourceFilename(effectiveRecipe.checkpoint, 'Model') || null)
            : null,
        replayManifest,
    };
}
