/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 画面の端（`D-20260828-01` 群F）。
 *
 * - **F1**: RTL（ar / fa）で全画面の閉じる釦が見出しに重なり、下が押せない
 * - **F2**: タイル表示でも隠れた表を全件ぶん組む（**打鍵ごと**に 5,536節点）
 * - **F3**: 品書きが視野の外へ出て届かない（`fixed` に丸め込みが無い）
 * - **F4**: 絞り込むとダウンロードの口が無音になる（押しても何も起きない）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createUnbakePanel } from '../web/panel/panel.js';
import { openFullscreen } from '../web/unbake.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale, t } from '../web/i18n/index.js';

const rec = (id, extra = {}) => ({
    id, libraryId: id, title: `Civitai_Recipe_${id}`, verdict: 'reproducible', ...extra,
});

const missing = (id) => rec(id, {
    verdict: 'blocked',
    missing: { models: [], resources: [{ type: 'lora', name: `m${id}`, versionId: id }] },
});

// --- F1 書字方向 --------------------------------------------------------------

test('全画面の器に書字方向が当たる（RTL で閉じる釦が見出しに重ならない）', () => {
    /*
     * 全画面は `document.body` の直下へ置くので、面の中で当てている `dir` が
     * 届かない。閉じる釦は `inset-inline` で寄せているので、器の方向が既定の
     * ままだと**反対側へ出て見出しに重なり、その下の操作が押せなくなる。**
     */
    setLocale('ar');
    const doc = fakeDocument();
    try {
        openFullscreen(doc, { documentRef: doc });
        const shell = doc.body.children.find(node => node.id === 'unbake-fullscreen');
        assert.ok(shell, '全画面の器が無い');
        assert.equal(shell.getAttribute('dir'), 'rtl', '書字方向が当たっていない');
    } finally { setLocale('en'); }

    setLocale('ja');
    const ltr = fakeDocument();
    try {
        openFullscreen(ltr, { documentRef: ltr });
        const shell = ltr.body.children.find(node => node.id === 'unbake-fullscreen');
        assert.equal(shell.getAttribute('dir'), 'ltr');
    } finally { setLocale('en'); }
});

// --- F2 見えない表を組まない ---------------------------------------------------

test('タイル表示のときは、隠れた表を組まない', () => {
    /*
     * 実測（346件）で **5,536節点**が毎回捨てられていた。しかも `render()` は
     * 検索欄の**打鍵ごと**に走るので、打つたびに作り直していた。
     */
    const doc = fakeDocument();
    const records = Array.from({ length: 20 }, (_, i) => rec(String(i)));
    const asTiles = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc, display: { listView: 'tiles' },
    });
    asTiles.setRecords(records);
    const rowsIn = (panel) => panel.root.findAll(node => node.tagName === 'TR'
        && node.parentNode?.tagName === 'TBODY').length;
    assert.equal(rowsIn(asTiles), 0, 'タイル表示なのに表を組んでいる');

    // **表示を切り替えたら、ちゃんと組む。**（組まないまま切り替わると空になる）
    const asTable = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc, display: { listView: 'table' },
    });
    asTable.setRecords(records);
    assert.equal(rowsIn(asTable), 20, '表表示なのに行が無い');
});

// --- F3 品書きを視野の中へ ------------------------------------------------------

test('品書きは窓の外へ出さない', () => {
    /*
     * 一覧の下の方や右端で押すと、`fixed` の座標がそのまま窓の外を指す。
     * `fixed` なので巻いても追えず、**開いた品書きに二度と手が届かない。**
     */
    const doc = fakeDocument();
    doc.defaultView = { innerWidth: 400, innerHeight: 300 };
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc, display: { listView: 'tiles' },
        downloadIo: { start: async () => ({ ok: true }), state: async () => ({}) },
    });
    panel.setRecords([missing('1')]);
    const button = panel.root.byClass('unbake-download-missing');
    // 窓の右下の外を指す位置から開く。
    button.getBoundingClientRect = () => ({ left: 5000, bottom: 5000, width: 10, height: 10 });
    button.dispatch('click', {});
    const menu = panel.root.byClass('unbake-context');
    assert.ok(menu, '品書きが開かない');
    assert.ok(parseFloat(menu.style.left) < 400, `窓の外（left=${menu.style.left}）`);
    assert.ok(parseFloat(menu.style.top) < 300, `窓の外（top=${menu.style.top}）`);
    assert.ok(parseFloat(menu.style.left) >= 0 && parseFloat(menu.style.top) >= 0,
        '負の座標へ丸めている');
});

// --- F4 開けなかったら理由を言う -------------------------------------------------

test('絞り込みで対象が消えたら、理由を出す（押しても無音にしない）', () => {
    /*
     * 出す出さないは全件で決め、口に書く件数は絞り込み後だった。
     * **絞り込むと「ダウンロード（0）」が出たまま押せて、押しても何も起きない。**
     */
    setLocale('ja');
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc, display: { listView: 'tiles' },
        downloadIo: { start: async () => ({ ok: true }), state: async () => ({}) },
    });
    try {
        panel.setRecords([missing('1')]);
        const button = panel.root.byClass('unbake-download-missing');
        assert.notEqual(button.style.display, 'none', '落とせるのに口が出ていない');

        // 何にも当たらない語で絞る。
        const search = panel.root.find(node => node.tagName === 'INPUT'
            && node.getAttribute('type') === 'search');
        assert.ok(search, '検索欄が無い');
        search.value = 'zzz-no-such-record';
        search.dispatch('input', {});

        // **母集団が揃っている**なら、ここで口ごと消える。
        assert.equal(button.style.display, 'none',
            '対象が0件なのに押せる口が残っている');
        // **`|| button.style.display === 'none'` を落とした**（2026-08-31・
        // 監査 I-20260831-33）。その右辺は**2行上で既に立証した命題**なので、
        // OR に置くと左辺（説明文が出ていること）が一度も評価されない
        // ——実測で、説明文を画面から消す変異を入れても1,534件が緑のままだった。
        assert.ok(panel.root.text.includes(t('list.noMatch', { total: 1 })),
            '絞り込みに1件も当たらないことの説明が画面に出ていない');
    } finally { setLocale('en'); }
});

test('それでも開けなかったときは、黙って閉じない', () => {
    // 口が渡っていない場合（最小構成）。**押した人に理由が要る。**
    setLocale('ja');
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc, display: { listView: 'tiles' },
        downloadIo: { start: async () => ({ ok: true }), state: async () => ({}) },
    });
    try {
        panel.setRecords([missing('1')]);
        const button = panel.root.byClass('unbake-download-missing');
        // 対象を空にしてから開く（`records` を空にすると口は消えるので、直に呼ぶ）。
        panel.setRecords([]);
        button.dispatch('click', {});
        assert.equal(panel.root.byClass('unbake-context'), null, '空の品書きを開いている');
        assert.ok(panel.root.text.includes(t('download.nothingHere'))
            || panel.root.text.includes(t('download.unavailable')),
        `理由を出していない: ${panel.root.text.slice(-200)}`);
    } finally { setLocale('en'); }
});
