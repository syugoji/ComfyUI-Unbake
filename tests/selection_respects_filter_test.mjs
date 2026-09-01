/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **選択を使う操作は、絞り込みの外へ手を伸ばさない**
 * （2026-08-31・監査 I-20260831-11）。
 *
 * `chosenRecords()` は「選択が『見えているもの』の外へ出ることは在りうる。
 * その分は**外す**——画面に出ていないものを動かさない」と宣言していて、
 * 落とす・束で回す・落とす品書きはそれを通していた。ところが
 * **削除・再現・モデル掃除の3つと、品書きの件数**だけが生の `selected` を読み、
 * 絞り込みで隠れている分まで巻き込んでいた。
 *
 * **画面が自己矛盾する形で出る。** 選択の帯は正しく
 * 「1件を選択（2件は絞り込みで隠れています）」と出しているのに、
 * 右クリックの品書きは「選択した3件を削除」と出て、実際に3件消える。
 * **削除は取り消せない**ので、ここが実害の最大点になる。
 *
 * 対照を置く——絞り込みを外せば3件とも対象になること（＝「選択を無視する
 * ようになった」のではなく「見えている分だけに絞った」のだと言えるように）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createUnbakePanel } from '../web/panel/panel.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale } from '../web/i18n/index.js';
import { resetMemoryStorage } from '../web/core/storage.js';

const RECORDS = () => ([
    { id: 'a', libraryId: 'a', title: 'alpha', verdict: 'reproducible' },
    { id: 'b', libraryId: 'b', title: 'beta', verdict: 'reproducible' },
    { id: 'c', libraryId: 'c', title: 'gamma', verdict: 'reproducible' },
]);

/** 3件を選び、`filter` で1件だけ見えている状態のパネルを作る。 */
async function panelWithHiddenSelection(io = {}) {
    setLocale('en');
    resetMemoryStorage();
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc,
        // 「消す前に確認する」を切ってある利用者。確認の面を挟まないぶん、
        // **押した瞬間に消える**ので実害の形がそのまま出る。
        display: { listView: 'table', confirmBeforeDelete: false },
        ...io,
    });
    panel.setRecords(RECORDS());
    panel.root.dispatch('keydown', { key: 'a', ctrlKey: true, preventDefault() {}, stopPropagation() {} });
    assert.equal(panel.selected.length, 3, '前提が崩れている（3件選べていない）');
    return { panel, doc };
}

async function narrowTo(panel, text) {
    const search = panel.root.byClass('unbake-search');
    search.value = text;
    await search.dispatch('input', {});
}

async function openMenuOnVisibleRow(panel) {
    const row = panel.root.findAll(n => n.tagName === 'TR'
        && n.getAttribute('data-selected') === 'true')[0];
    assert.ok(row, '選択された行が画面に出ていない（前提が崩れている）');
    await row.dispatch('contextmenu', { clientX: 10, clientY: 10, preventDefault() {}, stopPropagation() {} });
    return panel.root.allByClass('unbake-context-item');
}

test('絞り込みで隠れている選択は、削除の対象にしない', async () => {
    const removed = [];
    const { panel } = await panelWithHiddenSelection({
        recordsIo: { remove: async (id) => { removed.push(String(id)); return { ok: true }; } },
    });
    await narrowTo(panel, 'alpha');

    const items = await openMenuOnVisibleRow(panel);
    await items[0].dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.deepEqual(removed, ['a'],
        `画面に出ていない記録まで消した: ${JSON.stringify(removed)}`);
    assert.deepEqual(panel.getRecords().map(r => r.id).sort(), ['b', 'c'],
        '隠れていた記録が消えている（取り消せない）');
});

test('品書きの件数が、実際に消える件数と一致する', async () => {
    const { panel } = await panelWithHiddenSelection({
        recordsIo: { remove: async () => ({ ok: true }) },
    });
    await narrowTo(panel, 'alpha');

    const items = await openMenuOnVisibleRow(panel);
    const label = String(items[0].textContent);
    assert.ok(/\b1\b/.test(label) && !/\b3\b/.test(label),
        `帯は「1件」と出しているのに品書きは別の数字を出している: ${label}`);
});

test('対照: 絞り込みが無ければ、選んだ3件とも対象になる', async () => {
    const removed = [];
    const { panel } = await panelWithHiddenSelection({
        recordsIo: { remove: async (id) => { removed.push(String(id)); return { ok: true }; } },
    });
    // 絞り込みを掛けない＝3件とも見えている。

    const items = await openMenuOnVisibleRow(panel);
    await items[0].dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.deepEqual(removed.sort(), ['a', 'b', 'c'],
        '見えている選択まで外している（絞りすぎ）');
});
