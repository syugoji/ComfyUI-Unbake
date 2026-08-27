/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **再現が始まらない**（2026-08-27 実機の報告3件）。
 *
 *   ① 複数の記録の ▶ を押すと、1件目が終わっても2件目が始まらない
 *   ② `civitai_124673884` / `civitai_51644312` の生成が始まらない
 *   ⑥ 出た絵を消した後に再現すると、消した絵との比較が出る／消えなくなる
 *
 * **①②は同じ1つの原因だった。** 再現は投げる前に人へ聞くことがある
 * （VRAM に入らない／分割復号で止まり得る——②の2件はどちらもその形）。
 * その確認の面が **`z-index` で一番下** に置かれていたので、詳細・比較・拡大の
 * 下に隠れ、**押した人には何も見えないまま `await` が返らない**。
 * 返らない間、順番待ちの流し役はそこで止まり、以降は全部 ⏸ のまま動かない。
 *
 * ここで見張るのは3つ:
 *
 *   A. **確認は必ず一番上に居る**（重ねの数値を紙から読んで比べる）
 *   B. **面を差し替えても畳んでも、待っている約束は必ず返る**
 *   C. **消すと言った絵は、再現の前に本当に消える**
 *
 * **A を「実装を読んで確かめる」形にしない。** 重なりは紙（CSS）が決めているので、
 * 紙から読まなければ「直したつもりで数値だけ古い」を見逃す。
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
const themeCss = () => readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');

/**
 * ある選択子に付いている `z-index` を紙から読む。
 *
 * **合致が1つでないときは投げる。** 0件なら選択子の改名を見逃しており、
 * 2件以上なら**どちらが効くのかここでは決められない**——どちらも
 * 「読めたふりで通す」より止めたほうがよい。
 */
function zIndexOf(css, selector) {
    // **注釈を先に落とす。** この紙は注釈のほうが規則より長く、`,` も `{` も
    // 普通に入っている——落とさずに切ると、**選択子に注釈が混ざって1つも当たらない**
    // （そのまま「0件」を合格にする書き方だと、検査が丸ごと空振りする）。
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const found = [];
    for (const block of bare.split('}')) {
        const at = block.indexOf('{');
        if (at < 0) continue;
        const heads = block.slice(0, at).split(',').map(text => text.trim());
        if (!heads.includes(selector)) continue;
        for (const line of block.slice(at + 1).split(';')) {
            const [name, value] = line.split(':');
            if (String(name).trim() === 'z-index') found.push(Number(String(value).trim()));
        }
    }
    assert.equal(found.length, 1,
        `${selector} の z-index が ${found.length} 個見つかった（1個であること）`);
    return found[0];
}

// --- A. 確認は必ず一番上 ---------------------------------------------------

/**
 * **この面が持つ重ねを全部並べる。**
 *
 * 新しい面を足したときに、確認より上へ置いてしまったら赤くなる。
 * **「確認より下の面だけを並べる」形にしない**——それだと足し忘れが
 * そのまま見逃しになる。
 */
const OVERLAYS = [
    '.unbake-detail-backdrop',
    '.unbake-picker-backdrop',
    '.unbake-donate-backdrop',
    '.unbake-popup-layer',
    '.unbake-compare',
    '.unbake-lightbox',
];

test('確認の面は、他のどの面よりも上に出る', async () => {
    const css = await themeCss();
    const confirm = zIndexOf(css, '.unbake-confirm-backdrop');
    for (const selector of OVERLAYS) {
        const other = zIndexOf(css, selector);
        assert.ok(confirm > other,
            `${selector}(${other}) が確認(${confirm}) 以上に居る`
            + '——答えるまで進まない面が隠れると、待っている処理ごと止まる');
    }
});

test('走っている印を出すために、選ぶ口まで出していない', async () => {
    /*
     * ③「再現中、タイルの左上のチェックボックスがずっと出る」。
     *
     * 操作の列は普段 `opacity: 0` で、走っている間だけ列ごと不透明にしていた。
     * **出したかったのは ▶ 1つ**で、選ぶ口・消す口・☆まで道連れになっていた。
     */
    const css = await themeCss();
    assert.match(css, /\.unbake-tile-actions\[data-busy="true"\] > :not\(\.unbake-act-replay\)/,
        '走っている間に「▶ 以外を出さない」規則が無い');
    assert.match(css, /\.unbake-tile:hover \.unbake-tile-actions\[data-busy="true"\] > \*/,
        '合わせれば全部出る、という戻し道が無い');
    // **触る画面には hover が無い。** 戻し道が無いまま隠すと、選ぶ口へ二度と届かない。
    const touch = css.slice(css.indexOf('@media (hover: none)'));
    assert.match(touch, /\.unbake-tile-actions\[data-busy="true"\] > \*/,
        '触る画面での戻し道が無い（選ぶ口へ届かなくなる）');
});

// --- B. 待っている約束は必ず返る -------------------------------------------

const container = (doc) => doc.createElement('div');

test('確認を差し替えたら、前の確認を待っていた側へ返す', async () => {
    /*
     * `createConfirmView().destroy()` は**節点を外すだけ**で `onClose` を呼ばない。
     * 再現は返事を `await` しているので、放置すると**永久に返らない**
     * ——流し役がそこで止まり、以降に押した分は全部 ⏸ のまま動かなくなる。
     */
    const doc = fakeDocument();
    const panel = createUnbakePanel(container(doc), { mode: 'sidebar', width: 1200 });
    let returned = 0;
    panel.openConfirm({ title: '1枚目', onConfirm: async () => ({ ok: true }), onReturn: () => { returned += 1; } });
    assert.equal(returned, 0, 'まだ答えていないのに返っている');
    panel.openConfirm({ title: '2枚目', onConfirm: async () => ({ ok: true }), onReturn: () => {} });
    assert.equal(returned, 1, '差し替えで前の約束が捨てられた（待っている側が永久に止まる）');
});

test('面をまとめて畳んでも、確認を待っていた側へ返す', async () => {
    const doc = fakeDocument();
    const panel = createUnbakePanel(container(doc), { mode: 'sidebar', width: 1200 });
    let returned = 0;
    panel.openConfirm({ title: '1枚目', onConfirm: async () => ({ ok: true }), onReturn: () => { returned += 1; } });
    panel.closeOverlays();
    assert.equal(returned, 1, '畳んだだけで約束が宙に浮いた');
});

test('答えたら、その後に別の確認を開いても「取り消した」が二度呼ばれない', async () => {
    const doc = fakeDocument();
    const panel = createUnbakePanel(container(doc), { mode: 'sidebar', width: 1200 });
    let returned = 0;
    const view = panel.openConfirm({
        title: '1枚目', onConfirm: async () => ({ ok: true }), onReturn: () => { returned += 1; },
    });
    // 「閉じる」は答えの一種（＝戻る）。1回だけ返ること。
    const close = view.root.find(node => String(node.className).includes('unbake-confirm-close'));
    assert.ok(close, '閉じる口が無い');
    await close.dispatch('click', {});
    const afterClose = returned;
    panel.openConfirm({ title: '2枚目', onConfirm: async () => ({ ok: true }), onReturn: () => {} });
    assert.equal(returned, afterClose, '閉じた後の差し替えで、もう一度返っている');
});

// --- C. 消すと言った絵は、再現の前に本当に消える ----------------------------

test('出た絵を消した直後に再現すると、消してから投げる', async () => {
    /*
     * ⑥「出た絵を削除後に再現すると、削除した絵との比較が表示されたり
     *    削除されなくなったりする」。
     *
     * 消す口は押した瞬間には消さず、**12秒の猶予**を置いて戻せるようにしてある。
     * その間、絵は**ディスクにも索引にも生きている**ので、実行器は
     * 「この条件はもう出ている」と読み、**投げずに消したはずの絵を開く。**
     * 猶予の内と外で結果が変わるので、**同じ操作が日によって違う答えを返す**。
     */
    const doc = fakeDocument();
    const deleted = [];
    let ranAt = null;
    const panel = createUnbakePanel(container(doc), {
        mode: 'sidebar', width: 1200,
        deleteOutputIo: async ({ filename }) => { deleted.push(filename); return { ok: true }; },
        makeSweepRunner: () => ({
            inputsReady: Promise.resolve(),
            requireEmptyQueue: async () => {},
            run: async () => { ranAt = deleted.slice(); return { cells: [] }; },
        }),
    });
    panel.setRecords([{ id: 'a', title: 'A', recipe: { id: 'a', gen_params: { seed: 1 } } }]);

    // 消すと言う（**まだ1バイトも消えていない**）。
    await panel.deleteOutputLater({ filename: 'a_00001_.png', subfolder: '' }, { id: 'a' });
    assert.deepEqual(deleted, [], '猶予を待たずに消してしまっている');

    // 猶予の中で再現を押す。
    const button = panel.root.find(n => String(n.className).includes('unbake-act-replay'));
    button.dispatch('click', {});
    for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));

    assert.deepEqual(deleted, ['a_00001_.png'], '再現しても、消すと言った絵が残っている');
    assert.deepEqual(ranAt, ['a_00001_.png'],
        '消し終わる前に投げている（実行器が消したはずの絵を「もう出ている」と読む）');
});
