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
 * 供給ノードからは**文字列として出るだけ**で、選択肢の口へは繋がない。
 * 繋げないのは実装をさぼったからではなく、一覧の現物を握れないため
 * ——理由は `unbake/nodes.py` の `_return_types()` に実測ごと書いてある。
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
 * 束の `sampler` / `scheduler` を、**組み上がったグラフが実際に持っている値**へ揃える。
 *
 * `recipeBundle()` が入れるのは記録の生の値で、`"Euler a"` のような A1111 の
 * 表記が普通に来る。一方で組み立て側は `resolveSamplerScheduler()` を通して
 * ComfyUI の名前（`euler_ancestral`）へ寄せてから焼いている。
 * **生の値のまま選択肢の口へ繋ぐと、焼かれていた正しい値を壊す**——
 * 繋いでいなかった間は害が出なかっただけで、繋いだ瞬間に害へ変わる。
 *
 * ここで対応表を引き直さない（`genParamsMapper` を二重に持たない）。
 * **グラフに在る値を読むだけ。**
 *
 * **食い違うなら繋がない。** サンプラーの節が複数在って値が割れている場合、
 * 1個の出力からは1つの値しか流せないので、揃えずに束から落とす
 * ——片方に合わせると、もう片方を静かに書き換えることになる。
 *
 * @param {object} prompt `buildRecipeWorkflow()` が返した API グラフ
 * @param {object} bundle `recipeBundle()` が作った値の束
 * @returns {object} 揃えた束（元の束は変更しない）
 */
export function alignBundleToGraph(prompt, bundle = {}) {
    const aligned = { ...bundle };
    /** 項目 → グラフ側の口の名前。 */
    const SLOTS = [['sampler', 'sampler_name'], ['scheduler', 'scheduler']];
    const seen = new Map(SLOTS.map(([field]) => [field, new Set()]));

    for (const node of Object.values(prompt || {})) {
        if (!node || typeof node !== 'object') continue;
        if (!SAMPLER_CLASS.test(str(node.class_type))) continue;
        const inputs = node.inputs || {};
        for (const [field, input] of SLOTS) {
            const value = inputs[input];
            // **文字列だけを見る。** 配線済みの口の値は配列（`[nodeId, slot]`）
            // なのでここで落ちる——`planRecipeWiring()` が繋がない口を、
            // 揃えるかの判断にも入れないことになる。
            // 配列用の判定を別に置くと、**変異させても赤くならない飾り**が残る
            // （実測 2026-08-29・その形で1本入れて変異検査に落とされた）。
            if (typeof value !== 'string' || !value) continue;
            seen.get(field).add(value);
        }
    }

    for (const [field] of SLOTS) {
        const values = seen.get(field);
        if (values.size === 1) aligned[field] = [...values][0];
        else delete aligned[field];
    }
    return aligned;
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

        // 選択肢（COMBO）の口。**束の値は `alignBundleToGraph()` を通した後の
        // ものでなければならない**——生の記録の値（`"Euler a"`）を流すと、
        // 組み立て側が寄せた正しい名前を壊す。`checkpoint` はここに無い
        // （一覧の現物を握れないので出力を選択肢型にできない・`nodes.py`）。
        if ('sampler_name' in inputs && !isLink(inputs.sampler_name)) {
            add(id, 'sampler_name', 'sampler');
        }
        if ('scheduler' in inputs && !isLink(inputs.scheduler)) {
            add(id, 'scheduler', 'scheduler');
        }

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
