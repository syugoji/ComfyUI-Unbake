/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 実機で報告された6巡目（2026-08-21）。
 *
 *   ⑱ タイルの操作が見切れる・真ん中に出て絵を隠す
 *   ⑲ 見本画像を自前で集める（動画に注意・LoRA Manager と衝突しない）
 *   ⑳ 「既に出ている絵」で下へ送れない
 *   ㉑ 「不足」にカーソルを合わせると枠が橙になり「近似」に見える
 *   ㉒ 拡大が小さい・比べる相手が無い旨の一文が邪魔
 *   ㉓ `civitai_57874269` が「不足」だが本来「近似」
 *
 * **㉓ は判定の誤りだった。** A1111 は拡大モデルを `R-ESRGAN 4x+ Anime6B` と書き、
 * 同じ物のファイル名は `RealESRGAN_x4plus_anime_6B.pth`。字面が違うので
 * **手元に在るのに「未導入」**と判定していた（実データ346件で 59 → 51 に減った）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRecipeWorkflow } from '../web/core/recipeWorkflowBuilder.js';
import { createUnbakePanel } from '../web/panel/panel.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale } from '../web/i18n/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const OBJECT_INFO = {
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [['base.safetensors']] } } },
    UpscaleModelLoader: {
        input: { required: { model_name: ['COMBO', { options: [
            'RealESRGAN_x4plus_anime_6B.pth', 'RealESRGAN_x4plus.pth', '4x-UltraSharp.pth',
        ] }] } },
    },
};

const hiresRecipe = (upscaler) => ({
    id: 'rec-1',
    title: 'Civitai_Recipe_57874269',
    checkpoint: { file_name: 'base.safetensors' },
    gen_params: {
        prompt: 'a girl', seed: 1, steps: 20, cfg_scale: 7, sampler: 'euler',
        size: '832x1216', hires_upscale: 1.5, hires_upscaler: upscaler, hires_steps: 10,
        denoising_strength: 0.35,
    },
    loras: [],
});

const upscalerNodesOf = (workflow) => Object.values(workflow.prompt)
    .filter(node => node?.class_type === 'UpscaleModelLoader')
    .map(node => node.inputs.model_name);

// --- ㉓ A1111 の名前と、手元のファイル名 --------------------------------------

test('A1111 の拡大モデル名を、手元のファイル名へ突き合わせる', () => {
    setLocale('en');
    // **同じ物が2つの名前を持っている。** 字面で比べると「未導入」になる。
    const built = buildRecipeWorkflow(hiresRecipe('R-ESRGAN 4x+ Anime6B'),
        { objectInfo: OBJECT_INFO, embeddings: [] });
    assert.deepEqual(upscalerNodesOf(built), ['RealESRGAN_x4plus_anime_6B.pth'],
        '手元に在るのに名前で取り違えている');

    const plain = buildRecipeWorkflow(hiresRecipe('R-ESRGAN 4x+'),
        { objectInfo: OBJECT_INFO, embeddings: [] });
    assert.deepEqual(upscalerNodesOf(plain), ['RealESRGAN_x4plus.pth']);

    // そのままの名前で在るものは、そのまま。
    const direct = buildRecipeWorkflow(hiresRecipe('4x-UltraSharp'),
        { objectInfo: OBJECT_INFO, embeddings: [] });
    assert.deepEqual(upscalerNodesOf(direct), ['4x-UltraSharp.pth']);
});

test('手元に無い拡大モデルは、ノードを作らずに lanczos へ倒す', () => {
    setLocale('en');
    // **無い物を指すノードを組むと、ComfyUI が投入ごと拒んで1枚も出ない。**
    // lanczos だけなら絵は出る（元とは少し違う＝「近似」）。
    const built = buildRecipeWorkflow(hiresRecipe('SomeUnknownUpscaler_8x'),
        { objectInfo: OBJECT_INFO, embeddings: [] });
    assert.deepEqual(upscalerNodesOf(built), [], '手元に無いモデルを指すノードを組んでいる');
    // 拡大そのものは残る（hires の段は消えない）。
    const scales = Object.values(built.prompt).filter(node => node?.class_type === 'ImageScale');
    assert.ok(scales.length >= 1, 'hires の段ごと消している');
    // **黙って倒さない。** 何が起きたかを警告として残す。
    assert.ok((built.warnings || []).some(w => /SomeUnknownUpscaler_8x/.test(w)),
        '倒したことを言っていない');
});

test('導入済みが判らないときは、名前をそのまま渡す（今までの挙動）', () => {
    setLocale('en');
    const built = buildRecipeWorkflow(hiresRecipe('R-ESRGAN 4x+ Anime6B'), { embeddings: [] });
    assert.deepEqual(upscalerNodesOf(built), ['R-ESRGAN 4x+ Anime6B']);
});

// --- ⑲ 見本を自前で集める ----------------------------------------------------

test('見本は models フォルダの外へ置く（上流のダウンロードとぶつけない）', async () => {
    const source = await readFile(join(ROOT, 'unbake/model_previews.py'), 'utf8');
    // **こちらの取り分は user ディレクトリの下。** 同じ場所を2つの実装が書かない。
    assert.match(source, /Path\(base\) \/ "unbake" \/ "model-previews"/);
    // モデルの場所をこちらで組み立てない（組み立てると書き先が models へ寄る）。
    assert.doesNotMatch(source, /folder_paths\.get_full_path/);

    // 出すときは**上流のものを先に見る**（完全版が勝つ）。
    const routes = await readFile(join(ROOT, 'unbake/routes.py'), 'utf8');
    const start = routes.indexOf('def model_preview_path');
    assert.ok(start >= 0, '見本を出す関数が無い');
    const end = routes.indexOf('\ndef ', start + 1);
    const body = routes.slice(start, end > 0 ? end : undefined);
    const siblingAt = body.indexOf('with_suffix');
    const cacheAt = body.indexOf('cached_preview');
    assert.ok(siblingAt >= 0 && cacheAt > siblingAt,
        '上流の見本より先にこちらの取り分を見ている');
});

test('動画しか無いモデルは、見本にしない', async () => {
    // Civitai の見本は先頭が動画のことがある。`<img>` へ入れても何も出ないので、
    // **静止画だけを選ぶ**——「先頭を取る」と書くと、動画のモデルだけ黙って空になる。
    const source = await readFile(join(ROOT, 'unbake/model_previews.py'), 'utf8');
    assert.match(source, /def pick_still_image/);
    assert.match(source, /str\(item\.get\("type", "image"\)\)\.lower\(\) != "image"/,
        '種類を見ずに先頭を取っている');
    // 取りに行ってよい配信元を絞ってある。
    assert.match(source, /IMAGE_HOSTS = \("image\.civitai\.com",\)/);
    // 探して無かったことを覚える（毎回問い合わせ直さない）。
    assert.match(source, /_remember_miss\(kind, name, "no-still-image"\)/);
});

test('見本は原寸で集めない（400本で数百MBになる）', async () => {
    const source = await readFile(join(ROOT, 'unbake/model_previews.py'), 'utf8');
    assert.match(source, /width=450/, '原寸のまま集めている');
    assert.match(source, /MAX_PREVIEW_BYTES/, '大きさの上限が無い');
});

// --- ⑱㉑㉒ 見た目 -------------------------------------------------------------

test('タイルの操作は上の帯に出る（絵の真ん中を隠さない・折り返さない）', async () => {
    const css = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');
    // **`.unbake-tile-actions` は2つの規則に出てくる**（重ね方と、置き場所）。
    // セレクタ名だけで拾うと最初の規則を読む——ここで見たいのは置き場所の方。
    const block = [...css.matchAll(/([^{}]*)\{([^}]*)\}/g)]
        .map(([, selector, body]) => ({ selector, body }))
        .find(rule => rule.selector.includes('.unbake-tile-actions') && /top:/.test(rule.body));
    assert.ok(block, 'タイルの操作の置き場所を決めていない');
    assert.match(block.body, /top:\s*0/, '絵の真ん中に出している');
    assert.doesNotMatch(block.body, /transform:\s*translateY\(-50%\)/);
    // **折り返すと2段目が絵に食い込む。**
    assert.match(block.body, /flex-wrap:\s*nowrap/, '折り返している（見切れる）');
});

test('タイルの操作は印だけ（字を入れると横に伸びて枠から出る）', () => {
    setLocale('en');
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc, display: { listView: 'tiles' },
        makeSweepRunner: () => ({}), loadRecord: async () => ({}),
    });
    panel.setRecords([{ id: 'a', libraryId: 'a', title: 'Civitai_Recipe_1', verdict: 'reproducible' }]);
    const buttons = panel.root.byClass('unbake-tile-actions')
        .findAll(node => node.tagName === 'BUTTON');
    assert.ok(buttons.length >= 2, '操作が出ていない');
    for (const button of buttons) {
        assert.ok(button.textContent.length <= 2, `字を入れている: ${button.textContent}`);
        assert.ok(button.getAttribute('title'), `何のボタンか判らない: ${button.textContent}`);
    }
});

test('触っただけで判定の色を変えない（不足が近似に見える）', async () => {
    const css = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');
    const hover = css.match(/\.unbake-tile:hover,\s*\n\.unbake-tile:focus-within\s*\{([^}]*)\}/);
    assert.ok(hover, 'ホバーの規則が無い');
    // **枠の色は判定そのもの。** 橙（accent）に変えると「不足」が「近似」に見える。
    assert.doesNotMatch(hover[1], /border-color/, 'ホバーで判定の色を上書きしている');
    assert.match(hover[1], /box-shadow/, '触っていることを示せていない');
});

test('比べる相手が無ければ、字を出さずに絵を大きくする', () => {
    setLocale('en');
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), { documentRef: doc });
    panel.setRecords([{
        id: 'a', libraryId: 'a', title: 'Civitai_Recipe_1', verdict: 'reproducible',
        previewUrl: '/unbake/record-preview?id=a',
    }]);
    // **絵を押すと詳細が開く**（2026-08-22 に変えた）。拡大はそこから進む先なので、
    // ここでは詳細の絵を押してから拡大を見る。
    panel.root.byClass('unbake-thumb').dispatch('click', {});
    panel.root.byClass('unbake-detail-image').dispatch('click', {});
    const box = panel.root.byClass('unbake-compare');
    assert.ok(box, '詳細から拡大へ進めない');
    // **「まだ比べる相手がありません」を出さない。** 何も進まないうえ、
    // その一文のぶんだけ絵が小さくなる。
    assert.equal(box.byClass('unbake-compare-empty'), null, '要らない一文を出している');
    assert.equal(box.byClass('unbake-compare-hint'), null, '送る相手がいないのに案内を出している');
    assert.equal(box.byClass('unbake-compare-pair').getAttribute('data-single'), 'true');
    assert.equal(box.allByClass('unbake-compare-side').length, 1, '空の側を作っている');
});

test('既に出ている絵は、下まで送れる', async () => {
    const css = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');
    const block = css.match(/\.unbake-variants\s*\{([^}]*)\}/);
    assert.ok(block, '既出の面の規則が無い');
    assert.match(block[1], /overflow-y:\s*auto/, '中で送れない');
    assert.match(block[1], /max-block-size:\s*100%/, '器より高くなって、外側ごと伸びる');
});

test('出た絵を押したら、その絵が出る（元画像のまま残さない）', async () => {
    // **製品が渡す形は `filename` / `subfolder`** で、`url` が入るのは一部だけ。
    // 落とすと一覧が空になり、`show()` が何もしないので**基準（元画像）のまま**
    // 残る——2026-08-22 に「出た絵を押すと元画像が出る」と報告された形。
    setLocale('en');
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc,
        loadVariants: async () => ({
            outputs: [
                { filename: 'made-a.png', subfolder: '', differenceLabel: 'seed 1' },
                { filename: 'made-b.png', subfolder: 'sub', differenceLabel: 'seed 2' },
            ],
            recipe: null,
        }),
    });
    panel.setRecords([{ id: 'v1', title: 'V', verdict: 'reproducible',
                        previewUrl: '/unbake/record-preview?id=v1' }]);
    // **詳細の「出た絵」から押す。** こちらは1枚で大きく出す形なので、
    // 一覧が空だと**基準（元画像）がそのまま残る**——報告されたのはこの経路。
    //（単体で開く「出た絵」は左に元画像・右に出た絵を並べる別の形。）
    await panel.openDetail(panel.getRecords()[0], { tab: 'variants' });
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    const images = panel.root.allByClass('unbake-variant-image');
    assert.equal(images.length, 2, '出た絵が並んでいない');
    images[1].dispatch('click', {});

    const shown = panel.root.byClass('unbake-compare-image');
    const src = shown.getAttribute('src');
    assert.notEqual(src, '/unbake/record-preview?id=v1', '元画像のまま残っている');
    assert.match(src, /made-b\.png/, '押した絵が出ていない');
});
