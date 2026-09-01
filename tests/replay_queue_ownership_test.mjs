/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **生きている面の待ち行列を、別の面が「前回の残り」として奪わない**
 * （2026-08-31・監査 I-20260831-12）。
 *
 * 待ち行列は `writeStored(REPLAY_QUEUE_KEY, ids)` で**文書ごとに1つの鍵**へ
 * 控えられ、`offerLeftoverQueue()` が面の初回 `replaceRecords` でその鍵を読み、
 * **読んだ側が即座に空にして**「戻す」口を出す。
 *
 * 読む側は「前回のセッションの残り」を仮定しているが、**鍵の持ち主は
 * 今まさに動いているもう一方の面でありうる**——サイドバーの ⛶ は
 * サイドバーを畳まずに全画面の2枚目を起こし、その場で `setRecords` する。
 *
 * 実測（修正前）: A が 'b' を積む → 控えは `["b"]` → B が開いて
 * `Queue them again` を提示 → 戻すと **B が A の分を投入した**（同じ絵を2回焼く）。
 *
 * **「前回の残り」が意味を持つのは、読み込み直した後だけ。** 同じページの中で
 * 生きている面が持ち主なら、それは残りではなく**現役の行列**である。
 * だから持ち主を控えへ書き、**このページで生きている面の分は claim しない**
 * （読み込み直せばその一覧は空になるので、本来の「前回の残り」は今までどおり戻せる）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createUnbakePanel } from '../web/panel/panel.js';
import { fakeDocument } from './fake_dom.mjs';
import { readStored, resetMemoryStorage } from '../web/core/storage.js';
import { setLocale } from '../web/i18n/index.js';

const KEY = 'unbake.panel.replay_queue';
const RECORDS = [
    { id: 'a', libraryId: 'a', title: 'A', verdict: 'reproducible' },
    { id: 'b', libraryId: 'b', title: 'B', verdict: 'reproducible' },
];

/** 投入を止めたまま、行列に溜める仕掛け。 */
function harness() {
    const loads = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const shared = {
        loadRecord: (id) => { loads.push(String(id)); return gate.then(() => ({ id, gen_params: { seed: 1 } })); },
        makeSweepRunner: () => ({ inputsReady: null, run: async () => ({ ok: true }) }),
    };
    const mount = () => {
        const doc = fakeDocument();
        const panel = createUnbakePanel(doc.createElement('div'), {
            documentRef: doc, display: { listView: 'table' }, ...shared,
        });
        panel.setRecords(RECORDS);
        return panel;
    };
    return { loads, mount, release };
}

const replayButtons = (panel) => panel.root.allByClass('unbake-act-replay');
const restoreAction = (panel) => panel.root
    .findAll(node => String(node.className || '').includes('unbake-log-action'))[0];
const settle = () => new Promise(resolve => setTimeout(resolve, 10));

test('2枚目の面は、1枚目が持っている行列を横取りしない', async () => {
    setLocale('en');
    resetMemoryStorage();
    const { loads, mount } = harness();

    const first = mount();
    await replayButtons(first)[0].dispatch('click', {});
    await replayButtons(first)[1].dispatch('click', {});
    await settle();
    assert.deepEqual(loads, ['a'], '前提が崩れている（1件だけ走って残りが並ぶ形にならない）');
    assert.deepEqual(readStored(KEY, null)?.ids ?? readStored(KEY, null), ['b'],
        '待ち行列が控えられていない（前提が崩れている）');

    const second = mount();
    await settle();
    assert.equal(restoreAction(second), undefined,
        '生きている面の行列を「前回の残り」として戻そうとしている');

    // **控えを消してもいけない。** 消すと1枚目が落ちたとき本当に失われる。
    assert.deepEqual(readStored(KEY, null)?.ids ?? readStored(KEY, null), ['b'],
        '2枚目が1枚目の控えを消している');
    assert.deepEqual(loads, ['a'], '2枚目が勝手に投入した');
});

test('対照: 読み込み直した後なら、前回の残りを戻せる', async () => {
    setLocale('en');
    resetMemoryStorage();

    // 1回目のページ。行列を残したまま終わる。
    const before = harness();
    const first = before.mount();
    await replayButtons(first)[0].dispatch('click', {});
    await replayButtons(first)[1].dispatch('click', {});
    await settle();
    assert.deepEqual(readStored(KEY, null)?.ids ?? readStored(KEY, null), ['b']);

    // **読み込み直しを真似る。** 面を畳んで、生きている面の一覧から外す。
    first.destroy?.();

    const after = harness();
    const reopened = after.mount();
    await settle();
    const action = restoreAction(reopened);
    assert.ok(action, '前回の残りを戻す口が出ていない（機能そのものを殺した）');
    await action.dispatch('click', {});
    await settle();
    assert.deepEqual(after.loads, ['b'], `戻したのに投入されていない: ${JSON.stringify(after.loads)}`);
});

test('対照: 古い形（素の配列）の控えも、今までどおり戻せる', async () => {
    // 版を跨いだ利用者の控えを捨てない。
    setLocale('en');
    resetMemoryStorage();
    const { mount, loads } = harness();
    const { writeStored } = await import('../web/core/storage.js');
    writeStored(KEY, ['b']);

    const panel = mount();
    await settle();
    const action = restoreAction(panel);
    assert.ok(action, '古い形の控えを読み飛ばしている');
    await action.dispatch('click', {});
    await settle();
    assert.deepEqual(loads, ['b']);
});
