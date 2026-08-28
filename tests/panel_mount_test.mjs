/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 決定⑤ — **同じコンポーネントがサイドバーと全画面の両方で動く。**
 *
 * これは「最初からこの形で書かないと効かない」種類の性質で、
 * 独自ページ前提（上流 LoRA Manager のテンプレート34枚＋独自ルート）で書くと
 * サイドバーへ載せられなくなる。**後から直すのではなく、崩れたら赤くする。**
 *
 * jsdom は使わない（依存を増やさない）。`createElement` / `append` /
 * `addEventListener` しか使っていないので、最小のダブルで足りる。
 * **ダブルで足りること自体が「器に依存していない」ことの証拠**でもある。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createUnbakePanel } from '../web/panel/panel.js';
import { resetMemoryStorage } from '../web/core/storage.js';
import { DROP_ROUTES } from '../web/panel/dropRouting.js';

/** DOM の最小のダブル。 */
function fakeDocument() {
    const make = (tag) => {
        const node = {
            tagName: String(tag).toUpperCase(),
            className: '',
            textContent: '',
            attributes: {},
            style: {},
            children: [],
            listeners: {},
            scrollTop: 0,
            scrollHeight: 0,
            value: '',
            ownerDocument: null,
            setAttribute(key, value) { this.attributes[key] = String(value); },
            getAttribute(key) { return this.attributes[key] ?? null; },
            // **本物に在る口は、こちらにも置く。** 無いと、実装が使った途端に
            // 「実行時エラー」で落ちる——欠陥ではなく人形の穴なのに、原因が
            // 実装側に見える（2026-08-25 実際に踏んだ）。
            removeAttribute(key) { delete this.attributes[key]; },
            append(...items) { this.children.push(...items); for (const c of items) c.parent = this; },
            replaceChildren(...items) {
                this.children = [...items];
                for (const c of items) c.parent = this;
            },
            remove() {
                if (!this.parent) return;
                this.parent.children = this.parent.children.filter(c => c !== this);
                this.parent = null;
            },
            addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); },
            removeEventListener(type, handler) {
                this.listeners[type] = (this.listeners[type] || []).filter(h => h !== handler);
            },
            dispatch(type, event) {
                // **disabled な相手は押せない。** 本物のブラウザは disabled 要素へ
                // click を配らない。ここで配ると、**押せない口を「押せる」と証言する
                // テスト**ができる（2026-08-24 実機：待機中の ⏸ が押せなかった）。
                const pointerish = type === 'click' || type === 'dblclick'
                    || type.startsWith('pointer') || type.startsWith('mouse');
                if (pointerish && this.disabled) return;
                for (const handler of this.listeners[type] || []) handler(event);
            },
        };
        return node;
    };
    // **紙の出し入れも観測する。** `head` が無いと `applySkin` は黙って
    // 何もしないので、「積んでいない」と「器が無い」が混ざる。
    const sheets = [];
    const doc = {
        createElement: (tag) => {
            const node = make(tag);
            // **元の外し方を潰さない。** 潰すと、面を畳んでも器から外れなくなる
            // （2026-08-25 実際に踏んだ——`destroy` の検査が赤くなった）。
            const detach = node.remove.bind(node);
            node.remove = () => {
                const at = sheets.indexOf(node);
                if (at >= 0) sheets.splice(at, 1);
                detach();
            };
            return node;
        },
        head: { append: (node) => sheets.push(node) },
        getElementById: (id) => sheets.find(node => node.attributes?.id === id || node.id === id) || null,
        sheets,
    };
    return doc;
}

/** 分割復号を含む最小のグラフ（止まり得る形の目印）。 */
const PROMPT = { '9': { class_type: 'VAEDecodeTiled', inputs: {} } };

const container = (doc) => {
    const node = doc.createElement('div');
    node.ownerDocument = doc;
    return node;
};

/** 木を平坦に辿る。 */
function walk(node, out = []) {
    out.push(node);
    for (const child of node.children || []) walk(child, out);
    return out;
}

const find = (root, predicate) => walk(root).find(predicate) || null;

test('サイドバーと全画面で、同じ構造が同じ関数から出る', () => {
    const doc = fakeDocument();
    const sidebar = createUnbakePanel(container(doc), { mode: 'sidebar' });
    const fullscreen = createUnbakePanel(container(doc), { mode: 'fullscreen' });

    // 差は「器の名札」だけ。**要素の構造は同一。**
    assert.equal(sidebar.root.getAttribute('data-mode'), 'sidebar');
    assert.equal(fullscreen.root.getAttribute('data-mode'), 'fullscreen');

    const shape = (panel) => walk(panel.root).map(n => n.tagName + '.' + n.className).join('|');
    assert.equal(shape(sidebar), shape(fullscreen), '器によって構造が変わっている＝1コンポーネントでない');
});

test('密度は mode ではなく器の幅で決まる', () => {
    // **`mode` で分けると実装が2つに割れて、決定⑤（1コンポーネント）が崩れる。**
    // 幅で決めれば、全画面を狭くしてもサイドバーと同じ挙動になる。
    const doc = fakeDocument();
    const narrowFullscreen = createUnbakePanel(container(doc), { mode: 'fullscreen', width: 320 });
    const wideSidebar = createUnbakePanel(container(doc), { mode: 'sidebar', width: 1200 });
    assert.equal(narrowFullscreen.density, 'compact', '全画面でも狭ければ compact になるはず');
    assert.equal(wideSidebar.density, 'full', 'サイドバーでも広ければ full になるはず');
});

test('狭くても全件描く（行を切る道が1つも残っていない）', () => {
    // **元は上限12行で切って残りを全画面へ送っていた**——「スクロール量が
    // データ量に比例しない」ため。だが実機で「レコードが多いとサイドバーで
    // 途中までしか閲覧できない」と報告され（2026-08-20）、既定を「切らない」に
    // した。**行数の設定そのものは 2026-08-25 に撤去**（既定のままなら何も
    // 起きない設定で、戻す先は利用者が一度嫌った挙動だった）。
    const doc = fakeDocument();
    // **表の行を見る検査は、表示を明示する**（2026-08-28 F2 で、
    // タイル表示のときは隠れた表を組まなくなった。既定はタイル）。
    const panel = createUnbakePanel(container(doc), { mode: 'sidebar', width: 320, display: { listView: 'table' } });
    const rows = () => walk(panel.root).filter(n => n.tagName === 'TR' && n.parent?.tagName === 'TBODY').length;

    panel.setRecords(Array.from({ length: 10 }, (_, i) => ({ id: 'r' + i, verdict: 'reproducible' })));
    assert.equal(rows(), 10);

    panel.setRecords(Array.from({ length: 500 }, (_, i) => ({ id: 'r' + i, verdict: 'reproducible' })));
    assert.equal(rows(), 500, `狭いのに ${rows()} 行しか描いていない`);

    // 「残り N 件」の口も無くなっていること（在ると押せない口が残る）。
    assert.equal(find(panel.root, n => n.className === 'unbake-overflow'), null,
        '切らないのに「残り N 件」の口が残っている');

    // 広い器でも同じ。
    panel.setWidth(1200);
    assert.equal(rows(), 500, '広い器で件数が絞られている');
});

test('前回測れた幅から開く（再起動して測れなくても、前と同じ形で出る）', () => {
    // **再起動の直後は測れないことがある。** ComfyUI がサイドバーの幅を
    // 復元するのは、こちらが描いた後になりうる。測れないまま既定で開くと、
    // 広げてあるのに狭い版が出る（実機で「再起動すると戻る」と報告された）。
    resetMemoryStorage();
    const doc = fakeDocument();
    const saved = { ro: globalThis.ResizeObserver, raf: globalThis.requestAnimationFrame };
    delete globalThis.ResizeObserver;
    delete globalThis.requestAnimationFrame;
    try {
        // 1回目: 実際に測れた幅を覚える。
        const first = container(doc);
        first.getBoundingClientRect = () => ({ width: 300 });
        assert.equal(createUnbakePanel(first, { mode: 'sidebar' }).density, 'compact');

        // 2回目: **測れない**（幅0）。それでも前回の形で開く。
        const second = container(doc);
        second.getBoundingClientRect = () => ({ width: 0 });
        assert.equal(createUnbakePanel(second, { mode: 'sidebar' }).density, 'compact',
            '前回測れた幅を使っていない');

        // **覚えた値は実測に負ける。** 測れた瞬間に本物へ差し替わる。
        const third = container(doc);
        third.getBoundingClientRect = () => ({ width: 1200 });
        assert.equal(createUnbakePanel(third, { mode: 'sidebar' }).density, 'full',
            '覚えた値が実測を上書きしている');
    } finally {
        if (saved.ro) globalThis.ResizeObserver = saved.ro;
        if (saved.raf) globalThis.requestAnimationFrame = saved.raf;
        resetMemoryStorage();
    }
});

test('配置前に作られても、配置後に幅を測り直す', () => {
    // 前の試験が覚えた幅を持ち込まない（覚えた値は既定より強い）。
    resetMemoryStorage();
    // **実機で踏んで再現も取った。** ComfyUI はまだ配置されていない要素へ描かせる。
    // その状態で ResizeObserver を張ると、**後から挿入されても鳴らない**ので、
    // 幅300pxのサイドバーに広い版が出たまま固まる（症状は横スクロール）。
    const doc = fakeDocument();
    const host = container(doc);
    let laidOut = false;
    host.getBoundingClientRect = () => ({ width: laidOut ? 300 : 0 });

    const timers = [];
    const saved = {
        ro: globalThis.ResizeObserver,
        raf: globalThis.requestAnimationFrame,
        st: globalThis.setTimeout,
    };
    delete globalThis.ResizeObserver;                 // 監視は鳴かない前提
    delete globalThis.requestAnimationFrame;          // 隠れたページでは rAF も動かない
    globalThis.setTimeout = (fn) => { timers.push(fn); return timers.length; };
    try {
        const panel = createUnbakePanel(host, { mode: 'sidebar' });
        assert.equal(panel.density, 'full', '配置前は幅0なので既定のまま');
        assert.ok(timers.length > 0, '測り直しを一度も予約していない');

        laidOut = true;                               // ← ここで初めて配置される
        for (const fn of timers) fn();
        assert.equal(panel.density, 'compact', '配置後に測り直せていない');
    } finally {
        globalThis.setTimeout = saved.st;
        if (saved.ro) globalThis.ResizeObserver = saved.ro;
        if (saved.raf) globalThis.requestAnimationFrame = saved.raf;
    }
});

test('測り直しは自分を再予約しない（回り続けない）', () => {
    // 取れないまま予約し続けるのは、**直っていないのに動いて見える**形。
    resetMemoryStorage();
    const doc = fakeDocument();
    const host = container(doc);
    host.getBoundingClientRect = () => ({ width: 0 });   // ずっと配置されない
    const timers = [];
    const saved = { ro: globalThis.ResizeObserver, raf: globalThis.requestAnimationFrame, st: globalThis.setTimeout };
    delete globalThis.ResizeObserver;
    delete globalThis.requestAnimationFrame;
    globalThis.setTimeout = (fn) => { timers.push(fn); return timers.length; };
    try {
        createUnbakePanel(host, { mode: 'sidebar' });
        const scheduledAtFirst = timers.length;
        assert.ok(scheduledAtFirst > 0 && scheduledAtFirst <= 8, `予約が ${scheduledAtFirst} 件＝多すぎる`);
        for (let i = 0; i < scheduledAtFirst; i += 1) timers[i]();
        assert.equal(timers.length, scheduledAtFirst, '測り直しが自分を再予約している');
    } finally {
        globalThis.setTimeout = saved.st;
        if (saved.ro) globalThis.ResizeObserver = saved.ro;
        if (saved.raf) globalThis.requestAnimationFrame = saved.raf;
    }
});

test('描くたびに測り直す（仕掛けが全部空振りしても追いつく）', () => {
    resetMemoryStorage();
    const doc = fakeDocument();
    const host = container(doc);
    let laidOut = false;
    host.getBoundingClientRect = () => ({ width: laidOut ? 300 : 0 });
    const saved = { ro: globalThis.ResizeObserver, raf: globalThis.requestAnimationFrame, st: globalThis.setTimeout };
    delete globalThis.ResizeObserver;
    delete globalThis.requestAnimationFrame;
    globalThis.setTimeout = () => 0;   // 予約しても呼ばれない環境
    try {
        const panel = createUnbakePanel(host, { mode: 'sidebar' });
        assert.equal(panel.density, 'full');
        laidOut = true;
        panel.setRecords([{ id: 'a', verdict: 'reproducible' }]);   // 利用者が何か触った
        assert.equal(panel.density, 'compact', '描画時に測り直していない');
    } finally {
        globalThis.setTimeout = saved.st;
        if (saved.ro) globalThis.ResizeObserver = saved.ro;
        if (saved.raf) globalThis.requestAnimationFrame = saved.raf;
    }
});

test('絞り込みは描く前に効き、外した種別も件数は見え続ける', () => {
    const doc = fakeDocument();
    // **表の行を見る検査は、表示を明示する**（2026-08-28 F2 で、
    // タイル表示のときは隠れた表を組まなくなった。既定はタイル）。
    const panel = createUnbakePanel(container(doc), { mode: 'fullscreen', width: 1200, display: { listView: 'table' } });
    panel.setRecords([
        { id: 'a', title: 'fox', verdict: 'reproducible', checkpoint: 'anima.safetensors' },
        { id: 'b', title: 'cat', verdict: 'blocked' },
        { id: 'c', title: 'fox2', verdict: 'approximate', positive: 'a fox' },
    ]);
    const rows = () => walk(panel.root).filter(n => n.tagName === 'TR' && n.parent?.tagName === 'TBODY').length;
    assert.equal(rows(), 3);

    // 判定チップで落とす。**件数は残す**（0件と「隠した」を混ぜない）。
    const chip = find(panel.root, n => n.className === 'unbake-chip' && n.getAttribute('data-verdict') === 'blocked');
    chip.dispatch('click', {});
    assert.equal(rows(), 2);
    assert.match(chip.textContent, /1/, '外した種別の件数が消えている');
    assert.equal(chip.getAttribute('data-on'), 'false');

    // **「未確認」の欄は出さない**（2026-08-23 利用者の指示）。開いた直後は
    // 全件がこれで、判定を回し終えると 0 になる——見出しに「未確認 0」が
    // 居座るだけになる。**記録の側からは消えない**（タイルには印が出る）。
    assert.ok(
        !find(panel.root, n => n.className === 'unbake-chip' && n.getAttribute('data-verdict') === 'pending'),
        '「未確認」の欄が残っている');

    // 検索。
    const search = find(panel.root, n => n.className === 'unbake-search');
    search.value = 'fox';
    search.dispatch('input', {});
    assert.equal(rows(), 2, 'title と prompt の両方から拾えていない');
    search.value = 'anima';
    search.dispatch('input', {});
    assert.equal(rows(), 1, 'checkpoint 名から拾えていない');
});

test('落としたものが Generation Record として一覧へ入る', async () => {
    const doc = fakeDocument();
    const panel = createUnbakePanel(container(doc), {
        mode: 'fullscreen',
        width: 1200,
        ingest: async (routed) => ({
            records: [{ id: routed.filename, title: routed.filename, verdict: 'reproducible' }],
            errors: [],
        }),
    });
    const transfer = (map = {}, files = []) => ({ getData: (t) => map[t] || '', files });
    await panel.handleDrop(transfer({
        'text/uri-list': 'http://127.0.0.1:8188/api/view?filename=a.png&type=output&subfolder=',
    }));
    assert.equal(panel.getRecords().length, 1, '取り込んだ記録が一覧へ入っていない');

    // **同じ出所を落とし直しても増えない。**
    await panel.handleDrop(transfer({
        'text/uri-list': 'http://127.0.0.1:8188/api/view?filename=a.png&type=output&subfolder=',
    }));
    assert.equal(panel.getRecords().length, 1, '落とし直しで重複している');
});

test('差し込み先の document を使う（大域の document を掴まない）', () => {
    // 大域を掴んでいると、別 document のコンテナへ差した瞬間に壊れる。
    // ここで大域を用意しない状態で通ることが、掴んでいないことの証拠になる。
    const doc = fakeDocument();
    let created = 0;
    const counting = { createElement: (tag) => { created += 1; return doc.createElement(tag); } };
    const el = container(doc);
    el.ownerDocument = counting;
    createUnbakePanel(el, { mode: 'sidebar' });
    assert.ok(created > 5, 'コンテナ側の document が使われていない（' + created + '要素）');
});

test('落としたものが3経路へ振り分けられ、パネルに記録される', async () => {
    const doc = fakeDocument();
    const seen = [];
    const panel = createUnbakePanel(container(doc), {
        mode: 'sidebar',
        width: 1200,
        ingest: async (routed) => { seen.push(routed.route); return { records: [], errors: [] }; },
    });

    const transfer = (map = {}, files = []) => ({ getData: (t) => map[t] || '', files });
    await panel.handleDrop(transfer({ 'text/uri-list': 'https://civitai.red/images/18176508' }));
    await panel.handleDrop(transfer({ 'text/uri-list': 'http://127.0.0.1:8188/api/view?filename=a.png&type=output&subfolder=' }));
    await panel.handleDrop(transfer({}, [{ name: 'a.png', type: 'image/png' }]));

    assert.deepEqual(seen, [DROP_ROUTES.CIVITAI, DROP_ROUTES.COMFY_OUTPUT, DROP_ROUTES.LOCAL_FILE]);

    // 判定できなかったものは**黙って消さない**（0件と「読めなかった」を混ぜない）。
    const nothing = await panel.handleDrop(transfer({}, []));
    assert.equal(nothing, null);
    const log = find(panel.root, n => n.className === 'unbake-log');
    assert.equal(log.children.length, 4, '落とした回数だけ記録が残っていない');
});

// --- 押した手応え（2026-08-24 実機の指摘「大きなラグがある」）----------------
//
// **実測すると通信は速かった**（`/unbake/records` 8ms・1件 5ms・`/queue` 10ms）。
// 遅かったのは手応えで、押しても `disabled` も状態も変わらず、
// 唯一の反応が下の履歴に1行増えることだった。

test('押した瞬間にボタンが「走っている」姿になる', async () => {
    const doc = fakeDocument();
    let release;
    const held = new Promise((r) => { release = r; });
    const panel = createUnbakePanel(container(doc), {
        mode: 'sidebar', width: 1200,
        makeSweepRunner: () => ({
            inputsReady: held,
            requireEmptyQueue: async () => {},
            run: async () => ({ cells: [] }),
        }),
    });
    panel.setRecords([{ id: 'a', title: 'A', recipe: { id: 'a', gen_params: { seed: 1 } } }]);
    const button = find(panel.root, n => String(n.className).includes('unbake-act-replay'));
    assert.ok(button, '再現のボタンが無い');
    const idle = button.textContent;

    button.dispatch('click', {});
    await Promise.resolve();
    // **押した直後**——走り終わる前に、もう姿が変わっていること。
    assert.equal(button.disabled, true, '押しても押せたままになっている');
    assert.equal(button.getAttribute('data-busy'), 'true', '走っている印が付いていない');

    // **印そのものが変わること**（2026-08-24 利用者の指示「アイコンで示して」）。
    // 枠の色だけでは弱く、押したのに何も起きていないように見えた。
    assert.notEqual(button.textContent, idle, '印が変わっていない');

    release();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(button.disabled, false, '終わっても押せないままになっている');
    assert.equal(button.getAttribute('data-busy'), 'false', '走っている印が残っている');
    // **元の字へ戻す。** 押せる状態の見た目は器で違う（タイルは印だけ・行は語も出る）
    // ので、ここで作り直さず控えたものを戻す。
    assert.equal(button.textContent, idle, '押せる状態の字へ戻っていない');
});

test('描き直されても、走っている姿のまま出る', async () => {
    // **これが「押したら印が消える」の真因だった**（2026-08-24）。
    // タイルの操作列は `opacity: 0` で普段は見えておらず、hover したときだけ出る。
    // そこへ一覧の描き直しが重なると、ボタンは作り直されて `data-busy` を失い、
    // 列ごと `opacity: 0` へ戻る。**色の問題ではなかった。**
    const doc = fakeDocument();
    let release;
    const held = new Promise((r) => { release = r; });
    const panel = createUnbakePanel(container(doc), {
        mode: 'sidebar', width: 1200,
        // **透明になるのはタイルの列だけ。** 表の行では列は常に見えているので、
        // ここで確かめたい失敗が起きない器で測っても意味が無い。
        display: { listView: 'tiles' },
        makeSweepRunner: () => ({
            inputsReady: held, requireEmptyQueue: async () => {}, run: async () => ({ cells: [] }),
        }),
    });
    const records = [{ id: 'a', title: 'A', recipe: { id: 'a', gen_params: { seed: 1 } } }];
    panel.setRecords(records);
    find(panel.root, n => String(n.className).includes('unbake-act-replay')).dispatch('click', {});
    await Promise.resolve();

    // **走っている最中に描き直す**（判定の反映や絞り込みで普通に起きる）。
    panel.setRecords(records);
    const rebuilt = find(panel.root, n => String(n.className).includes('unbake-act-replay'));
    assert.equal(rebuilt.getAttribute('data-busy'), 'true', '描き直したら走っている姿が消えた');
    // **列ごと見えなくならないこと。** 印が在っても、列が透明なら見えない。
    const actions = find(panel.root, n => String(n.className) === 'unbake-tile-actions');
    assert.ok(actions, 'タイルの操作列が無い');
    assert.equal(actions.getAttribute('data-busy'), 'true', '列が隠れたままになる');

    release();
    // **流し役を1つ挟んだぶん、間が増えた**（2026-08-24 に順番待ちを足した）。
    // 押した瞬間に走るのではなく、待ち行列へ入って流し役が拾う形になっている。
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
    // **戻すのは押した相手だけでは足りない。** 描き直しで生まれた方も戻す。
    assert.equal(rebuilt.disabled, false, '描き直された方が押せないまま固まっている');
    assert.equal(rebuilt.getAttribute('data-busy'), 'false');
});

test('すぐ終わる操作は待たせない（同じ間に2度目を受け付ける）', () => {
    // **お気に入りは押し戻せること。** 走っている姿を全部の口へ付けたら、
    // 同期で終わる操作まで1回分待たされ、2度目が黙って無視されていた。
    const doc = fakeDocument();
    const panel = createUnbakePanel(container(doc), { mode: 'sidebar', width: 1200 });
    panel.setRecords([{ id: 'a', title: 'A' }]);
    const star = () => find(panel.root, n => String(n.className).includes('unbake-act-favorite'));
    const before = star().getAttribute('data-on');
    star().dispatch('click', {});
    const middle = star().getAttribute('data-on');
    star().dispatch('click', {});
    assert.notEqual(middle, before, '1度目が効いていない');
    assert.equal(star().getAttribute('data-on'), before, '同じ間に押し戻せない');
});

/*
 * **同時に2本走らせない**（2026-08-27・実機「1件目が終わっても次が始まらない」）。
 *
 * ここには「走っている裏で押された1件は、既に絵が在るならすぐ開く」を
 * 見張る検査が在った（2026-08-25 の要望）。**その近道は畳んだ。**
 *
 * 近道は `reproduceOne()` を行列の外でもう1本走らせる。再現は投げる前に
 * 人へ聞くことがあり（VRAM に入らない／分割復号で止まり得る）、
 * **確認の面は1枚しか持てない**——2本走ると後の面が前の面を差し替え、
 * 前の1本の返事が返らないまま**行列が永久に止まる**。
 * さらに、同じ拍で2つ押すと**どちらの投入もまだ着いていない隙に両方が通る**
 * （2026-08-26 に実測済み: 走り1・待ち1 で ComfyUI に2件同時に居た）。
 *
 * **代償は残る。** 既に絵が在るだけの記録も、走っている1件の後ろで待つ。
 * ここではその代わりに得たもの——**順番どおりに、1本ずつ、必ず全部回る**——を見張る。
 */
test('走っている間に押した分は行列を通る（同時に2本走らせない）', async () => {
    const doc = fakeDocument();
    let release;
    const held = new Promise((r) => { release = r; });
    /** いま走っている本数。**2 になったら約束が破れている。** */
    let live = 0;
    let overlapped = 0;
    const opened = [];
    const panel = createUnbakePanel(container(doc), {
        mode: 'sidebar', width: 1200,
        makeSweepRunner: (target) => ({
            inputsReady: Promise.resolve(),
            requireEmptyQueue: async () => {},
            run: async () => {
                const id = String(target?.id ?? target?.recipe?.id);
                live += 1;
                if (live > 1) overlapped += 1;
                try {
                    // a は投げる分が在って走り続ける。b は既に絵が在るので即返る。
                    if (id === 'a') await held;
                    opened.push(id);
                    return { cells: [] };
                } finally { live -= 1; }
            },
        }),
    });
    panel.setRecords([
        { id: 'a', title: 'A', recipe: { id: 'a', gen_params: { seed: 1 } } },
        { id: 'b', title: 'B', recipe: { id: 'b', gen_params: { seed: 2 } } },
    ]);
    const buttons = walk(panel.root)
        .filter(n => String(n.className).includes('unbake-act-replay'));
    buttons[0].dispatch('click', {});
    await new Promise((r) => setTimeout(r, 0));

    // **a が走っている最中に b を押す。**
    buttons[1].dispatch('click', {});
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    assert.equal(overlapped, 0, '同時に2本走った（行列の約束が破れている）');
    assert.deepEqual(opened, [], 'a より先に b が開いた');
    assert.equal(buttons[1].getAttribute('data-held'), 'true', 'b が待ちの姿になっていない');

    // **a が終われば b は自分で始まる。** ここが「次が始まらない」の本題。
    release();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(opened, ['a', 'b'], '1件目のあと2件目が始まっていない');
    assert.equal(overlapped, 0, '同時に2本走った');
});

test('走っている間に押すと、順番待ちになる（断らない）', async () => {
    const doc = fakeDocument();
    let release;
    let finished = false;
    const held = new Promise((r) => { release = r; });
    let starts = 0;
    // **数えるのは「投げた回数」。** 試すこと自体は正しい（投げる分が無ければ
    // その場で開くのが本題）ので、`makeSweepRunner` の回数では見ない。
    let ran = 0;
    const panel = createUnbakePanel(container(doc), {
        // **器を名指しする**（2026-08-28）。既定がタイルへ変わったので、
        // 表の行を数える検査は自分で表を選ぶ。測っている中身は変えていない。
        display: { listView: 'table' },
        mode: 'sidebar', width: 1200,
        makeSweepRunner: () => { starts += 1; return {
            inputsReady: Promise.resolve(),
            requireEmptyQueue: async () => {},
            // **投げる分が在る形**（本物の実行器と同じで、走っている間は断る）。
            run: async () => {
                if (starts > 1 && !finished) {
                    const error = new Error('busy');
                    error.code = 'queue_not_empty';
                    throw error;
                }
                await held;
                finished = true;
                ran += 1;
                return { cells: [] };
            },
        }; },
    });
    panel.setRecords([
        { id: 'a', title: 'A', recipe: { id: 'a', gen_params: { seed: 1 } } },
        { id: 'b', title: 'B', recipe: { id: 'b', gen_params: { seed: 2 } } },
    ]);
    const buttons = walk(panel.root)
        .filter(n => String(n.className).includes('unbake-act-replay'));
    assert.equal(buttons.length, 2, '再現のボタンが2つ無い');

    buttons[0].dispatch('click', {});
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(buttons[0].getAttribute('data-busy'), 'true', '1件目が走っていない');

    // **2件目は断らない。** 順番待ちにして、前が終わったら始める。
    buttons[1].dispatch('click', {});
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(buttons[1].getAttribute('data-held'), 'true', '2件目が順番待ちになっていない');
    assert.equal(buttons[1].getAttribute('data-busy'), 'false', '待っているのに走っている姿');
    assert.equal(ran, 0, '前が終わる前に2件目を投げている');

    // 1件目が終われば、2件目が自分から始まる。
    release();
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    assert.equal(ran, 2, '前が終わっても次が始まらない');
});

test('偽DOMは disabled な相手へ click を配らない（検出器そのものの検査）', () => {
    // **この検査だけは、他のどの検査でも代われない。** ここが緩むと、
    // 押せない口を「押せる」と証言するテストが全部通ってしまう
    // （2026-08-24 実機：待機中の ⏸ が disabled で押せないのに、テストは緑だった）。
    const doc = fakeDocument();
    const node = doc.createElement('button');
    let hits = 0;
    node.addEventListener('click', () => { hits += 1; });
    node.dispatch('click', {});
    assert.equal(hits, 1, '押せる相手にも配っていない');
    node.disabled = true;
    node.dispatch('click', {});
    assert.equal(hits, 1, 'disabled な相手へ配っている（本物のブラウザは配らない）');
    node.disabled = false;
    node.dispatch('click', {});
    assert.equal(hits, 2, '戻しても配らない');
});

test('宿主が生成中なら、断られてから空くまで待つ', async () => {
    // **待つのは断られた後**（2026-08-25 に順番を直した）。
    // 先に待つと、**既に出ている絵を開くだけの回**まで待たされる
    // ——その回はキューへ1件も投げないので、待つ理由が無い。
    const doc = fakeDocument();
    let hostBusy = true;
    let starts = 0;
    const panel = createUnbakePanel(container(doc), {
        mode: 'sidebar', width: 1200,
        hostQueue: async () => ({ running: hostBusy ? 1 : 0, pending: 0 }),
        makeSweepRunner: () => { starts += 1; return {
            inputsReady: Promise.resolve(),
            requireEmptyQueue: async () => {},
            // 実行器は**投げる分が在るときだけ**断る（本物と同じ形）。
            run: async () => {
                if (hostBusy) {
                    const error = new Error('busy');
                    error.code = 'queue_not_empty';
                    throw error;
                }
                return { cells: [] };
            },
        }; },
    });
    panel.setRecords([{ id: 'a', title: 'A', recipe: { id: 'a', gen_params: { seed: 1 } } }]);
    const button = find(panel.root, n => String(n.className).includes('unbake-act-replay'));
    button.dispatch('click', {});
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    // 1回は投げに行って断られ、そこから待ちへ入る。
    assert.equal(starts, 1, '一度も投げに行っていない');
    assert.equal(button.getAttribute('data-held'), 'true', '断られた後に待っていない');

    hostBusy = false;
    await new Promise((r) => setTimeout(r, 1700));
    assert.equal(starts, 2, '宿主が空いても並び直していない');
});

test('消す口は、詳細ウィンドウからも見える', async () => {
    // **出た絵の面にだけ差していたので、詳細からは見つけられなかった**
    // （2026-08-25 実機）。**見つけられない機能は、無いのと同じこと。**
    const doc = fakeDocument();
    const panel = createUnbakePanel(container(doc), {
        mode: 'sidebar', width: 1200,
        deleteOutputIo: async () => ({ ok: true }),
        loadRecord: async () => ({ id: 'a', gen_params: { seed: 1 } }),
        loadVariants: async () => ({ outputs: [{ filename: 'a.png', subfolder: '', url: '/view?a' }] }),
    });
    panel.setRecords([{ id: 'a', title: 'A', libraryId: 'a' }]);
    await panel.openDetail({ id: 'a', title: 'A', libraryId: 'a' });
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));

    const tabs = walk(panel.root).filter(n => String(n.className).includes('unbake-detail-tab'));
    for (const tab of tabs) tab.dispatch('click', {});
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));

    const remove = find(panel.root, n => String(n.className).includes('unbake-variant-delete'));
    assert.ok(remove, '詳細ウィンドウに消す口が無い');
    // **印だけにする。** 語を並べると操作の列が伸びる。
    assert.equal(remove.textContent, '🗑', `印になっていない: ${remove.textContent}`);
    // **何をする口かは、読み上げと吹き出しに残す。**
    assert.ok(String(remove.getAttribute('title') || '').length > 5, '吹き出しが無い');
});

test('戻す口は、詳細ウィンドウの中に出る', async () => {
    // **記録欄に出しても、詳細に被されて一度も見えなかった**（2026-08-25 実機の指摘）。
    // 押した場所——消えた升目そのもの——に戻す口を置く。
    const doc = fakeDocument();
    const deleted = [];
    const panel = createUnbakePanel(container(doc), {
        mode: 'sidebar', width: 1200,
        deleteOutputIo: async ({ filename }) => { deleted.push(filename); return { ok: true }; },
        loadRecord: async () => ({ id: 'a', gen_params: { seed: 1 } }),
        loadVariants: async () => ({ outputs: [{ filename: 'a.png', subfolder: '', url: '/view?a' }] }),
    });
    panel.setRecords([{ id: 'a', title: 'A', libraryId: 'a' }]);
    await panel.openDetail({ id: 'a', title: 'A', libraryId: 'a' });
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    const tabs = walk(panel.root).filter(n => String(n.className).includes('unbake-detail-tab'));
    for (const tab of tabs) tab.dispatch('click', {});
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));

    find(panel.root, n => String(n.className).includes('unbake-variant-delete')).dispatch('click', {});
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));

    // **詳細の中に在ること。** パネルのどこかに在るだけでは、被さって見えない。
    const detail = find(panel.root, n => String(n.className).split(' ').includes('unbake-detail'));
    assert.ok(detail, '詳細ウィンドウが無い');
    const back = find(detail, n => String(n.className).includes('unbake-variant-undo'));
    assert.ok(back, '詳細の中に戻す口が無い');

    back.dispatch('click', {});
    // **猶予を跨いで確かめる。** 直後に見るだけだと、止め忘れても受かる。
    await new Promise((r) => setTimeout(r, 13000));
    assert.deepEqual(deleted, [], '取り消したのに、猶予が過ぎたら消している');
});

test('画面の作りは、既定がテーマ1で、選んだ時だけ紙を積む', () => {
    // **既定は今までの面そのもの**（2026-08-25 利用者の指示「却下する可能性がある」）。
    // 選ばれていない間は紙を読み込まない——読み込むと、テーマ1の人にも解析を
    // 負わせるうえ「読み込んでいるが効いていない」という追いにくい状態になる。
    const doc = fakeDocument();
    const panel = createUnbakePanel(container(doc), { mode: 'sidebar', width: 1200 });
    assert.equal(panel.root.getAttribute('data-skin'), 'classic', '既定がテーマ1でない');
    assert.equal(doc.sheets.length, 0, '選んでいないのに紙を積んでいる');

    // 設定から切り替えたら、その場で効くこと（開き直さずに）。
    panel.applyDisplay({ ui_skin: 'prism' });
    assert.equal(panel.root.getAttribute('data-skin'), 'prism', '切り替えが面へ届いていない');
    assert.equal(doc.sheets.length, 1, '紙を積んでいない');

    // **戻したら外す。** 属性だけ戻して紙を残すと、テーマ1へ戻したつもりで
    // 規則が効き続ける。
    panel.applyDisplay({ ui_skin: 'classic' });
    assert.equal(panel.root.getAttribute('data-skin'), 'classic');
    assert.equal(doc.sheets.length, 0, 'テーマ1へ戻したのに紙が残っている');

    // 綴りを間違えた設定で画面が消えないこと。
    panel.applyDisplay({ ui_skin: 'ぷりずむ' });
    assert.equal(panel.root.getAttribute('data-skin'), 'classic', '知らない値を受けている');
});

test('走っている間だけ、面の根に印が立つ', async () => {
    // **作りによっては「走っている間だけ動く」**（円盤が回る・湯気が立つ）。
    // その判断を紙の側でできるように、状態を属性で出しておく
    // ——見せ方ごとに JS を足すと、テーマを捨てるときに JS 側へ痕が残る。
    const doc = fakeDocument();
    let release = null;
    const panel = createUnbakePanel(container(doc), {
        mode: 'sidebar', width: 1200,
        makeSweepRunner: () => ({
            inputsReady: Promise.resolve(),
            requireEmptyQueue: async () => {},
            preflight: () => ({ cells: [] }),
            run: () => new Promise((resolve) => { release = () => resolve({ cells: [] }); }),
        }),
    });
    panel.setRecords([{ id: 'a', title: 'A', recipe: { id: 'a', gen_params: { seed: 1 } } }]);
    assert.equal(panel.root.getAttribute('data-running'), 'false', '何も走っていないのに印が立っている');

    find(panel.root, n => String(n.className).includes('unbake-act-replay')).dispatch('click', {});
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    assert.equal(panel.root.getAttribute('data-running'), 'true', '走り出しても印が立たない');

    release();
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    assert.equal(panel.root.getAttribute('data-running'), 'false', '終わっても印が立ったまま');
});

test('消すのは猶予の後で、押せば1バイトも消えない', async () => {
    // **消してから戻すには置き場が要り、置き場は必ず溜まる**（2026-08-25 の設計）。
    // 猶予のあいだ呼ばないだけにすれば、取り消しは**本当に無料**になる。
    const doc = fakeDocument();
    const deleted = [];
    const panel = createUnbakePanel(container(doc), {
        mode: 'sidebar', width: 1200,
        deleteOutputIo: async ({ filename }) => { deleted.push(filename); return { ok: true }; },
        loadVariants: async () => ({ outputs: [{ filename: 'a.png', subfolder: '', url: '/view?a' }] }),
    });
    panel.setRecords([{ id: 'a', title: 'A' }]);
    const view = await panel.openVariants({ id: 'a', title: 'A' });
    assert.ok(view, '出た絵の面が開かない');
    const remove = find(panel.root, n => String(n.className).includes('unbake-variant-delete'));
    assert.ok(remove, '消す口が無い');
    remove.dispatch('click', {});
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));

    // **まだ消していない。**
    assert.deepEqual(deleted, [], '猶予の前に消している');
    const undo = find(panel.root, n => String(n.className).includes('unbake-log-action'));
    assert.ok(undo, '元に戻す口が無い');
    undo.dispatch('click', {});
    // **猶予を跨いで確かめる。** 直後に見るだけだと、止め忘れても受かる
    // （まだ時間が来ていないだけ）——実際に変異が素通りした。
    await new Promise((r) => setTimeout(r, 13000));
    assert.deepEqual(deleted, [], '取り消したのに、猶予が過ぎたら消している');
});

test('組み立てが言った注意は、そのまま画面へ出す', async () => {
    // **実行器は組み立ての `warnings` を一度も見ていなかった**（2026-08-25 実機）。
    // そのため「縮めました」も「推定で埋めました」も、画面には1行も出ていなかった
    // ——**黙って縮めると、次に比べたときの差が説明できない。**
    const doc = fakeDocument();
    const panel = createUnbakePanel(container(doc), {
        mode: 'sidebar', width: 1200,
        display: { replayMaxMegapixels: 4.5 },
        makeSweepRunner: () => ({
            inputsReady: Promise.resolve(),
            requireEmptyQueue: async () => {},
            preflight: () => ({ cells: [
                { workflow: { prompt: {}, warnings: ['縮めました 2560x3712 → 1760x2552', '同じ文'] } },
                { workflow: { prompt: {}, warnings: ['同じ文'] } },
            ] }),
            run: async () => ({ cells: [] }),
        }),
    });
    panel.setRecords([{ id: 'a', title: 'A', recipe: { id: 'a', gen_params: { seed: 1 } } }]);
    const log = find(panel.root, n => String(n.className).includes('unbake-log'));
    const before = log.children.length;
    find(panel.root, n => String(n.className).includes('unbake-act-replay')).dispatch('click', {});
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));

    const lines = log.children.slice(before).map(node => String(node.textContent || ''));
    assert.ok(lines.some(text => text.includes('1760x2552')),
        `縮めたことを言っていない: ${JSON.stringify(lines)}`);
    // **同じ文は1回だけ。** 升目の数だけ並ぶと、読む気が失せる。
    assert.equal(lines.filter(text => text.includes('同じ文')).length, 1,
        `同じ注意が繰り返し出ている: ${JSON.stringify(lines)}`);
});

test('止まり得る形は、投げる前に聞く', async () => {
    // **押した本人が知らないまま止まるのが一番困る**（2026-08-25 実機で踏んだ）。
    // 分割復号になる形は、実測で ComfyUI が復号の段から進まなくなる。
    const doc = fakeDocument();
    let submitted = 0;
    const panel = createUnbakePanel(container(doc), {
        mode: 'sidebar', width: 1200,
        // 縮める上限は切ってある（＝記録どおりに回す人）。
        display: { replayMaxMegapixels: 0 },
        makeSweepRunner: () => ({
            inputsReady: Promise.resolve(),
            requireEmptyQueue: async () => {},
            preflight: () => ({ cells: [{ workflow: { prompt: PROMPT } }] }),
            run: async () => { submitted += 1; return { cells: [] }; },
        }),
    });
    panel.setRecords([{ id: 'a', title: 'A', recipe: { id: 'a', gen_params: { seed: 1 } } }]);
    const button = find(panel.root, n => String(n.className).includes('unbake-act-replay'));
    button.dispatch('click', {});
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    // **聞くまでは投げない。**
    assert.equal(submitted, 0, '聞かずに投げている');
    const confirm = find(panel.root, n => String(n.className).includes('unbake-confirm'));
    assert.ok(confirm, '確認を出していない');
});

test('縮める上限が入っていれば、聞かずに投げる', async () => {
    // 縮める設定が入っていれば、そもそも分割にならない。**余計に聞かない。**
    const doc = fakeDocument();
    let submitted = 0;
    const panel = createUnbakePanel(container(doc), {
        mode: 'sidebar', width: 1200,
        display: { replayMaxMegapixels: 4.5 },
        makeSweepRunner: () => ({
            inputsReady: Promise.resolve(),
            requireEmptyQueue: async () => {},
            preflight: () => ({ cells: [{ workflow: { prompt: PROMPT } }] }),
            run: async () => { submitted += 1; return { cells: [] }; },
        }),
    });
    panel.setRecords([{ id: 'a', title: 'A', recipe: { id: 'a', gen_params: { seed: 1 } } }]);
    const button = find(panel.root, n => String(n.className).includes('unbake-act-replay'));
    button.dispatch('click', {});
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    assert.equal(submitted, 1, '上限が入っているのに聞いている');
});

test('宿主が生成中でも、既に出ている絵は待たずに開く', async () => {
    // **利用者の要望**（2026-08-25）。生成が走っている間でも、
    // 別の記録の「出た絵」を見比べられること。
    // その回はキューへ1件も投げないので、宿主の混み具合は関係が無い。
    const doc = fakeDocument();
    let opened = 0;
    const panel = createUnbakePanel(container(doc), {
        mode: 'sidebar', width: 1200,
        // 宿主はずっと混んでいる。
        hostQueue: async () => ({ running: 1, pending: 0 }),
        makeSweepRunner: () => ({
            inputsReady: Promise.resolve(),
            requireEmptyQueue: async () => {},
            // 投げる分が無いので断らない（本物の実行器と同じ）。
            run: async () => { opened += 1; return { cells: [] }; },
        }),
    });
    panel.setRecords([{ id: 'a', title: 'A', recipe: { id: 'a', gen_params: { seed: 1 } } }]);
    const button = find(panel.root, n => String(n.className).includes('unbake-act-replay'));
    button.dispatch('click', {});
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    assert.equal(opened, 1, '混んでいるだけで、開くのを待たせている');
    assert.notEqual(button.getAttribute('data-held'), 'true', '待ちの姿のまま止まっている');
});

test('断られて待っている間でも、押せば取り消せる', async () => {
    const doc = fakeDocument();
    let starts = 0;
    const panel = createUnbakePanel(container(doc), {
        mode: 'sidebar', width: 1200,
        hostQueue: async () => ({ running: 1, pending: 0 }),
        makeSweepRunner: () => { starts += 1; return {
            inputsReady: Promise.resolve(),
            requireEmptyQueue: async () => {},
            run: async () => {
                const error = new Error('busy');
                error.code = 'queue_not_empty';
                throw error;
            },
        }; },
    });
    panel.setRecords([{ id: 'a', title: 'A', recipe: { id: 'a', gen_params: { seed: 1 } } }]);
    const button = find(panel.root, n => String(n.className).includes('unbake-act-replay'));
    button.dispatch('click', {});
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    assert.equal(button.getAttribute('data-held'), 'true', '待っていない');
    button.dispatch('click', {});
    await new Promise((r) => setTimeout(r, 1700));
    assert.notEqual(button.getAttribute('data-held'), 'true', '取り消せない');
    assert.equal(starts, 1, '取り消したのに投げ直している');
});

test('宿主のキューが読めないときは、待たずに進む', async () => {
    // **読めないことを「混んでいる」と読まない。** 口が1つ落ちただけで
    // 再現が永久に始まらなくなる（断るなら実行器が改めて断る）。
    const doc = fakeDocument();
    let starts = 0;
    const panel = createUnbakePanel(container(doc), {
        mode: 'sidebar', width: 1200,
        hostQueue: async () => { throw new Error('boom'); },
        makeSweepRunner: () => { starts += 1; return {
            inputsReady: Promise.resolve(),
            requireEmptyQueue: async () => {},
            run: async () => ({ cells: [] }),
        }; },
    });
    panel.setRecords([{ id: 'a', title: 'A', recipe: { id: 'a', gen_params: { seed: 1 } } }]);
    const button = find(panel.root, n => String(n.className).includes('unbake-act-replay'));
    button.dispatch('click', {});
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    assert.equal(starts, 1, 'キューが読めないだけで止まっている');
});

test('待っている印をもう一度押すと、順番待ちをやめる', async () => {
    // **並べたのは自分なので、気が変わったら外せる**（2026-08-24 利用者の指示）。
    const doc = fakeDocument();
    let release;
    let finished = false;
    const held = new Promise((r) => { release = r; });
    let ran = 0;
    let starts = 0;
    const panel = createUnbakePanel(container(doc), {
        // **器を名指しする**（2026-08-28）。既定がタイルへ変わったので、
        // 表の行を数える検査は自分で表を選ぶ。測っている中身は変えていない。
        display: { listView: 'table' },
        mode: 'sidebar', width: 1200,
        makeSweepRunner: () => { starts += 1; return {
            inputsReady: Promise.resolve(),
            requireEmptyQueue: async () => {},
            // 走っている間は断る（本物の実行器と同じ形）。
            run: async () => {
                if (starts > 1 && !finished) {
                    const error = new Error('busy');
                    error.code = 'queue_not_empty';
                    throw error;
                }
                await held;
                finished = true;
                ran += 1;
                return { cells: [] };
            },
        }; },
    });
    panel.setRecords([
        { id: 'a', title: 'A', recipe: { id: 'a', gen_params: { seed: 1 } } },
        { id: 'b', title: 'B', recipe: { id: 'b', gen_params: { seed: 2 } } },
    ]);
    const buttons = walk(panel.root)
        .filter(n => String(n.className).includes('unbake-act-replay'));
    buttons[0].dispatch('click', {});
    await new Promise((r) => setTimeout(r, 0));

    buttons[1].dispatch('click', {});
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
    assert.equal(buttons[1].getAttribute('data-held'), 'true', '順番待ちになっていない');

    // **もう一度押したら、並びから外れて元の姿へ戻る。**
    buttons[1].dispatch('click', {});
    await new Promise((r) => setTimeout(r, 0));
    assert.notEqual(buttons[1].getAttribute('data-held'), 'true', 'もう一度押しても待ったまま');
    assert.equal(buttons[1].disabled, false, '外したのに押せないまま');

    release();
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    // **外したものは走らない。** 走ってしまうなら「やめた」と言いながら絵が出る。
    assert.equal(ran, 1, '順番待ちをやめたのに走っている');
});

test('前が失敗しても、次の順番待ちが始まる', async () => {
    // **行列は必ず前へ進むこと。** 進まないと、以降の押下が永久に待ちのまま残る
    // （2026-08-24 実機「2件目以降が待ちになるが1件目が始まらない」）。
    // 2件目は**再現の口が自分で握り潰せない場所で壊す**——流し役の受けが要る。
    const doc = fakeDocument();
    let release;
    let boom = false;
    const held = new Promise((r) => { release = r; });
    let starts = 0;
    const panel = createUnbakePanel(container(doc), {
        // **器を名指しする**（2026-08-28）。既定がタイルへ変わったので、
        // 表の行を数える検査は自分で表を選ぶ。測っている中身は変えていない。
        display: { listView: 'table' },
        mode: 'sidebar', width: 1200,
        makeSweepRunner: () => { starts += 1; return {
            inputsReady: Promise.resolve(),
            requireEmptyQueue: async () => {},
            run: async () => { await held; return { cells: [] }; },
        }; },
    });
    panel.setRecords([
        { id: 'a', title: 'A', recipe: { id: 'a', gen_params: { seed: 1 } } },
        // **描くときには壊れていない。** 押した後にだけ壊す
        // （描画時に投げると、そもそもボタンが出ない）。
        { id: 'b', title: 'B', recipe: { id: 'b', get gen_params() {
            if (boom) throw new Error('boom');
            return { seed: 2 };
        } } },
        { id: 'c', title: 'C', recipe: { id: 'c', gen_params: { seed: 3 } } },
    ]);
    const buttons = walk(panel.root)
        .filter(n => String(n.className).includes('unbake-act-replay'));
    assert.equal(buttons.length, 3, '再現のボタンが3つ無い');
    buttons[0].dispatch('click', {});
    await new Promise((r) => setTimeout(r, 0));
    boom = true;
    buttons[1].dispatch('click', {});
    buttons[2].dispatch('click', {});
    await new Promise((r) => setTimeout(r, 0));
    release();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    // 壊れた2件目では実行器まで届かないので、走るのは1件目と3件目の2つ。
    assert.equal(starts, 2, '途中で壊れたら行列が止まっている');
    assert.equal(buttons[1].disabled, false, '壊れた方が押せないまま固まっている');
    assert.notEqual(buttons[2].getAttribute('data-held'), 'true', '3件目が待ちのまま残っている');
});

test('同じ記録を二重に並べない（押し直しても順番は早まらない）', async () => {
    const doc = fakeDocument();
    let release;
    const held = new Promise((r) => { release = r; });
    let starts = 0;
    const panel = createUnbakePanel(container(doc), {
        // **器を名指しする**（2026-08-28）。既定がタイルへ変わったので、
        // 表の行を数える検査は自分で表を選ぶ。測っている中身は変えていない。
        display: { listView: 'table' },
        mode: 'sidebar', width: 1200,
        makeSweepRunner: () => { starts += 1; return {
            inputsReady: Promise.resolve(),
            requireEmptyQueue: async () => {},
            run: async () => { await held; return { cells: [] }; },
        }; },
    });
    panel.setRecords([
        { id: 'a', title: 'A', recipe: { id: 'a', gen_params: { seed: 1 } } },
        { id: 'b', title: 'B', recipe: { id: 'b', gen_params: { seed: 2 } } },
    ]);
    const buttons = walk(panel.root)
        .filter(n => String(n.className).includes('unbake-act-replay'));
    buttons[0].dispatch('click', {});
    await new Promise((r) => setTimeout(r, 0));
    // 並べる → やめる → 並べる。**奇数回なら1件だけ並んでいる。**
    buttons[1].dispatch('click', {});
    buttons[1].dispatch('click', {});
    buttons[1].dispatch('click', {});
    await new Promise((r) => setTimeout(r, 0));
    release();
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
    // **並べたぶんだけ回る**ので、二重に並べると同じ絵を2回出すだけになる。
    assert.equal(starts, 2, '同じ記録を二重に並べている');
});

test('ほかの理由の失敗は、止まった印にしない', async () => {
    const doc = fakeDocument();
    const panel = createUnbakePanel(container(doc), {
        mode: 'sidebar', width: 1200,
        makeSweepRunner: () => ({
            inputsReady: Promise.resolve(),
            requireEmptyQueue: async () => {},
            run: async () => { throw new Error('boom'); },
        }),
    });
    panel.setRecords([{ id: 'a', title: 'A', recipe: { id: 'a', gen_params: { seed: 1 } } }]);
    const button = find(panel.root, n => String(n.className).includes('unbake-act-replay'));
    button.dispatch('click', {});
    await new Promise((r) => setTimeout(r, 0));
    // **「待てば通る」と「壊れている」を混ぜない。** 混ぜると、待っても直らないものを待つ。
    assert.notEqual(button.getAttribute('data-held'), 'true', 'ただの失敗まで止まった印にしている');
});

test('走っている間は二度押しを受け付けない', async () => {
    const doc = fakeDocument();
    let starts = 0;
    let release;
    const held = new Promise((r) => { release = r; });
    const panel = createUnbakePanel(container(doc), {
        // **器を名指しする**（2026-08-28）。既定がタイルへ変わったので、
        // 表の行を数える検査は自分で表を選ぶ。測っている中身は変えていない。
        display: { listView: 'table' },
        mode: 'sidebar', width: 1200,
        makeSweepRunner: () => { starts += 1; return {
            inputsReady: held,
            requireEmptyQueue: async () => {},
            run: async () => ({ cells: [] }),
        }; },
    });
    panel.setRecords([{ id: 'a', title: 'A', recipe: { id: 'a', gen_params: { seed: 1 } } }]);
    const button = find(panel.root, n => String(n.className).includes('unbake-act-replay'));

    button.dispatch('click', {});
    await Promise.resolve();
    button.dispatch('click', {});
    await Promise.resolve();
    // **2件目は自分の1件目に当たって「キューが空でない」で落ちる。**
    // 他人の生成が居るように見えるので、押させない。
    assert.equal(starts, 1, '走っている最中にもう1件始めている');
    release();
});

test('投稿 URL は「判らなかった」で終わらせず、打つ手を出す', async () => {
    const doc = fakeDocument();
    const seen = [];
    const panel = createUnbakePanel(container(doc), {
        mode: 'sidebar', width: 1200,
        ingest: async (routed) => { seen.push(routed.route); return { records: [], errors: [] }; },
    });
    const transfer = (map = {}, files = []) => ({ getData: (t) => map[t] || '', files });

    const routed = await panel.handleDrop(transfer({ 'text/uri-list': 'https://civitai.com/posts/30572284' }));
    assert.equal(routed?.route, DROP_ROUTES.UNSUPPORTED);
    // **扱えないものを取り込まない。** 取り込むと空の記録が1件増える。
    assert.deepEqual(seen, [], '扱えないものを取り込んでいる');

    const log = find(panel.root, n => n.className === 'unbake-log');
    assert.equal(log.children.length, 1, '記録が1行だけ残っていない');
    const text = String(log.children[0].textContent || '');
    // **汎用の「特定できませんでした」で終わらせない。** 投稿番号と、次に何をすればよいかを出す。
    assert.match(text, /30572284/, '投稿番号を出していない');
    assert.match(text, /\/images\//, '次に落とすべき形を出していない');
});

// --- 自分の中から始まった引きずり（2026-08-24 実機報告）--------------------
//
// **記録をつまむと受け口が開き、離すと同じ記録がもう1件増えていた。**
// 記録のタイルの `<img>` はブラウザの既定で引きずれるので、つまむと
// `dataTransfer` に絵の URL が入り、**外から URL を落とされたのと区別が付かない**。

/** 引きずりの出来事を1つ作る。`prevented` で「落として良い」と言ったかを見る。 */
function dragEvent(map = {}, files = []) {
    const event = {
        prevented: false,
        preventDefault() { this.prevented = true; },
        dataTransfer: { getData: (type) => map[type] || '', files },
    };
    return event;
}

test('面の中からの引きずりでは、受け口を開かない', async () => {
    const doc = fakeDocument();
    const panel = createUnbakePanel(container(doc), {
        mode: 'sidebar', width: 1200,
        ingest: async () => ({ records: [], errors: [] }),
    });
    const dropzone = find(panel.root, n => n.className === 'unbake-dropzone');

    await panel.root.dispatch('dragstart', dragEvent());
    const over = dragEvent();
    await panel.root.dispatch('dragenter', dragEvent());
    await panel.root.dispatch('dragover', over);

    // **`preventDefault()` を呼ばないことが「受け取らない」の意思表示。**
    // 呼んでしまうとブラウザは落とせると判断し、`drop` まで飛ばす。
    assert.equal(over.prevented, false, '自分の引きずりを受け取ると言っている');
    assert.equal(dropzone.getAttribute('data-active'), 'false', '受け口が開いている');
});

test('面の中からの引きずりを離しても、取り込まない（記録が複製されない）', async () => {
    const doc = fakeDocument();
    const seen = [];
    const panel = createUnbakePanel(container(doc), {
        mode: 'sidebar', width: 1200,
        ingest: async (routed) => { seen.push(routed.route); return { records: [], errors: [] }; },
    });
    const url = { 'text/uri-list': 'https://civitai.red/images/18176508' };

    await panel.root.dispatch('dragstart', dragEvent());
    await panel.root.dispatch('drop', dragEvent(url));
    // **ここが実害だった。** 1件でも入ると、つまむたびに記録が増える。
    assert.deepEqual(seen, [], '自分の引きずりを取り込んでいる');

    // **外からの落とし込みは殺さない。** 引きずりが終われば元どおり受け取る。
    await panel.root.dispatch('dragend', dragEvent());
    const over = dragEvent();
    await panel.root.dispatch('dragover', over);
    assert.equal(over.prevented, true, '引きずり終了後に受け取らなくなっている');
    await panel.root.dispatch('drop', dragEvent(url));
    assert.deepEqual(seen, [DROP_ROUTES.CIVITAI], '外からの落とし込みまで塞いでいる');
});

test('絵を引きずれること自体は残す（持ち出しを奪わない）', () => {
    // **バグを直すために機能を削らない。** `draggable="false"` で塞ぐと
    // 記録の絵を別のアプリへ持ち出せなくなる。塞ぐのは受け取る側だけ。
    const doc = fakeDocument();
    const panel = createUnbakePanel(container(doc), { mode: 'sidebar', width: 1200 });
    panel.setRecords([{ id: 'a', title: 'A', preview: 'x.png', verdict: 'reproducible' }]);
    const blocked = find(panel.root, n => String(n.getAttribute?.('draggable')) === 'false');
    assert.equal(blocked, null, '引きずりを禁止して持ち出しを奪っている');
});

test('判定は色帯で示し、判定済みを薄くしない', () => {
    // 判定対象を劣化させると見直せなくなる。**表示の劣化ではなく帯で区別する。**
    const doc = fakeDocument();
    // **表の行を見る検査は、表示を明示する**（2026-08-28 F2 で、
    // タイル表示のときは隠れた表を組まなくなった。既定はタイル）。
    const panel = createUnbakePanel(container(doc), { mode: 'sidebar', display: { listView: 'table' } });
    panel.setRecords([
        { id: 'a', verdict: 'reproducible' },
        { id: 'b', verdict: 'approximate' },
        { id: 'c', verdict: 'blocked' },
    ]);
    const badges = walk(panel.root).filter(n => n.className === 'unbake-verdict');
    assert.deepEqual(badges.map(n => n.getAttribute('data-verdict')),
        ['reproducible', 'approximate', 'blocked']);
    const dimmed = badges.filter(n => n.style.opacity !== undefined && n.style.opacity !== '');
    assert.deepEqual(dimmed, [], '判定済みを薄くしている');
});

test('destroy で購読も要素も残らない', () => {
    const doc = fakeDocument();
    const el = container(doc);
    const panel = createUnbakePanel(el, { mode: 'sidebar' });
    // **受け口は面そのもの**（2026-08-23 に広げた）。帯だけを狙わせると、
    // そのために常に場所を取ることになる——器の中はほとんど一覧なので、
    // 落とす先として自然なのは一覧の側。
    assert.equal(panel.root.listeners.drop.length, 1, '面が落とし込みを受けていない');
    assert.ok(find(panel.root, n => n.className === 'unbake-dropzone'), '案内の帯が無い');
    panel.destroy();
    assert.equal(panel.root.listeners.drop.length, 0, '購読が残っている');
    assert.equal(el.children.includes(panel.root), false);
});
