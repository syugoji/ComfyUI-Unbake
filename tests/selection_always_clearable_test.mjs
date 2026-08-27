/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **複数選択の解除を、いつでも行えるようにする**（2026-08-27 利用者の指示）。
 *
 * 前の回で「選んでいる最中はタイルを押すと選択に足す」を入れた結果、
 * **1件でも選ぶと一覧が選択の作法へ切り替わる**。抜けるには解除するしかないのに、
 * 解除の口は**一覧の上に1回だけ置かれた帯**の中にあった——記録が315件あると
 * 少し巻いた時点で画面から消え、**一番上まで巻き戻すまで抜けられない**。
 *
 * 塞ぎ方は2つ。**どちらも「探しに行かなくてよい」形にする。**
 *
 *   1. **帯を貼り付ける**（`position: sticky`）。巻いても居なくならない。
 *   2. **Escape を届くようにする**。受け口は面の根に張ってあるが、
 *      タイルの `<article>` は焦点を取れないので、**絵を押して選んだ直後は
 *      焦点が面の外に残ったまま**で、叩いても何も起きなかった。
 *
 * **背景を押したら解除、は入れていない。** 一般的な作法ではあるが、
 * 30件選んだ後の誤爆が高くつく（選び直す手間は解除の比ではない）。
 * 上の2つで「いつでも」は満たせる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createUnbakePanel } from '../web/panel/panel.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale } from '../web/i18n/index.js';

setLocale('ja');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rec = (id) => ({
    id, libraryId: id, title: `Civitai_Recipe_${id}`, verdict: 'reproducible',
    previewUrl: `/unbake/record-preview?id=${id}`,
});

function mount(records, display = { listView: 'tiles' }) {
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), { documentRef: doc, display });
    panel.setRecords(records);
    return { doc, panel };
}

const tilesOf = (panel) => panel.root.allByClass('unbake-tile')
    .filter(node => node.className === 'unbake-tile');

// --- 1. 帯は巻いても居なくならない -------------------------------------------

test('選択の帯は貼り付いていて、巻いても消えない', async () => {
    const css = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');
    const block = /\.unbake-selection\s*\{([^}]*)\}/.exec(css);
    assert.ok(block, '選択の帯の規則が見つからない（改名を見逃している）');
    assert.match(block[1], /position:\s*sticky/,
        '巻くと画面から出ていくので、解除の口へ戻れない');
    // **属性の切れ目を見る。** `top:` だけで探すと `margin-top: 8px` を掴む
    // ——実際に掴んで「8px は 0 でない」で落ちた。前が `-` でないことを要求する。
    const top = /(?:^|[;{\s])top:\s*([^;]+);/.exec(block[1]);
    assert.ok(top, '貼り付く位置が無い（sticky は top が無いと効かない）');
    /*
     * **器の内余白ぶんを打ち消す**（2026-08-27 利用者の指示「設定の帯へぴったり」）。
     *
     * `top: 0` は**内余白 14px ぶん下**に貼り付き、上の見出し帯との間に隙間が空く。
     * 実測（巻いた状態・ヘッダ下端から帯上端まで）: `0px`→14 / `-8px`→6 /
     * **`-14px`→0** / `-22px`→-8。高さは 37px のままで切れない。
     *
     * **当初この検査は `0` を要求し、理由に「負だと切れる」と書いていた。
     * 測らずに書いた嘘で、実測が否定した。** 数値直書きではなく、
     * 内余白と対で動く形（`calc(var(--unbake-pad) * -1)`）を要求する
     * ——余白を変えた日に隙間が復活しないため。
     */
    assert.match(top[1], /calc\(\s*var\(--unbake-pad\)\s*\*\s*-1\s*\)/,
        `見出しの帯へぴったり付かない（器の内余白ぶんを打ち消していない）: ${top[1]}`);
});

test('貼り付いた帯の地は不透明（下を流れる絵が透けない）', async () => {
    const css = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');
    const active = /\.unbake-selection\[data-active="true"\]\s*\{([^}]*)\}/.exec(css);
    assert.ok(active, '選んでいる間の規則が見つからない');
    // **`background:` 一括で半透明の色を当てない。** 当てると地ごと透ける。
    assert.doesNotMatch(active[1], /(^|\s)background:\s*var\(--unbake-accent-dim\)/,
        '選んでいる間だけ帯が半透明になり、貼り付いたときに字が読めなくなる');
    assert.match(active[1], /background-color:\s*var\(--unbake-panel\)/,
        '地が不透明だと言い切れていない');
});

// --- 2. Escape が届く ---------------------------------------------------------

test('絵を押して選んだ後、Escape で解除できる', async () => {
    const { doc, panel } = mount([rec('1'), rec('2'), rec('3')]);
    // 1件目を選ぶ（口から）。
    const box = panel.root.allByClass('unbake-pick')[0];
    box.checked = true;
    await box.dispatch('click', {});
    // 2件目は**絵**を押して足す（`<article>` も `<img>` も焦点を取れない）。
    await panel.root.allByClass('unbake-tile-image')[1].dispatch('click', {});
    assert.equal(panel.selected.length, 2, '選べていない（この検査が空振りしている）');

    // **面の外に焦点が在る**状態を作る（実機で普通に起きる形）。
    doc.activeElement = doc.body;
    await panel.root.dispatch('click', {});
    assert.ok(panel.root.contains(doc.activeElement),
        '面の中を押したのに焦点が外のまま（Escape が届かない）');

    await panel.root.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(panel.selected, [], 'Escape で解除できない');
});

test('面の中の入力欄へ入っているときは、焦点を奪わない', async () => {
    const { doc, panel } = mount([rec('1')]);
    const box = panel.root.allByClass('unbake-pick')[0];
    doc.activeElement = box;           // 面の中に既に焦点が在る
    await panel.root.dispatch('click', {});
    assert.equal(doc.activeElement, box,
        '字を打っている途中で焦点を根へ引き剥がしている');
});

// --- 3. 帯の解除そのもの ------------------------------------------------------

test('帯の「解除」はいつでも押せる（選んでいる間は必ず有効）', async () => {
    const { panel } = mount([rec('1'), rec('2')]);
    const clear = panel.root.find(node => String(node.className).includes('unbake-select-clear'));
    assert.ok(clear, '解除の口が無い');
    assert.equal(clear.disabled, true, '選んでいないのに押せる');
    const box = panel.root.allByClass('unbake-pick')[0];
    box.checked = true;
    await box.dispatch('click', {});
    const again = panel.root.find(node => String(node.className).includes('unbake-select-clear'));
    assert.equal(again.disabled, false, '選んだのに解除が押せない');
    await again.dispatch('click', {});
    assert.deepEqual(panel.selected, [], '解除が効かない');
});

// --- 4. Shift は「選ぶ操作だ」という合図（2026-08-27 利用者の指示）-----------
//
// 実測すると、**1件も選んでいない状態からの Shift+クリックは詳細が開いていた**
// ——範囲で選ぶには、先に左上の小さな四角を1つ押して「選択中」にしてからでないと
// 始められない。**一番自然な「A を押して、B を Shift+クリック」が入口で塞がっていた。**

test('何も選んでいなくても、Shift+クリックなら選ぶ側を採る', async () => {
    const { panel } = mount([rec('1'), rec('2'), rec('3')]);
    await panel.root.allByClass('unbake-tile-image')[1]
        .dispatch('click', { shiftKey: true, preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(panel.selected, ['2'], 'Shift を押しても詳細が開いている');
    assert.equal(panel.root.byClass('unbake-detail'), null, '詳細が開いた');
});

test('Shift+クリックで、起点からの範囲をまとめて選ぶ', async () => {
    const { panel } = mount([rec('1'), rec('2'), rec('3'), rec('4'), rec('5')]);
    // 起点を Shift で作る（口を押さなくても始められること自体が今回の主眼）。
    await panel.root.allByClass('unbake-tile-image')[0]
        .dispatch('click', { shiftKey: true, preventDefault() {}, stopPropagation() {} });
    await panel.root.allByClass('unbake-tile-image')[3]
        .dispatch('click', { shiftKey: true, preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(panel.selected.sort(), ['1', '2', '3', '4'],
        '範囲で選べていない');
});

test('タイル本体の Shift+クリックも、選択0件から効く', async () => {
    const { panel } = mount([rec('1'), rec('2'), rec('3')]);
    await tilesOf(panel)[2].dispatch('click', { shiftKey: true });
    assert.deepEqual(panel.selected, ['3'], '絵の外側だけ Shift が効いていない');
});

test('Shift を押していなければ、今までどおり詳細が開く', async () => {
    // **広げすぎない。** Shift 無しの押下まで選択にすると、
    // 一番よく使う「絵を押して中身を見る」が押せなくなる。
    const { panel } = mount([rec('1'), rec('2')]);
    await panel.root.allByClass('unbake-tile-image')[0].dispatch('click', {});
    assert.ok(panel.root.byClass('unbake-detail'), '詳細が開かない');
    assert.deepEqual(panel.selected, [], '押しただけで選ばれている');
});
