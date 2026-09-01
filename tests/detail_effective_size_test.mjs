/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **詳細画面の「サイズ」は記録の報告値で、実際に描かれる寸法とは違う**
 * （`I-20260830-02`・利用者の報告）。
 *
 * 実測（2026-08-30・実データ200件）: 一致 129 / **記録が空 49** / 食い違い 12。
 * 食い違いの中身は 8の倍数への丸め・画素数の上限・埋め込みグラフ優先・
 * 多段の1段目・転置補正で、**丸めと上限は画面に何も出ていなかった**。
 *
 * 直し方は「欄を実効値に差し替える」ではない——**欄は編集でき、そのまま Sweep の
 * 軸になる入力**なので、差し替えると記録を書き換えたことになる。だから添える。
 *
 * ## 測り方でも間違えた（ここも固定する）
 *
 * 最初は「幅・高さを持つ最初の節」を読んで **118件が食い違う**と出した。それは
 * `smZ CLIPTextEncode` の条件付け用 1024x1024 で、生成寸法ではない。
 * `generatedSizeOf()` は**サンプラーの `latent_image` を辿る**——その違いを
 * 対照つきで固定しておかないと、同じ読み違いがまた入る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generatedSizeOf } from '../web/core/recipeWorkflowBuilder.js';
import { createDetailView } from '../web/panel/detailView.js';
import { fakeDocument } from './fake_dom.mjs';

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/** 実物の形（`smZ` は条件付けに幅・高さを持つ）。 */
const GRAPH = {
    2: { class_type: 'smZ CLIPTextEncode', inputs: { text: 'a', width: 1024, height: 1024 } },
    3: { class_type: 'smZ CLIPTextEncode', inputs: { text: 'b', width: 1024, height: 1024 } },
    4: { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1216, batch_size: 1 } },
    5: {
        class_type: 'KSampler',
        inputs: { seed: 1, positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0] },
    },
};

test('サンプラーの潜在を辿って寸法を読む', () => {
    assert.deepEqual(generatedSizeOf(GRAPH),
        { width: 832, height: 1216, via: 'EmptyLatentImage' });
});

test('[対照] 条件付けの幅・高さを拾わない（118件の誤報の正体）', () => {
    // **素朴な実装をここに並べて置く。** 「順に拾う」と何が返るかを検査の中で
    // 示さないと、この対照が本当に差を見ているのか読む側に判らない
    // ——実際、変異検査で別経路を突いてしまい素通りさせた。
    const naive = (prompt) => {
        for (const node of Object.values(prompt)) {
            const i = node?.inputs || {};
            if (typeof i.width === 'number' && typeof i.height === 'number') {
                return `${i.width}x${i.height}`;
            }
        }
        return null;
    };
    assert.equal(naive(GRAPH), '1024x1024', '前提: 素朴に拾うと条件付けに当たる');

    const got = generatedSizeOf(GRAPH);
    assert.equal(`${got.width}x${got.height}`, '832x1216');
    assert.notEqual(`${got.width}x${got.height}`, naive(GRAPH),
        '条件付けの寸法を生成寸法として読んでいる');
    assert.match(got.via, /EmptyLatent/);
});

/** 本物の多段。**サンプラーは2本**で、拡大の節が最終寸法を持つ。 */
const TWO_PASS = {
    4: { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1216 } },
    5: { class_type: 'KSampler', inputs: { seed: 1, latent_image: ['4', 0] } },
    6: { class_type: 'LatentUpscale', inputs: { samples: ['5', 0], width: 1248, height: 1824 } },
    7: { class_type: 'KSampler', inputs: { seed: 1, latent_image: ['6', 0] } },
    8: { class_type: 'VAEDecode', inputs: { samples: ['7', 0] } },
    9: { class_type: 'SaveImage', inputs: { images: ['8', 0] } },
};

test('多段では、保存される絵の寸法を返す（1段目ではない）', () => {
    // **前の版はここで 832x1216（1段目）を返していた。** 画面はそれを
    // 「実際に描かれるのは 832x1216」と出すので、**嘘の訂正**になっていた。
    //
    // 前の検査は「多段」と名乗りながら `5:` を上書きしていて**サンプラーが1本**、
    // しかも `LatentUpscale` が幅高さを持っていなかった。だから `find` でも
    // `findLast` でも同じ値になり、**一度も測っていなかった**。
    const got = generatedSizeOf(TWO_PASS);
    assert.equal(`${got.width}x${got.height}`, '1248x1824',
        `1段目の寸法を返している: ${JSON.stringify(got)}`);
});

test('[対照] 節の並び順に依らない（1段目が後ろでも同じ）', () => {
    // 並び順で当たっていただけ、を排除する。
    const shuffled = Object.fromEntries(Object.entries(TWO_PASS).reverse());
    const got = generatedSizeOf(shuffled);
    assert.equal(`${got.width}x${got.height}`, '1248x1824',
        `並び順で答えが変わる: ${JSON.stringify(got)}`);
});

test('保存へ繋がっていない枝は拾わない', () => {
    // 未接続の精錬枝が後ろに在るグラフ。**`findLast` では外す形。**
    const graph = {
        ...TWO_PASS,
        20: { class_type: 'LatentUpscale', inputs: { samples: ['5', 0], width: 4096, height: 4096 } },
        21: { class_type: 'KSampler', inputs: { seed: 9, latent_image: ['20', 0] } },
    };
    const got = generatedSizeOf(graph);
    assert.equal(`${got.width}x${got.height}`, '1248x1824',
        `保存へ繋がらない枝を拾っている: ${JSON.stringify(got)}`);
});

test('保存の節が無ければ、サンプラーから遡る（組み立て途中）', () => {
    const { 9: _save, ...noSave } = TWO_PASS;
    assert.ok(generatedSizeOf(noSave), '保存が無いだけで読めなくなっている');
});

test('サンプラーが無ければ空潜在を探す（img2img・動画）', () => {
    const graph = { 9: { class_type: 'EmptySD3LatentImage', inputs: { width: 768, height: 1344 } } };
    assert.deepEqual(generatedSizeOf(graph),
        { width: 768, height: 1344, via: 'EmptySD3LatentImage' });
});

test('読めなければ null（空を 0 と読まない）', () => {
    assert.equal(generatedSizeOf({}), null);
    assert.equal(generatedSizeOf(null), null);
    assert.equal(generatedSizeOf({ 1: { class_type: 'KSampler', inputs: {} } }), null);
});

// --- 画面へ添える側 -------------------------------------------------------

const RECORD = { id: 'a', libraryId: 'a', title: 'r', previewUrl: '/p?id=a' };
const recipeWith = (size) => ({ gen_params: { size, seed: 1, steps: 20 } });

async function noteFor({ size, effectiveSize }) {
    const doc = fakeDocument();
    const view = createDetailView({
        documentRef: doc, record: RECORD, recipe: recipeWith(size), effectiveSize,
    });
    await settle();
    // **偽DOM は `querySelector` を持たない。** 既存の検査と同じ `byClass` で探す
     // ——道具に無い口を使うと、製品側でなく検査が落ちる。
    const note = view.root.byClass('unbake-detail-effective');
    const inputs = view.root.allByClass('unbake-detail-input');
    return { view, note, text: (note?.textContent || '').trim(), inputs };
}

test('記録と実際が違うときは添える', async () => {
    const { text } = await noteFor({ size: '540x960', effectiveSize: { width: 536, height: 960 } });
    assert.ok(text.includes('536x960'), `実効値が出ていない: ${JSON.stringify(text)}`);
});

test('[対照] 同じときは添えない', async () => {
    // **これが無いと「常に出す」実装でも上の検査は通る。**
    const { text } = await noteFor({ size: '832x1216', effectiveSize: { width: 832, height: 1216 } });
    assert.equal(text, '', `同じなのに添えている: ${JSON.stringify(text)}`);
});

test('記録が空でも添える（空欄でも寸法は決まっている）', async () => {
    const { text } = await noteFor({ size: null, effectiveSize: { width: 832, height: 1216 } });
    assert.ok(text.includes('832x1216'), `空欄のときに出ていない: ${JSON.stringify(text)}`);
});

test('[対照] 実効値が取れなければ何も添えない', async () => {
    const { text } = await noteFor({ size: '540x960', effectiveSize: null });
    assert.equal(text, '', '取れていないのに何か出している');
});

test('欄の値は記録のまま（差し替えない＝振る軸の入力を壊さない）', async () => {
    const { inputs } = await noteFor({ size: '540x960', effectiveSize: { width: 536, height: 960 } });
    const values = inputs.map(el => el.value);
    assert.ok(values.includes('540x960'), `欄が記録値になっていない: ${JSON.stringify(values)}`);
    assert.ok(!values.includes('536x960'), '欄を実効値へ差し替えている');
});
test('欄を書き換えたら消える（実効値は「記録のまま出したら」の話）', async () => {
    const { view, note } = await noteFor({ size: '540x960', effectiveSize: { width: 536, height: 960 } });
    assert.ok((note?.textContent || '').includes('536x960'), '前提: 出ていること');
    const size = view.root.allByClass('unbake-detail-field')
        .find(f => (f.byClass('unbake-detail-input')?.value || '') === '540x960');
    assert.ok(size, 'サイズの欄が見つからない');
    const input = size.byClass('unbake-detail-input');
    input.value = '640x960';
    input.dispatch('input', {});
    assert.equal((note.textContent || '').trim(), '',
        '書き換えた後も実効値を出している（もうその話ではない）');
});
test('画素空間で拡大する多段でも、最終寸法を返す', () => {
    // **実物に在る形。** コード側の実測コメント（2026-08-10）が
    // 「潜在拡大は腕が肉塊化する。画素拡大（lanczos）の方が元に近い」として
    // この経路を選んでいる。保存 → 画像を受ける節 → … と**画像の線**を
    // 辿れないと、ここで止まって最終寸法に届かない。
    const graph = {
        4: { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1216 } },
        5: { class_type: 'KSampler', inputs: { seed: 1, latent_image: ['4', 0] } },
        6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0] } },
        10: { class_type: 'ImageScale', inputs: {
            image: ['6', 0], width: 1248, height: 1824, upscale_method: 'lanczos' } },
        11: { class_type: 'ImageSharpen', inputs: { images: ['10', 0] } },
        12: { class_type: 'SaveImage', inputs: { images: ['11', 0] } },
    };
    const got = generatedSizeOf(graph);
    assert.equal(`${got.width}x${got.height}`, '1248x1824',
        `画像の線を辿れていない: ${JSON.stringify(got)}`);
});
