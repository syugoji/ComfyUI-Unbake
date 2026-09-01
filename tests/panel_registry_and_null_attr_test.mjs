/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * **走査16周目（2026-09-01）で見つけた、`panel.js` の2件。**
 *
 * ①**釦の登録簿に捨てる所が無かった。** 一覧は絞り込み・並べ替え・検索の1打ごとに
 *   描き直すので、記録1件につき**描いた回数だけ**釦が溜まる。実測（記録20件・
 *   31回描き直し）で **620個・うち画面に居るのは20個**。浮いた600個は
 *   `applyReplayState` が毎回なめる。
 *
 * ②**`makeElement` に null の番人が無かった。** 兄弟9本（`detailView` /
 *   `sweepView` / `modelsView` ほか）は全部持っていて、**この1本だけ**無い。
 *   呼ぶ側は `record?.verdictBlocker || null` と「無ければ付けない」つもりで書くが、
 *   番人が無いと**文字列の `"null"`** が属性に入る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createUnbakePanel } from '../web/panel/panel.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale } from '../web/i18n/index.js';

function mount(records, options = {}, { attach = true } = {}) {
    const doc = fakeDocument();
    const el = doc.createElement('div');
    // **本文へ付ける。** 付けないと `isConnected` が常に偽で、
    // 「外れた釦を捨てたか」を測れない（人形も本物と同じ条件を要る）。
    if (attach) doc.body.append(el);
    const panel = createUnbakePanel(el, {
        documentRef: doc, display: { listView: 'tiles' },
        // **返らない実行器。** 1件目が走り続けるので、2件目は順番待ちのまま留まる
        // ——留まらないと「描き直しを越えたか」を見る前に姿が消える。
        makeSweepRunner: () => ({
            run: () => new Promise(() => {}), stop: () => {}, preflight: () => ({ cells: [] }),
        }),
        ...options,
    });
    panel.setRecords(records);
    return { doc, panel };
}

const RECORDS = [
    { id: 'a', title: 'A', verdict: 'blocked', verdictBlocker: 'downloadable',
      recipe: { id: 'a', gen_params: { seed: 1 }, comfy_prompt: {} } },
    { id: 'b', title: 'B', verdict: 'blocked',
      recipe: { id: 'b', gen_params: { seed: 2 }, comfy_prompt: {} } },
];

const replayButtons = (panel) => panel.root.allByClass('unbake-act-replay');

/** 1件目を走らせて、2件目を順番待ちにする。**待ちの姿は描き直しを越えるはず。** */
async function holdSecond(panel) {
    const buttons = replayButtons(panel);
    await buttons[0].dispatch('click', {});   // 走り始める（返らない）
    await buttons[1].dispatch('click', {});   // 順番待ちになる
    await new Promise(resolve => setTimeout(resolve, 10));
    return buttons;
}

// --- ① 登録簿は描き直しを越えるが、溜め込まない ------------------------------

test('描き直しても、順番待ちの姿は新しい釦に出る（越えさせる側）', async () => {
    setLocale('en');
    const { panel } = mount(RECORDS);
    const before = await holdSecond(panel);
    assert.equal(before[1].getAttribute('data-held'), 'true', '待っている姿になっていない');

    panel.setRecords(RECORDS);                // 一覧を描き直す
    const after = replayButtons(panel);
    assert.notEqual(after[1], before[1], '同じ釦が使い回されている（前提が崩れている）');
    assert.equal(after[1].getAttribute('data-held'), 'true',
        '描き直したら順番待ちが画面から消えた');
});

test('画面から外れた釦は、もう当てに行かない（溜め込まない側）', async () => {
    setLocale('en');
    const { panel } = mount(RECORDS);
    const before = await holdSecond(panel);
    const stale = before[1];

    panel.setRecords(RECORDS);                // 描き直し → `stale` は画面から外れる
    assert.equal(stale.isConnected, false, '外れていない（前提が崩れている）');

    const fresh = replayButtons(panel)[1];
    await fresh.dispatch('click', {});        // もう一度押す＝並びから外す
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(fresh.getAttribute('data-held'), 'false', '取り消しが効いていない');

    assert.equal(stale.getAttribute('data-held'), 'true',
        '外れた釦にまで姿を当てている＝登録簿から捨てていない'
        + ' — 描くたびに溜まり、当てる手間も描いた回数に比例して増える');
});

test('描き直しを重ねても、外れた釦は当てに行かれない', async () => {
    setLocale('en');
    const { panel } = mount(RECORDS);
    await holdSecond(panel);

    /** 描き直すたびに、外れていく釦を控える。 */
    const stale = [];
    for (let i = 0; i < 10; i++) {
        stale.push(replayButtons(panel)[1]);
        panel.setRecords(RECORDS);
    }
    const live = replayButtons(panel)[1];
    await live.dispatch('click', {});         // 並びから外す（姿が変わる）
    await new Promise(resolve => setTimeout(resolve, 10));

    const touched = stale.filter(button => button.getAttribute('data-held') !== 'true');
    assert.deepEqual(touched, [],
        `外れた釦 ${touched.length}/${stale.length} 個にまで姿を当てている`
        + ' — 描き直すたびに溜まり続けている');
    assert.equal(live.getAttribute('data-held'), 'false', '画面に居る釦へは当たっていない');
});

test('面ごと外れているときは、何も捨てない', async () => {
    setLocale('en');
    // **差し込まれていない面。** `isConnected` は全部の釦に偽を返すので、
    // そこで捨てると**登録簿が毎回空になり、順番待ちが描き直しを越えられない。**
    // 実際にそう書いて通しの検査が5本落ちた——面を本文へ付けずに組む検査が多数派だった。
    const { panel } = mount(RECORDS, {}, { attach: false });
    const before = await holdSecond(panel);
    assert.equal(before[1].getAttribute('data-held'), 'true', '待っている姿になっていない');
    assert.equal(panel.root.isConnected, false, '面が本文に居る（この検査の前提が崩れている）');

    panel.setRecords(RECORDS);
    const after = replayButtons(panel);
    assert.notEqual(after[1], before[1], '同じ釦が使い回されている（前提が崩れている）');
    assert.equal(after[1].getAttribute('data-held'), 'true',
        '面が外れている間に登録簿を空にしている（順番待ちが画面から消える）');
});

// --- ② null の属性を付けない -------------------------------------------------

const verdictMarks = (panel) => panel.root.allByClass('unbake-tile-mark')
    .filter(node => node.getAttribute('data-mark') === 'verdict');

test('遮断の理由が無い記録は、`data-blocker` を持たない', () => {
    setLocale('en');
    const { panel } = mount(RECORDS);
    const marks = verdictMarks(panel);
    assert.equal(marks.length, 2, '判定の印が2つ出ていない（前提が崩れている）');

    assert.equal(marks[1].getAttribute('data-blocker'), null,
        `理由が無いのに属性が付いている: ${JSON.stringify(marks[1].getAttribute('data-blocker'))}`
        + ' — 文字列の "null" が入ると、有無で引いた紙が全部に当たる');
});

test('[対照] 理由が在る記録には、今までどおり付く', () => {
    setLocale('en');
    const { panel } = mount(RECORDS);
    assert.equal(verdictMarks(panel)[0].getAttribute('data-blocker'), 'downloadable');
});

test('[対照] 空文字は落とさない（`null` / `undefined` だけを落とす）', () => {
    setLocale('en');
    // 面の内側の器は空の `text` を渡す所が在る。空を落とすと字が消える。
    const { panel } = mount(RECORDS);
    const status = panel.root.byClass('unbake-selection-count');
    assert.ok(status, '選択件数の器が無い（前提が崩れている）');
    assert.equal(typeof status.textContent, 'string', '空文字ごと落としている');
});

/*
 * **子の側の番人は、いま覆えない**（2026-09-01・走査16周目に実測）。
 *
 * `makeElement` は `null` の子も落とすようにしたが、**変異させても検査は素通りする**
 * ——16通りの構成 × 記録5件で計測して、**子へ `null`/`undefined` を渡す所は0件**
 * だった（属性側は1件・`span[data-blocker]`）。呼ぶ側が全部 `.filter(Boolean)` を
 * 通してから渡している。
 *
 * つまりこれは**いまのところ等価変異**で、番人は「次に `.filter(Boolean)` を
 * 書き忘れた日」のために置いてある。**件数を合わせるためだけの検査は書かない**
 * ——書くと、覆えていないものを覆っているように見せることになる。
 */
