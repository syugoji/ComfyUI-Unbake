/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 画像1枚から **Generation Record** を組む。
 *
 * ここは「再現」ではなく**「捕捉」**である。ComfyUI が出した画像には実行したグラフが
 * そのまま埋まっているので、**組み直す必要がない**——読んで束ねるだけ。
 * Civitai の画像（URL しか来ない・API から取り直して再構成が要る）とは
 * 質的に別の経路で、混ぜると片方が必ず壊れる。
 *
 * **鍵の優先順位（実測に基づく）**
 *
 *   1. 刻印 `unbake_generation_record` / 旧 `lora_manager_recipe`
 *      → 保存済みの記録への**参照**。あればグラフを解析せずに解決できる。
 *   2. `prompt`（API 形式のグラフ）**実測で全件にある**。ここから中身を取る。
 *   3. `workflow`（画面のグラフ）実測18%。**主経路にすると8割が落ちる**ので、
 *      画面で開き直すためだけに保持する。
 *
 * **外向きの鍵は `unbake_` で始める。** 旧い鍵 `lora_manager_recipe` は
 * 名前に上流の製品名を含んでおり、決定④（`lora manager` を含めない）に反する。
 * ただし**手元の出力3,084枚はその鍵で刻まれている**ので、読む側は両方受ける
 * ——書く側だけ新しい鍵にする。**読めなくすると過去の資産が全部見えなくなる。**
 */

import { t } from '../i18n/index.js';
import { parseJsonLoose, readPngText } from './pngText.js';
import { looksLikeExifImage, readExifText } from './exifText.js';
import { applyA1111ToSummary, recipeFromA1111 } from './a1111Parameters.js';

/** 書くときの鍵。**外向きなので上流の製品名を含めない。** */
export const RECORD_STAMP_KEY = 'unbake_generation_record';
export const SWEEP_STAMP_KEY = 'unbake_sweep_cell';

/** 読むときに受ける鍵（**旧い刻印も読む**。過去の出力を捨てないため）。 */
export const RECORD_STAMP_KEYS = [RECORD_STAMP_KEY, 'lora_manager_recipe'];
export const SWEEP_STAMP_KEYS = [SWEEP_STAMP_KEY, 'lora_manager_sweep'];

const SAMPLER_TYPES = new Set([
    'KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'SamplerCustomAdvanced',
]);
const CHECKPOINT_INPUTS = ['ckpt_name', 'unet_name'];

function firstOf(text, keys) {
    for (const key of keys) {
        if (typeof text?.[key] === 'string' && text[key].trim()) return { key, value: text[key] };
    }
    return null;
}

/**
 * 1つのノードが何本も持つ形の LoRA を読む（2026-08-26 実測）。
 *
 * 実物（`Lora Loader (LoraManager)`）はこう入っている:
 *
 *     inputs.loras.__value__ = [{ name, strength, clipStrength, active }, …]
 *     inputs.text            = "<lora:名前:0.25> <lora:別の名前:0.50> …"
 *
 * **`__value__` だけを読む。`text` は読まない。**
 *
 * `text` は表示用の写しなので、そこからも読めば取りこぼしが減る——と考えて
 * 一度そうしたが、**実測すると利益が0で害だけだった**。手元の 895 枚で
 * `text` に `<lora:…>` を含むのは `CLIPTextEncode` 系の9ノードだけで、
 * `loras` を持つのに `__value__` が無いノードは**1つも無かった**。
 * つまり写しの経路が拾うのは**プロンプト本文に書かれた A1111 の記法**だけ
 * ——ComfyUI はそれを LoRA として適用しないので、採ると
 * 「使っていない LoRA を使ったことにする」という嘘になる。
 *
 * **`active: false` は入れない。** 切ってある LoRA を効いていることにすると、
 * 「同じ材料なのに絵が違う」という一番読みにくい食い違いになる。
 *
 * @param {object} inputs ノードの `inputs`
 * @returns {{name: string, strength: number|null}[]}
 */
export function readMultiLoraWidget(inputs) {
    const out = [];
    const bag = inputs?.loras;
    const list = Array.isArray(bag?.__value__) ? bag.__value__
        : (Array.isArray(bag) ? bag : null);
    if (list) {
        for (const item of list) {
            const name = typeof item?.name === 'string' ? item.name.trim() : '';
            if (!name) continue;
            if (item?.active === false) continue;
            out.push({
                name,
                strength: typeof item?.strength === 'number' ? item.strength : null,
            });
        }
    }
    return out;
}

/** API 形式のグラフから、人が見て分かる要点だけを抜く。 */
export function summarizePrompt(prompt) {
    const summary = {
        checkpoint: null,
        loras: [],
        seed: null,
        steps: null,
        cfg: null,
        sampler: null,
        scheduler: null,
        width: null,
        height: null,
        positive: null,
        // **負の側も持つ**（2026-08-24 実機 `ComfyUI_00444_`）。
        // 持っていなかったので、記録の負のプロンプトは**全件が空**だった。
        // 空のまま再現すると、同じ種・同じ設定なのに絵が変わる。
        negative: null,
        nodeCount: 0,
    };
    if (!prompt || typeof prompt !== 'object') return summary;

    const entries = Object.entries(prompt);
    summary.nodeCount = entries.length;

    for (const [, node] of entries) {
        const type = node?.class_type;
        const inputs = node?.inputs || {};

        if (!summary.checkpoint) {
            for (const name of CHECKPOINT_INPUTS) {
                if (typeof inputs[name] === 'string' && inputs[name]) {
                    summary.checkpoint = inputs[name];
                    break;
                }
            }
        }
        if (typeof inputs.lora_name === 'string' && inputs.lora_name) {
            summary.loras.push({
                name: inputs.lora_name,
                strength: typeof inputs.strength_model === 'number' ? inputs.strength_model : null,
            });
        }
        // **1つのノードが何本も持つ形**（2026-08-26 実測で見つけた）。
        //
        // `lora_name` だけを見ていたので、`Lora Loader (LoraManager)` を使った
        // 絵は **LoRA が1本も採れていなかった**——手元の 897 枚のうち 34 枚
        // （3.8%）がこれで、1枚あたり8本入っていた。**採れないのではなく、
        // 「LoRA を使っていない」という別の嘘になる**のが悪い。
        //
        // 種類名では見分けない。`loras.__value__` という形を持つノードを拾う
        // ——同じ形の別ノードが出ても、そのまま読める。
        for (const entry of readMultiLoraWidget(inputs)) summary.loras.push(entry);
        if (SAMPLER_TYPES.has(type)) {
            if (summary.seed === null && typeof inputs.seed === 'number') summary.seed = inputs.seed;
            if (summary.seed === null && typeof inputs.noise_seed === 'number') summary.seed = inputs.noise_seed;
            if (summary.steps === null && typeof inputs.steps === 'number') summary.steps = inputs.steps;
            if (summary.cfg === null && typeof inputs.cfg === 'number') summary.cfg = inputs.cfg;
            if (!summary.sampler && typeof inputs.sampler_name === 'string') summary.sampler = inputs.sampler_name;
            if (!summary.scheduler && typeof inputs.scheduler === 'string') summary.scheduler = inputs.scheduler;
        }
        if (summary.width === null && typeof inputs.width === 'number' && typeof inputs.height === 'number') {
            summary.width = inputs.width;
            summary.height = inputs.height;
        }
    }

    // --- プロンプト -------------------------------------------------------
    //
    // **並び順では決めない。** 元は「最初の非空 CLIPTextEncode を正とする」
    // だったので、負の側が先に並ぶグラフでは**正負が入れ替わり**、
    // 負の側は**どのグラフでも取れなかった**（2026-08-24 実機）。
    // サンプラーの `positive` / `negative` の線は入れ替わらない。
    const texts = resolvePromptTexts(prompt);
    summary.positive = texts.positive;
    summary.negative = texts.negative;
    return summary;
}

/** サンプラーの線を辿って正負の文字を取る。辿れなければ並び順へ落とす。 */
function resolvePromptTexts(prompt) {
    const sampler = Object.values(prompt)
        .find(node => SAMPLER_TYPES.has(node?.class_type));
    const textOf = (reference) => {
        if (!Array.isArray(reference) || reference.length !== 2) return null;
        const node = prompt[String(reference[0])];
        const text = node?.inputs?.text;
        return typeof text === 'string' && text.trim() ? text.trim() : null;
    };
    let positive = textOf(sampler?.inputs?.positive);
    let negative = textOf(sampler?.inputs?.negative);

    // **辿れないときだけ並び順。** 片方だけ辿れた場合は、もう片方に
    // 「辿れた方と同じノード」を選ばない（同じ文字が正負に入る）。
    if (!positive || !negative) {
        const encoders = Object.values(prompt)
            .filter(node => node?.class_type === 'CLIPTextEncode'
                && typeof node?.inputs?.text === 'string' && node.inputs.text.trim())
            .map(node => node.inputs.text.trim());
        if (!positive) positive = encoders.find(text => text !== negative) || null;
        if (!negative) negative = encoders.find(text => text !== positive) || null;
    }
    return { positive, negative };
}

/**
 * 再現できる見込みを、**この時点で分かる範囲だけ**で付ける。
 *
 * **これは判定ではない。** 本当の可否は導入済みモデル（`/object_info`）と
 * 突き合わせて初めて出る（`analyzeRecipeReplayCapability`）。ここで返すのは
 * 「グラフが手に入ったか」までで、**それを可否と読ませないために名前を分けてある。**
 */
export function captureCompleteness(record) {
    if (!record.prompt) return 'blocked';
    if (record.checkpoint) return 'reproducible';
    return 'approximate';
}

/**
 * 画像のバイト列から Generation Record を組む。
 *
 * @param {ArrayBuffer|Uint8Array} bytes 画像
 * @param {object} [origin] どこから来たか（`{ kind, filename, url, subfolder }`）
 * @returns {{ ok: boolean, record: object|null, reason: string|null, unsupported: string[] }}
 */
export function buildGenerationRecord(bytes, origin = {}) {
    // **PNG 以外も読む**（2026-08-24）。元は PNG 専用で、落とされた JPEG/WEBP は
    // `not-png` で即座に終わっていた——**情報を持っているのに「メタが無い絵」**と
    // 同じ扱いになる。実測（手元のレシピ置き場・無作為40件）で、
    // webp は**全件が EXIF UserComment を持ち、45%（18件）が実際の生成情報**だった
    // （A1111 パラメータ11件 / ComfyUI のグラフ7件）。
    if (looksLikeExifImage(bytes)) {
        const exif = readExifText(bytes);
        if (!exif.ok) {
            return { ok: false, record: null, reason: exif.reason, unsupported: exif.unsupported };
        }
        return buildRecordFromTextChunks(exif.text, origin, exif.unsupported);
    }
    const parsed = readPngText(bytes);
    if (!parsed.ok) {
        return { ok: false, record: null, reason: parsed.reason, unsupported: parsed.unsupported };
    }
    return buildRecordFromTextChunks(parsed.text, origin, parsed.unsupported);
}

/**
 * **すでに取り出してあるテキストチャンクから**記録を組む。
 *
 * PNG のバイト列を持っていない経路（Civitai は URL しか来ない）でも、
 * **同じ形の記録を同じ関数から**作るためにここを分けてある。
 * 分けないと「画像から来た記録」と「API から来た記録」で形が割れ、
 * 画面がどちらから来たかで分岐を持つことになる。
 *
 * @param {object} text `{ 鍵: 文字列 }` の平たいマップ（`readPngText().text` と同じ形）
 * @param {object} [origin]
 * @param {string[]} [unsupported] 読めなかったチャンク
 */
export function buildRecordFromTextChunks(text, origin = {}, unsupported = []) {
    const promptRaw = firstOf(text, ['prompt']);
    const workflowRaw = firstOf(text, ['workflow']);
    const stampRaw = firstOf(text, RECORD_STAMP_KEYS);
    const sweepRaw = firstOf(text, SWEEP_STAMP_KEYS);
    const a1111 = firstOf(text, ['parameters']);

    const promptParsed = promptRaw ? parseJsonLoose(promptRaw.value) : { value: null, repaired: false };
    const prompt = promptParsed.value;
    const workflowParsed = workflowRaw ? parseJsonLoose(workflowRaw.value) : { value: null, repaired: false };
    const workflow = workflowParsed.value;
    const stamp = stampRaw ? parseJsonLoose(stampRaw.value).value : null;
    const sweep = sweepRaw ? parseJsonLoose(sweepRaw.value).value : null;
    // **直したことを残す。** `NaN` を `null` へ置き換えた値は元の値ではない。
    const repairedJson = [
        promptParsed.repaired ? 'prompt' : null,
        workflowParsed.repaired ? 'workflow' : null,
    ].filter(Boolean);

    if (!prompt && !workflow && !stamp && !a1111) {
        // **「メタが無い」と「圧縮されていて読めない」を混ぜない。**
        return {
            ok: false,
            record: null,
            reason: unsupported.length ? 'compressed-metadata' : 'no-metadata',
            unsupported,
        };
    }

    // **テキストに書いてある分を写す。** グラフが無い画像（A1111・civitai から
    // 落とした PNG）は、ここを通さないと checkpoint も LoRA も seed も全部
    // `null` のまま保存される——`hasA1111: true` を立てながら空の殻が残る、
    // という一番読みにくい形で壊れていた（2026-08-23 利用者の報告）。
    //
    // **グラフから取れた値は上書きしない。** そちらの方が確かで、
    // A1111 のテキストは「グラフが無いときの次善」である。
    const summary = a1111
        ? applyA1111ToSummary(summarizePrompt(prompt), a1111.value)
        : summarizePrompt(prompt);
    const filename = origin.filename || null;
    const record = {
        id: stamp?.recipe_id || filename || null,
        title: filename ? filename.replace(/\.[^.]+$/, '') : (stamp?.recipe_id || t('core.generationRecord.1')),
        origin: {
            kind: origin.kind || 'unknown',
            url: origin.url || null,
            filename,
            subfolder: origin.subfolder ?? null,
        },
        // **どの鍵から来たかを残す。** 後から「なぜこの値なのか」を辿れなくなる。
        provenance: {
            stampKey: stampRaw?.key || null,
            hasPrompt: Boolean(prompt),
            hasWorkflow: Boolean(workflow),
            hasA1111: Boolean(a1111),
            unsupported,
            repairedJson,
        },
        // 参照だけの刻印。これがあればグラフを解析せずに保存済みの記録へ辿れる。
        reference: stamp ? { recipeId: stamp.recipe_id ?? null, schema: stamp.schema ?? null } : null,
        sweep: sweep
            ? {
                jobId: sweep.job_id ?? null,
                cellId: sweep.cell_id ?? null,
                signature: sweep.signature ?? null,
                labels: Array.isArray(sweep.labels) ? sweep.labels : [],
            }
            : null,
        prompt,
        workflow,
        a1111: a1111 ? a1111.value : null,
        ...summary,
    };

    // **グラフが無くても、A1111 の書式なら組める。** レシピ346件のうち298件が
    // 同じ状態（グラフ無し）で通っているのと同じ道へ乗せる——別の道は作らない。
    // 乗せないと、項目が全部埋まっているのに「再現不可」と出る。
    if (!prompt && a1111) {
        const recipe = recipeFromA1111(a1111.value, { id: record.id, title: record.title });
        if (recipe) {
            record.recipe = recipe;
            /** グラフが無いので `buildRecipeWorkflow()` に通す必要がある。 */
            record.needsBuild = true;
        }
    }
    // **「まだ組んでいない」を「組めない」と呼ばない。** `blocked` は
    // 手の打ちようが無いという意味で、組めば済むものに付けると諦めさせる。
    record.verdict = (!prompt && record.needsBuild) ? 'pending' : captureCompleteness(record);
    return { ok: true, record, reason: null, unsupported };
}

/**
 * **LoRA Manager が書き出したレシピ**から Generation Record を組む。
 *
 * **これは「捕捉」ではなく「再現」の入口である。** 最初は逆に作って間違えた——
 * レシピには `comfy_prompt` が入っていると思い込み、無いものを `blocked` にしていた。
 * **実測（手元の346件）で `comfy_prompt` を持つのは48件（14%）だけ。**
 * 残り298件はグラフを持たず、`buildRecipeWorkflow()` で**組む**必要がある
 * （切り出した中核4,199行がやるのがまさにこれ）。
 *
 * だからここでは**グラフを組まない**。持っていれば使い、無ければ `needsBuild` を立てて
 * 呼び手（ホスト）へ渡す。判定材料（`/object_info`）を持っているのはホストだけなので、
 * ここで組もうとすると core が環境へ手を伸ばすことになる。
 *
 * `checkpoint` はレシピでは**オブジェクト**（Civitai のモデル情報）で、
 * グラフでは**ファイル名の文字列**である。**同じ名前で別の形**なので、
 * ここで取り違えると「checkpoint がある」と言いながら投入できない状態になる。
 * グラフから取れた文字列を優先し、取れないときだけレシピ側の名前を使う。
 *
 * @param {object} recipe レシピ JSON を解いたもの
 * @param {object} [origin]
 * @returns {{ ok: boolean, record: object|null, reason: string|null }}
 */
export function buildRecordFromRecipe(recipe, origin = {}) {
    if (!recipe || typeof recipe !== 'object') {
        return { ok: false, record: null, reason: 'not-a-recipe' };
    }
    const prompt = recipe.comfy_prompt && typeof recipe.comfy_prompt === 'object'
        ? recipe.comfy_prompt
        : null;
    const summary = summarizePrompt(prompt);
    if (!summary.checkpoint) {
        // レシピ側の checkpoint は Civitai のモデル情報（オブジェクト）。
        // ファイル名が入っていることもあるので、文字列のときだけ使う。
        const fromRecipe = recipe.checkpoint?.file_name ?? recipe.checkpoint?.name ?? recipe.checkpoint;
        if (typeof fromRecipe === 'string' && fromRecipe.trim()) summary.checkpoint = fromRecipe.trim();
    }
    if (summary.loras.length === 0 && Array.isArray(recipe.loras)) {
        summary.loras = recipe.loras
            .map(l => ({ name: l?.file_name || l?.name || null, strength: l?.weight ?? null }))
            .filter(l => l.name);
    }
    const gen = recipe.gen_params || {};
    if (summary.seed === null && typeof gen.seed === 'number') summary.seed = gen.seed;
    if (summary.steps === null && typeof gen.steps === 'number') summary.steps = gen.steps;
    if (summary.cfg === null && typeof gen.cfg_scale === 'number') summary.cfg = gen.cfg_scale;
    if (!summary.sampler && typeof gen.sampler === 'string') summary.sampler = gen.sampler;
    if (!summary.positive && typeof gen.prompt === 'string' && gen.prompt.trim()) {
        summary.positive = gen.prompt.trim();
    }

    const record = {
        id: recipe.id || origin.filename || null,
        title: recipe.title || origin.filename || t('core.generationRecord.2'),
        /** グラフが無いので `buildRecipeWorkflow()` に通す必要がある。 */
        needsBuild: !prompt,
        /** 組み直しに要るので元のレシピを持ち回る。 */
        recipe,
        origin: {
            kind: origin.kind || 'recipe_file',
            url: origin.url || null,
            filename: origin.filename || null,
            subfolder: origin.subfolder ?? null,
        },
        provenance: {
            stampKey: null,
            hasPrompt: Boolean(prompt),
            hasWorkflow: Boolean(recipe.comfy_workflow),
            hasA1111: false,
            unsupported: [],
            repairedJson: [],
            // **どのレシピ由来かを残す。** 上流の語を使うのはここだけ。
            recipeSource: recipe.source_path ?? null,
        },
        reference: recipe.id ? { recipeId: recipe.id, schema: 'lora-manager.recipe' } : null,
        sweep: null,
        prompt,
        workflow: recipe.comfy_workflow ?? null,
        a1111: null,
        ...summary,
    };
    // **グラフが無いことを「不足」と呼ばない。** まだ組んでいないだけである。
    record.verdict = prompt ? captureCompleteness(record) : 'pending';
    return { ok: true, record, reason: null };
}

/**
 * 組めなかったレシピを、**理由つきで**「不足」として畳む。
 *
 * **中核が投げるのはクラッシュではなく判断である。** 実測（346件）で出た3種は
 * 「元画像にプロンプト／生成パラメータがない」「プロンプトが LoRA タグだけで
 * 描画内容の記述がない」「チェックポイント情報がない」——どれも**利用者に見せるべき理由**で、
 * 握り潰すと「なぜか出てこない」に化ける。
 *
 * @param {object} record
 * @param {unknown} error
 * @returns {object} 新しい記録（**元は書き換えない**）
 */
export function markUnbuildable(record, error) {
    return {
        ...record,
        needsBuild: false,
        verdict: 'blocked',
        blockedReason: String(error?.message || error || t('core.generationRecord.3')),
    };
}


/**
 * `buildRecipeWorkflow()` が組んだグラフを記録へ結び付け、要点と判定を取り直す。
 *
 * @param {object} record `buildRecordFromRecipe()` が返したもの
 * @param {object} built `buildRecipeWorkflow()` の戻り値（`{ prompt, … }`）
 * @returns {object} 新しい記録（**元は書き換えない**）
 */
export function attachBuiltWorkflow(record, built) {
    const prompt = built?.prompt && typeof built.prompt === 'object' ? built.prompt : null;
    if (!prompt) {
        return { ...record, needsBuild: false, verdict: 'blocked' };
    }
    const summary = summarizePrompt(prompt);
    // レシピ側からしか取れない値は残す（組み上げたグラフに出てこないものがある）。
    for (const key of Object.keys(summary)) {
        if (summary[key] === null || (Array.isArray(summary[key]) && summary[key].length === 0)) {
            if (record[key] !== undefined && record[key] !== null) summary[key] = record[key];
        }
    }
    const next = {
        ...record,
        ...summary,
        prompt,
        needsBuild: false,
        provenance: { ...record.provenance, hasPrompt: true, builtFromRecipe: true },
    };
    next.verdict = captureCompleteness(next);
    return next;
}
