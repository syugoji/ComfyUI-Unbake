/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * キャンバスノード（`UnbakeRecipeSource`）の**純粋な部分**。
 *
 * 画面へ差す手つき（litegraph を触る側）は入口の `web/unbake.js` に置く。
 * ここに在るのは **JSON だけを見て決められること**——値の束を作る、
 * 組み上がった API グラフのどこへ繋ぐかを決める——で、そこは検査できる。
 *
 * ---
 *
 * **繋ぐのは「束に値が在る項目」だけ。** ここを飛ばすと、読み取れなかった
 * 項目まで供給ノードから流れ、**組み上げたグラフが持っていた正しい値を
 * 0 で上書きする**（seed も steps も既定へ落ちる）。読めなかったことが
 * 「消してよい」に化ける形は `extractedParams.js` で既に一度踏んでいる。
 *
 * **既に別のノードから来ている口へは繋がない。** API グラフの入力値が
 * 配列（`[nodeId, slot]`）なら、それは配線であって値ではない。上書きすると
 * 元のグラフの構造を壊す。
 */

/**
 * ComfyUI へ登録した型名。**`unbake/nodes.py` と同じ字**でなければならない。
 *
 * ここが割れると、組み上がったグラフにノードが差さらず、**増殖経路が静かに
 * 切れる**——グラフは開くので、画面上は何も壊れていないように見える。
 * `tests/comfy_package_test.mjs` が両方を突き合わせている。
 */
export const UNBAKE_NODE_TYPE = 'UnbakeRecipeSource';

/**
 * 出力の並び。**`unbake/nodes.py` の `FIELDS` と1対1・同じ順**。
 *
 * 番号で繋ぐので、片方だけ並べ替えると**別の値が別の口へ入る**
 * ——プロンプトが seed の欄へ流れるような壊れ方をする。
 */
export const OUTPUT_NAMES = [
    'prompt', 'negative', 'seed', 'steps', 'cfg', 'sampler', 'scheduler', 'checkpoint',
];

/** 出力名 → 出力の番号。 */
export const OUTPUT_INDEX = Object.fromEntries(
    OUTPUT_NAMES.map((name, index) => [name, index]),
);

/** サンプラーの節。名前は環境ごとに増えるので、**含むか**で見る。 */
const SAMPLER_CLASS = /KSampler|SamplerCustom|Sampler\b/i;

/** 本文を持つ節。SDXL 版や smZ 版も同じ `text` の口を持つ。 */
const TEXT_CLASS = /CLIPTextEncode|TextEncode|CLIPTextEncodeSDXL/i;

/** 種の口は実装ごとに名前が違う（`KSamplerAdvanced` は `noise_seed`）。 */
const SEED_INPUTS = ['seed', 'noise_seed'];

const isLink = (value) => Array.isArray(value);
const str = (value) => (typeof value === 'string' ? value : (value == null ? '' : String(value)));

/** 数として読める値だけ通す。**`0` は落とさない**（seed 0 も cfg 0 も正当）。 */
function num(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 使うモデルの名前。**在れば出す、無ければ空。**
 *
 * 形が3通りある（文字列・`{name}`・`{file_name}`）ので、ここで1つへ寄せる。
 * 供給ノードからは文字列として出るだけで、選択肢の口へは繋がない
 * （繋げないので、`nodes.py` の注記を見よ）。
 */
function checkpointName(recipe) {
    const checkpoint = recipe?.checkpoint;
    if (!checkpoint) return '';
    if (typeof checkpoint === 'string') return checkpoint;
    return str(checkpoint.file_name || checkpoint.name || checkpoint.model_name || '');
}

/**
 * ノードの欄へ書き込む**値の束**を作る。
 *
 * 記録まるごとは入れない——共有される workflow.json が記録の重さになる
 * （埋め込みグラフや LoRA の一覧まで JSON へ乗る）。
 *
 * **空の項目は入れない。** 入れると Python 側が既定値で埋めてしまい、
 * 「読めなかった」が「0 だった」に化ける。
 *
 * **出どころも入れる。** どの絵から組んだかが束に残っていないと、共有された
 * グラフを受け取った人が**差し替えの起点を持てない**（ノードは在るのに、
 * 何を差し替えれば動き直すのかが判らない）。
 *
 * @param {object} recipe レシピの形（`toRecipeShape()` を通した後）
 * @param {object} params `extractParamsFromBytes()` が返した流し込める値
 * @param {{image?: string, url?: string}} origin どの絵から組んだか（空でよい）
 */
export function recipeBundle(recipe, params = {}, origin = {}) {
    const gen = recipe?.gen_params || {};
    const bundle = {};
    const put = (key, value) => {
        if (value === null || value === undefined) return;
        if (typeof value === 'string' && !value.trim()) return;
        bundle[key] = value;
    };
    put('image', str(origin?.image ?? ''));
    put('url', str(origin?.url ?? ''));
    put('prompt', str(params.prompt ?? gen.prompt ?? ''));
    put('negative', str(params.negative_prompt ?? gen.negative_prompt ?? ''));
    put('seed', num(params.seed ?? gen.seed));
    put('steps', num(params.steps ?? gen.steps));
    put('cfg', num(params.cfg_scale ?? gen.cfg_scale));
    put('sampler', str(params.sampler ?? gen.sampler ?? ''));
    put('scheduler', str(gen.scheduler ?? ''));
    put('checkpoint', checkpointName(recipe));
    return bundle;
}

/**
 * 条件（conditioning）を遡って、本文を持つ節を探す。
 *
 * 直結とは限らない——間に結合や ControlNet が挟まる形は普通に在る。
 * **深さは切る**（環になっている壊れたグラフで止まらなくなる）。
 */
function findTextNode(prompt, link, depth = 0) {
    if (!isLink(link) || depth > 6) return null;
    const id = String(link[0]);
    const node = prompt[id];
    if (!node) return null;
    if (TEXT_CLASS.test(str(node.class_type)) && !isLink(node.inputs?.text)
        && typeof node.inputs?.text === 'string') {
        return id;
    }
    for (const value of Object.values(node.inputs || {})) {
        const found = findTextNode(prompt, value, depth + 1);
        if (found) return found;
    }
    return null;
}

/**
 * 組み上がった API グラフの、**どの口へ供給ノードを繋ぐか**を決める。
 *
 * 返すのは `{ node, input, from }` の並び。`node` は API グラフの鍵
 * （`app.loadApiJson` はこの鍵をそのまま litegraph の id にする・実測 frontend 1.45.20）。
 *
 * @param {object} prompt `buildRecipeWorkflow()` が返した API グラフ
 * @param {object} bundle `recipeBundle()` が作った値の束
 * @returns {Array<{node: string, input: string, from: string}>}
 */
export function planRecipeWiring(prompt, bundle = {}) {
    if (!prompt || typeof prompt !== 'object') return [];
    const plan = [];
    const taken = new Set();
    const add = (node, input, from) => {
        // 束に値が無い項目は繋がない（既定値での上書きを作らない）。
        if (!(from in bundle)) return;
        const key = `${node}:${input}`;
        if (taken.has(key)) return;
        taken.add(key);
        plan.push({ node: String(node), input, from });
    };

    for (const [id, node] of Object.entries(prompt)) {
        if (!node || typeof node !== 'object') continue;
        if (!SAMPLER_CLASS.test(str(node.class_type))) continue;
        const inputs = node.inputs || {};

        for (const name of SEED_INPUTS) {
            if (name in inputs && !isLink(inputs[name])) add(id, name, 'seed');
        }
        if ('steps' in inputs && !isLink(inputs.steps)) add(id, 'steps', 'steps');
        if ('cfg' in inputs && !isLink(inputs.cfg)) add(id, 'cfg', 'cfg');

        // 本文は条件の側にある。**サンプラーから辿る**——グラフの中に
        // 使われていない `CLIPTextEncode` が残っていることが実際に在り、
        // 節を総なめにすると**繋がっていない方**へ書いてしまう。
        const positive = findTextNode(prompt, inputs.positive);
        if (positive) add(positive, 'text', 'prompt');
        const negative = findTextNode(prompt, inputs.negative);
        if (negative && negative !== positive) add(negative, 'text', 'negative');
    }
    return plan;
}
