/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **実際の meta に出る鍵を、落とさずに採る。**
 *
 * 2026-08-26 に Civitai の公開 API を 316件ぶん数えて決めた（利用者の指示・
 * 鍵は測定後に削除）。下の値は**その走査で出た実物**。
 *
 * **「鍵が在る」と「情報が在る」は別。** 同じ走査で `versionIds` /
 * `modelIds` / `controlNets` は 26件中 **26件とも空の配列**だったので、
 * 読むようにしても何も増えない——だから足していない。
 * 逆に `upscalers` は 19件が中身を持ち、**使う側は元から在った**のに
 * 取り込みが値を入れていなかった。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recipeFromCivitaiMeta } from '../web/core/civitaiClient.js';

/** 実測で出た値（2026-08-26）。 */
const FORGE = {
    prompt: 'a', negativePrompt: 'b', seed: 1, steps: 20, cfgScale: 5,
    // 実測 316件の内訳は a1111 262 / other 121 / comfy 16。多数派の形にする。
    Model: 'someCheckpoint_v1',
    'Model hash': 'ABCDEF0123',
    'Distilled CFG Scale': '4.6',
    'Module 1': 'ae',
    'Hires Module 1': 'Use same choices',
    'ADetailer model': 'face_yolov8n.pt',
    'ADetailer confidence': '0.3',
    'ADetailer denoising strength': '0.4',
    upscalers: ['DAT_x4.pth'],
    versionIds: [], modelIds: [], controlNets: [],
};

/**
 * **95%側の経路で測る。**
 *
 * 取り込みには2本ある: グラフを持つ絵（`recordFromCivitaiImage`）と、
 * 持たない絵（`recipeFromCivitaiMeta`）。同じ 316件の走査で **`comfy` を
 * 持つのは16件（5.1%）**しかないので、A1111 形の値が要るのはこちら。
 * グラフを持つ絵は、値がグラフの中に在るので拾い直す必要が無い。
 */
const build = (meta) => recipeFromCivitaiMeta({ id: 1 }, meta, new Map());

test('Flux の誘導値を落とさない', () => {
    // 実測 7.9%。**絵が変わる値**なので、採らないと材料が違う。
    assert.equal(build(FORGE).gen_params.distilled_cfg_scale, '4.6');
});

test('Forge がモジュールに入れた VAE を拾う', () => {
    // 実測 7.0%。`VAE` が無い絵でも、`Module 1` に名前が入っている。
    assert.equal(build(FORGE).gen_params.vae, 'ae');
});

test('VAE が在るときは Module 1 で上書きしない', () => {
    const got = build({ ...FORGE, VAE: 'real_vae.safetensors' });
    assert.equal(got.gen_params.vae, 'real_vae.safetensors');
});

test('Hires Module 1 は VAE として使わない', () => {
    // **実測の値が `"Use same choices"`**——ファイル名ではなく指示の言葉。
    // これを VAE にすると、存在しないファイルを探しに行く。
    const got = build({ ...FORGE, 'Module 1': undefined });
    assert.notEqual(got.gen_params.vae, 'Use same choices');
});

test('顔の描き直しの設定を落とさない', () => {
    // **そのままでは再現できない工程だからこそ残す。** 消すと
    // 「同じ材料なのに絵が違う」の理由が記録から消える。
    const got = build(FORGE).gen_params;
    assert.equal(got.adetailer_model, 'face_yolov8n.pt');
    assert.equal(got.adetailer_confidence, '0.3');
    assert.equal(got.adetailer_denoising_strength, '0.4');
});

test('ADetailer が無い絵に、空の欄を作らない', () => {
    const got = build({ prompt: 'a', seed: 1, Model: 'x' }).gen_params;
    assert.equal('adetailer_model' in got, false, '無い工程の欄を作っている');
});

test('拡大器を、使う側が読む場所へ入れる', () => {
    // 使う側は `generation_metadata.upscalers`（元から在った）。
    assert.deepEqual(build(FORGE).generation_metadata.upscalers, ['DAT_x4.pth']);
});

test('空の拡大器で欄を作らない', () => {
    assert.equal('generation_metadata' in build({ ...FORGE, upscalers: [] }), false);
});

test('土台のモデルの鍵が1つだけ', async () => {
    // **同じリテラルに2つ在ると、片方を直したつもりで直らない。**
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../web/core/civitaiClient.js', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('export function recordFromCivitaiImage'));
    const count = [...body.matchAll(/^\s{8}base_model:/gm)].length;
    assert.equal(count, 1, `記録の直下に base_model が ${count} 個ある`);
});
