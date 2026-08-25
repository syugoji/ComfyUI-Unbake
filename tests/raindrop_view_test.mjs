/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 「あとで読む箱」の面（裁定⑦・手順19）。
 *
 * ここで押さえるのは、**黙って間違える**種類のことだけである。
 *
 * 1. 鍵が無い・届かない・0件 の3つが**別の文言**で出る
 *    （混ぜると「箱が空だ」と読まれて、鍵を入れる手が止まる）
 * 2. 取り込みが**落とし込みと同じ経路**を通る（2本目の取り込み器を作らない）
 * 3. **ドメインを落とさない**（実データの出典は 326/340 が `.red`）
 * 4. 取り込み済みを**もう一度取りに行かない**（書庫の分＋この回の分の両方）
 * 5. 見えている範囲を書く（「未取り込み0件」はこのページの話でしかない）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createUnbakePanel } from '../web/panel/panel.js';
import { fakeDocument } from './fake_dom.mjs';
import {
    civitaiTargetOf, createRaindropView, imageIdOfRecord, splitBookmarks,
} from '../web/panel/raindropView.js';

const doc = fakeDocument();

function bookmark(id, { domain = 'civitai.red', title = '' } = {}) {
    return {
        link: `https://${domain}/images/${id}`,
        title: title || `Image ${id}`,
        created: '2026-08-20T19:52:10.630Z',
        civitaiImageId: String(id),
    };
}

/** 面を1つ作って、最初の読み込みが終わるまで待つ。 */
async function open(options) {
    const view = createRaindropView({ documentRef: doc, ...options });
    await view.ready;
    return view;
}

// --- 振り分け -------------------------------------------------------------

test('ドメインを落とさない（`.red` を既定へ丸めない）', () => {
    assert.deepEqual(civitaiTargetOf(bookmark('139635147')), {
        id: '139635147', domain: 'civitai.red', source: 'page',
    });
    assert.equal(civitaiTargetOf(bookmark('137796075', { domain: 'civitai.com' })).domain, 'civitai.com');
});

test('Civitai 以外のブックマークを「取り込み済み」に混ぜない', () => {
    const items = [
        bookmark('1'),
        { link: 'https://example.com/note', title: 'not civitai', created: null, civitaiImageId: null },
        bookmark('2'),
    ];
    const split = splitBookmarks(items, ['2']);
    assert.equal(split.fresh.length, 1, '未取り込みは1件');
    assert.equal(split.imported.length, 1, '取り込み済みは1件');
    assert.equal(split.other.length, 1, 'Civitai 以外は別の山');
});

test('記録の出典から画像 ID を拾う（題や連番からは拾わない）', () => {
    assert.equal(imageIdOfRecord({ origin: { url: 'https://civitai.red/images/42' } }), '42');
    // 題は当てにならない。**出典が無ければ null**——推測で「取り込み済み」にすると、
    // 未取り込みが黙って消える。
    assert.equal(imageIdOfRecord({ title: 'Civitai_Recipe_42', origin: { url: null } }), null);
});

// --- 3つの「出ない」を分ける ----------------------------------------------

test('鍵が無いことを 0件 と混ぜない', async () => {
    const view = await open({
        list: async () => ({ ok: false, error: 'no-token', items: [], count: 0 }),
        importOne: async () => { throw new Error('取り込みへ進んではいけない'); },
    });
    const status = view.root.byClass('unbake-sweep-help');
    assert.match(status.textContent, /Raindrop/);
    assert.doesNotMatch(status.textContent, /0/, '「0件」と読める文言にしない');
});

test('届かなかったことを 0件 と混ぜない', async () => {
    const view = await open({
        list: async () => ({ ok: false, error: 'could not reach Raindrop', items: [] }),
        importOne: async () => ({ ok: true }),
    });
    assert.match(view.root.byClass('unbake-sweep-help').textContent, /could not reach Raindrop/);
});

test('本当に0件のときだけ「ブックマークが無い」と言う', async () => {
    const view = await open({
        list: async () => ({ ok: true, items: [], count: 0, perPage: 50, knownImageIds: [] }),
        importOne: async () => ({ ok: true }),
    });
    assert.match(view.root.text, /no bookmarks|ブックマーク/i);
});

test('例外を握り潰さない（呼び手が投げても面は開いたまま理由を出す）', async () => {
    const view = await open({
        list: async () => { throw new Error('boom'); },
        importOne: async () => ({ ok: true }),
    });
    assert.match(view.root.byClass('unbake-sweep-help').textContent, /boom/);
});

// --- 取り込み -------------------------------------------------------------

test('未取り込みだけを、落とし込みと同じ形で取り込む', async () => {
    const calls = [];
    const view = await open({
        list: async () => ({
            ok: true, perPage: 50, count: 3,
            items: [bookmark('11'), bookmark('12'), bookmark('13', { domain: 'civitai.com' })],
            // 書庫に在る分はサーバが返す。
            knownImageIds: ['12'],
        }),
        importOne: async (target) => { calls.push(target); return { ok: true, records: [{ id: target.id }] }; },
    });

    const result = await view.importFresh();
    assert.equal(result.added, 2);
    assert.deepEqual(calls.map(call => call.id), ['11', '13'], '取り込み済みを取りに行かない');
    // **ドメインをそのまま渡す。** 既定へ落とすと 94% が別ドメインへ行く。
    assert.deepEqual(calls.map(call => call.domain), ['civitai.red', 'civitai.com']);
    assert.deepEqual(calls.map(call => call.url), [
        'https://civitai.red/images/11', 'https://civitai.com/images/13',
    ]);
});

test('手元に在る記録も「取り込み済み」に数える（同じ回に2度取りに行かない）', async () => {
    const calls = [];
    const view = await open({
        list: async () => ({
            ok: true, perPage: 50, count: 2,
            items: [bookmark('21'), bookmark('22')],
            knownImageIds: [],
        }),
        // 落とし込みで既に手元へ入っている分。
        knownIdsOf: () => ['21'],
        importOne: async (target) => { calls.push(target.id); return { ok: true, records: [{}] }; },
    });
    await view.importFresh();
    assert.deepEqual(calls, ['22']);

    // 2回目は残っていない。**「無い」と言うだけで、空振りの通信をしない。**
    await view.importFresh();
    assert.deepEqual(calls, ['22'], '取り込んだ分をもう一度取りに行っている');
});

test('落ちた件は理由を1件ずつ出す（件数だけにしない）', async () => {
    const view = await open({
        list: async () => ({
            ok: true, perPage: 50, count: 2,
            items: [bookmark('31'), bookmark('32')],
            knownImageIds: [],
        }),
        importOne: async (target) => (target.id === '31'
            ? { ok: false, records: [], errors: ['404 のため取れない'] }
            : { ok: true, records: [{}] }),
    });
    const result = await view.importFresh();
    assert.equal(result.added, 1);
    assert.equal(result.failed, 1);
    const lines = view.root.allByClass('unbake-raindrop-log-line').map(node => node.textContent);
    assert.ok(lines.some(line => line.includes('31') && line.includes('404')),
        '落ちた1件の id と理由が画面に出ていない');
});

test('取り込みに失敗した件を「取り込み済み」にしない', async () => {
    const view = await open({
        list: async () => ({
            ok: true, perPage: 50, count: 1, items: [bookmark('41')], knownImageIds: [],
        }),
        importOne: async () => { throw new Error('通信断'); },
    });
    await view.importFresh();
    const split = splitBookmarks(view.last.items, []);
    assert.equal(split.fresh.length, 1);
    // 押し直せる状態のままであること（諦めた印を付けない）。
    assert.equal(view.root.byClass('unbake-raindrop-import').disabled, false);
});

// --- 範囲を隠さない -------------------------------------------------------

test('箱ごと読む（1ページで打ち切らない）', async () => {
    // **50件ずつでは「未取り込み0件」が*このページ*の話にしかならない。**
    // 箱全体を見渡せないと、残りを「もう取り込んだ」と読み違える
    // （2026-08-23 利用者の指示で、ページ送りをやめて箱ごと読むようにした）。
    const asked = [];
    const view = await open({
        list: async (options) => {
            asked.push(options);
            return {
                ok: true, perPage: 50, count: 346, all: true, truncated: false,
                items: [bookmark('51'), bookmark('52')], knownImageIds: ['51'],
            };
        },
        importOne: async () => ({ ok: true }),
    });
    assert.equal(asked.length, 1, '何度も取りに行っている');
    assert.equal(asked[0].all, true, '箱ごと読むよう頼んでいない（1ページで止まる）');
    // ページ送りは無い（意味が無くなった）。
    assert.deepEqual(view.root.allByClass('unbake-raindrop-page'), [],
        'ページ送りが残っている');
    const helps = view.root.allByClass('unbake-sweep-help').map(node => node.textContent).join(' ');
    assert.match(helps, /2/, '読めた件数を出していない');
});

test('途中で止めたら、そう書く（黙って切らない）', async () => {
    // **黙って切ると「これで全部」と読まれる**——箱に残っている分を
    // 「もう取り込んだ」と勘違いする。
    const view = await open({
        list: async () => ({
            ok: true, perPage: 50, count: 12000, all: true, truncated: true,
            items: [bookmark('71')], knownImageIds: [],
        }),
        importOne: async () => ({ ok: true }),
    });
    const helps = view.root.allByClass('unbake-sweep-help').map(node => node.textContent).join(' ');
    assert.match(helps, /12000/, '箱の総数を出していない');
    assert.match(helps, /1/, '読めた件数を出していない');
});

// --- 面ではなく「配線」を見る ----------------------------------------------

test('箱からの取り込みが、落とし込みと同じ ingest を通る（2本目の取り込み器を作らない）', async () => {
    const seen = [];
    const documentRef = fakeDocument();
    const panel = createUnbakePanel(documentRef.createElement('div'), {
        documentRef,
        ingest: async (routed) => {
            seen.push(routed);
            return { records: [{ id: routed.imageId, origin: { url: routed.url } }], errors: [] };
        },
        raindropIo: {
            list: async () => ({
                ok: true, perPage: 50, count: 1, items: [bookmark('71')], knownImageIds: [],
            }),
        },
    });

    const view = panel.openRaindrop();
    await view.ready;
    await view.importFresh();

    assert.equal(seen.length, 1, '取り込みが ingest を通っていない');
    assert.equal(seen[0].route, 'civitai', '落とし込みと同じ経路名で渡していない');
    assert.equal(seen[0].imageId, '71');
    assert.equal(seen[0].domain, 'civitai.red');
    assert.equal(seen[0].source, 'raindrop', 'どこから来たのかを残していない');

    // **面の中で終わらせない。** 取り込んだものは一覧に載る（落とし込みと同じ）。
    assert.equal(panel.getRecords().length, 1, '取り込んだ記録が一覧へ入っていない');

    // 開き直したら「取り込み済み」になる（手元の記録から数えている）。
    const again = panel.openRaindrop();
    await again.ready;
    assert.equal(again.root.byClass('unbake-raindrop-import').disabled, true);
});

test('口が渡されていなければ、あとで読む箱の入口を出さない', () => {
    const documentRef = fakeDocument();
    const panel = createUnbakePanel(documentRef.createElement('div'), { documentRef });
    assert.equal(panel.root.byClass('unbake-raindrop-open'), null,
        '押せないボタンを出している');
    assert.equal(panel.openRaindrop(), null);
});

test('あとで読む箱を開くと、一覧の上に2枚重ならない', async () => {
    const documentRef = fakeDocument();
    const panel = createUnbakePanel(documentRef.createElement('div'), {
        documentRef,
        settingsIo: { read: async () => ({ settings: {} }), write: async () => ({}) },
        raindropIo: { list: async () => ({ ok: true, perPage: 50, count: 0, items: [], knownImageIds: [] }) },
    });
    panel.openSettings();
    const view = panel.openRaindrop();
    await view.ready;
    assert.equal(panel.settingsView, null, '設定の面が開いたまま残っている');
    assert.ok(panel.raindropView, '箱の面が開いていない');
    panel.closeOverlays();
    assert.equal(panel.raindropView, null, '閉じても面が残っている');
});

// --- 表紙（2026-08-22 利用者の指摘）------------------------------------------

test('表紙が在れば絵を出し、無ければ枠ごと出さない', async () => {
    // **絵の話をしている面が字だけだと、取り込むまでどれか判らない。**
    // ただし表紙の無いブックマークもあるので、壊れた画像は並べない。
    const view = await open({
        list: async () => ({
            ok: true, count: 2, items: [
                { ...bookmark('1'), cover: 'https://x/a.jpg' },
                { ...bookmark('2'), cover: '' },
            ],
        }),
        importOne: async () => ({ ok: true }),
    });
    const rows = view.root.allByClass('unbake-raindrop-row');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].byClass('unbake-raindrop-thumb')?.getAttribute('src'), 'https://x/a.jpg');
    assert.equal(rows[1].byClass('unbake-raindrop-thumb'), null, '表紙が無いのに枠を出している');
});

test('一覧の器は巻き取れる（349件のうち後ろが届かない、を止める）', async () => {
    // **実機で踏んだ**（2026-08-25 利用者の指摘「スクロールが効かず、
    // 全ての件数を閲覧できません」）。角を丸く切るために `overflow: hidden` を
    // 置いていたが、**`overflow` を隠すと flex の最小の高さが 0 になる**——
    // 箱は余った高さまで縮み、中身（実測 10434px）は 648px に切り落とされ、
    // 外側からは「はみ出していない」と見えるので**どこにも巻き取りが出ない**。
    const { readFile } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const raw = await readFile(join(root, 'web/panel/theme.css'), 'utf8');
    // **コメントを外してから走査する。** 外さないと、規則を説明した文に
    // `overflow: hidden` と書いただけで赤くなる（この木で既に踏んでいる罠）。
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');

    const block = css.slice(css.indexOf('.unbake-raindrop-list {'));
    const body = block.slice(0, block.indexOf('}'));
    assert.ok(body.length > 0, '一覧の器の指定を読めない＝この検査が何も見ていない');
    // 切ってよいが、**巻き取れる切り方**であること。
    assert.match(body, /overflow-y:\s*auto/, '縦に巻き取れない（後ろの件数へ届かない）');
    assert.doesNotMatch(body, /overflow:\s*hidden/, '中身ごと切り落としている');
    // 縮んでよいことを明示していること（していないと操作帯を押し出す）。
    assert.match(body, /min-block-size:\s*0/, '縮み方を決めていない');
});

test('未取り込みが上に来て、群の切れ目が見出しで読める', async () => {
    // **並び自体は前からこの順**だったが、349件が同じ見た目で続くので
    // どこまでが未取り込みか目で追えなかった（2026-08-25 利用者の指示）。
    const view = await open({
        list: async () => ({
            ok: true, count: 3, items: [
                { ...bookmark('10'), cover: 'https://x/imported.jpg' },   // 取り込み済みにする
                { ...bookmark('20'), cover: 'https://x/fresh.jpg' },      // 未取り込み
                { link: 'https://example.com/other', title: 'other', created: 't', civitaiImageId: null, cover: 'https://x/other.jpg' },
            ],
        }),
        knownIdsOf: () => ['10'],
        importOne: async () => ({ ok: true }),
    });

    // 見出しの並び＝群の並び。
    const groups = view.root.allByClass('unbake-raindrop-group')
        .map(node => node.getAttribute('data-state'));
    assert.deepEqual(groups, ['fresh', 'imported', 'other'], '未取り込みが先頭でない');

    // 行の並びも同じ順（見出しだけ並べ替えても意味が無い）。
    const rows = view.root.allByClass('unbake-raindrop-row')
        .map(node => node.getAttribute('data-state'));
    assert.deepEqual(rows, ['fresh', 'imported', 'other']);

    // **絵は未取り込みだけ。** 取り込み済みは「どれか」を決める必要がもう無く、
    // 絵はその分の高さを取るだけになる。
    const thumbOf = (state) => view.root.allByClass('unbake-raindrop-row')
        .find(node => node.getAttribute('data-state') === state)
        ?.byClass('unbake-raindrop-thumb');
    assert.ok(thumbOf('fresh'), '未取り込みに絵が出ていない');
    assert.equal(thumbOf('imported'), null, '取り込み済みにも絵を出している');
});

test('中身が無い群は、見出しごと出さない', async () => {
    // **空の見出しは「0件在る」と読める。** 出さない。
    const view = await open({
        list: async () => ({ ok: true, count: 1, items: [bookmark('7')] }),
        knownIdsOf: () => [],
        importOne: async () => ({ ok: true }),
    });
    const groups = view.root.allByClass('unbake-raindrop-group')
        .map(node => node.getAttribute('data-state'));
    assert.deepEqual(groups, ['fresh'], '中身の無い群まで出している');
});
