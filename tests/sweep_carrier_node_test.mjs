/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **運搬ノードを持つ記録でも掃引が回ること**（2026-08-31・監査 I-20260831-02）。
 *
 * LoRA Manager の運搬ノードは名簿を `inputs.loras = {"__value__": [...]}` の形で
 * 持つ。`expandCarriedLoras` は**未導入のときだけ**これを標準の `LoraLoader` へ
 * 開くので、**導入している利用者の手元では運搬ノードがそのまま残る**。
 *
 * 掃引側はこの形を2箇所で取り落としていた:
 *
 * 1. `patchBuiltLoraStrength` / `patchBuiltLoraSwap` の `Array.isArray(inputs.loras)`
 *    は `{__value__: […]}` に一致しない。書き換える相手が見つからないまま
 *    `assert(changed > 0)` に落ちて **`LoRA target 0 is not present in the built
 *    workflow`** で終わる。
 * 2. 仮に素の配列でも、`assertOnlySweepInputsChanged` の照合が `.inputs.` の
 *    直後1片しか見ないので `loras` としか比べられず、**宣言外の入力を動かした**
 *    として弾かれる。`allowedInputNames` のコメントは「`inputs.loras` の配列を持つ
 *    ノードのために strength を宣言へ入れた」と書いているが、**その宣言は
 *    どちらの経路にも届いていなかった**。
 *
 * 実測の露出は自分の出力411枚中18枚（4.4%）で、すべて `Lora Loader (LoraManager)`。
 * **LoRA Manager をアンインストールすると動く**という倒錯した形になっていた。
 *
 * 対照を必ず置く——運搬ノードが未導入なら（＝標準ローダーへ開かれるなら）
 * 元から通っていたこと。片方だけだと「通るようにした」と「検査を緩めた」が
 * 見分けられない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertOnlySweepInputsChanged, buildSweepPlan } from '../web/core/recipeSweep.js';
import { toRecipeShape } from '../web/core/recordShape.js';
import { setLocale } from '../web/i18n/index.js';

const BASE = Object.fromEntries([
    'CheckpointLoaderSimple', 'CLIPTextEncode', 'EmptyLatentImage',
    'KSampler', 'VAEDecode', 'SaveImage', 'LoraLoader',
].map(type => [type, { input: { required: {} } }]));
/** 運搬ノードが**導入されている**宿主（実環境と同じ）。 */
const WITH_CARRIER = { ...BASE, 'Lora Loader (LoraManager)': { input: { required: {} } } };

function carrierGraph() {
    return {
        '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a.safetensors' } },
        '10': { class_type: 'Lora Loader (LoraManager)', inputs: {
            model: ['1', 0], clip: ['1', 1],
            text: '<lora:alpha:0.25>',
            loras: { __value__: [{ name: 'alpha', strength: 0.25, clipStrength: 0.25, active: true }] },
        } },
        '2': { class_type: 'CLIPTextEncode', inputs: { text: 'neg', clip: ['10', 1] } },
        '3': { class_type: 'CLIPTextEncode', inputs: { text: 'pos', clip: ['10', 1] } },
        '4': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
        '5': { class_type: 'KSampler', inputs: {
            seed: 1, steps: 20, cfg: 4, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
            model: ['10', 0], positive: ['3', 0], negative: ['2', 0], latent_image: ['4', 0] } },
        '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
        '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'x' } },
    };
}

const RECORD = {
    id: 'r', title: 'r', checkpoint: 'a.safetensors',
    loras: [{ name: 'alpha', strength: 0.25 }],
    seed: 1, steps: 20, cfg: 4, sampler: 'euler', scheduler: 'normal',
    width: 1024, height: 1024, positive: 'pos', negative: 'neg',
};

const STRENGTH_TEMPLATE = {
    mode: 'single_axis_seeds',
    seeds: [1],
    axes: [{ id: 'ls', kind: 'lora_strength', target: 0,
             values: [{ value: 0.25, baseline: true }, { value: 0.6 }] }],
};

function plan(objectInfo, template = STRENGTH_TEMPLATE) {
    setLocale('en');
    const recipe = toRecipeShape({ ...RECORD, comfy_prompt: carrierGraph() });
    return buildSweepPlan(recipe, template, { objectInfo, embeddings: [] });
}

test('運搬ノードが導入されていても、強度の掃引が組める', () => {
    const built = plan(WITH_CARRIER);
    const cells = built.cells ?? built;
    assert.equal(cells.length, 2, `升が組めていない: ${JSON.stringify(cells?.length)}`);

    // **書き換わった先まで見る。** 通っただけでは「弾かなくなった」に過ぎない。
    const carrierOf = (cell) => Object.values(cell.workflow.prompt)
        .find(node => /LoraManager/.test(String(node.class_type)));
    const strengths = cells.map(cell => carrierOf(cell)?.inputs?.loras?.__value__?.[0]?.strength);
    assert.deepEqual(strengths.slice().sort(), [0.25, 0.6],
        `名簿の強度が振られていない: ${JSON.stringify(strengths)}`);

    // **形を壊していない。** `{__value__: […]}` のまま返すこと（素の配列にすると
    // ComfyUI 側が受け取れない）。
    for (const cell of cells) {
        const loras = carrierOf(cell)?.inputs?.loras;
        assert.ok(loras && Array.isArray(loras.__value__),
            `名簿の形が変わっている: ${JSON.stringify(loras)}`);
    }
});

test('運搬ノードの差し替えは、二重掛けを作るくらいなら止まる（別件・I-20260831-39）', () => {
    /*
     * **差し替えは強度と同じようには直せない。** 名簿の書き換え
     * （`patchBuiltLoraSwap`）はグラフを**組んだ後**に走るので、組み立ての側は
     * まだ `alpha` を積んだ運搬ノードしか見ていない。`recipe.loras` は既に
     * `beta` なので、**運搬ノードとは別に標準ローダーを1本足してしまう**
     * （実測: 節が `…10:Lora Loader (LoraManager) 12:LoraLoader` になる）。
     * その後で運搬ノード側も `beta` へ改名されるため、**同じ LoRA が二重に当たる。**
     *
     * 今は検証器の「節の増減は弾く」がそれを止めている。**止まるのが正しい**
     * ——黙って二重掛けの絵を出すよりよい。直すなら組み立ての側で
     * 「名簿は後で書き換わる」を知らせる必要があり、別の案件にした。
     *
     * **この検査は「今は止まる」を留めるためのもの。** 直したら、ここを
     * 「差し替わって節は増えない」へ書き換えること。
     */
    assert.throws(() => plan(WITH_CARRIER, {
        mode: 'single_axis_seeds',
        seeds: [1],
        axes: [{ id: 'sw', kind: 'lora_swap', target: 0,
                 values: [{ value: 'alpha', baseline: true }, { value: 'beta.safetensors' }] }],
    }), /unintended/, '二重掛けのグラフを黙って通している');
});

test('検証器は、名簿の中の強度を「宣言した軸」として認める', () => {
    const template = { mode: 'single_axis_seeds', axes: [{ id: 'ls', kind: 'lora_strength', target: 0, values: [] }] };
    const before = { 10: { class_type: 'Lora Loader (LoraManager)', inputs: {
        loras: { __value__: [{ name: 'a.safetensors', strength: 0.8, clipStrength: 0.8 }] } } } };
    const after = { 10: { class_type: 'Lora Loader (LoraManager)', inputs: {
        loras: { __value__: [{ name: 'a.safetensors', strength: 1.0, clipStrength: 1.0 }] } } } };
    assert.doesNotThrow(() => assertOnlySweepInputsChanged(before, after, template, { includeSeed: true }));
});

test('緩めすぎていない: 名簿の中でも宣言外の項目を動かせば弾く', () => {
    // **ここが要**。葉の名前で照合するようにしたので、`loras` の下なら何でも
    // 通る、という緩め方になっていないことを確かめる。
    const template = { mode: 'single_axis_seeds', axes: [{ id: 'ls', kind: 'lora_strength', target: 0, values: [] }] };
    const before = { 10: { inputs: { loras: { __value__: [{ name: 'a.safetensors', strength: 0.8 }] } } } };
    const after = { 10: { inputs: { loras: { __value__: [{ name: 'b.safetensors', strength: 0.8 }] } } } };
    assert.throws(() => assertOnlySweepInputsChanged(before, after, template, { includeSeed: true }),
        /unintended/, '強度の軸なのに名前の差し替えを通している');
});

test('対照: 運搬ノードが未導入なら（標準ローダーへ開かれる）元から通る', () => {
    const built = plan(BASE);
    const cells = built.cells ?? built;
    assert.equal(cells.length, 2);
    const strengths = cells.map(cell => Object.values(cell.workflow.prompt)
        .find(node => node.class_type === 'LoraLoader')?.inputs?.strength_model);
    assert.deepEqual(strengths.slice().sort(), [0.25, 0.6]);
});
