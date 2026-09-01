/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **記録された LoRA の強度を、勝手に書き換えない**
 * （2026-08-31・監査 I-20260831-04, I-20260831-05）。
 *
 * 同じファイルの中で規則が2通りに割れていた。
 *
 * `extractPromptLoras`（:389 付近）は `Number.isFinite(strength) ? strength : 1`
 * と書いていて **0 を保つ**。ところが:
 *
 * 1. `carriedLoraEntries` の `text` 経路は `Number(match[2] ?? 1) || 1`。
 *    `Number("0") || 1` は **1** になるので、**作者が切っていた LoRA が全開で当たる**。
 *    しかも `expandCarriedLoras` の警告は「順番も強さも同じなので絵は変わりません」
 *    ——**変わるのに変わらないと言う**。
 * 2. `mergePromptLoras` は `weight: tagged.strength` しか写さず、`clipStrength` を
 *    どこにも渡さない。`<lora:名前:model:clip>` の第3項が**値によらず常に失われ**、
 *    model 側の値で塗り潰される。姉妹経路の `a1111LoraMerge.js` は正しく使っている。
 *
 * **どちらも投入は通り、警告も出ない。** 絵だけが静かに変わる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildRecipeWorkflow } from '../web/core/recipeWorkflowBuilder.js';
import { toRecipeShape } from '../web/core/recordShape.js';
import { setLocale } from '../web/i18n/index.js';

const STOCK = Object.fromEntries([
    'CheckpointLoaderSimple', 'CLIPTextEncode', 'EmptyLatentImage',
    'KSampler', 'VAEDecode', 'SaveImage', 'LoraLoader',
].map(type => [type, { input: { required: {} } }]));

const RECORD = {
    id: 'r', title: 'r', checkpoint: 'a.safetensors', loras: [],
    seed: 1, steps: 20, cfg: 4, sampler: 'euler', scheduler: 'normal',
    width: 1024, height: 1024, negative: 'neg',
};

/** 組み上がった `LoraLoader` の並び（名前・model 強度・clip 強度）。 */
function loaders(prompt) {
    return Object.values(prompt)
        .filter(node => node.class_type === 'LoraLoader')
        .map(node => ({
            name: String(node.inputs.lora_name),
            model: node.inputs.strength_model,
            clip: node.inputs.strength_clip,
        }));
}

function buildFromPrompt(positive) {
    setLocale('en');
    return buildRecipeWorkflow(toRecipeShape({ ...RECORD, positive }),
        { objectInfo: STOCK, embeddings: [] });
}

/** 運搬ノードが**未導入**のグラフ（＝標準ローダーへ開かれる経路）。 */
function buildFromCarrierText(text) {
    setLocale('en');
    const graph = {
        '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a.safetensors' } },
        '10': { class_type: 'Lora Loader (LoraManager)', inputs: { model: ['1', 0], clip: ['1', 1], text } },
        '2': { class_type: 'CLIPTextEncode', inputs: { text: 'neg', clip: ['10', 1] } },
        '3': { class_type: 'CLIPTextEncode', inputs: { text: 'pos', clip: ['10', 1] } },
        '4': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
        '5': { class_type: 'KSampler', inputs: {
            seed: 1, steps: 20, cfg: 4, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
            model: ['10', 0], positive: ['3', 0], negative: ['2', 0], latent_image: ['4', 0] } },
        '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
        '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'x' } },
    };
    return buildRecipeWorkflow(toRecipeShape({ ...RECORD, positive: 'pos', comfy_prompt: graph }),
        { objectInfo: STOCK, embeddings: [] });
}

test('プロンプトのタグの CLIP 側強度が、model 側で塗り潰されない', () => {
    const built = buildFromPrompt('a cat <lora:mystyle:0.8:0.3>');
    const rows = loaders(built.prompt);
    assert.equal(rows.length, 1, `LoRA が1本になっていない: ${JSON.stringify(rows)}`);
    assert.equal(rows[0].model, 0.8, 'model 側が記録と違う');
    assert.equal(rows[0].clip, 0.3,
        `CLIP 側が model の値で塗り潰されている: ${JSON.stringify(rows[0])}`);
});

test('CLIP 側が 0 でも保つ（0 を「書いていない」と読まない）', () => {
    const built = buildFromPrompt('a cat <lora:mystyle:0.8:0>');
    const rows = loaders(built.prompt);
    assert.equal(rows[0].model, 0.8);
    assert.equal(rows[0].clip, 0, `CLIP 側の 0 が消えている: ${JSON.stringify(rows[0])}`);
});

test('運搬ノードの text に書かれた強度 0 が、1 に化けない', () => {
    const built = buildFromCarrierText('<lora:style_a:0.8:0> <lora:style_b:0>');
    const rows = loaders(built.prompt);
    const byName = Object.fromEntries(rows.map(row => [row.name.replace(/\.safetensors$/, ''), row]));

    assert.equal(byName.style_a?.model, 0.8, 'style_a の model 側が違う');
    assert.equal(byName.style_a?.clip, 0,
        `style_a の clip 側が 1 に化けている: ${JSON.stringify(byName.style_a)}`);

    // **作者が切っていた LoRA。** 1 になると全開で当たる＝別の絵になる。
    assert.equal(byName.style_b?.model, 0,
        `切ってあった LoRA が全開で当たっている: ${JSON.stringify(byName.style_b)}`);
    assert.equal(byName.style_b?.clip, 0);
});

test('対照: 強度を書いていないタグは、今までどおり 1 として扱う', () => {
    // **0 と「書いていない」は別。** ここを一緒にすると、A1111 の既定
    // （書かなければ 1）が壊れる。
    const built = buildFromPrompt('a cat <lora:mystyle>');
    const rows = loaders(built.prompt);
    assert.equal(rows[0].model, 1, '書いていないタグの既定が 1 でなくなっている');
    assert.equal(rows[0].clip, 1);
});

test('対照: model だけ書いたタグは、clip も同じ値になる', () => {
    const built = buildFromPrompt('a cat <lora:mystyle:0.6>');
    const rows = loaders(built.prompt);
    assert.equal(rows[0].model, 0.6);
    assert.equal(rows[0].clip, 0.6, 'clip を書いていないときは model と同じにする約束');
});
