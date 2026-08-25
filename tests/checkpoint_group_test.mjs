/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * まとめの名札（2026-08-25 実機）。
 *
 * 報告は「新しい順にしたのに、取り込んだ記録の次に**2番目に新しい記録**が
 * 来ない」。並びは設定どおりで、`group_by_checkpoint` が日付順の後ろで
 * モデルごとに固めていた——**正しく動いている仕掛けが、画面のどこにも
 * 出ていない**のが正体だった。
 *
 * だからここで見張るのは2つだけ:
 *
 *   1. まとめが入っているとき、切れ目に名札が出る（理由が読める）
 *   2. 名札は**並びを1件も動かさない**（見出しを足すために順を組み替えない）
 *
 * 変異試験（9件）で8件が倒れた。生き残った1件は「名札のセルに
 * `unbake-col-title` を足す」——**挙動を何も変えない変異**（並びも件数も
 * 選択も同じ）で、倒せないのが正しい。ここを倒すために測り方を歪めない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkpointRuns, createUnbakePanel } from '../web/panel/panel.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale, t } from '../web/i18n/index.js';

setLocale('ja');

const rec = (id, checkpoint, extra = {}) => ({
    id, libraryId: id, title: `Civitai_Recipe_${id}`, verdict: 'reproducible',
    checkpoint, ...extra,
});

function mount(records, display = null) {
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), { documentRef: doc, display });
    panel.setRecords(records);
    return panel;
}

const heads = (panel, className) => panel.root.allByClass(className)
    .filter(node => node.className === className)
    .map(node => node.textContent);

/** 行の題（見出しの空セルは除く——`th` も同じ class を持っている）。 */
const rowTitles = (panel) => panel.root.allByClass('unbake-col-title')
    .filter(node => node.className === 'unbake-col-title')
    .map(node => node.textContent)
    .filter(Boolean);

// --- 塊の切り出し ---------------------------------------------------------

test('隣り合う同じモデルが1つの塊になる', () => {
    const runs = checkpointRuns([
        rec('1', 'a.safetensors'), rec('2', 'a.safetensors'), rec('3', 'b.safetensors'),
    ]);
    assert.equal(runs.length, 2);
    assert.deepEqual(runs.map(r => r.records.length), [2, 1]);
    assert.equal(runs[0].name, 'a.safetensors');
    assert.equal(runs[1].name, 'b.safetensors');
});

test('離れた同じモデルは別の塊のまま（並びを組み替えない）', () => {
    // **ここが要**。`sortRecords` が既にまとめているので、飛び地が出るのは
    // まとめが**切れている**とき——そこで勝手に寄せると、名札のために
    // 並びが変わる。名札は並びに従うのであって、並びを作らない。
    const runs = checkpointRuns([
        rec('1', 'a.safetensors'), rec('2', 'b.safetensors'), rec('3', 'a.safetensors'),
    ]);
    assert.deepEqual(runs.map(r => r.name), ['a.safetensors', 'b.safetensors', 'a.safetensors']);
});

test('フォルダ込みの名前は末尾だけで見る（表のモデル列と同じ規則）', () => {
    const runs = checkpointRuns([
        rec('1', 'Illustrious\\anime\\wai.safetensors'), rec('2', 'wai.safetensors'),
    ]);
    assert.equal(runs.length, 1, 'フォルダの有無で塊が割れている');
    assert.equal(runs[0].raw, 'Illustrious\\anime\\wai.safetensors', '元のパスを落としている');
});

test('checkpoint が無い記録も塊になる（落とさない）', () => {
    const runs = checkpointRuns([rec('1', null), rec('2', undefined)]);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].records.length, 2);
});

test('空の一覧では塊も空（空集合に対する全称で緑にならない）', () => {
    assert.deepEqual(checkpointRuns([]), []);
    assert.deepEqual(checkpointRuns(null), []);
});

// --- 画面 -----------------------------------------------------------------

const RECORDS = [
    rec('a1', 'alpha.safetensors'),
    rec('a2', 'alpha.safetensors'),
    rec('b1', 'beta.safetensors'),
];

test('まとめが入っていると、表に名札が出る', () => {
    const panel = mount(RECORDS, { groupByCheckpoint: true, sortKey: 'title' });
    const names = heads(panel, 'unbake-group-name');
    assert.equal(names.length, 2, `名札が ${names.length} 件（塊は2つ）`);
    assert.ok(names[0].includes('alpha.safetensors'), names[0]);
    assert.ok(names[0].includes('2'), `件数が出ていない: ${names[0]}`);
    assert.ok(names[1].includes('beta.safetensors'), names[1]);
});

test('まとめが切れていると、名札は1つも出ない', () => {
    const panel = mount(RECORDS, { groupByCheckpoint: false, sortKey: 'title' });
    assert.deepEqual(heads(panel, 'unbake-group-name'), []);
    assert.deepEqual(heads(panel, 'unbake-tile-group'), []);
});

test('タイルでも同じ語が出る（器だけが違う）', () => {
    const panel = mount(RECORDS, { groupByCheckpoint: true, sortKey: 'title', listView: 'tiles' });
    const table = heads(panel, 'unbake-group-name');
    const tiles = heads(panel, 'unbake-tile-group');
    assert.equal(tiles.length, 2, `タイルの名札が ${tiles.length} 件`);
    assert.deepEqual(tiles, table, '表とタイルで語が違う');
});

test('名札は記録の並びを1件も動かさない', () => {
    // 既にモデルごとに固まっている並びでは、名札を挟んでも**行の顔ぶれも順も同じ**。
    // 名札は `td.unbake-col-title` を持たないので、ここに映るのは記録だけ。
    const withGroup = rowTitles(mount(RECORDS, { groupByCheckpoint: true, sortKey: 'title' }));
    const without = rowTitles(mount(RECORDS, { groupByCheckpoint: false, sortKey: 'title' }));
    assert.equal(withGroup.length, 3, `行が ${withGroup.length} 件（記録は3件）`);
    assert.deepEqual(withGroup, without, '名札を出した側で並びが変わっている');
});

test('長いモデル名を文字数で切らない（切るのは幅が足りないときだけ）', () => {
    // 実機では `hassakuXLIllustrious_v13Sty…` と、**広い所でも**切れていた
    // ——表のモデル列と同じ `shorten` を通していたため。名札は1行を丸ごと
    // 使えるので、切るかどうかは CSS（器の幅）が決める。
    const long = 'hassakuXLIllustrious_v13StyleA.safetensors';
    const panel = mount([rec('L', long)], { groupByCheckpoint: true });
    const names = heads(panel, 'unbake-group-name');
    assert.ok(names[0].includes(long), `名前が切れている: ${names[0]}`);
    assert.ok(!names[0].includes('…'), `三点で切っている: ${names[0]}`);
});

test('モデルが判らない塊は「モデル不明」と言う（—で済ませない）', () => {
    const panel = mount([rec('x', null)], { groupByCheckpoint: true });
    const names = heads(panel, 'unbake-group-name');
    assert.equal(names.length, 1);
    assert.ok(names[0].includes(t('list.group.unknown')), names[0]);
});

test('名札の吹き出しに、なぜ続いているのかが書いてある', () => {
    const panel = mount(RECORDS, { groupByCheckpoint: true, sortKey: 'title' });
    const head = panel.root.allByClass('unbake-group-name')
        .find(node => node.className === 'unbake-group-name');
    const title = head.getAttribute('title');
    assert.ok(title.includes(t('list.group.hint')), `吹き出しに理由が無い: ${title}`);
    assert.ok(title.includes('alpha.safetensors'), `元の名前が無い: ${title}`);
});

// --- その場で効くこと（2026-08-25 利用者の指示）-----------------------------
//
// > 「チェックポイントごとにまとめる」を OFF にしたあと再読み込みが必要になった
//
// 面は**開いたときの値**でまとめの旗を固定していた（`const`）ので、保存はできても
// 一覧は古いままだった。**保存が効いているのに画面が変わらないと、設定が壊れている
// ように見える**——並びを変える設定ほど、その場で効かないと読めない。

test('まとめを切ると、その場で名札が消えて並びが戻る', () => {
    const panel = mount(RECORDS, { groupByCheckpoint: true, sortKey: 'title' });
    assert.equal(heads(panel, 'unbake-group-name').length, 2, '前提（まとめ入りで名札2つ）が崩れている');
    panel.applyDisplay({ group_by_checkpoint: false });
    assert.deepEqual(heads(panel, 'unbake-group-name'), [], '切っても名札が残っている');
    assert.equal(rowTitles(panel).length, 3, '記録の行が減っている');
});

test('まとめを入れると、その場で名札が出る', () => {
    const panel = mount(RECORDS, { groupByCheckpoint: false, sortKey: 'title' });
    assert.deepEqual(heads(panel, 'unbake-group-name'), [], '前提（まとめ無しで名札0）が崩れている');
    panel.applyDisplay({ group_by_checkpoint: true });
    assert.equal(heads(panel, 'unbake-group-name').length, 2, '入れても名札が出ない');
});

test('タイルでも、その場で切り替わる', () => {
    const panel = mount(RECORDS, { groupByCheckpoint: true, sortKey: 'title', listView: 'tiles' });
    panel.applyDisplay({ group_by_checkpoint: false });
    assert.deepEqual(heads(panel, 'unbake-tile-group'), [], 'タイルの名札が残っている');
    panel.applyDisplay({ group_by_checkpoint: true });
    assert.equal(heads(panel, 'unbake-tile-group').length, 2, 'タイルの名札が出ない');
});

test('列を出し入れしても、見出しと中身がずれない', () => {
    // **見出しは器を作るときに1回しか組まない。** 本文だけ出し入れすると、
    // 見出しと中身が1列ずれる（並びのまとめと同じ「その場で効かせる」話）。
    const withLicense = (panel) => panel.root.allByClass('unbake-col-license')
        .filter(node => node.className === 'unbake-col-license').length;
    const panel = mount(RECORDS, { showCommercialOk: true, sortKey: 'title' });
    const before = withLicense(panel);
    assert.ok(before >= 1, '前提（商用可否の列が在る）が崩れている');
    panel.applyDisplay({ show_commercial_ok: false });
    assert.equal(withLicense(panel), 0, '列を切っても見出しか中身が残っている');
    panel.applyDisplay({ show_commercial_ok: true });
    assert.equal(withLicense(panel), before, '戻したときの列の数が違う');
});
