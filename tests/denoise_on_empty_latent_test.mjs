/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **白紙から描く段で記録の denoise を落としたら、そう言う**（`I-20260830-18`）。
 *
 * 詳細画面の控えには「Denoising Strength 0.38」と出ているのに、実際は `denoise 1`
 * で走る記録が**実測190件中11件**あり、うち2件は警告も一切出ていなかった。
 *
 * **値のほうは直さない。** 白紙 latent へ 1 未満を入れると平坦な絵になるので、
 * 1 が正しい。記録の 0.38 は別の文脈（img2img の段）のメタである。害があるのは
 * **無言であること**だけなので、言うようにする。
 *
 * ここを「記録を無視しているバグだ」と読んで値を直すと、**txt2img の再現が全部
 * 平坦化する**（しかも落ちる検査はゼロだった）。だからこの検査は
 * 「1 で描くこと」と「言うこと」の**両方**を固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toRecipeShape } from '../web/core/recordShape.js';
import { buildRecipeWorkflow } from '../web/core/recipeWorkflowBuilder.js';
import { setLocale } from '../web/i18n/index.js';

const base = () => ({
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a.safetensors' } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: 'neg', clip: ['1', 1] } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: 'pos', clip: ['1', 1] } },
});

/** 白紙 latent から描く1段グラフ。 */
const blankGraph = (denoise = 0.38) => ({
    ...base(),
    4: { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1216, batch_size: 1 } },
    5: { class_type: 'KSampler', inputs: {
        seed: 1, steps: 20, cfg: 4, sampler_name: 'euler', scheduler: 'normal', denoise,
        model: ['1', 0], positive: ['3', 0], negative: ['2', 0], latent_image: ['4', 0] } },
    6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    7: { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'x' } },
});

const RECORD = {
    id: 'x.png', title: 'x', checkpoint: 'a.safetensors',
    seed: 1, steps: 20, cfg: 4, sampler: 'euler', scheduler: 'normal',
    positive: 'pos', negative: 'neg',
};

/**
 * 記録を組む。**`denoising_strength` は `toRecipeShape` の写す鍵に無い**ので、
 * レシピの形にしてから `gen_params` へ入れる（実物の記録はここに持っている）。
 */
function build(graph, { denoising_strength = null } = {}) {
    const recipe = toRecipeShape({ ...RECORD, prompt: graph });
    if (denoising_strength !== null) {
        recipe.gen_params = { ...(recipe.gen_params || {}), denoising_strength };
    }
    return buildRecipeWorkflow(recipe, { objectInfo: null, embeddings: [] });
}
const denoisesOf = (prompt) => Object.values(prompt)
    .filter(n => /KSampler/i.test(String(n.class_type || '')))
    .map(n => n.inputs?.denoise);
const said = (built) => (built.warnings || []).join(' / ');

test('白紙から描く段は denoise 1 で走る（値は直さない）', () => {
    setLocale('en');
    const built = build(blankGraph(), { denoising_strength: 0.38 });
    assert.deepEqual(denoisesOf(built.prompt), [1],
        `白紙の段が 1 で走っていない: ${JSON.stringify(denoisesOf(built.prompt))}`);
});

test('落とした記録値を言う（無言にしない）', () => {
    setLocale('en');
    const built = build(blankGraph(), { denoising_strength: 0.38 });
    assert.match(said(built), /Denoising strength/i,
        `記録値を落としたことを言っていない: ${JSON.stringify(built.warnings)}`);
    assert.match(said(built), /0\.38/, '落とした値そのものを出していない');
});

test('[対照] 記録に無ければ、余計なことを言わない', () => {
    setLocale('en');
    const built = build(blankGraph());
    assert.doesNotMatch(said(built), /Denoising strength/i,
        `記録が無いのに言っている: ${JSON.stringify(built.warnings)}`);
});

test('[対照] 記録が 1 なら、落としていないので言わない', () => {
    setLocale('en');
    const built = build(blankGraph(1), { denoising_strength: 1 });
    assert.doesNotMatch(said(built), /Denoising strength/i, '同じ値なのに言っている');
});

test('[対照] 白紙でない段（img2img）では記録値がそのまま載る', () => {
    setLocale('en');
    const graph = {
        ...base(),
        9: { class_type: 'LoadImage', inputs: { image: 'in.png' } },
        10: { class_type: 'VAEEncode', inputs: { pixels: ['9', 0], vae: ['1', 2] } },
        5: { class_type: 'KSampler', inputs: {
            seed: 1, steps: 20, cfg: 4, sampler_name: 'euler', scheduler: 'normal', denoise: 0.9,
            model: ['1', 0], positive: ['3', 0], negative: ['2', 0], latent_image: ['10', 0] } },
        6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
        7: { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'x' } },
    };
    const built = build(graph, { denoising_strength: 0.38 });
    assert.deepEqual(denoisesOf(built.prompt), [0.38], '記録値が載っていない');
    assert.doesNotMatch(said(built), /Denoising strength/i, '載せたのに落としたと言っている');
});

test('この注記は「絵が変わる」に数えない', async () => {
    // 白紙の段の denoise は 1 が正しく、記録の 0.38 は別の文脈のメタ。
    // 「変わる」に数えると、11件が理由なく「中」へ落ちる。
    const { summarizeWarnings } = await import('../web/core/recipeWarningSeverity.js');
    setLocale('en');
    const built = build(blankGraph(), { denoising_strength: 0.38 });
    const only = (built.warnings || []).filter(w => /Denoising strength/i.test(String(w)));
    assert.equal(only.length, 1, '対象の注記が1本でない');
    const fidelity = summarizeWarnings(only);
    assert.equal(fidelity.riskCount, 0, '「絵が変わる」に数えている');
    assert.deepEqual(fidelity.unknown, [], '未分類のまま残っている');
});
