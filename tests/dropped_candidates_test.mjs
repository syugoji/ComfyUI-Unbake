/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **枠から落とした候補のうち、拾うと決めたもの**（`D-20260831-01`）。
 *
 * 2026-08-31 の9スライス監査は各スライスに上位3〜5件の枠を掛けており、
 * **超えた50件は登記すらされていなかった**。内訳の残る34件を読み直して
 * 「拾う11／人が決める4／捨てる14／済み5」へ振り分けた
 * （`_Planning/unbake_audit_triage.md`）。ここはその「拾う」側のうち、
 * 中核（`web/core/`）に居る6件を留める。
 *
 * **落とした理由の大半は「筋書きを書けなかった」だった**——実測で挙動は
 * 確認できているのに、利用者に見える形へ落とせなかっただけ。
 * **害の不在は測っていない。** だからここでは「利用者に見える害」ではなく
 * **その挙動そのもの**を固定する。
 *
 * 変異で赤くなることを1件ずつ確かめてある（緑のままなら何も見ていない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildRecipeWorkflow, inlineJoinStringMulti } from '../web/core/recipeWorkflowBuilder.js';
import { toRecipeShape } from '../web/core/recordShape.js';
import { formatNotes, parseNotes } from '../web/core/recipeNotes.js';
import { recipeFromCivitaiMeta } from '../web/core/civitaiClient.js';
import {
    applyRecordOverrides, clearAllOverrides, setLoraOverride, setModelOverride,
} from '../web/core/recipeLoraOverrides.js';
import { setLocale } from '../web/i18n/index.js';

const INSTALLED = Object.fromEntries([
    'CheckpointLoaderSimple', 'CLIPTextEncode', 'EmptyLatentImage',
    'KSampler', 'VAEDecode', 'SaveImage', 'LoraLoader',
].map(type => [type, { input: { required: {} } }]));

const RECORD = {
    id: 'x.png', title: 'x', checkpoint: 'a.safetensors',
    seed: 1, steps: 20, cfg: 4, sampler: 'euler', scheduler: 'normal',
    width: 1024, height: 1024, positive: 'pos', negative: 'neg',
};

// --------------------------------------------------------------------------
// I-20260831-45: 開いた LoRA の id が、文字連結で 11 → 111 と伸びる
// --------------------------------------------------------------------------

/** 運搬ノード（`Lora Loader (LoraManager)`）が2本の LoRA を運ぶグラフ。 */
function carrierGraph() {
    return {
        1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a.safetensors' } },
        10: { class_type: 'Lora Loader (LoraManager)', inputs: {
            model: ['1', 0], clip: ['1', 1],
            loras: { __value__: [
                { name: 'alpha', strength: 0.5, clipStrength: 0.5, active: true },
                { name: 'beta', strength: 0.25, clipStrength: 0.25, active: true },
            ] },
        } },
        2: { class_type: 'CLIPTextEncode', inputs: { text: 'neg', clip: ['10', 1] } },
        3: { class_type: 'CLIPTextEncode', inputs: { text: 'pos', clip: ['10', 1] } },
        4: { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
        5: { class_type: 'KSampler', inputs: {
            seed: 1, steps: 20, cfg: 4, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
            model: ['10', 0], positive: ['3', 0], negative: ['2', 0], latent_image: ['4', 0] } },
        6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
        7: { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'x' } },
    };
}

test('運搬ノードを開いた LoRA の id が、順に数え上がる（文字連結にならない）', () => {
    setLocale('en');
    // 運搬ノードが**未導入**の宿主。ここでだけ `expandCarriedLoras` が走る。
    const built = buildRecipeWorkflow(
        toRecipeShape({ ...RECORD, loras: [{ name: 'alpha' }, { name: 'beta' }], prompt: carrierGraph() }),
        { objectInfo: INSTALLED, embeddings: [] },
    );
    const opened = Object.entries(built.prompt)
        .filter(([, node]) => node?._meta?.unbake_expanded_lora)
        .map(([id]) => id);

    assert.equal(opened.length, 2, `開いた数が2でない: ${JSON.stringify(opened)}`);
    // グラフの最大 id は 10 なので、次は 11・12。
    // 綴りのまま `+= 1` すると 11 → 111 になる（`I-20260831-45`）。
    assert.deepEqual(opened.map(Number).sort((a, b) => a - b), [11, 12],
        `id が順に数え上がっていない（文字連結の疑い）: ${JSON.stringify(opened)}`);
});

// --------------------------------------------------------------------------
// I-20260831-47: 2^53 を超える seed を Number で潰す
// --------------------------------------------------------------------------

/** ComfyUI の `noise_seed` が取る上限に近い値。`Number()` を通すと下の桁が変わる。 */
const HUGE_SEED = '18446744073709551615';

function builtWithSeed(seed) {
    const recipe = toRecipeShape({ ...RECORD });
    recipe.gen_params = { ...(recipe.gen_params || {}), seed };
    return buildRecipeWorkflow(recipe, { objectInfo: INSTALLED, embeddings: [] });
}

const seedsOf = (prompt) => Object.values(prompt)
    .filter(node => /KSampler/i.test(String(node.class_type || '')))
    .map(node => node.inputs?.seed)
    .filter(value => value !== undefined);

test('2^53 を超える seed は、綴りのまま渡す（桁を落とさない）', () => {
    setLocale('en');
    const seeds = seedsOf(builtWithSeed(HUGE_SEED).prompt);
    assert.ok(seeds.length > 0, 'KSampler が組めていない');
    for (const seed of seeds) {
        assert.equal(String(seed), HUGE_SEED,
            `seed が変わっている（Number で潰れた）: ${String(seed)}`);
    }
    // **`Number()` を通すと本当に変わる**ことを同じ場で見せる。
    // これが変わらない環境なら、この検査は何も守っていない。
    assert.notEqual(String(Number(HUGE_SEED)), HUGE_SEED,
        'この処理系では Number() が精度を落とさない＝検査の前提が崩れている');
});

test('[対照] 収まる seed は数のまま（綴りへ変えない）', () => {
    setLocale('en');
    const seeds = seedsOf(builtWithSeed('12345').prompt);
    assert.ok(seeds.length > 0, 'KSampler が組めていない');
    for (const seed of seeds) {
        assert.equal(typeof seed, 'number', `収まる seed が数でない: ${typeof seed}`);
        assert.equal(seed, 12345, `収まる seed が変わっている: ${seed}`);
    }
});

// --------------------------------------------------------------------------
// I-20260831-49: inputcount がリンクだと string_1 しか畳まれない
// --------------------------------------------------------------------------

/** `JoinStringMulti` が2本を繋いで `CLIPTextEncode` へ渡すグラフ。 */
function joinGraph(inputcount) {
    return {
        20: { class_type: 'JoinStringMulti', inputs: {
            inputcount, delimiter: ', ', string_1: 'first', string_2: 'second' } },
        21: { class_type: 'CLIPTextEncode', inputs: { text: ['20', 0], clip: ['1', 1] } },
        30: { class_type: 'PrimitiveInt', inputs: { value: 2 } },
    };
}

test('inputcount がリンクで来ても、本文が欠けない', () => {
    // `JoinStringMulti` は未導入（だから畳む必要がある）。
    const prompt = joinGraph(['30', 0]);
    const out = inlineJoinStringMulti(prompt, INSTALLED);

    // 繋ぎ先が定数なら読めるので、畳んだうえで**両方**入っていること。
    assert.equal(out.folded, 1, `畳めていない: ${JSON.stringify(out)}`);
    assert.equal(prompt['21'].inputs.text, 'first, second',
        `本文が欠けている: ${JSON.stringify(prompt['21'].inputs.text)}`);
});

test('inputcount の本数が読めないなら、畳まない（黙って切り詰めない）', () => {
    // 繋ぎ先が定数でない＝本数が判らない。以前はここで `string_1` だけを
    // 畳んで本文を落としていた（例外もログも出ない）。
    const prompt = joinGraph(['31', 0]);
    prompt['31'] = { class_type: 'SomeNode', inputs: { a: ['30', 0] } };
    const out = inlineJoinStringMulti(prompt, INSTALLED);

    assert.equal(out.folded, 0, '本数が読めないのに畳んでいる');
    assert.deepEqual(prompt['21'].inputs.text, ['20', 0],
        `畳まないはずの参照が書き換わっている: ${JSON.stringify(prompt['21'].inputs.text)}`);
});

test('[対照] inputcount が数なら、これまでどおり畳む', () => {
    const prompt = joinGraph(2);
    const out = inlineJoinStringMulti(prompt, INSTALLED);
    assert.equal(out.folded, 1);
    assert.equal(prompt['21'].inputs.text, 'first, second');
});

// --------------------------------------------------------------------------
// I-20260831-46: メモの往復で並びが入れ替わり、URL が項目に化ける
// --------------------------------------------------------------------------

test('メモの往復で、行の並びが変わらない', () => {
    const source = ['自由記述の1行目', 'ポーズ: 立ち絵', '自由記述の2行目'].join('\n');
    assert.equal(formatNotes(parseNotes(source)), source,
        '自由記述が末尾へ寄っている（並びが落ちている）');
});

test('URL の行は項目にしない（`https` という項目名を作らない）', () => {
    const source = 'https://example.com/a?b=1';
    const parsed = parseNotes(source);
    assert.deepEqual(parsed.fields, [], `URL が項目になっている: ${JSON.stringify(parsed.fields)}`);
    assert.equal(formatNotes(parsed), source, '往復で URL が書き換わっている');
});

test('[対照] 値としての URL は、項目のまま残す', () => {
    const parsed = parseNotes('参考: https://example.com/a');
    assert.deepEqual(parsed.fields, [{ key: '参考', value: 'https://example.com/a' }]);
});

test('[対照] 昔ながらの formatNotes(fields, freeText) も動く', () => {
    assert.equal(
        formatNotes([{ key: 'ポーズ', value: '立ち絵' }], '自由記述'),
        'ポーズ: 立ち絵\n自由記述',
    );
});

// --------------------------------------------------------------------------
// I-20260831-48: 強度と差し替えの順番（注記が実装と逆だった）
// --------------------------------------------------------------------------

test('強度は差し替えより先に当たる（差し替え後の名前で引かない）', () => {
    const record = {
        id: 'rec-48',
        checkpoint: 'a.safetensors',
        loras: [{ file_name: 'alpha.safetensors', strength_model: 1, strength_clip: 1 }],
    };
    try {
        // 強度は**元の名前**を鍵に置く（画面はそうする）。
        setLoraOverride(record.id, record.loras[0], 0, 0.3);
        setModelOverride(record.id, record.loras[0], 0, 'beta.safetensors');

        const out = applyRecordOverrides(record);
        assert.equal(out.loras[0].file_name, 'beta.safetensors', '差し替えが効いていない');
        // 差し替えを先に走らせると、強度は `fbeta.safetensors` を引いて当たらない。
        assert.equal(out.loras[0].strength_model, 0.3,
            '強度が当たっていない＝差し替えが先に走っている');
    } finally {
        clearAllOverrides(record.id);
    }
});

// --------------------------------------------------------------------------
// I-20260831-51: 名前の無い LoRA へ、添字でハッシュを割り当てる
// --------------------------------------------------------------------------

const namelessMeta = (count) => ({
    civitaiResources: Array.from({ length: count }, (_, index) => ({
        type: 'lora', modelVersionId: 100 + index, weight: 0.5,
    })),
    hashes: Object.fromEntries(
        Array.from({ length: count }, (_, index) => [`lora:name${index}`, `HASH${index}`]),
    ),
});

test('相手が1つに決まらないなら、ハッシュを結び付けない', () => {
    const recipe = recipeFromCivitaiMeta({ id: 1 }, namelessMeta(2));
    const nameless = recipe.loras.filter(item => !item.file_name);

    assert.equal(nameless.length, 2, `名前の無い項目が消えている: ${JSON.stringify(recipe.loras)}`);
    for (const item of nameless) {
        assert.equal(item.hash ?? null, null,
            `当てずっぽうのハッシュが付いている: ${JSON.stringify(item)}`);
    }
    // ハッシュ側は捨てない——別の項目として残す（重複はしても、嘘はつかない）。
    const named = recipe.loras.filter(item => item.file_name);
    assert.deepEqual(named.map(item => item.file_name).sort(), ['name0', 'name1'],
        `hashes 側の LoRA が落ちている: ${JSON.stringify(recipe.loras)}`);
});

test('[対照] 相手が1つに決まるなら、これまでどおり結び付ける', () => {
    const recipe = recipeFromCivitaiMeta({ id: 1 }, namelessMeta(1));
    assert.equal(recipe.loras.length, 1, `項目が増えている: ${JSON.stringify(recipe.loras)}`);
    assert.equal(recipe.loras[0].file_name, 'name0');
    assert.equal(recipe.loras[0].hash, 'HASH0');
});
