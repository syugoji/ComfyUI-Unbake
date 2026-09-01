/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * ComfyUI-Unbake の一部。**この行の意味**——著作権の所在を明示してある限り、
 * 後から別のライセンスを足せる。表示が無いまま配ると、それが言いづらくなる。
 */
import { t } from '../i18n/index.js';
import { buildRecipeWorkflow, getResourceFilename } from './recipeWorkflowBuilder.js';
import {
    classifyMissing,
    fetchResourceAvailability,
    findCatalogEntry,
    getKnownModelCatalog,
    hasUndistributableBlock,
    unexplainedReasons,
} from './recipeMissingModels.js';
import { summarizeWarnings } from './recipeWarningSeverity.js';
import { installedNamesFrom } from './modelResolver.js';

// **`clip_nameN` は 4 まである。** `QuadrupleCLIPLoader`（HiDream 等）は
// clip_l / clip_g / t5xxl / llama の4本を取る。2 までしか見ていなかったため、
// `clip_name3` / `clip_name4` に入る未導入モデルが**一度も検査されず**、
// 「未導入0件・compatible」と表示しながら ComfyUI が投入を拒否していた
// （実測 2026-08-15・`Civitai_Recipe_72877227` の `llama_3.1_8b_instruct_fp8_scaled`）。
const MODEL_INPUTS = new Set([
    'ckpt_name', 'lora_name', 'unet_name', 'clip_name', 'clip_name1',
    'clip_name2', 'clip_name3', 'clip_name4', 'vae_name', 'control_net_name', 'model_name',
]);

// **`/object_info` も埋め込み一覧も、ここでは取りに行かない。**
// 元は `getComfyObjectInfo()` / `getComfyEmbeddings()` がモジュール内で
// 大域の HTTP 呼び出しを直接使い、プロセス内キャッシュまで抱えていた。
// フォークの外へ出した時点でその2本が唯一の環境依存だったので、
// **呼び手が引数で渡す形へ揃えた**（判定側 `auditReplayManifest` は元から引数で受けている）。
// 取得とキャッシュはホスト側（`web/host/comfyHost.js`）の責務。

function normalizedPath(value) {
    return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
}

function basename(value) {
    return normalizedPath(value).split('/').at(-1) || '';
}

function stem(value) {
    return basename(value).replace(/\.[^.]+$/, '');
}

function compactStem(value) {
    return stem(value).replace(/[^a-z0-9]+/g, '');
}

/**
 * 既知モデル台帳の別名で照合する。
 *
 * A1111 は "R-ESRGAN 4x+ Anime6B"、ComfyUI は
 * "RealESRGAN_x4plus_anime_6B.pth" と同じ物を別名で呼ぶ。記号を潰す
 * 正規化では届かないので、台帳の別名表が要る。これが無いと
 * **ダウンロードしたのに「未導入」のまま**になる（実際にそうなっていた）。
 */
function catalogAliasMatches(requested, choices, catalog) {
    if (!catalog) return [];
    const entry = findCatalogEntry(catalog, requested);
    if (!entry?.filename) return [];
    const wanted = compactStem(entry.filename);
    return choices.filter(choice => compactStem(choice) === wanted);
}

/**
 * SDXL系VAEの**改変版**。`sdxl_vae` とは別ファイルなので、
 * **満たされたことにはしない**（2026-08-15 ユーザー判断）。
 *
 * 以前はこれらを `sdxl_vae` で代用可能と見なしていたため、判定は `compatible`
 * なのに ComfyUI が `value_not_in_list` で投入を拒否する食い違いが出ていた。
 * 代用して通すと「記録どおりに再現した」という言葉の意味が変わる。
 * 導入済みの近い系統は**診断としてだけ**伝える（`installedFamilyNeighbours`）。
 */
const SDXL_VAE_VARIANTS = new Set(['sdxlvaefixed', 'fixfp16errorssdxllowermemoryusev10']);

/** 満たしはしないが、利用者へ伝える価値のある「近い系統の導入済みファイル」。 */
function installedFamilyNeighbours(inputName, requested, choices) {
    if (inputName !== 'vae_name') return [];
    if (!SDXL_VAE_VARIANTS.has(compactStem(requested))) return [];
    return choices.filter(choice => compactStem(choice) === 'sdxlvae');
}

function compatibleFamilyMatches(inputName, requested, choices) {
    const compact = compactStem(requested);
    if (inputName === 'vae_name' && compact === 'sdxlvae') {
        return choices.filter(choice => compactStem(choice) === 'sdxlvae');
    }
    if (/^clip_name[0-9]*$/.test(inputName) && compact.startsWith('t5xxl')) {
        return choices.filter(choice => compactStem(choice).startsWith('t5xxl'));
    }
    return [];
}

/**
 * 同じ名前が置き場の複数箇所に在るとき、**1つに決める。**
 *
 * **同名で複数在ることは「無い」ではない。** 元は「候補がちょうど1つ」の
 * ときだけ導入済みと見なしていたので、同じファイルが下位フォルダと直下の
 * 両方に在ると**不足**と出た——そして落とそうとすると「既にある」と言われる。
 * 実データで踏んだ（2026-08-23 利用者の報告・8件がこれ）:
 *
 *   Illustrious\poses\finger_frame_il_d16.safetensors  ← 元から在る
 *   finger_frame_il_d16.safetensors                     ← 直下（過去の取得が作った）
 *
 * **取り違えの心配は小さい。** 名前が同じモデルファイルは、まず同じ中身である。
 * 逆に「無い」と言い続けると、押すたびに3つ目の複製を作りに行く。
 *
 * 選び方は**決め打ちで再現できること**——同じ入力なら毎回同じ答えになる。
 * 求められた綴りに一致するものを最優先し、次に置き場の浅い方（直下）、
 * 最後に名前順にする。
 */
function pickOne(matches, requested) {
    if (matches.length <= 1) return matches;
    const wanted = normalizedPath(requested);
    const exact = matches.filter(choice => normalizedPath(choice) === wanted);
    if (exact.length) return [exact[0]];
    const depth = (choice) => normalizedPath(choice).split('/').length;
    return [[...matches].sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : 1))[0]];
}

function modelMatches(inputName, requested, choices, catalog = null) {
    const exact = choices.filter(choice => normalizedPath(choice) === normalizedPath(requested));
    if (exact.length >= 1) return pickOne(exact, requested);
    const byBasename = choices.filter(choice => basename(choice) === basename(requested));
    if (byBasename.length >= 1) return pickOne(byBasename, requested);
    const byStem = choices.filter(choice => stem(choice) === stem(requested));
    if (byStem.length >= 1) return pickOne(byStem, requested);
    const byAlias = catalogAliasMatches(requested, choices, catalog);
    if (byAlias.length === 1) return byAlias;
    return compatibleFamilyMatches(inputName, requested, choices);
}

function inspectBuiltWorkflow(built, objectInfo, catalog = null) {
    const fatal = [];
    const compatible = [];
    const missingModels = [];
    const outputIds = Object.entries(built.prompt || {})
        .filter(([, node]) => objectInfo?.[node?.class_type]?.output_node === true)
        .map(([id]) => id);
    const reachable = new Set();
    const pending = [...outputIds];
    while (pending.length > 0) {
        const id = String(pending.pop());
        if (reachable.has(id) || !built.prompt?.[id]) continue;
        reachable.add(id);
        for (const value of Object.values(built.prompt[id]?.inputs || {})) {
            if (Array.isArray(value) && value.length >= 2 && built.prompt[String(value[0])]) {
                pending.push(String(value[0]));
            }
        }
    }

    const auxiliary = [];
    for (const [id, node] of Object.entries(built.prompt || {})) {
        if (!reachable.has(id)) continue;
        const info = objectInfo?.[node?.class_type];
        if (!info) {
            fatal.push(t('core.recipeReplayCapability.1', { p1: node?.class_type || 'Unknown' }));
            continue;
        }
        const inputs = node.inputs || {};
        for (const inputName of Object.keys(info?.input?.required || {})) {
            if (!(inputName in inputs) || inputs[inputName] === null || inputs[inputName] === undefined) {
                fatal.push(t('core.recipeReplayCapability.2', { p1: node.class_type, p2: inputName }));
            }
        }
        const specs = { ...(info?.input?.optional || {}), ...(info?.input?.required || {}) };
        for (const [inputName, value] of Object.entries(inputs)) {
            if (!MODEL_INPUTS.has(inputName) || typeof value !== 'string' || !value.trim()) continue;
            const spec = specs?.[inputName];
            const choices = Array.isArray(spec?.[0])
                ? spec[0]
                : (spec?.[0] === 'COMBO' && Array.isArray(spec?.[1]?.options)
                    ? spec[1].options
                    : null);
            if (!choices || !choices.every(choice => typeof choice === 'string')) continue;
            const matched = modelMatches(inputName, value, choices, catalog);
            // **チェックポイントとLoRAは画面の別欄が既に出している。**
            // ここで集めるのは「構成から逆算されるだけで、どこにも出ていない」もの
            // ——テキストエンコーダ・VAE・拡大器。導入済みでも見えないと、
            // 何が入ったのかを確かめる手段が無い（2026-08-15 ユーザー指摘）。
            if (!AUXILIARY_INPUTS.has(inputName)) {
                if (matched.length === 1) continue;
            } else {
                auxiliary.push({
                    name: value,
                    resolvedName: matched.length === 1 ? matched[0] : null,
                    inputName,
                    classType: node.class_type,
                    folder: modelInputFolder(node.class_type, inputName),
                    installed: matched.length === 1,
                });
                if (matched.length === 1) continue;
            }
            // **LoRA だけは致命にしない。** 組み立ての側は手元に無い LoraLoader を
            // 鎖から外して組める（`dropUnavailableLoras`）ので、**外して似た絵は出る**
            // ——それが「近似」の意味。checkpoint・VAE・テキストエンコーダは土台なので、
            // 無ければ似た絵も出ない（今までどおり致命）。
            //
            // 「LoRA を外すと真っ白になる」場合（プロンプトが LoRA タグだけ）は
            // **別の検査が今も致命として落とす**ので、ここを緩めても素通りしない。
            const droppable = modelInputFolder(node.class_type, inputName) === 'loras';
            const reason = droppable
                ? t('core.recipeReplayCapability.loraMissing', { p1: value })
                : t('core.recipeReplayCapability.3', { p1: value });
            if (droppable) compatible.push(reason);
            else fatal.push(reason);
            const neighbours = installedFamilyNeighbours(inputName, value, choices);
            missingModels.push({
                name: value,
                inputName,
                classType: node.class_type,
                folder: modelInputFolder(node.class_type, inputName),
                reason,
                // **代用しない理由を、利用者に分かる言葉で残す。**
                // 「入手先が判っていません」だけだと、近い物が入っているのに
                // なぜ使わないのかが伝わらない。
                ...(neighbours.length ? {
                    why: t('core.recipeReplayCapability.4', { p1: neighbours.join(' / ') }),
                } : {}),
            });
        }
    }

    if (outputIds.length === 0) fatal.push(t('core.recipeReplayCapability.5'));
    return {
        fatal: [...new Set(fatal)],
        compatible: [...new Set(compatible)],
        missingModels: [...new Map(missingModels.map(item => [item.reason, item])).values()],
        auxiliary: [...new Map(
            auxiliary.map(item => [`${item.classType}.${item.inputName}:${item.name}`, item])
        ).values()],
    };
}

/**
 * 「再現不可」を、**打つ手が違う4つ**へ割る。
 *
 * これまで再現不可は一括表示だった。だが実測（2026-08-10 / 全339レシピ）で
 * 中身はまるで違っていた:
 *
 *   モデルを落とすだけで直る : 29件（再現不可87件の33%）
 *   入手先が判っていない     : 28件
 *   手動導入が要る           :  3件
 *   生成の記録が無い         : 27件 ← モデルを揃えても永久に直らない
 *
 * 一括で「再現不可」と出すと、**落とせば直る29件が埋もれ**、逆に記録の無い
 * 27件をユーザーが追いかけることになる。行動が変わる区別なので表に出す。
 */
/**
 * **`t()` を module 直下で呼ばない**（2026-09-01・走査8周目）。
 *
 * ここは `const BLOCKER_METADATA = { downloadable: { blockerLabel: t(...) } }` と
 * **読み込み時に訳を確定**していた。`t()` は呼んだ時点の `current` を見るが、
 * `setLocale()` を呼ぶのは `web/unbake.js:236`——**静的 import の module 本体は
 * 全部その前に走る**ので、ここで捕まるのは常に既定（英語）である。
 * 実測: import 時点 `"Waiting on models"` / `setLocale('ja')` 後 `"モデル待ち"`。
 * つまり**日本語の利用者に英語の札が出て、言語を切り替えても追随しない**。
 *
 * `web/core/*.js` で module 直下の `t()` はここだけだった。関数にして、
 * **使うたびに引く**。
 */
export function blockerMetadata(blocker) {
    if (!blocker) return null;
    return {
    downloadable: {
        blockerLabel: t('core.recipeReplayCapability.6'),
        blockerTitle: t('core.recipeReplayCapability.7'),
    },
    unobtainable: {
        blockerLabel: t('core.recipeReplayCapability.8'),
        blockerTitle: t('core.recipeReplayCapability.9'),
    },
    // **「入手先が判らない」と「入手先は判っているが配布されていない」は別物。**
    // 前者は調べれば見つかるかもしれないが、後者は Civitai に現物が無いと
    // 確認済みなので探すだけ無駄になる。実測（2026-08-13）で該当2件。
    undistributed: {
        blockerLabel: t('core.recipeReplayCapability.10'),
        blockerTitle: t('core.recipeReplayCapability.11'),
    },
    manual: {
        blockerLabel: t('core.recipeReplayCapability.12'),
        blockerTitle: t('core.recipeReplayCapability.13'),
    },
    norecord: {
        blockerLabel: t('core.recipeReplayCapability.14'),
        blockerTitle: t('core.recipeReplayCapability.15'),
    },
    nocheckpoint: {
        blockerLabel: t('core.recipeReplayCapability.16'),
        blockerTitle: t('core.recipeReplayCapability.17'),
    },
    }[blocker] || null;
}

/** 生成条件が1つでも残っているか。「記録なし」と「モデル未特定」の分かれ目。 */
const RECORD_KEYS = ['prompt', 'steps', 'seed', 'cfg_scale', 'sampler', 'size'];

function hasGenerationRecord(recipe) {
    const gen = recipe?.gen_params;
    if (!gen || typeof gen !== 'object') return false;
    return RECORD_KEYS.some(key => gen[key] !== undefined && gen[key] !== null && gen[key] !== '');
}

function classifyBlocker(level, reasons, missing, catalog, context = {}) {
    if (level !== 'unavailable') return null;
    const groups = classifyMissing(missing, catalog);
    // 配布されていないと確認できたものは、入手先不明と混ぜない。
    if (hasUndistributableBlock(groups)) return 'undistributed';
    if (groups.blocked.length > 0) return 'unobtainable';
    if (groups.manual.length > 0) return 'manual';
    // 「1件でもDLできる」ではなく「**DLで全部片付く**」で判定する。
    // モデル以外の遮断（プロンプト欠落など）が残るなら落としても直らない。
    if (groups.resolvableCount > 0
        && unexplainedReasons({ level, reasons, missing }).length === 0) {
        return 'downloadable';
    }
    // **「モデルが判らない」と「記録が無い」は別物。**
    // 実測（2026-08-10 / 全346レシピ）: 記録なし29件のうち7件は生成条件を
    // 持っていて、欠けているのはチェックポイントの特定だけだった
    // （例: ComfyUI_00183_ は prompt/steps/seed など8項目を保持）。
    // 元画像を今の実装で解析し直すと解決した実例があるので、同じ灰色で
    // 「直しようがない」側へ寄せない。
    // 生成条件ごと無いなら、モデルが判っても直らない（＝記録なし）。
    // 条件は残っていてモデルだけ判らないなら、取り込み直しで直ることがある。
    // **理由文だけでは区別できない**（どちらも同じ「チェックポイント情報が
    // ありません」を出す）ので、記録そのものの有無で分ける。
    const text = reasons.map(String).join(' / ');
    if (context.hasGenerationRecord && /チェックポイント情報がありません/.test(text)) {
        return 'nocheckpoint';
    }
    return 'norecord';
}

function result(level, reasons, built = null, audit = null, missing = emptyMissing(),
                catalog = null, context = {}) {
    const metadata = {
        exact: {
            label: t('core.recipeReplayCapability.18'), iconClass: 'fas fa-check-circle',
            title: t('core.recipeReplayCapability.19'),
        },
        compatible: {
            label: t('core.recipeReplayCapability.20'), iconClass: 'fas fa-tools',
            title: t('core.recipeReplayCapability.21'),
        },
        unavailable: {
            label: t('core.recipeReplayCapability.22'), iconClass: 'fas fa-ban',
            title: t('core.recipeReplayCapability.23'),
        },
    }[level];
    const blocker = classifyBlocker(level, reasons, missing, catalog, context);
    const blockerMeta = blockerMetadata(blocker);
    const headline = blockerMeta ? blockerMeta.blockerTitle : metadata.title;
    // **警告は「やったこと」であって「危うさ」ではない。** 実測（2026-08-10 /
    // 316レシピ）で98.7%が何らかの警告を持つため、件数では差がつかない。
    // 危険と判定した分だけを別に数える。
    const fidelity = summarizeWarnings(reasons.length ? reasons : built?.warnings);
    const lines = [headline, ...reasons];
    if (fidelity.riskCount > 0) {
        lines.push(t('core.recipeReplayCapability.24', { p1: fidelity.riskCount }), ...fidelity.risk, ...fidelity.unknown);
    }
    return {
        level,
        ...metadata,
        title: lines.join('\n'),
        blocker,
        blockerLabel: blockerMeta?.blockerLabel ?? null,
        fidelity,
        reasons,
        built,
        audit,
        missing,
        // **導入済みでも出す。** 何が使われているかを画面で確かめられないと、
        // ダウンロードしたものが入ったのかどうかも分からない。
        auxiliary: context.auxiliary || [],
    };
}

/**
 * 遮断要因を「何が無いか」の構造として返すための器。
 *
 * 理由は日本語の文字列なので、UI が「これはダウンロードで解決できる」と
 * 判断するには文字列を解析するしかなかった。解析は理由文を書き換えた瞬間に
 * 壊れるので、判定に使う事実は最初から構造で持つ。
 */
function emptyMissing() {
    return { models: [], resources: [], nodes: [] };
}

/** ComfyUI のウィジェット名から、そのファイルが置かれるフォルダを引く。 */
// 画面の別欄が出していないもの＝構成から逆算される補助モデル。
// `ckpt_name`（チェックポイント欄）と `lora_name`（LoRA欄）は除く。
const AUXILIARY_INPUTS = new Set([
    'unet_name', 'clip_name', 'clip_name1', 'clip_name2', 'clip_name3', 'clip_name4',
    'vae_name', 'control_net_name', 'model_name',
]);

const MODEL_INPUT_FOLDERS = {
    ckpt_name: 'checkpoints',
    lora_name: 'loras',
    unet_name: 'diffusion_models',
    clip_name: 'text_encoders',
    clip_name1: 'text_encoders',
    clip_name2: 'text_encoders',
    clip_name3: 'text_encoders',
    clip_name4: 'text_encoders',
    vae_name: 'vae',
    control_net_name: 'controlnet',
};

function modelInputFolder(classType, inputName) {
    if (inputName === 'model_name') {
        // model_name は複数ノードで使い回される名前で、ノード側でしか行き先が決まらない。
        if (classType === 'UpscaleModelLoader') return 'upscale_models';
        if (classType === 'UltralyticsDetectorProvider') return 'ultralytics';
        return null;
    }
    return MODEL_INPUT_FOLDERS[inputName] || null;
}

function normalizedHash(value) {
    const hash = String(value || '').trim().toLowerCase();
    return /^[a-f0-9]{8,64}$/.test(hash) ? hash : '';
}

function embeddedCheckpointHash(recipe) {
    const direct = normalizedHash(recipe?.gen_params?.model_hash || recipe?.gen_params?.modelHash);
    if (direct) return direct;
    const parameters = [
        recipe?.a1111_parameters,
        recipe?.metadata?.a1111_parameters,
        recipe?.raw_metadata?.parameters,
    ].find(value => typeof value === 'string' && value.trim());
    const match = parameters?.match(/(?:^|[,\n]\s*)Model hash\s*:\s*([a-f0-9]{8,64})/i);
    return normalizedHash(match?.[1]);
}

function resolvedCheckpointHash(recipe) {
    const checkpoint = recipe?.checkpoint || {};
    const direct = normalizedHash(checkpoint.hash || checkpoint.sha256);
    if (direct) return direct;
    const files = checkpoint?.civitai?.files;
    if (!Array.isArray(files)) return '';
    for (const file of files) {
        const hash = normalizedHash(file?.hashes?.SHA256 || file?.hashes?.sha256);
        if (hash) return hash;
    }
    return '';
}

function hashesConflict(left, right) {
    return Boolean(left && right && !left.startsWith(right) && !right.startsWith(left));
}

/**
 * `objectInfo` から出した LoRA の選択肢の**控え**（`I-20260829-02`）。
 *
 * **鍵は `objectInfo` そのもの**（`WeakMap` の同一性）。中身の指紋ではない。
 * 同じ物なら答えは同じ、別の物なら計算し直す——**陳腐化する余地が構造として無い**
 * ので、捨て時の設計が要らない。ホストは `/object_info` を取り直すたびに
 * 新しい物を作るので、モデルを入れた／消したときは自動で外れる。
 *
 * **前提**: `objectInfo` を**その場で書き換えない**こと。書き換えると古い答えが残る。
 * 現状ホストは応答をそのまま持ち回るだけで、書き換える箇所は無い。
 *
 * **なぜ要るか。** ここは記録1件ごとに `objectInfo` の**全ノード型**を舐めていた。
 * 実測（2026-08-30・実機 8188・ノード型 1,049 種）で判定は 3.05 ms/件、うち
 * この全走査が **0.48 ms/件＝18%**。効くのは今の 0.2 秒より、**利用者が拡張を
 * 増やすほど重くなる項を消す**ことのほう——費目が記録の数と関係ないものに
 * 比例している状態をやめる。
 */
const LORA_CHOICES_BY_OBJECT_INFO = new WeakMap();

export function loraChoices(objectInfo) {
    if (!objectInfo || typeof objectInfo !== 'object') return Object.freeze([]);
    const cached = LORA_CHOICES_BY_OBJECT_INFO.get(objectInfo);
    if (cached) return cached;
    const computed = computeLoraChoices(objectInfo);
    LORA_CHOICES_BY_OBJECT_INFO.set(objectInfo, computed);
    return computed;
}

function computeLoraChoices(objectInfo) {
    const choices = [];
    for (const [classType, info] of Object.entries(objectInfo || {})) {
        const type = String(classType).replace(/[^a-z0-9]+/gi, '').toLowerCase();
        if (!type.startsWith('loraloader') && !type.startsWith('loadlora')) continue;
        const spec = {
            ...(info?.input?.optional || {}),
            ...(info?.input?.required || {}),
        }.lora_name;
        const values = Array.isArray(spec?.[0])
            ? spec[0]
            : (spec?.[0] === 'COMBO' && Array.isArray(spec?.[1]?.options)
                ? spec[1].options
                : []);
        choices.push(...values.filter(value => typeof value === 'string'));
    }
    // **凍らせて返す。** 控えた配列を呼び手が書き換えると、次の記録は
    // 書き換えられた一覧で判定される（読むだけの値なので、書けないほうが正しい）。
    return Object.freeze([...new Set(choices)]);
}

function reachableWorkflowNodes(prompt, objectInfo) {
    const roots = Object.entries(prompt || {})
        .filter(([, node]) => objectInfo?.[node?.class_type]?.output_node === true
            || ['saveimage', 'previewimage', 'saveanimatedwebp', 'saveanimatedpng']
                .includes(String(node?.class_type || '').replace(/[^a-z0-9]+/gi, '').toLowerCase()))
        .map(([id]) => String(id));
    const reachable = new Set();
    const pending = [...roots];
    while (pending.length > 0) {
        const id = String(pending.pop());
        if (reachable.has(id) || !prompt?.[id]) continue;
        reachable.add(id);
        for (const value of Object.values(prompt[id]?.inputs || {})) {
            if (Array.isArray(value) && value.length >= 2 && prompt[String(value[0])]) {
                pending.push(String(value[0]));
            }
        }
    }
    return reachable;
}

function consumedOutputSlots(prompt, reachable, nodeId) {
    const slots = new Set();
    for (const consumerId of reachable) {
        for (const value of Object.values(prompt?.[consumerId]?.inputs || {})) {
            if (Array.isArray(value) && value.length >= 2 && String(value[0]) === String(nodeId)) {
                slots.add(Number(value[1]));
            }
        }
    }
    return slots;
}

export function auditReplayManifest(recipe, built, objectInfo) {
    const manifest = built?.replayManifest || recipe?.replay_manifest || null;
    if (!manifest) {
        return { ok: true, mode: 'legacy', failures: [], required_model_inputs: [] };
    }

    const failures = [];
    const requiredModelInputs = [];
    const fail = (code, requirementId, message) => {
        failures.push({ code, requirement_id: requirementId, message });
    };
    if (manifest.schema !== 'lora-manager.replay-manifest' || manifest.version !== 1) {
        fail('MANIFEST_VERSION_UNSUPPORTED', '', t('core.recipeReplayCapability.25'));
        return { ok: false, mode: 'strict', failures, required_model_inputs: [] };
    }
    for (const error of manifest.errors || []) {
        fail(error?.code || 'MANIFEST_ERROR', '', error?.message || t('core.recipeReplayCapability.26'));
    }

    const prompt = built?.prompt || {};
    const reachable = reachableWorkflowNodes(prompt, objectInfo);
    const choices = loraChoices(objectInfo);
    const loraNodes = Object.entries(prompt).filter(([, node]) => {
        const type = String(node?.class_type || '').replace(/[^a-z0-9]+/gi, '').toLowerCase();
        return type.startsWith('loraloader') || type.startsWith('loadlora');
    });

    for (const requirement of manifest.required_resources || []) {
        if (requirement?.required !== true || requirement?.kind !== 'lora') continue;
        const requirementId = String(requirement.requirement_id || '');
        const expectedFilename = getResourceFilename(requirement.resource);
        const expectedChoices = expectedFilename
            ? modelMatches('lora_name', expectedFilename, choices)
            : [];
        const canonicalChoice = expectedChoices.length === 1 ? expectedChoices[0] : null;
        if (!canonicalChoice) {
            fail(
                'UNRESOLVED_REQUIRED_RESOURCE',
                requirementId,
                t('core.recipeReplayCapability.27', { p1: expectedFilename || requirementId })
            );
        }

        const evidenceNodeIds = new Set(
            (requirement.evidence || [])
                .map(item => item?.node_id)
                .filter(value => value !== undefined && value !== null)
                .map(String)
        );
        const candidates = new Set();
        for (const [nodeId, node] of loraNodes) {
            const metaId = String(node?._meta?.replay_requirement?.id || '');
            if (metaId && metaId === requirementId) candidates.add(String(nodeId));
            if (evidenceNodeIds.has(String(nodeId))) candidates.add(String(nodeId));
            if (!canonicalChoice) continue;
            const actual = node?.inputs?.lora_name;
            const actualChoices = typeof actual === 'string'
                ? modelMatches('lora_name', actual, choices)
                : [];
            if (actualChoices.length === 1
                && normalizedPath(actualChoices[0]) === normalizedPath(canonicalChoice)) {
                candidates.add(String(nodeId));
            }
        }

        if (candidates.size === 0) {
            fail(
                'REQUIRED_LORA_MISSING',
                requirementId,
                t('core.recipeReplayCapability.28', { p1: expectedFilename || requirementId })
            );
            continue;
        }
        if (candidates.size > 1) {
            fail(
                'REQUIRED_LORA_DUPLICATE',
                requirementId,
                t('core.recipeReplayCapability.29', { p1: expectedFilename || requirementId })
            );
            continue;
        }

        const nodeId = [...candidates][0];
        const node = prompt[nodeId];
        const type = String(node?.class_type || '').replace(/[^a-z0-9]+/gi, '').toLowerCase();
        if (type !== 'loraloader') {
            fail(
                'UNSUPPORTED_LORA_LOADER',
                requirementId,
                t('core.recipeReplayCapability.30', { p1: node?.class_type || 'Unknown' })
            );
            continue;
        }
        if (!reachable.has(nodeId)) {
            fail(
                'REQUIRED_LORA_DISCONNECTED',
                requirementId,
                t('core.recipeReplayCapability.31', { p1: expectedFilename || requirementId })
            );
        }
        if (node?.mode === 2 || node?.mode === 4
            || ['bypass', 'mute', 'never'].includes(String(node?.mode || '').toLowerCase())) {
            fail(
                'REQUIRED_LORA_BYPASSED',
                requirementId,
                t('core.recipeReplayCapability.32', { p1: expectedFilename || requirementId })
            );
        }

        const modelInput = node?.inputs?.model;
        const clipInput = node?.inputs?.clip;
        if (!Array.isArray(modelInput) || !prompt[String(modelInput[0])]
            || !Array.isArray(clipInput) || !prompt[String(clipInput[0])]) {
            fail(
                'REQUIRED_LORA_INPUT_DISCONNECTED',
                requirementId,
                t('core.recipeReplayCapability.33', { p1: expectedFilename || requirementId })
            );
        }
        const slots = consumedOutputSlots(prompt, reachable, nodeId);
        if (!slots.has(0) || !slots.has(1)) {
            fail(
                'REQUIRED_LORA_OUTPUT_DISCONNECTED',
                requirementId,
                t('core.recipeReplayCapability.34', { p1: expectedFilename || requirementId })
            );
        }

        const actualModel = Number(node?.inputs?.strength_model);
        const actualClip = Number(node?.inputs?.strength_clip);
        const expectedModel = Number(requirement?.expected?.strength_model);
        const expectedClip = Number(requirement?.expected?.strength_clip);
        if (![actualModel, actualClip, expectedModel, expectedClip].every(Number.isFinite)) {
            fail(
                'LORA_STRENGTH_NON_FINITE',
                requirementId,
                t('core.recipeReplayCapability.35', { p1: expectedFilename || requirementId })
            );
        } else if (Math.abs(actualModel - expectedModel) > 1e-9
            || Math.abs(actualClip - expectedClip) > 1e-9) {
            fail(
                'LORA_STRENGTH_MISMATCH',
                requirementId,
                t('core.recipeReplayCapability.36', { p1: expectedFilename || requirementId })
            );
        }

        requiredModelInputs.push({
            node_id: nodeId,
            widget_name: 'lora_name',
            requirement_id: requirementId,
        });
    }

    return {
        ok: failures.length === 0,
        mode: 'strict',
        failures,
        required_model_inputs: requiredModelInputs,
    };
}

/**
 * @param {object} recipe
 * @param {object} [options]
 * @param {object} options.objectInfo **必須。** ホストが取る `/object_info`
 * @param {object|null} [options.knownModelCatalog] 既知モデル台帳。
 *   **渡さないと `/api/lm/known-models` を自分で叩く。** 台帳の有無で結果が変わる
 *   （実測: unavailable 51 ↔ 59）ので、**呼び手が条件を固定して渡すこと。**
 * @param {string[]|null} [options.embeddings]
 * @param {boolean} [options.probeAvailability] 遮断されたときに、その素材が本当に
 *   配布されているかをフォークの口へ問い合わせるか。**既定は従来どおり真。**
 *   偽にすると問い合わせは1本も出ず、代わりに理由が
 *   「配布可否は未確認」のまま残る——**確認しなかったことを、確認して不可だった
 *   ことと混ぜないため**、結果には `availabilityProbed` を必ず添える。
 */
export async function analyzeRecipeReplayCapability(
    recipe,
    {
        objectInfo = null,
        knownModelCatalog = null,
        embeddings: injectedEmbeddings = null,
        probeAvailability = true,
    } = {}
) {
    // **`objectInfo` は必須。** 元は未指定なら自分で取りに行っていたが、
    // その1本がフォークの外へ出せない唯一の理由だった。**黙って空で続けない**
    // ——`/object_info` が無いまま判定すると、全モデルが「未導入」に見えて
    // 「再現不能」という誤った答えが静かに出る（縮んだ数字は縮んだと判らない）。
    if (!objectInfo || typeof objectInfo !== 'object') {
        throw new TypeError(
            'analyzeRecipeReplayCapability: objectInfo must be supplied by the caller (the host fetches /object_info)'
        );
    }
    try {
        const resolvedObjectInfo = objectInfo;
        // 台帳が引けない環境（旧バックエンド）でも判定は続く（空で返る）。
        const catalog = knownModelCatalog || await getKnownModelCatalog();
        // **台帳はビルダーへも渡す。** 判定側だけが別名を解決していると、
        // 「導入済み」と表示しながら ComfyUI が `value_not_in_list` で投入を拒否する
        // （実測 2026-08-14: `R-ESRGAN 4x+ Anime6B` の実体は
        // `RealESRGAN_x4plus_anime_6B.pth` で、判定は通るが投入は落ちていた）。
        // 導入済み埋め込みもビルダーへ渡す。レシピが名前を記録していないとき、
        // 裸の名前を `embedding:` へ直せるかはこの一覧でしか判らない。
        // **取れない環境では空**——判定を壊すより補いをしないほうが安全、という
        // 元の性質はそのまま。違うのは、取りに行く主体がホスト側になったことだけ。
        const embeddings = Array.isArray(injectedEmbeddings) ? injectedEmbeddings : [];
        const built = buildRecipeWorkflow(recipe, {
            objectInfo: resolvedObjectInfo,
            knownModelCatalog: catalog,
            embeddings,
        });
        const inspected = inspectBuiltWorkflow(built, resolvedObjectInfo, catalog);
        const audit = auditReplayManifest(recipe, built, resolvedObjectInfo);
        // 監査の失敗は「厳密再現の保証がない」ことしか意味しない。
        // 以前は fatal へ合流させて再現ごと遮断していたが、それだと
        // 近似なら再現できるレシピまで一括で殺してしまう。理由として残す。
        const approximations = audit.failures.map(failure => failure.message);
        const sourceCheckpointHash = embeddedCheckpointHash(recipe);
        const localCheckpointHash = resolvedCheckpointHash(recipe);
        if (hashesConflict(sourceCheckpointHash, localCheckpointHash)) {
            // SHA が違っても同名モデルは手元に**在る**。以前は少し似た形で
            // 再現できていた系のレシピなので、警告つきで近似再現へ落とす。
            approximations.push(
                t('core.recipeReplayCapability.37', { p1: sourceCheckpointHash, p2: localCheckpointHash.slice(0, 12) })
            );
        }
        /**
         * その素材は、**名前で見て手元に在るか。**
         *
         * `inLibrary` は上流の台帳が持つ印で、**ComfyUI に何が入っているかは
         * 見ていない。** 台帳に無くても置き場には在る、が普通に起きる
         * ——実測（2026-08-23 利用者の報告）で「不足」として並んだ8件は、
         * 全部ディスクに在り、落とそうとすると「既にある」と言われていた。
         * 押すたびに複製を作りに行く形だったので、ここで確かめる。
         *
         * **見るのは名前だけ。** hash は突き合わせない——同名の別物という
         * 危険はあるが、それは今までも `modelMatches` が受け入れている前提で、
         * ここだけ厳しくしても「無い」と言い続ける側へ倒れるだけになる。
         */
        const installedChoices = {
            lora: loraChoices(resolvedObjectInfo),
            checkpoint: installedNamesFrom(resolvedObjectInfo).checkpoints,
            // **埋め込みは別の置き場に居る。** LoRA の一覧には出てこないので、
            // ここを足さないと「ディスクに在るのに不足」が埋め込みだけ残る
            // （実データ4件のうち `NEGATIVE_HANDS` がそれだった）。
            embedding: embeddings,
        };
        const INPUT_OF = { lora: 'lora_name', checkpoint: 'ckpt_name', embedding: 'lora_name' };
        /**
         * **置き場を問わず探す。** 資源の種別は当てにならない——実データで
         * `NEGATIVE_HANDS.safetensors` は埋め込みとして置き場に在るのに、
         * 記録の側に種別が無いので LoRA としてしか探しておらず、
         * 「不足」のまま残った（2026-08-23）。
         *
         * **取り違えの心配より、複製を作り続ける害が大きい。** 種別を跨いで
         * 同じ名前が在ることは稀で、あったとしても組み立ての側の検査が
         * 本当の不具合（投入できない）を今までどおり捕まえる。
         */
        const alreadyInstalled = (resource) => {
            const name = resource?.file_name || resource?.name || '';
            if (!name) return false;
            return Object.keys(installedChoices).some(kind => modelMatches(
                INPUT_OF[kind], name, installedChoices[kind] || [], null).length === 1);
        };

        const missingResources = [];
        const noteMissingResource = (resource, type) => {
            if (!resource) return;
            // **在るものを「不足」と呼ばない。** 呼ぶと落としに行き、
            // 置き場に2つ目が出来て、次はその2つで名前が曖昧になる。
            if (alreadyInstalled(resource)) return;
            missingResources.push({
                type,
                name: resource.file_name || resource.name || resource.modelName || 'Unknown',
                modelId: resource.modelId ?? resource.model_id ?? resource.civitai?.modelId ?? null,
                versionId: resource.id ?? resource.modelVersionId ?? resource.civitai?.id ?? null,
                isDeleted: Boolean(resource.isDeleted),
            });
        };
        // **manifest が確定できなかった理由の中に、欠けている素材が書いてある。**
        // manifest を捨てて近似で組む道を選んだあと、この情報を誰も見ていなかった。
        // 実測（13650835）: 元画像は5本のLoRAで描かれ、うち strength 0.95 の
        // 主役（Rawfully Stylish）がレシピに保存されていない。それでも
        // 「互換再構築」と表示され、不足一覧にも出ず、ダウンロードもできなかった。
        // レシピが既に持っている版は「不足」ではない。manifest の
        // 「一意に対応付けできない」は**曖昧さ**であって不在とは限らず、
        // 実測では errors に versionId を持つ12件のうち5件が、その版を
        // 既に鎖へ載せていた。除外しないと同じLoRAを二重に適用してしまう。
        const recipeVersionIds = new Set(
            [
                ...(recipe?.loras || []),
                ...(recipe?.embeddings || []),
                recipe?.checkpoint,
            ]
                .filter(Boolean)
                .flatMap(resource => [resource.modelVersionId, resource.id, resource.civitai?.id])
                .filter(value => value !== null && value !== undefined)
                .map(String)
        );
        for (const error of recipe?.replay_manifest?.errors || []) {
            // evidence は辞書のことも配列のこともある。
            const rawEvidence = error?.evidence;
            const evidenceList = Array.isArray(rawEvidence) ? rawEvidence : [rawEvidence];
            for (const evidence of evidenceList) {
            if (!evidence || typeof evidence !== 'object') continue;
            const versionId = evidence.model_version_id;
            if (!versionId) continue;
            if (recipeVersionIds.has(String(versionId))) continue;
            const strength = Number(evidence.strength_model);
            const name = evidence.name || `modelVersionId ${versionId}`;
            missingResources.push({
                type: 'lora',
                name,
                modelId: evidence.model_id ?? null,
                versionId,
                isDeleted: false,
            });
            approximations.push(
                t('core.recipeReplayCapability.38', { p1: name, p2: Number.isFinite(strength) ? t('core.fragment.strength', { p1: strength }) : '' })
            );
            }
        }
        if (recipe?.checkpoint?.inLibrary === false) {
            inspected.fatal.push(
                t('core.recipeReplayCapability.39', { p1: recipe.checkpoint.file_name || recipe.checkpoint.name || 'Unknown' })
            );
            noteMissingResource(recipe.checkpoint, 'checkpoint');
        }
        const manifestRequiredResources = built.replayManifest
            ? built.replayManifest.required_resources
                .filter(item => item?.required === true)
                .map(item => item?.resource)
                .filter(Boolean)
            : null;
        const resourcesToCheck = manifestRequiredResources
            ? [...manifestRequiredResources, ...(recipe?.embeddings || [])]
            : [...(recipe?.loras || []), ...(recipe?.embeddings || [])];
        const isEmbeddingResource = resource =>
            String(resource?.type || '').toLowerCase() === 'embedding'
            || (recipe?.embeddings || []).includes(resource);
        for (const resource of resourcesToCheck) {
            const name = resource.file_name || resource.name || resource.modelName || 'Unknown';
            // **LoRA の欠品は致命ではない。**
            //
            // 元は checkpoint と同じ扱いで「再現不可」にしていたが、組み立ての側は
            // **手元に無い LoRA を鎖から外して組める**（`dropUnavailableLoras`）。
            // 外して出た絵は元と同じにはならないが、**ある程度似た絵は出る**
            // ——それがまさに「近似」の意味で、実機でもそう指摘された（2026-08-21）。
            //
            // checkpoint は別。**土台そのもの**なので、無ければ似た絵も出ない。
            //
            // 「LoRA を外すと真っ白になる」場合（プロンプトが LoRA タグだけ）は、
            // **別の検査が今も致命として落としている**ので、ここを緩めても素通りしない。
            const isLora = isLoraResource(resource, recipe);
            if (!resource?.exclude && resource?.inLibrary === false) {
                if (isEmbeddingResource(resource)) {
                    // 埋め込みの欠品は「その効果が乗らない」だけで、生成自体は成立する。
                    approximations.push(t('core.recipeReplayCapability.40', { p1: name }));
                } else if (isLora) {
                    approximations.push(t('core.recipeReplayCapability.loraMissing', { p1: name }));
                    noteMissingResource(resource, 'lora');
                } else {
                    inspected.fatal.push(t('core.recipeReplayCapability.41', { p1: name }));
                    noteMissingResource(resource, 'checkpoint');
                }
            }
            if (resource?.exclude || resource?.inLibrary || !resource?.isDeleted) continue;
            if (isEmbeddingResource(resource)) {
                approximations.push(t('core.recipeReplayCapability.42', { p1: name }));
            } else if (isLora) {
                // 配布が終わっていても、**外して組めることは変わらない。**
                approximations.push(t('core.recipeReplayCapability.loraDeleted', { p1: name }));
                noteMissingResource(resource, 'lora');
            } else {
                inspected.fatal.push(t('core.recipeReplayCapability.43', { p1: name }));
                noteMissingResource(resource, 'checkpoint');
            }
        }
        inspected.fatal = [...new Set(inspected.fatal)];
        // 外した LoRA も「不足している」ことに変わりはない。実行は通るので
        // fatal には積まないが、詳細とダウンロード導線には出す。
        const droppedLoraModels = (built.droppedLoras || []).map(name => ({
            name,
            inputName: 'lora_name',
            classType: 'LoraLoader',
            folder: 'loras',
            reason: t('core.recipeReplayCapability.44', { p1: name }),
        }));
        const missing = {
            models: [...(inspected.missingModels || []), ...droppedLoraModels].map(model => {
                const found = findRecipeResourceByName(recipe, model.name);
                if (!found) return model;
                const { resource, type } = found;
                return {
                    ...model,
                    resourceType: type,
                    modelId: resource.modelId ?? resource.model_id ?? resource.civitai?.modelId ?? null,
                    versionId: resource.id ?? resource.modelVersionId ?? resource.civitai?.id ?? null,
                    isDeleted: Boolean(resource.isDeleted),
                };
            }),
            resources: [...new Map(
                missingResources.map(item => [`${item.type}:${item.name}`, item])
            ).values()],
            /*
             * **手元に無いノード**（2026-08-28 利用者の指示）。
             *
             * 名前は**環境ごとに違う**（公開しているので、こちらの手元に在る物と
             * 相手の手元に在る物は一致しない）。だから表に持たず、
             * **`object_info` と突き合わせてその場で測った物だけ**を載せる。
             */
            nodes: [...new Set(built?.missingNodes || [])],
        };
        if (inspected.fatal.length > 0) {
            // **遮断の理由を決める前に、その素材が本当に配布されているかを確かめる。**
            // ここで待たないと、カードのバッジ（`classifyBlocker`）だけが判定を
            // 受け取れず「モデル待ち」のまま残る——実測で `Civitai_Recipe_53290457`
            // （生成専用）と `Civitai_Recipe_43591898`（削除済み）が、詳細モーダルでは
            // 正しい理由を出すのに一覧では「DLで解決可能」に居座っていた。
            // 判定はプロセス内とサーバー側の両方でキャッシュされるので、素材あたり1回。
            if (probeAvailability) {
                try {
                    await fetchResourceAvailability([...missing.models, ...missing.resources]);
                } catch {
                    // 判定が取れなくても再現可否は変わらない。従来どおりDL導線へ委ねる。
                }
            }
            return result('unavailable', inspected.fatal, built, audit, missing, catalog,
                {
                    hasGenerationRecord: hasGenerationRecord(recipe),
                    auxiliary: inspected.auxiliary,
                });
        }

        const reasons = [...built.warnings, ...inspected.compatible, ...new Set(approximations)];
        // **「警告ゼロ」ではなく「危険ゼロ」で完全再現とする。**
        // 以前は理由が1件でもあれば降格していたため、忠実度を上げた処理
        // （プロンプト解釈の是正・出力ノードの保存化など）まで減点していた。
        const exact = built.source === 'embedded'
            && summarizeWarnings(reasons).riskCount === 0;
        return result(exact ? 'exact' : 'compatible', reasons, built, audit, missing, catalog,
            {
                hasGenerationRecord: hasGenerationRecord(recipe),
                auxiliary: inspected.auxiliary,
            });
    } catch (error) {
        // ビルドが例外で止まる経路（チェックポイント未特定など）でも、
        // 記録の有無は判る。渡さないと全部「記録なし」に見えてしまう。
        return result('unavailable', [error?.message || String(error)], null, null,
            emptyMissing(), null, { hasGenerationRecord: hasGenerationRecord(recipe) });
    }
}

function isLoraResource(resource, recipe) {
    if (String(resource?.type || '').toLowerCase() === 'lora') return true;
    return (recipe?.loras || []).includes(resource);
}

/**
 * グラフが参照している未導入ファイル名を、レシピ台帳の素材へ結び付ける。
 *
 * `inLibrary` が未確定（null）の素材は素材チェックを素通りし、グラフ検査側で
 * 「未導入モデル: X」として初めて落ちる。この経路では素材のCivitai IDが
 * 付いてこないため、**IDが記録されているのにダウンロード不能に見えていた**。
 * 名前で引き当てて、既存のダウンロード経路へ渡せるようにする。
 */
function findRecipeResourceByName(recipe, name) {
    const wanted = stem(name);
    if (!wanted) return null;
    const candidates = [
        recipe?.checkpoint ? { resource: recipe.checkpoint, type: 'checkpoint' } : null,
        ...(recipe?.loras || []).map(resource => ({ resource, type: 'lora' })),
        ...(recipe?.embeddings || []).map(resource => ({ resource, type: 'embedding' })),
    ].filter(Boolean);
    return candidates.find(({ resource }) => {
        const fileName = resource?.file_name || resource?.name || resource?.modelName || '';
        return stem(fileName) === wanted;
    }) || null;
}
