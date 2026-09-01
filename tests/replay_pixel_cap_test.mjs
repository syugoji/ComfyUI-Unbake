/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **「大きすぎる再現を縮める」上限が、単独で効くこと**（`I-20260830-08`）。
 *
 * 元は縮める処理が「グラフに `VAEDecodeTiled` が在るとき」に囲われていた。だが
 * 分割復号を選ぶかどうかは `vaeDecodeInputs` が **4.5M という別の閾値**で決めており、
 * 利用者が入れた上限とは無関係である。結果、この設定が防ぐはずだった当のものが
 * 素通りしていた:
 *
 *   - 素の `VAEDecode` を持つ埋め込みグラフは、**何メガピクセルでも縮まない**
 *   - 上限を 2M へ下げても、4.5M 未満の記録は**一切縮まない**
 *
 * ## 既存の検査が素通りさせた理由（同じ轍を踏まないために書いておく）
 *
 * `record_shape_test.mjs` は上限を **4,500,000 と 0 の2値**でしか呼ばず、題材の
 * グラフが**最初から `VAEDecodeTiled` を持っている**。しかも 9.5MP ÷ 4.5MP＝**2.11倍**
 * なので、閾値を2倍に緩める変異すら生き残る。ここでは
 *
 *   - 上限の **1.02倍**（境界の際）で測る
 *   - 分割復号を**持たない**グラフで測る
 *   - 上限を**下げた**場合で測る
 *
 * の3方向を足す。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toRecipeShape } from '../web/core/recordShape.js';
import { buildRecipeWorkflow } from '../web/core/recipeWorkflowBuilder.js';
import { setLocale } from '../web/i18n/index.js';

const RECORD = {
    id: 'x.png', title: 'x',
    checkpoint: 'a.safetensors',
    seed: 1, steps: 20, cfg: 4, sampler: 'euler', scheduler: 'normal',
    positive: 'pos', negative: 'neg',
};

/** 素の `VAEDecode` だけを持つ1段グラフ（分割復号は**在らない**）。 */
function plainGraph(width, height) {
    return {
        1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a.safetensors' } },
        2: { class_type: 'CLIPTextEncode', inputs: { text: 'neg', clip: ['1', 1] } },
        3: { class_type: 'CLIPTextEncode', inputs: { text: 'pos', clip: ['1', 1] } },
        4: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
        5: { class_type: 'KSampler', inputs: {
            seed: 1, steps: 20, cfg: 4, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
            model: ['1', 0], positive: ['3', 0], negative: ['2', 0], latent_image: ['4', 0] } },
        6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
        7: { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'x' } },
    };
}

/** 同じ形だが、復号が**分割**（記録そのものがタイル分割だった場合）。 */
function tiledGraph(width, height) {
    const graph = plainGraph(width, height);
    graph[6] = { class_type: 'VAEDecodeTiled', inputs: {
        samples: ['5', 0], vae: ['1', 2],
        tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 } };
    return graph;
}

const build = (graph, maxReplayPixels) => buildRecipeWorkflow(
    toRecipeShape({ ...RECORD, prompt: graph }),
    { objectInfo: null, embeddings: [], maxReplayPixels },
);
const biggest = (prompt) => Object.values(prompt)
    .filter(node => Number(node.inputs?.width) > 0)
    .map(node => [node.inputs.width, node.inputs.height])
    .sort((a, b) => (b[0] * b[1]) - (a[0] * a[1]))[0];
const said = (built) => (built.warnings || []).join(' / ');

test('分割復号を持たないグラフでも縮む', () => {
    setLocale('en');
    // 9.5MP。**素の `VAEDecode` しか無い**ので、元の実装はここで即 return していた。
    const built = build(plainGraph(2560, 3712), 4_500_000);
    const [w, h] = biggest(built.prompt);
    assert.ok(w * h <= 4_500_000, `縮めていない: ${w}x${h}`);
    assert.match(said(built), /reduced to|縮めました/, '黙って縮めている');
});

test('上限の1.02倍でも縮む（境界の際で測る）', () => {
    setLocale('en');
    // 2144x2144 = 4,596,736 ＝ 4.5M の 1.021倍。**2倍の余裕を残さない。**
    const built = build(plainGraph(2144, 2144), 4_500_000);
    const [w, h] = biggest(built.prompt);
    assert.ok(w * h <= 4_500_000, `境界の際で縮めていない: ${w}x${h} (${w * h})`);
});

test('[対照] 上限のちょうど以下なら触らない', () => {
    setLocale('en');
    // 2120x2120 = 4,494,400 ＝ 上限のすぐ下。
    const built = build(plainGraph(2120, 2120), 4_500_000);
    const [w, h] = biggest(built.prompt);
    assert.deepEqual([w, h], [2120, 2120], '上限内なのに縮めている');
    assert.doesNotMatch(said(built), /reduced to|縮めました/, '触っていないのに縮めたと言っている');
});

test('上限を下げれば、4.5M 未満の記録も縮む', () => {
    setLocale('en');
    // 1600x1600 = 2.56MP。分割復号の閾値（4.5M）より**下**なので、
    // 元の実装ではどんな上限を入れても一切縮まなかった。
    const built = build(plainGraph(1600, 1600), 2_000_000);
    const [w, h] = biggest(built.prompt);
    assert.ok(w * h <= 2_000_000, `下げた上限が効いていない: ${w}x${h}`);
});

test('[対照] 上限が 0 なら、下げても上げても触らない', () => {
    setLocale('en');
    const built = build(plainGraph(2560, 3712), 0);
    assert.deepEqual(biggest(built.prompt), [2560, 3712], '上限が無いのに縮めている');
});

test('縮めた後もまだ大きいなら、分割復号を残す', () => {
    setLocale('en');
    // 上限を 8M へ上げた人のグラフ。9.5MP → 8M へ縮むが、**VRAM の閾値 4.5M は超える**。
    // ここで素の復号へ戻すと、載らない形へ書き換えることになる。
    // **見本は分割復号を持つもの**——素の復号しか無い記録には、そもそも残す物が無い。
    const built = build(tiledGraph(2560, 3712), 8_000_000);
    const [w, h] = biggest(built.prompt);
    assert.ok(w * h <= 8_000_000, `上限まで縮めていない: ${w}x${h}`);
    assert.ok(w * h > 4_500_000, `前提: VRAM の閾値は超えたまま (${w * h})`);
    const decodes = Object.values(built.prompt)
        .filter(n => String(n.class_type).startsWith('VAEDecode')).map(n => n.class_type);
    assert.ok(decodes.includes('VAEDecodeTiled'),
        `まだ大きいのに素の復号へ戻している: ${decodes.join(',')}`);
});

test('比率と8の倍数は保つ', () => {
    setLocale('en');
    const built = build(plainGraph(2560, 3712), 4_500_000);
    const [w, h] = biggest(built.prompt);
    assert.equal(w % 8, 0, '幅が8の倍数でない');
    assert.equal(h % 8, 0, '高さが8の倍数でない');
    assert.ok(Math.abs((w / h) - (2560 / 3712)) < 0.02, `比率が変わっている: ${w}x${h}`);
});
