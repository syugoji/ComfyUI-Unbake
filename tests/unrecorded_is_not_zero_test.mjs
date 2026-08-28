/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **未記録を 0 と読まない**（`D-20260828-01` 群A）。
 *
 * `Number(null)` は 0 を返し、`Number.isFinite(0)` は true を返す。だから
 * `Number.isFinite(Number(x)) ? Number(x) : 既定` と素直に書くと、
 * **未記録が「0 という有効値」として通る。** 起きるのはこれ:
 *
 *   - `steps: 0` … 1歩も denoise しないので、絵ではなく灰色の塊が出る
 *   - `cfg: 0`  … プロンプトが効かない
 *   - `seed: 0` … **埋め込みグラフに書いてある正しい seed を 0 で潰す**
 *   - LoRA 強度 0 … **名前どおり挿入されるのに、絵には一本も効かない**
 *
 * `null` が来る経路は実在する（`generationRecord.js` は強度がリンク供給なら
 * `strength: null` を書き、`recordShape.js` の `numberOf()` も読めない値に
 * `null` を返す）。**「今のデータには null が無い」ではなく「書く側が null を書く」。**
 *
 * 同じ罠を書いた `firstRecordedNumber()` は前から在った——**通していない所が
 * 5箇所残っていた**のがこの群である。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildRecipeWorkflow } from '../web/core/recipeWorkflowBuilder.js';
import { setLocale } from '../web/i18n/index.js';

setLocale('ja');

/** 数値という数値が全部 `null` の記録。**形は正しく、値だけが未記録。** */
const ALL_NULL = () => ({
    id: 'rec-null',
    title: 'unrecorded',
    checkpoint: { file_name: 'base.safetensors', modelVersionId: 1 },
    loras: [
        // 強度がリンク供給の LoRA（`generationRecord.js` が実際に書く形）。
        { file_name: 'a.safetensors', strength: null, modelVersionId: 2 },
        { file_name: 'b.safetensors', strength_model: null, strength_clip: null, modelVersionId: 3 },
    ],
    gen_params: {
        prompt: 'a girl', negative_prompt: '',
        seed: null, steps: null, cfg_scale: null,
        hires_steps: null, hires_cfg_scale: null,
    },
});

const nodesOf = (built, type) => Object.values(built?.prompt || {})
    .filter(node => new RegExp(type, 'i').test(node?.class_type || ''));

test('steps と cfg は、未記録なら既定へ落ちる（0 にならない）', () => {
    const built = buildRecipeWorkflow(ALL_NULL(), {});
    const samplers = nodesOf(built, 'KSampler');
    assert.ok(samplers.length, '組めていない');
    for (const node of samplers) {
        assert.notEqual(node.inputs.steps, 0,
            'steps が 0（1歩も denoise しないので灰色の塊が出る）');
        assert.notEqual(node.inputs.cfg, 0, 'cfg が 0（プロンプトが効かない）');
        assert.equal(node.inputs.steps, 20, `既定の 20 でない: ${node.inputs.steps}`);
        assert.equal(node.inputs.cfg, 7, `既定の 7 でない: ${node.inputs.cfg}`);
    }
});

test('LoRA の強度は、未記録なら 1（0 で積まない）', () => {
    const built = buildRecipeWorkflow(ALL_NULL(), {});
    const loras = nodesOf(built, 'LoraLoader');
    assert.ok(loras.length >= 2, `LoRA が積まれていない: ${loras.length}`);
    for (const node of loras) {
        assert.notEqual(node.inputs.strength_model, 0,
            `${node.inputs.lora_name} が強度 0（名前は入るのに絵に効かない）`);
        /*
         * **1 ちょうどは求めない。** 記録の無い強度には別の決めごとが在り
         *（`UNRECORDED_LORA_PEAK_CAP = 0.85`・実走で全件が成立した値）、
         * 既定 1 を上限で丸めたものがここへ来る。**この検査が見るのは
         * 「未記録が 0 として通らないこと」**であって、丸め方ではない。
         */
        assert.ok(node.inputs.strength_model > 0 && node.inputs.strength_model <= 1,
            `強度が範囲外: ${node.inputs.strength_model}`);
        assert.ok(node.inputs.strength_clip > 0 && node.inputs.strength_clip <= 1,
            `CLIP 強度が範囲外: ${node.inputs.strength_clip}`);
    }
});

test('埋め込みグラフの seed を、未記録の seed で潰さない', () => {
    /*
     * ここが一番読みにくい壊れ方をする。**グラフには正しい seed が在る**のに、
     * 記録側の `seed: null` を「記録されている」と読んで 0 で上書きしていた
     * ——同じ材料・同じ手順で、**毎回ちがう絵の出ない**（常に seed 0 の）再現になる。
     */
    const record = ALL_NULL();
    record.prompt = {
        1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'base.safetensors' } },
        2: { class_type: 'CLIPTextEncode', inputs: { text: 'a girl', clip: ['1', 1] } },
        3: { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
        4: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
        5: { class_type: 'KSampler', inputs: {
            seed: 123456789, steps: 28, cfg: 6.5, sampler_name: 'euler', scheduler: 'normal',
            denoise: 1, model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0],
        } },
        6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
        7: { class_type: 'SaveImage', inputs: { images: ['6', 0] } },
    };
    const built = buildRecipeWorkflow(record, {});
    const sampler = nodesOf(built, 'KSampler')[0];
    assert.ok(sampler, '埋め込みグラフから組めていない');
    assert.notEqual(sampler.inputs.seed, 0, 'グラフの seed を 0 で潰している');
    assert.equal(sampler.inputs.seed, 123456789, `seed が変わっている: ${sampler.inputs.seed}`);
    // **歩数も同じ。** 記録が無いならグラフの値が残る（既定で塗り替えない）。
    assert.equal(sampler.inputs.steps, 28, `グラフの steps を書き換えている: ${sampler.inputs.steps}`);
    assert.equal(sampler.inputs.cfg, 6.5, `グラフの cfg を書き換えている: ${sampler.inputs.cfg}`);
});

test('Civitai の資源欄が重みを持たないとき、強度 0 で積まない', async () => {
    /*
     * `normalizeResources` は重みが数値でなければ**明示的に `null` を書く**ので、
     * ここは実際に通る道。`Number(null)` を「記録されている」と読むと、
     * **版IDまで判っている LoRA が強度 0 で積まれる**——名前は出るのに絵に効かない。
     */
    const { recipeFromCivitaiMeta } = await import('../web/core/civitaiClient.js');
    const built = recipeFromCivitaiMeta({ id: 1 }, {
        civitaiResources: [
            { type: 'lora', modelVersionId: 1, modelVersionName: 'v1', weight: null },
        ],
    }, new Map());
    const loras = built?.loras || [];
    assert.equal(loras.length, 1, `積めていない: ${JSON.stringify(built)}`);
    assert.notEqual(loras[0].strength, 0, '強度 0 で積んでいる');
    assert.equal(loras[0].strength, 1);
});
