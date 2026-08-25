/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * サイドバーを**押し広げず重ねる**（2026-08-25 利用者の指示）。
 *
 * **測るのは器のほう。** こちらの中身をいくら細くしても
 * ComfyUI の `.side-bar-panel`（実測 v1.42.15: `min-width: 312px` /
 * `width: 370px`）は縮まず、**横の並びで場所を取る**——右の Job Queue が
 * 切れていたのはそれが理由。だから検査も「中身の幅」ではなく
 * **器が並びから外れたか**を見る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findSidebarPanel, installSidebarOverlay } from '../web/panel/sidebarOverlay.js';

/** ComfyUI 側の入れ子を、実測どおりの形で組む。 */
function hostTree({ connected = true, panelWidth = 370 } = {}) {
    const node = (className, extra = {}) => ({
        className,
        style: {},
        attributes: {},
        children: [],
        listeners: {},
        setAttribute(key, value) { this.attributes[key] = String(value); },
        removeAttribute(key) { delete this.attributes[key]; },
        addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); },
        removeEventListener(type, handler) {
            this.listeners[type] = (this.listeners[type] || []).filter(h => h !== handler);
        },
        dispatch(type, event = {}) { for (const h of [...(this.listeners[type] || [])]) h(event); },
        append(...items) { this.children.push(...items); for (const c of items) c.parent = this; },
        remove() {
            if (!this.parent) return;
            this.parent.children = this.parent.children.filter(c => c !== this);
            this.parent = null;
        },
        parentElement: null,
        ...extra,
    });
    // 掴み手を作る先。**本物と同じで、器の持ち主から作る。**
    const doc = {
        listeners: {},
        createElement: (tag) => node('', { tagName: String(tag).toUpperCase() }),
        addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); },
        removeEventListener(type, handler) {
            this.listeners[type] = (this.listeners[type] || []).filter(h => h !== handler);
        },
        dispatch(type, event = {}) { for (const h of [...(this.listeners[type] || [])]) h(event); },
    };
    const panel = node('p-splitterpanel side-bar-panel pointer-events-auto min-w-78', {
        // ツール群の右から始まっている（実測 58px）。
        offsetLeft: 58,
        ownerDocument: doc,
        getBoundingClientRect: () => ({ width: panelWidth }),
    });
    const content = node('sidebar-content-container size-full');
    const wrapper = node('');
    const root = node('unbake-shell', { isConnected: connected });
    content.parentElement = panel;
    wrapper.parentElement = content;
    root.parentElement = wrapper;
    return { panel, content, wrapper, root, doc, gripOf: () => panel.children.find(
        child => String(child.className).includes('unbake-sidebar-grip')) || null };
}

test('器を横の並びから外す（右端を動かさないため）', () => {
    const { panel, root } = hostTree();
    // 触る前の姿を控える。
    assert.equal(panel.style.position, undefined);
    const overlay = installSidebarOverlay(root);
    assert.equal(overlay.ok, true, overlay.reason || '');
    assert.equal(panel.style.position, 'absolute', '並びから外していない');
    assert.equal(panel.style.top, '0');
    assert.equal(panel.style.bottom, '0');
    assert.equal(panel.attributes['data-unbake-overlay'], 'true', '印が無い');
});

test('宿主の実行バーより上に出す（下に潜ると押せない面ができる）', () => {
    // **実測**（2026-08-25・ComfyUI v0.28.3 / frontend 1.42.15）:
    //   `.actionbar` を包む `.p-panel` … z-index **1300**
    //   両者を包む `div.z-999`          … 999（積み木の底）
    // 並びから外して広げると実行バーの下へ潜り、**設定の面まで覆われる**
    // ——利用者の指摘はこれ。
    const HOST_TOOLBAR_Z = 1300;
    const { panel, root } = hostTree();
    installSidebarOverlay(root);
    const z = Number(panel.style.zIndex);
    assert.ok(Number.isFinite(z), `重なり順を指定していない: ${panel.style.zIndex}`);
    assert.ok(z > HOST_TOOLBAR_Z,
        `実行バー(${HOST_TOOLBAR_Z}) より下に居る: ${z}`);
    // **対話窓（body 直下の 1101）は覆わない。** こちらは z-999 の入れ物の中なので、
    // 中で何番を付けても入れ物ごと 999 として比べられる——ここは「入れ物の中に
    // 居ること」を前提にしているので、外へ出したくなった日はこの検査も読むこと。
    assert.equal(String(panel.className).includes('side-bar-panel'), true);
});

test('左のツール群は覆わない（Unbake を閉じる釦が消えるため）', () => {
    // **左端から出すと、開けっぱなしになる。**
    const { panel, root } = hostTree();
    installSidebarOverlay(root);
    assert.equal(panel.style.left, '58px', `左端から出している: ${panel.style.left}`);
    assert.equal(panel.style.maxWidth, 'calc(100vw - 58px)', '窓からはみ出す指定になっている');
});

test('幅は設定で決める（0 なら窓に合わせる）', () => {
    const wide = hostTree();
    installSidebarOverlay(wide.root, { width: 560 });
    assert.equal(wide.panel.style.width, '560px', `設定の幅になっていない: ${wide.panel.style.width}`);

    const auto = hostTree();
    installSidebarOverlay(auto.root, { width: 0 });
    assert.match(auto.panel.style.width, /clamp\(/, `窓に合わせる形になっていない: ${auto.panel.style.width}`);

    // **中身の最小幅（285px）を割る値は受けない。** 器だけ細くすると中で横に溢れる。
    const thin = hostTree();
    installSidebarOverlay(thin.root, { width: 120 });
    assert.match(thin.panel.style.width, /clamp\(/, `狭すぎる値を受けている: ${thin.panel.style.width}`);
});

test('切ってあるときは、器に一切触らない', () => {
    const { panel, root } = hostTree();
    const overlay = installSidebarOverlay(root, { enabled: false });
    assert.equal(overlay.ok, false);
    assert.deepEqual(panel.style, {}, '切ってあるのに触っている');
    assert.deepEqual(panel.attributes, {}, '切ってあるのに印を付けている');
});

test('器が無い形でも落ちない（全画面・検査）', () => {
    const lone = { className: 'unbake-shell', style: {}, parentElement: null, isConnected: true };
    const overlay = installSidebarOverlay(lone, { scheduler: () => null });
    assert.equal(overlay.ok, false);
    assert.match(String(overlay.reason), /sidebar panel/);
    // **口は同じ形で返す。** 呼び手が分岐を書かなくて済む。
    assert.doesNotThrow(() => { overlay.refresh(); overlay.dispose(); });
});

test('渡された時点で繋がっていなくても、付いたら重ねる', () => {
    // **実機ではこれが既定の順序だった**（2026-08-25 実測）。器を渡してくる
    // 時点では祖先に `.side-bar-panel` が無く、1回で諦める作りだと
    // **例外もログも出ないまま、何も起きない**——最初の版が実際にそうだった。
    const { panel, root, wrapper } = hostTree();
    const later = [];
    const detached = { className: 'unbake-shell', style: {}, parentElement: null, isConnected: true };
    const overlay = installSidebarOverlay(detached, {
        width: 520,
        scheduler: (fn) => { later.push(fn); return later.length; },
    });
    assert.equal(overlay.ok, false, 'まだ付いていないのに繋がったと言っている');
    assert.ok(later.length >= 3, `やり直しを積んでいない: ${later.length}`);

    // 画面へ差し込まれた（`root` の祖先に器が現れた）。
    detached.parentElement = wrapper;
    later[0]();
    assert.equal(overlay.applied(), true, '付いた後も重ねていない');
    assert.equal(panel.style.width, '520px');
    // **同じ器へ二度手を入れない。** 二度目に控えを取り直すと、
    // 「触る前」が重ねた後の値になり、戻せなくなる。
    later[1]();
    overlay.dispose();
    // 元が空だったので、戻した後も空（重ねた幅が残らないこと）。
    assert.ok(!panel.style.width, `戻せていない: ${panel.style.width}`);
    assert.ok(!panel.style.position, `並びから外したままになっている: ${panel.style.position}`);
});

test('他のタブへ持ち込まない（外れた瞬間に戻す）', () => {
    // 器はタブ間で使い回される。**戻さないと Queue まで重なって出る。**
    const { panel, root } = hostTree();
    panel.style.position = 'static';
    panel.style.width = '369.75px';
    const observers = [];
    const overlay = installSidebarOverlay(root, {
        width: 560,
        observerFactory: class {
            constructor(handler) { this.handler = handler; observers.push(this); }
            observe() { this.observing = true; }
            disconnect() { this.observing = false; }
        },
    });
    assert.equal(overlay.applied(), true, '入っていない');
    assert.equal(observers.length, 1, '切り替えを見張っていない');
    assert.equal(observers[0].observing, true, '見張りを始めていない');

    // 別のタブへ切り替わった＝こちらの面が外れた。
    root.isConnected = false;
    observers[0].handler();
    assert.equal(overlay.applied(), false, '外れても重ねたまま');
    assert.equal(panel.style.position, 'static', `触る前へ戻していない: ${panel.style.position}`);
    assert.equal(panel.style.width, '369.75px', `幅を戻していない: ${panel.style.width}`);
    assert.equal(panel.attributes['data-unbake-overlay'], undefined, '印が残っている');

    // 戻ってきたら、また重ねる。
    root.isConnected = true;
    observers[0].handler();
    assert.equal(overlay.applied(), true, '戻ってきたのに重ねていない');
    assert.equal(panel.style.width, '560px');

    overlay.dispose();
    assert.equal(panel.style.position, 'static', '畳んでも触ったまま');
    assert.equal(observers[0].observing, false, '見張りを止めていない');
});

test('器は class の語で探す（部分一致で拾わない）', () => {
    const { panel, root, content } = hostTree();
    assert.equal(findSidebarPanel(content), panel);
    // **語として持っていない物を器と読まない。**
    const decoy = { className: 'my-side-bar-panelish', style: {}, parentElement: null };
    assert.equal(findSidebarPanel(decoy), null, '別物を器と読んでいる');
    assert.equal(findSidebarPanel(root), panel, 'たどれていない');
});

// --- 掴んで幅を変える（2026-08-25 利用者の指摘）--------------------------

test('掴み手を出す（並びから外すと、宿主の仕切りが効かなくなるため）', () => {
    // **取り上げたなら、代わりを出す。** 重ねた瞬間に ComfyUI の splitter は
    // 効かなくなる——向こうが動かすのは `flex-basis` で、絶対位置の器は見ない。
    const tree = hostTree();
    const overlay = installSidebarOverlay(tree.root, { gripTitle: '掴んで幅を変える' });
    const grip = tree.gripOf();
    assert.ok(grip, '掴み手が無い＝幅を変える口が1つも無い');
    assert.equal(grip.style.cursor, 'col-resize', '掴める見た目になっていない');
    assert.ok(String(grip.title || '').length > 3, '何をする所か言っていない');

    // **畳んだら片付ける。** 残すと、他のタブの器に見えない縦帯が残る。
    overlay.dispose();
    assert.equal(tree.gripOf(), null, '掴み手が残っている');
});

test('掴んで動かすと幅が変わり、離した時に1回だけ保存する', () => {
    const tree = hostTree({ panelWidth: 400 });
    const saved = [];
    installSidebarOverlay(tree.root, { width: 400, onWidth: (px) => saved.push(px) });
    const grip = tree.gripOf();

    grip.dispatch('pointerdown', { clientX: 400 });
    tree.doc.dispatch('pointermove', { clientX: 480 });
    assert.equal(tree.panel.style.width, '480px', `動かした分が効いていない: ${tree.panel.style.width}`);
    // **動かすたびには保存しない。** 1回の掴みで何十回も書きに行く。
    assert.deepEqual(saved, [], '動かしている途中で保存している');

    tree.doc.dispatch('pointerup', { clientX: 520 });
    assert.equal(tree.panel.style.width, '520px');
    assert.deepEqual(saved, [520], `離した時の保存が違う: ${JSON.stringify(saved)}`);

    // **離した後は追わない。** 追うと、掴んでいないのに幅が動く。
    tree.doc.dispatch('pointermove', { clientX: 900 });
    assert.equal(tree.panel.style.width, '520px', '離した後も追いかけている');
});

test('掴んでも、中身の下限と窓の右端は割らない', () => {
    const narrow = hostTree({ panelWidth: 400 });
    installSidebarOverlay(narrow.root, { width: 400, viewportWidth: 1134 });
    narrow.gripOf().dispatch('pointerdown', { clientX: 400 });
    narrow.doc.dispatch('pointermove', { clientX: 0 });
    assert.equal(narrow.panel.style.width, '285px', `下限を割っている: ${narrow.panel.style.width}`);

    const wide = hostTree({ panelWidth: 400 });
    installSidebarOverlay(wide.root, { width: 400, viewportWidth: 1134 });
    wide.gripOf().dispatch('pointerdown', { clientX: 400 });
    wide.doc.dispatch('pointermove', { clientX: 3000 });
    // 器は 58px から始まるので、窓 1134 なら 1076 が上限。
    assert.equal(wide.panel.style.width, '1076px', `窓からはみ出している: ${wide.panel.style.width}`);
});

test('ダブルクリックで既定へ戻る（掴んで狭めた後の出口）', () => {
    const tree = hostTree({ panelWidth: 400 });
    const saved = [];
    installSidebarOverlay(tree.root, { width: 600, onWidth: (px) => saved.push(px) });
    const grip = tree.gripOf();
    grip.dispatch('pointerdown', { clientX: 400 });
    tree.doc.dispatch('pointerup', { clientX: 320 });
    assert.equal(tree.panel.style.width, '320px');

    grip.dispatch('dblclick', {});
    // **設定の幅でもなく、掴んだ幅でもなく、窓に合わせる形へ戻す。**
    assert.match(tree.panel.style.width, /clamp\(/, `既定へ戻っていない: ${tree.panel.style.width}`);
    assert.deepEqual(saved, [320, 0], `戻したことを保存していない: ${JSON.stringify(saved)}`);
});

test('掴んで決めた幅は、面が出入りしても残る', () => {
    // タブを行き来するたびに設定の幅へ戻ると、掴んだ意味が無い。
    const tree = hostTree({ panelWidth: 400 });
    const observers = [];
    const overlay = installSidebarOverlay(tree.root, {
        width: 400,
        observerFactory: class {
            constructor(handler) { this.handler = handler; observers.push(this); }
            observe() {} disconnect() {}
        },
    });
    tree.gripOf().dispatch('pointerdown', { clientX: 400 });
    tree.doc.dispatch('pointerup', { clientX: 640 });
    assert.equal(tree.panel.style.width, '640px');

    tree.root.isConnected = false;
    observers[0].handler();
    tree.root.isConnected = true;
    observers[0].handler();
    assert.equal(tree.panel.style.width, '640px', `戻ってきたら幅が巻き戻った: ${tree.panel.style.width}`);
    overlay.dispose();
});
