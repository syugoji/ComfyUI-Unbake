/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 「出た絵」の面から、記録にする／設定を戻す（2026-08-24 利用者の指示）。
 *
 * **どちらも機能としては前から在った。** 記録にする口は升目の側、設定を戻す口は
 * 詳細の欄の側。**出た絵を並べて見ているこの面からだけ届かなかった**ので、
 * 利用者からは「無い」と見えていた。
 *
 * **見つけられない機能は、無いのと同じこと。** ここで固定するのは
 * 「この面から届くこと」であって、取り込みや読み取りの中身ではない
 * ——中身は既にある1本を差しているだけで、2本目を作っていない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setLocale } from '../web/i18n/index.js';
import { createVariantsView } from '../web/panel/variantsView.js';
import { fakeDocument } from './fake_dom.mjs';

const OUTPUT = {
    filename: 'ComfyUI_00001_.png',
    url: '/api/view?filename=ComfyUI_00001_.png&type=output&subfolder=',
    attribution: { evidence: 'stamped' },
    raw: { prompt: {} },
};

const view = (options = {}) => createVariantsView({
    documentRef: fakeDocument(),
    record: { id: 'r1', title: 'R' },
    outputs: [OUTPUT],
    ...options,
});

test('口を渡さなければ、押せるものを出さない', () => {
    setLocale('en');
    const v = view();
    // **押しても何も起きないボタンを並べない**（面の他の口と同じ約束）。
    assert.equal(v.root.byClass('unbake-variant-actions'), null, '渡していない口が出ている');
});

test('記録にする口と、設定を戻す口が、出た絵1枚ごとに出る', () => {
    setLocale('en');
    const v = view({ onCapture: async () => ({ ok: true }), onExtract: async () => ({ ok: true }) });
    assert.ok(v.root.byClass('unbake-variant-save'), '記録にする口が無い');
    assert.ok(v.root.byClass('unbake-variant-extract'), '設定を戻す口が無い');
});

test('違いと根拠は畳んでおき、押せる口は畳まない', () => {
    setLocale('en');
    const v = view({ onCapture: async () => ({ ok: true }), onExtract: async () => ({ ok: true }) });
    // **普段は畳む**（2026-08-24 利用者の指示）。違いはプロンプトの差を含むので
    // 長くなりがちで、並べて見たいのは絵のほう。
    const info = v.root.byClass('unbake-variant-info');
    assert.ok(info, '情報の畳みが無い');
    assert.equal(info.tagName, 'DETAILS', '畳めない形で置いている');
    assert.equal(info.getAttribute('open'), null, '最初から開いている');
    // **畳んだのは情報であって、押せる口ではない。**
    const inside = (cls) => Boolean(info.byClass?.(cls));
    assert.equal(inside('unbake-variant-save'), false, '記録にする口まで畳んでいる');
    assert.equal(inside('unbake-variant-extract'), false, '設定を戻す口まで畳んでいる');
    // 畳んだままでも「読めなかった／差が無い」は読める。
    assert.notEqual(v.root.byClass('unbake-variant-summary').textContent, '', '畳んだ見出しが空');
});

test('押すと、その絵を渡して結果を隣に出す', async () => {
    setLocale('en');
    const seen = [];
    const v = view({
        onCapture: async (output) => { seen.push(output?.filename); return { ok: true }; },
        onExtract: null,
    });
    v.root.byClass('unbake-variant-save').dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 0));
    // **どの絵に対する操作かを取り違えない。**
    assert.deepEqual(seen, ['ComfyUI_00001_.png'], '別の絵を渡している');
    assert.notEqual(v.root.byClass('unbake-variant-status').textContent, '', '結果を出していない');
});

test('走っている間は二度押しを受け付けない', async () => {
    setLocale('en');
    let starts = 0;
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const v = view({ onCapture: async () => { starts += 1; await held; return { ok: true }; } });
    const button = v.root.byClass('unbake-variant-save');
    button.dispatch('click', {});
    await Promise.resolve();
    button.dispatch('click', {});
    await Promise.resolve();
    // **記録にする口を2回叩くと2件増える。** 押している間は受け付けない。
    assert.equal(starts, 1, '走っている最中にもう1件始めている');
    release();
});

test('失敗を成功と混ぜない（理由をそのまま出す）', async () => {
    setLocale('en');
    const v = view({ onCapture: async () => ({ ok: false, reason: 'no-recipe' }) });
    v.root.byClass('unbake-variant-save').dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(v.root.byClass('unbake-variant-status').textContent, /no-recipe/, '理由が出ていない');
});

test('口が投げても面は死なず、理由が出る', async () => {
    setLocale('en');
    const v = view({ onCapture: async () => { throw new Error('boom'); } });
    const button = v.root.byClass('unbake-variant-save');
    button.dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(v.root.byClass('unbake-variant-status').textContent, /boom/, '理由が出ていない');
    // **押せる状態へ戻す。** 戻さないと、1回失敗しただけで永久に押せなくなる。
    assert.equal(button.disabled, false, '失敗したまま押せなくなっている');
});

// --- 消す（2026-08-25 利用者の指示）----------------------------------------

test('消す口は、押した瞬間には消さない（猶予のあいだ画面から外すだけ）', async () => {
    setLocale('en');
    const doc = fakeDocument();
    const asked = [];
    const view = createVariantsView({
        documentRef: doc,
        record: { id: 'r', title: 'R' },
        outputs: [{ filename: 'a.png', subfolder: '', url: '/view?a' }],
        onDelete: async (output) => { asked.push(output.filename); return { ok: true }; },
    });
    const remove = view.root.byClass('unbake-variant-delete');
    assert.ok(remove, '消す口が無い');
    remove.dispatch('click', {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(asked, ['a.png'], '呼ばれていない');
    // **絵は画面から外れる。** 消えたかどうかは呼び手が決める。
    assert.equal(view.root.byClass('unbake-variant-image'), null, '絵が残っている');
    // **升目は残す。** 丸ごと消すと、戻す口を置く場所が無くなる。
    assert.ok(view.root.byClass('unbake-variant-gone'), '消したことを言っていない');
});

test('消した升目に「元に戻す」が出て、押すと戻る', async () => {
    // **戻す口はパネルの記録欄にしか無かった**（2026-08-25 利用者の指摘）。
    // 詳細は画面いっぱいに被さるので、そこからは**一度も見えない**。
    setLocale('en');
    const doc = fakeDocument();
    let undone = 0;
    const view = createVariantsView({
        documentRef: doc,
        record: { id: 'r', title: 'R' },
        outputs: [{ filename: 'a.png', subfolder: '', url: '/view?a' }],
        onDelete: async () => ({ ok: true, seconds: 12, undo: () => { undone += 1; } }),
    });
    view.root.byClass('unbake-variant-delete').dispatch('click', {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const back = view.root.byClass('unbake-variant-undo');
    assert.ok(back, '戻す口が出ていない');
    back.dispatch('click', {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(undone, 1, '約束を取り消していない');
    // **絵が戻ること。** 口だけ戻して中身が空だと、戻ったことにならない。
    assert.ok(view.root.byClass('unbake-variant-image'), '絵が戻っていない');
    assert.equal(view.root.byClass('unbake-variant-gone'), null, '跡が残っている');
    // **もう一度消せること。** 押せないままだと、戻した後が行き止まりになる。
    assert.equal(view.root.byClass('unbake-variant-delete').disabled, false, '消す口が押せないまま');
});

test('戻す口が渡されていないときは、出さない', async () => {
    // **押しても何も起きない口を出さない**（前に出して指摘を受けている）。
    setLocale('en');
    const doc = fakeDocument();
    const view = createVariantsView({
        documentRef: doc,
        record: { id: 'r', title: 'R' },
        outputs: [{ filename: 'a.png', subfolder: '', url: '/view?a' }],
        onDelete: async () => ({ ok: true }),
    });
    view.root.byClass('unbake-variant-delete').dispatch('click', {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(view.root.byClass('unbake-variant-gone'), '消したことを言っていない');
    assert.equal(view.root.byClass('unbake-variant-undo'), null, '効かない口を出している');
});

test('消せなかったら、升目を残して理由を出す', async () => {
    setLocale('en');
    const doc = fakeDocument();
    const view = createVariantsView({
        documentRef: doc,
        record: { id: 'r', title: 'R' },
        outputs: [{ filename: 'a.png', subfolder: '', url: '/view?a' }],
        onDelete: async () => ({ ok: false, reason: 'busy' }),
    });
    const remove = view.root.byClass('unbake-variant-delete');
    remove.dispatch('click', {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // **消せていないのに消えた顔をしない。**
    assert.ok(view.root.byClass('unbake-variant'), '消せていないのに升目を外している');
    assert.equal(remove.disabled, false, '押し直せない');
    assert.match(String(view.root.byClass('unbake-variant-status').textContent || ''), /busy/,
        '理由が出ていない');
});

test('消す口を渡さなければ、口は出さない', () => {
    setLocale('en');
    const view = createVariantsView({
        documentRef: fakeDocument(),
        record: { id: 'r', title: 'R' },
        outputs: [{ filename: 'a.png', subfolder: '', url: '/view?a' }],
    });
    assert.equal(view.root.byClass('unbake-variant-delete'), null,
        '口が無いのに消す釦を出している');
});
