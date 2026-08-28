/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **消した絵・古い絵が画面に出続ける問題**（利用者の報告・複数回）。
 *
 * 報告そのまま: 「レコードの出た絵の削除を行った後再現すると比較画像が
 * 表示されたり、再度生成した後に表示が前の画像だったりします」。
 *
 * ## 成り立ちの条件（どれも repo 内で実測済み）
 *
 *   1. ComfyUI の `/api/view` は `Cache-Control` を返さない（`ETag` と
 *      `Last-Modified` だけ）。ブラウザは推測でキャッシュを効かせるので、
 *      **同じ URL なら問い合わせずに前の中身を出す**（`panel.js` の
 *      `freshImageUrl` の注記・2026-08-27 実測）。
 *   2. **ComfyUI は消して空いた番号を再利用する。** `_00006_` を消して
 *      作り直すと、出来上がる絵も `_00006_` になり **URL が完全に同じ**になる。
 *
 * 1 と 2 が揃うと、**消した絵・前の絵がそのまま出る**。
 *
 * ## なぜ何度直しても直らなかったか（この検査の主眼）
 *
 * URL を組み立てている所が **5箇所**あるのに、回避は**表示側の1箇所**
 * （`openCompare` の相手側）にしか入っていなかった。**口を1つずつ塞ぐ形**では、
 * 塞いでいない口から同じ症状が出続ける——直したのに直っていない、の正体はこれ。
 *
 * だからここで固定するのは「ある画面が直ったこと」ではなく、
 * **URL を作る側が必ず鮮度の印を載せること**である。新しい口が増えても、
 * この検査は組み立て器を通っているかどうかを見る。
 *
 * ## 印に時刻（`Date.now()`）を使わない理由
 *
 * 毎回変わる印を全部の口へ入れると、**4,275枚の一覧が毎回全部再取得**になる。
 * 印は**中身が変わったときだけ変わる**必要があり、それ以外では変わってはいけない。
 * サーバは各出力の `modified`（mtime）と `size` を既に返しているので、そこから作る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setLocale } from '../web/i18n/index.js';
import { outputImageUrl, freshnessToken } from '../web/core/outputUrl.js';
import { createVariantsView } from '../web/panel/variantsView.js';
import { fakeDocument } from './fake_dom.mjs';

/** 消される前の絵。 */
const BEFORE = {
    filename: 'civitai_137684933_00006_.png',
    subfolder: '',
    modified: 1756400000.5,
    size: 1327543,
};

/** **同じ名前で作り直された**別の絵（ComfyUI が空いた番号を再利用した）。 */
const AFTER = {
    filename: 'civitai_137684933_00006_.png',
    subfolder: '',
    modified: 1756400900.25,
    size: 1328607,
};

// --- 組み立て器そのもの -----------------------------------------------------

test('同じ名前で中身が変わったら、URL が変わる', () => {
    // **これが直したかった症状そのもの。** 名前も置き場も同じなので、
    // 印が無ければ2つは区別できず、ブラウザは前の中身を出す。
    assert.notEqual(
        outputImageUrl(BEFORE), outputImageUrl(AFTER),
        '消して作り直しても URL が同じ＝前の絵が出る',
    );
});

test('中身が同じなら、URL は変わらない', () => {
    // **毎回変える印にしない。** 一覧は実測 4,275枚あり、開くたびに
    // 全部取り直すと、直したはずの面が今度は重くて使えなくなる。
    assert.equal(
        outputImageUrl(BEFORE), outputImageUrl({ ...BEFORE }),
        '同じ絵なのに URL が動いている（毎回取り直しになる）',
    );
});

test('mtime だけ・size だけが変わっても、URL は変わる', () => {
    // 片方しか見ていないと、そちらが動かない直し方（同じ大きさで上書き・
    // タイムスタンプを保った複製）で素通りする。
    assert.notEqual(
        outputImageUrl(BEFORE), outputImageUrl({ ...BEFORE, modified: BEFORE.modified + 1 }),
        'mtime の変化を見ていない',
    );
    assert.notEqual(
        outputImageUrl(BEFORE), outputImageUrl({ ...BEFORE, size: BEFORE.size + 1 }),
        'size の変化を見ていない',
    );
});

test('鮮度が判らない絵にも、必ず印は載る', () => {
    // 生成直後は履歴から名前だけが来る（mtime も大きさもまだ判らない）。
    // **判らないときこそ古い絵が出る場面**なので、ここは毎回変わる印でよい。
    const bare = { filename: 'ComfyUI_00001_.png', subfolder: '' };
    const first = outputImageUrl(bare);
    assert.match(first, /[?&]_ub=/, '鮮度が判らないのに印が無い');
    assert.notEqual(first, outputImageUrl(bare), '判らないのに同じ URL を返している');
});

test('印は問い合わせの形を壊さない', () => {
    const url = outputImageUrl(BEFORE);
    assert.match(url, /^\/api\/view\?/, '口が変わっている');
    const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    assert.equal(params.get('filename'), BEFORE.filename);
    assert.equal(params.get('type'), 'output');
    assert.equal(params.get('subfolder'), '');
});

test('置き場が違えば別の絵として扱う', () => {
    assert.notEqual(
        outputImageUrl(BEFORE), outputImageUrl({ ...BEFORE, subfolder: 'sub' }),
        '置き場を見ていない',
    );
});

test('印は素材の値だけで決まる（呼ぶ場所で変わらない）', () => {
    // 同じ絵を別の面が出したときに URL が食い違うと、片方だけが取り直す。
    assert.equal(freshnessToken(BEFORE), freshnessToken({ ...BEFORE }));
});

// --- 画面へ届くところ -------------------------------------------------------

test('「出た絵」の一覧のサムネにも印が載っている', () => {
    setLocale('en');
    const view = createVariantsView({
        documentRef: fakeDocument(),
        record: { id: 'r1', title: 'R' },
        outputs: [BEFORE],
    });
    const image = view.root.byClass('unbake-variant-image');
    assert.ok(image, 'サムネが無い');
    assert.match(
        image.getAttribute('src'), /[?&]_ub=/,
        '一覧のサムネに印が無い＝消して作り直しても前の絵が出続ける',
    );
});

test('一覧のサムネは、作り直した絵で別の URL になる', () => {
    setLocale('en');
    const src = (output) => createVariantsView({
        documentRef: fakeDocument(),
        record: { id: 'r1', title: 'R' },
        outputs: [output],
    }).root.byClass('unbake-variant-image').getAttribute('src');
    assert.notEqual(src(BEFORE), src(AFTER), '作り直しても同じ URL を出している');
});
