/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **記録した seed が、そのまま走ること**（`I-20260830-09`）。
 *
 * 元は `isHiresSampler()` が「上流に拡大 or `VAEEncode` が在れば2段目」と判定し、
 * 2段目の seed に +1 していた。ところが `LoadImage → VAEEncode → KSampler` は
 * **ごく普通の img2img** で、サンプラーは1本しかない。それを2段目と読むため、
 *
 *     記録 seed 777 → 実際に走るのは 778（警告は1本も出ない）
 *
 * になっていた。詳細画面の seed 欄は編集でき Sweep の基準にもなるので、
 * 「seed を指定したのに違う絵」が説明抜きで起きる。
 *
 * ## 不変条件で書く（形を列挙しない）
 *
 * 個々のグラフの形を並べると、`UPSCALE_CLASS_PATTERN` に語が1つ増えるたびに
 * 検査を書き足すことになる。代わりに**組み上がったグラフ全体に対する不変条件**を
 * 置く——**「サンプラーの少なくとも1本は、記録の seed と完全に一致する」**。
 * 1段目は必ず記録どおりなので、これはどの形でも成り立つ。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toRecipeShape } from '../web/core/recordShape.js';
import { buildRecipeWorkflow } from '../web/core/recipeWorkflowBuilder.js';
import { setLocale } from '../web/i18n/index.js';

const SEED = 777;
const RECORD = {
    id: 'x.png', title: 'x', checkpoint: 'a.safetensors',
    seed: SEED, steps: 20, cfg: 4, sampler: 'euler', scheduler: 'normal',
    positive: 'pos', negative: 'neg',
};

const base = () => ({
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a.safetensors' } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: 'neg', clip: ['1', 1] } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: 'pos', clip: ['1', 1] } },
});

/** ごく普通の img2img。**サンプラーは1本**（上流に VAEEncode が居る）。 */
function img2imgGraph(seed = SEED) {
    return {
        ...base(),
        9: { class_type: 'LoadImage', inputs: { image: 'in.png' } },
        10: { class_type: 'VAEEncode', inputs: { pixels: ['9', 0], vae: ['1', 2] } },
        5: { class_type: 'KSampler', inputs: {
            seed, steps: 20, cfg: 4, sampler_name: 'euler', scheduler: 'normal', denoise: 0.6,
            model: ['1', 0], positive: ['3', 0], negative: ['2', 0], latent_image: ['10', 0] } },
        6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
        7: { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'x' } },
    };
}

/** 本物の2段（hires）。1段目は白紙 latent、2段目の上流に1段目が居る。 */
function twoPassGraph(seed = SEED) {
    return {
        ...base(),
        4: { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1216, batch_size: 1 } },
        5: { class_type: 'KSampler', inputs: {
            seed, steps: 20, cfg: 4, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
            model: ['1', 0], positive: ['3', 0], negative: ['2', 0], latent_image: ['4', 0] } },
        6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
        10: { class_type: 'ImageScale', inputs: {
            width: 1248, height: 1824, upscale_method: 'lanczos', crop: 'disabled', image: ['6', 0] } },
        11: { class_type: 'VAEEncode', inputs: { pixels: ['10', 0], vae: ['1', 2] } },
        12: { class_type: 'KSampler', inputs: {
            seed, steps: 20, cfg: 4, sampler_name: 'euler', scheduler: 'normal', denoise: 0.35,
            model: ['1', 0], positive: ['3', 0], negative: ['2', 0], latent_image: ['11', 0] } },
        13: { class_type: 'VAEDecode', inputs: { samples: ['12', 0], vae: ['1', 2] } },
        14: { class_type: 'SaveImage', inputs: { images: ['13', 0], filename_prefix: 'x' } },
    };
}

const build = (graph, record = RECORD) => buildRecipeWorkflow(
    toRecipeShape({ ...record, prompt: graph }), { objectInfo: null, embeddings: [] },
);
const seedsOf = (prompt) => Object.values(prompt)
    .filter(node => /KSampler/i.test(String(node.class_type || '')))
    .map(node => Number(node.inputs?.seed ?? node.inputs?.noise_seed));

test('【不変条件】サンプラーの少なくとも1本は、記録の seed と完全に一致する', () => {
    setLocale('en');
    for (const [name, graph] of [['img2img', img2imgGraph()], ['2段', twoPassGraph()]]) {
        const seeds = seedsOf(build(graph).prompt);
        assert.ok(seeds.includes(SEED),
            `${name}: 記録の seed(${SEED}) を持つサンプラーが1本も無い → ${JSON.stringify(seeds)}`);
    }
});

test('普通の img2img では seed を動かさない（サンプラーは1本）', () => {
    setLocale('en');
    const seeds = seedsOf(build(img2imgGraph()).prompt);
    assert.deepEqual(seeds, [SEED], `img2img で seed が動いた: ${JSON.stringify(seeds)}`);
});

test('[対照] 本物の2段では、2段目だけが +1 される', () => {
    // **これが無いと「常に動かさない」実装でも上の検査は通る。**
    setLocale('en');
    const seeds = seedsOf(build(twoPassGraph()).prompt).sort((a, b) => a - b);
    assert.deepEqual(seeds, [SEED, SEED + 1],
        `2段の seed が想定と違う: ${JSON.stringify(seeds)}`);
});

test('記録に seed が無ければ、グラフの seed をそのまま残す（足さない）', () => {
    setLocale('en');
    const { seed, ...noSeed } = RECORD;
    const seeds = seedsOf(build(twoPassGraph(4242), noSeed).prompt);
    assert.deepEqual([...new Set(seeds)], [4242],
        `記録が無いのにグラフの seed を動かした: ${JSON.stringify(seeds)}`);
});

test('拡大だけで上流にサンプラーが居なければ、2段目扱いにしない', () => {
    // `LoadImage → ImageScale → VAEEncode → KSampler`（拡大してから描き直すだけ）。
    setLocale('en');
    const graph = {
        ...base(),
        9: { class_type: 'LoadImage', inputs: { image: 'in.png' } },
        10: { class_type: 'ImageScale', inputs: {
            width: 1248, height: 1824, upscale_method: 'lanczos', crop: 'disabled', image: ['9', 0] } },
        11: { class_type: 'VAEEncode', inputs: { pixels: ['10', 0], vae: ['1', 2] } },
        5: { class_type: 'KSampler', inputs: {
            seed: SEED, steps: 20, cfg: 4, sampler_name: 'euler', scheduler: 'normal', denoise: 0.5,
            model: ['1', 0], positive: ['3', 0], negative: ['2', 0], latent_image: ['11', 0] } },
        6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
        7: { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'x' } },
    };
    assert.deepEqual(seedsOf(build(graph).prompt), [SEED]);
});

test('題名に hires と書いてあれば、その申告は尊重する', () => {
    // 構造で判らない形のための逃げ道。**残っていることを固定する。**
    setLocale('en');
    const graph = img2imgGraph();
    graph[5]._meta = { title: 'KSampler (Hires)' };
    assert.deepEqual(seedsOf(build(graph).prompt), [SEED + 1]);
});
