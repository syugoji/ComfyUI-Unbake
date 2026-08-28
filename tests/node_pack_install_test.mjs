/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **足りないノードパックを Manager に入れてもらう**（2026-08-28 利用者の指示）。
 *
 * **API の形は版で違う。** 両方の実物を読んで合わせた:
 *
 *     3.41（ポータブル）  /api/customnode/getmappings   /api/manager/queue/install（平ら）
 *     4.2.2（Desktop）    /api/v2/customnode/getmappings /api/v2/manager/queue/task（kind+params）
 *
 * **地図はこちらで持たない。** `getmappings` の鍵はそのままパックの id で、
 * 実測では 5,590 件あった（`comfyui_smznodes` / `comfyui-impact-pack`）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectManager, packsForNodes, installPacks } from '../web/core/nodePackInstall.js';

/** 実物の `getmappings` と同じ形（鍵＝パック id、値＝[ノード名, {title_aux}]）。 */
const MAP = {
    comfyui_smznodes: [['smZ CLIPTextEncode', 'smZ Settings'], { title_aux: 'smZNodes' }],
    'comfyui-impact-pack': [['FaceDetailer', 'DetailerForEach'], { title_aux: 'ComfyUI Impact Pack' }],
    'comfyui-impact-subpack': [['UltralyticsDetectorProvider'], { title_aux: 'Impact Subpack' }],
    unrelated: [['SomethingElse'], { title_aux: 'Unrelated' }],
};

/**
 * 偽の宿主。`have` に居る道だけが 200 を返す。
 *
 * @param {{have: Set<string>, calls: object[]}} state
 */
function fakeHost(have, calls = []) {
    return async (path, options = {}) => {
        calls.push({ path, method: options.method || 'GET', body: options.body });
        if (!have.has(path.split('?')[0])) return { ok: false, status: 404 };
        if (path.includes('getmappings')) return { ok: true, status: 200, json: async () => MAP };
        if (path.includes('/version')) return { ok: true, status: 200, text: async () => 'V4.2.2' };
        return { ok: true, status: 200 };
    };
}

const V2 = new Set([
    '/api/v2/manager/version', '/api/v2/customnode/getmappings',
    '/api/v2/manager/queue/task', '/api/v2/manager/queue/start',
]);
const V1 = new Set([
    '/api/manager/version', '/api/customnode/getmappings',
    '/api/manager/queue/install', '/api/manager/queue/start',
]);

// --- どちらの Manager かを見分ける ------------------------------------------

test('4.x が居れば v2 を選ぶ', async () => {
    const found = await detectManager(fakeHost(V2));
    assert.equal(found?.api, 'v2');
});

test('3.x しか居なければ v1 へ落ちる', async () => {
    // **新しい方から順に見て、無ければ次。** 片方が無いのは失敗ではない。
    const found = await detectManager(fakeHost(V1));
    assert.equal(found?.api, 'v1');
});

test('どちらも居なければ null（黙って諦める）', async () => {
    const found = await detectManager(fakeHost(new Set()));
    assert.equal(found, null);
});

test('版を見に行くだけで、勝手に何も入れない', async () => {
    const calls = [];
    await detectManager(fakeHost(V1, calls));
    assert.ok(calls.every(c => c.method === 'GET'), `POST している: ${JSON.stringify(calls)}`);
});

// --- ノード名からパックを引く ------------------------------------------------

test('ノード名から、入れるべきパックを引く', async () => {
    const packs = await packsForNodes(fakeHost(V2), 'v2', ['smZ CLIPTextEncode']);
    assert.deepEqual(packs.map(p => p.id), ['comfyui_smznodes']);
    assert.equal(packs[0].title, 'smZNodes', '題を拾えていない（画面に id しか出せない）');
});

test('複数のパックに散っていても、まとめて引く', async () => {
    const packs = await packsForNodes(fakeHost(V2), 'v2',
        ['FaceDetailer', 'UltralyticsDetectorProvider', 'smZ CLIPTextEncode']);
    assert.deepEqual(packs.map(p => p.id).sort(),
        ['comfyui-impact-pack', 'comfyui-impact-subpack', 'comfyui_smznodes']);
});

test('同じパックの中に2つ在っても、パックは1つに畳む', async () => {
    const packs = await packsForNodes(fakeHost(V2), 'v2', ['FaceDetailer', 'DetailerForEach']);
    assert.equal(packs.length, 1);
    assert.deepEqual(packs[0].nodes.sort(), ['DetailerForEach', 'FaceDetailer']);
});

test('ノードが空なら、地図すら引きに行かない', async () => {
    // **要らない問い合わせをしない。** 印が出ていない記録でも呼ばれうる。
    const calls = [];
    const packs = await packsForNodes(fakeHost(V2, calls), 'v2', []);
    assert.deepEqual(packs, []);
    assert.equal(calls.length, 0, '空なのに地図を引きに行っている');
});

test('地図に無いノードは黙って落とす', async () => {
    /*
     * **推測で名前を出さない。** 出すと「入れても直らない物」を入れさせる
     * ——この面が前から持っている決めごと。
     */
    const packs = await packsForNodes(fakeHost(V2), 'v2', ['NobodyKnowsThisNode']);
    assert.deepEqual(packs, []);
});

test('v1 でも同じ地図を引ける（道だけが違う）', async () => {
    const calls = [];
    const packs = await packsForNodes(fakeHost(V1, calls), 'v1', ['smZ CLIPTextEncode']);
    assert.deepEqual(packs.map(p => p.id), ['comfyui_smznodes']);
    assert.ok(calls.some(c => c.path.startsWith('/api/customnode/getmappings')),
        `v1 の道を叩いていない: ${JSON.stringify(calls.map(c => c.path))}`);
});

// --- 入れてもらう -------------------------------------------------------------

const packOf = (id) => ({ id, title: id, nodes: ['X'] });

test('v2 は kind と params の形で投げる', async () => {
    const calls = [];
    const result = await installPacks(fakeHost(V2, calls), 'v2', [packOf('comfyui_smznodes')],
        { clientId: 'cid', uuid: () => 'u1' });
    assert.deepEqual(result.queued, ['comfyui_smznodes']);
    const post = calls.find(c => c.path === '/api/v2/manager/queue/task');
    assert.ok(post, `v2 の道へ投げていない: ${JSON.stringify(calls.map(c => c.path))}`);
    const body = JSON.parse(post.body);
    assert.equal(body.kind, 'install');
    assert.equal(body.client_id, 'cid', 'client_id は 4.x の必須項目');
    assert.equal(body.params.id, 'comfyui_smznodes');
    assert.ok(body.params.selected_version, 'どの版かを言っていない');
});

test('v1 は平らな本体で投げる', async () => {
    const calls = [];
    const result = await installPacks(fakeHost(V1, calls), 'v1', [packOf('comfyui_smznodes')],
        { uuid: () => 'u1' });
    assert.deepEqual(result.queued, ['comfyui_smznodes']);
    const post = calls.find(c => c.path === '/api/manager/queue/install');
    assert.ok(post, `v1 の道へ投げていない: ${JSON.stringify(calls.map(c => c.path))}`);
    const body = JSON.parse(post.body);
    assert.equal(body.id, 'comfyui_smznodes');
    assert.equal(body.kind, undefined, 'v1 に kind は無い（3.41 の実物に合わせる）');
});

test('入れたら行列を起こす（入れただけでは走らない）', async () => {
    for (const [api, have, start] of [['v2', V2, '/api/v2/manager/queue/start'], ['v1', V1, '/api/manager/queue/start']]) {
        const calls = [];
        await installPacks(fakeHost(have, calls), api, [packOf('x')], { uuid: () => 'u' });
        assert.ok(calls.some(c => c.path === start && c.method === 'POST'),
            `${api}: 行列を起こしていない`);
    }
});

test('1件失敗しても、残りは投げる', async () => {
    // **止めると「何件入ったのか」が判らないまま終わる。**
    const calls = [];
    const host = async (path, options = {}) => {
        calls.push({ path, body: options.body });
        if (path === '/api/v2/manager/queue/task' && String(options.body).includes('bad')) {
            return { ok: false, status: 500 };
        }
        return { ok: true, status: 200 };
    };
    const result = await installPacks(host, 'v2', [packOf('bad'), packOf('good')], { uuid: () => 'u' });
    assert.deepEqual(result.queued, ['good']);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].id, 'bad');
});

test('何も渡さなければ、行列も起こさない', async () => {
    const calls = [];
    const result = await installPacks(fakeHost(V2, calls), 'v2', [], {});
    assert.deepEqual(result.queued, []);
    assert.equal(calls.length, 0, '空なのに宿主を触っている');
});

// --- 面へ繋がっているか（鎖を1本ずつ見る）------------------------------------

test('宿主が口を渡しており、輸入も通っている', async () => {
    /*
     * **読み込めるだけでは足りない。** `environmentRequestOrNull` は
     * `unbake.js` のどこからも輸入されていないのに 389 行目が呼んでいた
     * ——**その道を踏むまで判らない ReferenceError** が埋まっていた。
     * 同じ轍を踏まないよう、輸出と輸入の両方をここで見る。
     */
    const env = await import('../web/core/environment.js');
    assert.equal(typeof env.environmentRequestOrNull, 'function', '輸出が無い');
    const source = await (await import('node:fs/promises'))
        .readFile(new URL('../web/unbake.js', import.meta.url), 'utf8');
    assert.match(source, /import \{ environmentRequestOrNull \} from '\.\/core\/environment\.js';/,
        '宿主が輸入していない（呼んだ時に ReferenceError で落ちる）');
    assert.match(source, /nodePackIo:/, '面へ口を渡していない');
});

const mountPanel = async (nodes, io = {}) => {
    const { createUnbakePanel } = await import('../web/panel/panel.js');
    const { fakeDocument } = await import('./fake_dom.mjs');
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc, display: { listView: 'tiles' },
        nodePackIo: {
            detect: async () => null, packsFor: async () => [],
            install: async () => ({ queued: [], failed: [] }), ...io,
        },
    });
    panel.setRecords([{
        id: '1', libraryId: '1', title: 'T', verdict: 'approximate',
        missing: { models: [], resources: [], nodes },
    }]);
    return panel;
};

const menuLabels = (panel) => panel.root.allByClass('unbake-context-item').map(n => String(n.textContent || ''));

test('「ダウンロード」の品書きから、ノードの行が Manager を探しに行く', async () => {
    /*
     * **口は1つ、中で分ける**（2026-08-28 利用者の指示）。3つ並べると
     * 帯の高さは 幅352px で 136.8px（3行）だった——実測して1行へ畳んだ。
     *
     * **文字列で見張らない。** 押して、外へ出たかを見る。
     */
    const asked = [];
    const panel = await mountPanel(['smZ CLIPTextEncode'],
        { detect: async () => { asked.push('detect'); return null; } });
    const parent = panel.root.find(node => String(node.className || '').includes('unbake-download-missing'));
    assert.ok(parent, '帯に「ダウンロード」が無い');
    assert.notEqual(parent.style?.display, 'none', '足りない物が在るのに出ていない');
    parent.dispatch('click', {});
    const labels = menuLabels(panel);
    assert.ok(labels.some(text => text.includes('⊞')), `ノードの行が無い: ${labels.join(' / ')}`);
    panel.root.allByClass('unbake-context-item')
        .find(node => String(node.textContent || '').includes('⊞')).dispatch('click', {});
    for (let i = 0; i < 8; i += 1) await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(asked, ['detect'], '押しても Manager を探しに行っていない');
});

test('足りない物が無ければ、口ごと出さない', async () => {
    // **圧迫感への答えは「小さくする」ではなく「出さない」**（利用者の指示）。
    const panel = await mountPanel([]);
    const parent = panel.root.find(node => String(node.className || '').includes('unbake-download-missing'));
    assert.ok(parent, '口そのものが無い（描き直しで戻せなくなる）');
    assert.equal(parent.style?.display, 'none', '当てはまらないのに場所を取っている');
});

test('当てはまらない行は、品書きにも出さない', async () => {
    // 押せるのに何も起きない行を作らない。
    const panel = await mountPanel(['smZ CLIPTextEncode']);
    panel.root.find(node => String(node.className || '').includes('unbake-download-missing')).dispatch('click', {});
    const labels = menuLabels(panel);
    assert.ok(!labels.some(text => text.includes('⤓⊞')),
        `モデルが要らないのに「両方」が出ている: ${labels.join(' / ')}`);
});

test('タイルの ⊞ は押せる口にしない（触れると消えるため）', async () => {
    const source = await (await import('node:fs/promises'))
        .readFile(new URL('../web/panel/panel.js', import.meta.url), 'utf8');
    const at = source.indexOf("'data-mark': 'needs-node'");
    assert.notEqual(at, -1, '印が見つからない');
    const around = source.slice(at - 700, at + 400);
    assert.doesNotMatch(around, /addEventListener\('click'/,
        'タイルの印に押し口を戻している（触れると消えるので届かない）');
});

test('親の口の語は、描き直した後も「ダウンロード（件数）」のまま', async () => {
    /*
     * **実機の報告**（2026-08-28）「全ての不足モデルをダウンロードしか出ていません」。
     *
     * 品書きへ畳んだとき、語を `render()` の中だけで書き換えた。ところが
     * **`downloadButtonText()` を呼んで書き戻す所が他に4つ**在り
     *（数え上げの終わり・構えの解除・選択の変化・描き直しの末尾）、
     * そちらが後から上書きして**モデルの語に戻っていた**。
     */
    const { setLocale: pick, t: tr } = await import('../web/i18n/index.js');
    pick('ja');
    const panel = await mountPanel(['smZ CLIPTextEncode']);
    const parent = panel.root.find(node => String(node.className || '').includes('unbake-download-missing'));
    assert.ok(parent, '親の口が無い');
    const text = String(parent.textContent || '');
    assert.ok(text.startsWith(tr('download.menu')),
        `親の語が品書きの名前になっていない: ${text}`);
    assert.notEqual(text, tr('download.missing.all'), 'モデルの語に戻っている');
    assert.match(text, /1/, '件数が出ていない');
    pick('en');
});

// --- 品書きの畳み方と、2段の順番 ---------------------------------------------

const mountBoth = async (io = {}) => {
    const { createUnbakePanel } = await import('../web/panel/panel.js');
    const { fakeDocument } = await import('./fake_dom.mjs');
    const doc = fakeDocument();
    const calls = { install: [], plan: [], start: [] };
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc,
        display: { listView: 'tiles', confirmBeforeDelete: true },
        nodePackIo: {
            detect: async () => ({ api: 'v2', version: '4.2.2' }),
            packsFor: async () => [{ id: 'comfyui_smznodes', title: 'smZNodes', nodes: ['smZ CLIPTextEncode'] }],
            install: async (...args) => { calls.install.push(args); return { queued: ['comfyui_smznodes'], failed: [] }; },
        },
        downloadIo: {
            start: async (versionId) => { calls.start.push(versionId); return { ok: true }; },
            state: async () => ({}),
            plan: async (ids) => { calls.plan.push(ids); return { items: [] }; },
        },
        ...io,
    });
    panel.setRecords([{
        id: '1', libraryId: '1', title: 'T', verdict: 'blocked',
        missing: {
            models: [], nodes: ['smZ CLIPTextEncode'],
            resources: [{ type: 'lora', name: 'm1', versionId: '9001' }],
        },
    }]);
    return { panel, doc, calls };
};

const settle = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

test('「モデルとノード」は、ノードの面が閉じるまでモデルへ進まない', async () => {
    /*
     * **実機の報告**（2026-08-28）「ノードのインストール画面のすぐあとに
     * モデルのダウンロード画面が出て、モデルのダウンロードしかできない」。
     *
     * `askThen()` は返事を待たずに返る。`await` しても意味が無く、
     * **ノードの確認の上にモデルの確認が重なって**下が押せなくなっていた。
     */
    const { setLocale: pick, t: tr } = await import('../web/i18n/index.js');
    pick('ja');
    const { panel, calls } = await mountBoth();
    panel.root.byClass('unbake-download-missing').dispatch('click', {});
    const rows = panel.root.allByClass('unbake-context-item');
    const both = rows.find(node => String(node.textContent).includes('⤓⊞'));
    assert.ok(both, `「モデルとノード」の行が無い: ${rows.map(r => r.textContent).join(' / ')}`);
    both.dispatch('click', {});
    await settle(20);

    // **出ている面はノードの側。** モデルの面に差し替わっていたら、
    // ノードの確認は押せないまま消えている。
    const shown = panel.root.text;
    assert.ok(shown.includes(tr('nodes.install.title', { count: 1 })),
        `ノードの確認が出ていない（モデルに差し替わった）: ${shown.slice(-300)}`);
    assert.deepEqual(calls.plan, [], 'ノードの返事を待たずにモデルへ進んでいる');

    // **返事をしたら、続きが始まる。** 待たせるだけにすると、
    // 「モデルとノード」がノードだけの口になる。
    const go = panel.root.findAll(node => node.textContent === tr('nodes.install.go'))[0];
    assert.ok(go, `頼む口が無い: ${panel.root.text.slice(-200)}`);
    await go.dispatch('click', {});
    await settle(30);
    assert.equal(calls.install.length, 1, 'ノードを頼んでいない');
    // **入れたのに「消しました」と言わない。**
    assert.ok(!panel.root.text.includes(tr('confirm.done', { list: 'comfyui_smznodes' })),
        `入れる問いに消す側の語が出ている: ${panel.root.text.slice(-200)}`);
    /*
     * **済んだ後の出口が「やめる」のままではない**（2026-08-28 利用者の報告
     * 「ここから先に進めません」）。頼み終わった画面で押せる口が「やめる」
     * だけだと、押すと取り消されるようにしか読めない——実際には閉じるだけで、
     * ここでは**次の段（モデル）の始まり**でもある。
     */
    const ways = panel.root.findAll(node => node.tagName === 'BUTTON' && !node.disabled)
        .map(node => node.textContent);
    assert.ok(ways.includes(tr('confirm.close')),
        `済んだのに出口が「閉じる」になっていない: ${JSON.stringify(ways)}`);

    // 面を閉じて初めて、続き（モデル）が始まる。
    const close = panel.root.byClass('unbake-confirm-close');
    assert.ok(close, '閉じる口が無い');
    await close.dispatch('click', {});
    await settle(30);
    assert.ok(panel.root.text.includes(tr('download.scope', { count: 1, models: 1, blocked: 0 }))
        || calls.plan.length > 0,
        `ノードの後にモデルへ進んでいない: ${panel.root.text.slice(-300)}`);
    pick('en');
});

test('面の外（ComfyUI の背景）を押すと品書きが閉じ、聞き手も残らない', async () => {
    // **付けた聞き手を外す所まで見る。** 残ると、次に開いた品書きを
    // その場で閉じる形で表に出る。
    const { panel, doc } = await mountBoth();
    panel.root.byClass('unbake-download-missing').dispatch('click', {});
    assert.ok(panel.root.byClass('unbake-context'), '品書きが開いていない');
    assert.equal(doc.countListeners('click'), 1, '外を見る聞き手が付いていない');

    await doc.dispatch('click', {});
    assert.equal(panel.root.byClass('unbake-context'), null, '外を押しても閉じない');
    assert.equal(doc.countListeners('click'), 0, '閉じたのに聞き手が残っている');
});

test('品書きの中の押しは、外の聞き手まで届かない', async () => {
    // 届くと**開いた行を押した瞬間に閉じる**——行の処理が走る前に消える。
    const { panel, doc } = await mountBoth();
    panel.root.byClass('unbake-download-missing').dispatch('click', {});
    const menu = panel.root.byClass('unbake-context');
    let outside = 0;
    doc.addEventListener('click', () => { outside += 1; });
    await menu.dispatch('click', {});
    assert.equal(outside, 0, '品書きの中の押しが外まで上がっている');
});
