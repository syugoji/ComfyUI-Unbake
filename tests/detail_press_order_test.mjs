/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **遅れて返った1件が、後から押した1件を畳まない**
 * （2026-08-31・監査 I-20260831-23）。
 *
 * `openDetail()` は `loadRecord` / `canBuild` / `loadVariants` を**await してから**
 * `detailView?.destroy()` して自分を据える。押した順の見張りが無いので、
 * **遅い1件目が後から返ると、既に出ている2件目を destroy して自分に差し替える。**
 *
 * 同じ形は再現の側では既に解いてある——`openMadeOrQueue` は `lastPressedReplay`
 * を持ち「遅れて返った分で、後から押した記録の絵を消さない」と書いてある。
 * **詳細だけがその見張りを持っていなかった。**
 *
 * 押した人からは「押しても開かない → もう1件押したら一瞬出て、関係ない方に
 * 戻った」に見える。記録も例外も出ない（付いている面は1枚なので、器が残る形の
 * 壊れ方はしない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createUnbakePanel } from '../web/panel/panel.js';
import { fakeDocument } from './fake_dom.mjs';
import { resetMemoryStorage } from '../web/core/storage.js';
import { setLocale } from '../web/i18n/index.js';

const RECORDS = [
    { id: 'alpha', libraryId: 'alpha', title: 'Alpha', verdict: 'reproducible' },
    { id: 'beta', libraryId: 'beta', title: 'Beta', verdict: 'reproducible' },
];

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** `alpha` だけ遅く返す書庫。 */
function slowFirst(delays = { alpha: 60, beta: 1 }) {
    return async (id) => {
        await wait(delays[String(id)] ?? 1);
        return { id, gen_params: { seed: 1, steps: 20, cfg_scale: 4, sampler: 'euler' } };
    };
}

function mount(io = {}) {
    setLocale('en');
    resetMemoryStorage();
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc, display: { listView: 'table' }, ...io,
    });
    panel.setRecords(RECORDS);
    return panel;
}

/** 詳細を開く。**待たない**（押しっぱなしの状態を作りたいので）。 */
function press(panel, id) {
    const record = RECORDS.find(item => item.id === id);
    return panel.openDetail(record);
}

/** 今どの記録の詳細が出ているか。 */
function shownId(panel) {
    const view = panel.detailView;
    if (!view?.root) return '';
    const text = [...view.root.walk()].map(node => String(node.textContent || '')).join(' ');
    if (/Beta/.test(text)) return 'beta';
    if (/Alpha/.test(text)) return 'alpha';
    return '';
}

test('遅い1件目が後から返っても、後に押した方が出たままになる', async () => {
    const panel = mount({ loadRecord: slowFirst() });

    press(panel, 'alpha');   // 遅い（60ms）・待たない
    await wait(5);
    press(panel, 'beta');    // 速い（1ms）
    await wait(200);         // alpha が返り切るまで待つ

    assert.equal(shownId(panel), 'beta',
        `後から押した Beta が、遅れて返った Alpha に畳まれている: ${shownId(panel)}`);
});

test('対照: 1件だけ押したときは、遅くても開く', async () => {
    const panel = mount({ loadRecord: slowFirst() });
    await press(panel, 'alpha');
    await wait(200);
    assert.equal(shownId(panel), 'alpha', '遅い1件が開かなくなっている（見張りが強すぎる）');
});

test('対照: 押し直せば、後の1件へ入れ替わる', async () => {
    const panel = mount({ loadRecord: slowFirst({ alpha: 1, beta: 1 }) });
    await press(panel, 'alpha');
    await wait(50);
    assert.equal(shownId(panel), 'alpha');
    await press(panel, 'beta');
    await wait(50);
    assert.equal(shownId(panel), 'beta', '押し直しても入れ替わらない（見張りが効きすぎている）');
});
