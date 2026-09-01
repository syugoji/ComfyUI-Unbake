/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **重ねる面は、開いた直後から Esc で閉じられる**（`I-20260830-21`）。
 *
 * `keydown` は焦点から上へしか伝わらない。詳細の面は `tabindex` を持たず
 * `.focus()` も呼ばれていなかったので、**開いた直後の Esc は完全に無反応**
 * だった（× と外側クリックは効く）。中を一度押すと以後は効くので、
 * 「さっきは閉じたのに」という一番読みにくい形になる。
 *
 * ## 形を列挙せず、重ねる面すべてを回す
 *
 * 確認の面（`confirmView.js`）は同じ対を既に持っていた。**片方だけ持っている
 * 状態**が生まれたので、ここは「面ごとの検査」ではなく**重ねる面の一覧**に
 * 対して回す——新しい面を足した人の分が自動で守られる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDetailView } from '../web/panel/detailView.js';
import { fakeDocument } from './fake_dom.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

const RECORD = { id: 'a', libraryId: 'a', title: 'A', previewUrl: '/p?id=a' };

test('開いた直後の Esc で閉じる（焦点を移していないと死ぬ）', async () => {
    const doc = fakeDocument();
    let closed = 0;
    const view = createDetailView({
        documentRef: doc, record: RECORD, onClose: () => { closed += 1; },
    });
    await settle();
    // **中を一度も押さずに**押す。
    view.root.dispatch('keydown', { key: 'Escape' });
    assert.equal(closed, 1, '開いた直後の Esc が効かない');
});

test('焦点が箱の外にあっても効く（文書へも張る）', async () => {
    const doc = fakeDocument();
    let closed = 0;
    const view = createDetailView({
        documentRef: doc, record: RECORD, onClose: () => { closed += 1; },
    });
    await settle();
    doc.dispatch?.('keydown', { key: 'Escape' });
    assert.ok(closed >= 1, '文書側の Esc が届いていない');
    view.destroy?.();
});

test('畳んだら文書の受け口を外す（積み上げない）', async () => {
    const doc = fakeDocument();
    let closed = 0;
    const view = createDetailView({
        documentRef: doc, record: RECORD, onClose: () => { closed += 1; },
    });
    await settle();
    view.destroy?.();
    closed = 0;
    doc.dispatch?.('keydown', { key: 'Escape' });
    assert.equal(closed, 0, '閉じた面の受け口が残っている（開くたび積み上がる）');
});

test('[対照] Esc 以外では閉じない', async () => {
    const doc = fakeDocument();
    let closed = 0;
    const view = createDetailView({
        documentRef: doc, record: RECORD, onClose: () => { closed += 1; },
    });
    await settle();
    view.root.dispatch('keydown', { key: 'a' });
    assert.equal(closed, 0, '別の鍵で閉じている');
});

test('[人形の契約] 外れた箱は焦点を取れない', () => {
    /*
     * **人形を緩めれば、上の検査は全部緑にできる**（変異で確認）。
     *
     * 本物のブラウザでは、文書へ付いていない要素に `focus()` を呼んでも
     * `activeElement` は動かない——実機で焦点が litegraph のキャンバスに
     * 残っていたのがそれ。ここを緩めると「効いていない実装」が通ってしまうので、
     * **人形がその性質を持っていること自体**を留める。
     */
    const doc = fakeDocument();
    // **焦点を取れる札を使う**（2026-08-31・監査 I-20260831-17）。
    // 元はここが素の `<div>` で、最後の1行が「付ければ div でも焦点を取れる」を
    // 留めていた——**本物はそうならない**（`tabindex` の無い div は焦点を取れない）。
    // 見たいのは「付いているか」であって「どんな札でも取れるか」ではないので、
    // 札の側の条件を満たしてから測る。札の条件そのものは
    // `tests/fake_dom_contract_test.mjs` が別に留める。
    const loose = doc.createElement('button');
    loose.focus();
    assert.equal(doc.activeElement, doc.body,
        '外れた箱が焦点を取れている（人形が本物より甘い）');
    assert.equal(loose.isConnected, false, '外れた箱が「付いている」と答えている');

    doc.body.append(loose);
    assert.equal(loose.isConnected, true, '付けたのに「付いていない」と答えている');
    loose.focus();
    assert.equal(doc.activeElement, loose, '付けた箱が焦点を取れない（人形が本物より厳しい）');
});

test('焦点は、文書へ付いてから移る（外れた箱へ呼ばない）', async () => {
    /*
     * **原文に `focus()` が在ることを見ても、効いているかは判らない**
     * （2026-08-30 実機で発覚）。呼び手は `createDetailView()` が**返ってから**
     * `root.append(view.root)` する。構築の途中で呼んだ `focus()` は
     * **外れた要素に当たって何も起きず**、実機では焦点が litegraph の
     * キャンバスに残ったままだった。**効果を測る。**
     */
    const doc = fakeDocument();
    const view = createDetailView({ documentRef: doc, record: RECORD, onClose: () => {} });

    // 呼び手と同じ順で付ける。
    assert.equal(doc.activeElement, doc.body, '前提: まだ焦点は面の外');
    doc.body.append(view.root);
    await settle();
    assert.equal(doc.activeElement, view.root,
        `付けたのに焦点が移っていない: ${String(doc.activeElement?.tagName)}`);
    view.destroy?.();
});

test('[対照] 付けなければ、焦点は動かさない', async () => {
    // 外れたままの箱が焦点を奪うと、**画面に出ていない物へ鍵盤が向く。**
    const doc = fakeDocument();
    const view = createDetailView({ documentRef: doc, record: RECORD, onClose: () => {} });
    await settle();
    assert.equal(doc.activeElement, doc.body,
        '文書へ付いていない箱が焦点を取っている');
    view.destroy?.();
});

test('確認の面も、付いてから焦点が移る（片方だけ直さない）', async () => {
    const { createConfirmView } = await import('../web/panel/confirmView.js');
    const doc = fakeDocument();
    const view = createConfirmView({
        documentRef: doc, title: 'x',
        files: [{ name: 'a.safetensors', bytes: 10 }],
        onConfirm: async () => ({ ok: true, removed: [] }),
        onClose: () => {},
    });
    doc.body.append(view.root);
    await settle();
    assert.equal(doc.activeElement, view.root,
        `確認の面の焦点が移っていない: ${String(doc.activeElement?.tagName)}`);
    view.destroy?.();
});

test('重ねる面はすべて、焦点を受け取れる箱になっている', () => {
    /*
     * **一覧をディスクから拾う**（2026-08-31・監査 I-20260831-27）。
     *
     * 「一覧に対して回す。面ごとに書くと、次に足した面がまた抜ける」と
     * 宣言しておきながら、**中身は2ファイルの決め打ち**だった。
     * `role: 'dialog'` の重ねる面は実際には4つあり、`donateView.js` と
     * `modelPicker.js` が**丸ごと検査の外**に居た——変異で確認済み
     * （`donateView.js` の keydown 登録を消しても1,534件が緑のまま）。
     *
     * `if (!hasRole) continue;` も外した。**綴りが変わった面が黙って
     * 全条件をすり抜ける**ので、「役を宣言していないこと」自体を赤くする。
     */
    const sheets = fs.readdirSync(path.join(ROOT, 'web/panel'))
        .filter(name => name.endsWith('View.js') || name === 'modelPicker.js')
        .map(name => `web/panel/${name}`);
    const overlays = sheets.filter(rel =>
        /role:\s*'dialog'/.test(fs.readFileSync(path.join(ROOT, rel), 'utf8')));

    // **空振り検出。** 拾えなくなったら、何も見ずに緑になる。
    assert.ok(overlays.length >= 3,
        `重ねる面を ${overlays.length} 枚しか拾えていない（走査が壊れている）: ${sheets.join(', ')}`);

    const missing = [];
    for (const rel of overlays) {
        const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        if (!/tabindex: '-1'/.test(source)) missing.push(`${rel}: tabindex が無い`);
        if (!/doc\.addEventListener\?\.\('keydown'/.test(source)) {
            missing.push(`${rel}: 文書側の Esc が無い`);
        }
        // **綴りではなく「焦点を移している」ことを見る。** 面ごとに根の変数名が
        // 違う（`root` / `backdrop`）ので、1つの綴りに縛ると**名前が違うだけで
        // 通らない／通ってしまう**——挙動そのものは下の [挙動] が測る。
        if (!/\.focus\?\.\(\)/.test(source)) missing.push(`${rel}: 焦点を移していない`);
    }
    assert.deepEqual(missing, [], `重ねる面のどれかが Esc の対を欠いている: ${missing.join(' / ')}`);
});

test('[挙動] donateView と modelPicker が、開いた直後に焦点を受け取る', async () => {
    /*
     * **綴りの照合だけでは足りない**（2026-08-31・監査 I-20260831-27）。
     *
     * 上の検査は原文を見るだけなので、根の変数名を変えたり、焦点を移す行を
     * 別の条件の下へ入れたりしても通ってしまう。**実際に開いて測る。**
     * この2面は長く検査の外に居たので、ここで挙動を留めておく。
     */
    const { createDonateView } = await import('../web/panel/donateView.js');
    const { createModelPicker } = await import('../web/panel/modelPicker.js');

    for (const [name, open] of [
        ['donateView', (doc) => createDonateView({ documentRef: doc, onClose: () => {} })],
        ['modelPicker', (doc) => createModelPicker({
            documentRef: doc, title: 'x', options: ['a.safetensors'],
            onPick: () => {}, onClose: () => {},
        })],
    ]) {
        const doc = fakeDocument();
        const view = open(doc);
        doc.body.append(view.root);
        await settle();
        assert.equal(doc.activeElement, view.root,
            `${name} の焦点が移っていない: ${String(doc.activeElement?.tagName)}`);
        view.destroy?.();
    }
});
