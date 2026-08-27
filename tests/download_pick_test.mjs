/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **落とす前に、内訳を並べて選ばせる**（2026-08-26 利用者の指示）。
 *
 * 元は「本当に落とす（6 件・299 MB）」と釦の字が変わるだけで、**何が
 * 299 MB なのかは判らないまま**押すことになっていた。
 *
 * **押す回数は増やさない**——調べた回にこの面が出て、ここで落とす
 * （構えて押し直す形と同じ2回のまま）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUnbakePanel } from '../web/panel/panel.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale, t, LOCALE_META } from '../web/i18n/index.js';

setLocale('ja');

const withMissing = (id, versionId) => ({
    id, libraryId: id, title: `r${id}`, verdict: 'blocked',
    missing: { models: [], resources: [
        { type: 'lora', name: `m${versionId}`, versionId, modelId: null, isDeleted: false },
    ] },
});

/** 版ID → 大きさ（実測の形: `/unbake/download-plan` の `items[].bytes`）。 */
function planFor(table) {
    return async (ids) => ({
        ok: true, unknown: 0,
        bytes: ids.reduce((sum, id) => sum + (table[String(id)]?.bytes || 0), 0),
        items: ids.map(id => ({ versionId: String(id), ...table[String(id)] })),
    });
}

function mount(io = {}) {
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), { documentRef: doc, ...io });
    panel.setRecords([withMissing('a', '111'), withMissing('b', '222'), withMissing('c', '333')]);
    return panel;
}

const TABLE = {
    111: { filename: 'small.safetensors', bytes: 20_000_000 },
    222: { filename: 'big.safetensors', bytes: 300_000_000 },
    333: { filename: 'medium.safetensors', bytes: 80_000_000 },
};

function started() {
    const list = [];
    return { list, start: async (versionId) => { list.push(String(versionId)); return { ok: true, path: 'x' }; } };
}

test('一本ずつの名前と大きさを並べる', async () => {
    const io = started();
    const panel = mount({ downloadIo: { start: io.start, plan: planFor(TABLE) } });
    await panel.downloadMissing();
    const box = panel.root.byClass('unbake-confirm');
    assert.ok(box, `内訳の面が出ていない: ${panel.root.text.slice(-260)}`);
    for (const name of ['small.safetensors', 'big.safetensors', 'medium.safetensors']) {
        assert.ok(box.text.includes(name), `${name} が内訳に無い`);
    }
    // **大きさも1本ずつ。** 総量だけでは「何が 300 MB なのか」は判らない。
    assert.match(box.text, /286 MB/, '行ごとの大きさが出ていない');
});

test('外したものは落とさない', async () => {
    const io = started();
    const panel = mount({ downloadIo: { start: io.start, plan: planFor(TABLE) } });
    await panel.downloadMissing();
    const picks = panel.root.allByClass('unbake-confirm-pick');
    assert.equal(picks.length, 3, `印の数が違う: ${picks.length}`);
    // **既定は全部えらばれている。** 外したい人だけが触る。
    assert.ok(picks.every(pick => pick.checked), '既定で外れているものがある');
    const big = panel.root.allByClass('unbake-confirm-file')
        .findIndex(row => row.text.includes('big.safetensors'));
    picks[big].checked = false;
    await picks[big].dispatch('change', {});
    await panel.root.byClass('unbake-confirm-go').dispatch('click', {});
    assert.deepEqual(io.list.sort(), ['111', '333'], `落とした顔ぶれが違う: ${io.list}`);
});

test('外すと、釦の数字もその場で減る', async () => {
    // **総量が追随しないと、どちらが本当なのか読めない。**
    const panel = mount({ downloadIo: { start: async () => ({ ok: true }), plan: planFor(TABLE) } });
    await panel.downloadMissing();
    const go = panel.root.byClass('unbake-confirm-go');
    assert.match(go.textContent, /3 件/, `開いた時点の件数が違う: ${go.textContent}`);
    assert.match(go.textContent, /381 MB/, `開いた時点の総量が違う: ${go.textContent}`);
    const picks = panel.root.allByClass('unbake-confirm-pick');
    const big = panel.root.allByClass('unbake-confirm-file')
        .findIndex(row => row.text.includes('big.safetensors'));
    picks[big].checked = false;
    await picks[big].dispatch('change', {});
    assert.match(go.textContent, /2 件/, `件数が減っていない: ${go.textContent}`);
    assert.match(go.textContent, /95\.4 MB/, `総量が減っていない: ${go.textContent}`);
});

test('全部外したら、進めない', async () => {
    // **押しても何も起きない口を残さない。**
    const io = started();
    const panel = mount({ downloadIo: { start: io.start, plan: planFor(TABLE) } });
    await panel.downloadMissing();
    const picks = panel.root.allByClass('unbake-confirm-pick');
    for (const pick of picks) { pick.checked = false; await pick.dispatch('change', {}); }
    const go = panel.root.byClass('unbake-confirm-go');
    assert.equal(go.disabled, true, '1つも選んでいないのに押せる');
    await go.dispatch('click', {});
    assert.deepEqual(io.list, [], '1つも選んでいないのに落としている');
});

test('やめれば、1本も落とさない', async () => {
    const io = started();
    const panel = mount({ downloadIo: { start: io.start, plan: planFor(TABLE) } });
    await panel.downloadMissing();
    await panel.root.byClass('unbake-confirm-cancel').dispatch('click', {});
    assert.deepEqual(io.list, [], 'やめたのに落としている');
    assert.match(panel.root.text, /落とすのをやめました/, '何が起きたか言っていない');
});

test('押す回数は増えていない', async () => {
    /*
     * 利用者の条件:「クリックの回数は余計に増やさないように」。
     * 調べる1回 → 面の「落とす」1回 = **2回**（構えて押し直す形と同じ）。
     */
    const io = started();
    const panel = mount({ downloadIo: { start: io.start, plan: planFor(TABLE) } });
    let clicks = 0;
    clicks += 1; await panel.downloadMissing();
    clicks += 1; await panel.root.byClass('unbake-confirm-go').dispatch('click', {});
    assert.equal(clicks, 2);
    assert.equal(io.list.length, 3, '2回で落ち切っていない');
});

test('消す面の言い回しは出さない', async () => {
    // **何も消さない。** 「これは取り消せません」「消す」は別の面の言葉。
    const panel = mount({ downloadIo: { start: async () => ({ ok: true }), plan: planFor(TABLE) } });
    await panel.downloadMissing();
    const box = panel.root.byClass('unbake-confirm');
    assert.doesNotMatch(box.text, /取り消せません/);
    assert.doesNotMatch(box.text, /二度と表示しない/);
});

test('文言が全部の言語に在る', () => {
    for (const locale of Object.keys(LOCALE_META || {})) {
        setLocale(locale);
        for (const key of ['download.pick.title', 'download.pick.help', 'download.pick.cancelled']) {
            assert.notEqual(t(key), key, `${locale}: ${key} が無い`);
        }
    }
    setLocale('ja');
});

test('外した本体の伴走まで落とさない', async () => {
    /*
     * 拡散モデルは本体だけでは動かないので、系統ごとにテキストエンコーダと
     * VAE を一緒に落とす。**外した本体の分まで落とすと、使い道の無い
     * 8GB を引くことになる**（実測で Krea 2 の伴走は 8.3 GB）。
     */
    const pulled = [];
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc,
        downloadIo: {
            start: async () => ({ ok: true, path: 'x' }),
            plan: async (ids) => ({
                ok: true, unknown: 0, bytes: 2,
                items: ids.map(id => ({
                    versionId: String(id),
                    filename: id === '111' ? 'anima.safetensors' : 'krea.safetensors',
                    baseModel: id === '111' ? 'Anima' : 'Krea 2',
                    bytes: 1,
                })),
            }),
        },
        companionIo: {
            status: async (base) => ({ companions: [], missingCount: 1, missingBytes: 1, missingUnknown: 0, baseModel: base }),
            download: async (base) => { pulled.push(base); return [{ ok: true }]; },
        },
    });
    panel.setRecords([withMissing('a', '111'), withMissing('b', '222')]);
    await panel.downloadMissing();
    const rows = panel.root.allByClass('unbake-confirm-file');
    const picks = panel.root.allByClass('unbake-confirm-pick');
    const krea = rows.findIndex(row => row.text.includes('krea.safetensors'));
    assert.ok(krea >= 0, `内訳に本体が並んでいない: ${panel.root.text.slice(-260)}`);
    picks[krea].checked = false;
    await picks[krea].dispatch('change', {});
    await panel.root.byClass('unbake-confirm-go').dispatch('click', {});
    assert.deepEqual(pulled, ['Anima'], `伴走の顔ぶれが違う: ${pulled}`);
});

test('釦の総量に、伴走の分も入っている', async () => {
    /*
     * 実機（2026-08-26）: 釦は「8 件・32.2 GB」なのに、履歴の総量は 42.1 GB。
     * **押した人が知らないまま 10 GB 増える。** 落とし終わってから足りないと
     * 判るのを避けるための仕組みなのに、その数字を釦から落としていた。
     */
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc,
        downloadIo: {
            start: async () => ({ ok: true, path: 'x' }),
            plan: async (ids) => ({
                ok: true, unknown: 0, bytes: 1_000_000_000,
                items: ids.map(id => ({
                    versionId: String(id), filename: 'anima.safetensors',
                    baseModel: 'Anima', bytes: 1_000_000_000,
                })),
            }),
        },
        companionIo: {
            status: async (base) => ({
                companions: [], missingCount: 2, missingBytes: 8_300_000_000,
                missingUnknown: 0, baseModel: base,
            }),
            download: async () => [{ ok: true }],
        },
    });
    panel.setRecords([withMissing('a', '111')]);
    await panel.downloadMissing();
    const go = panel.root.byClass('unbake-confirm-go');
    // **期待値は実測から。** 本体 1.0 GB + 伴走 8.3 GB = 9.3 GB → 表示は 8.7 GB。
    assert.match(go.textContent, /8\.7 GB/,
        `伴走の分が入っていない: ${go.textContent}`);
});

test('本体を外せば、伴走の分も総量から消える', async () => {
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc,
        downloadIo: {
            start: async () => ({ ok: true, path: 'x' }),
            plan: async (ids) => ({
                ok: true, unknown: 0, bytes: 1_000_000_000,
                items: ids.map(id => ({
                    versionId: String(id), filename: 'anima.safetensors',
                    baseModel: 'Anima', bytes: 1_000_000_000,
                })),
            }),
        },
        companionIo: {
            status: async (base) => ({
                companions: [], missingCount: 2, missingBytes: 8_300_000_000,
                missingUnknown: 0, baseModel: base,
            }),
            download: async () => [{ ok: true }],
        },
    });
    panel.setRecords([withMissing('a', '111')]);
    await panel.downloadMissing();
    const pick = panel.root.allByClass('unbake-confirm-pick')[0];
    pick.checked = false;
    await pick.dispatch('change', {});
    const go = panel.root.byClass('unbake-confirm-go');
    assert.match(go.textContent, /0 件/, `件数が残っている: ${go.textContent}`);
    assert.doesNotMatch(go.textContent, /GB/, `外したのに伴走が残っている: ${go.textContent}`);
});

// --- 待っている件数で並べる（2026-08-26 利用者の指示）----------------------

/**
 * **大きさだけでは選べない。** 実機の内訳は
 * 「31.9 GB が1件のためだけ」と「244 MB が8件を止めている」が
 * 同じ顔で並んでいた。どちらを先に落とすかは件数で決まる。
 */
function manyWaiting() {
    const recs = [];
    // `huge` を待つのは1件、`small` を待つのは3件。
    recs.push({ id: 'a', libraryId: 'a', title: 'a', verdict: 'blocked',
        missing: { models: [], resources: [
            { type: 'checkpoint', name: 'huge.safetensors', versionId: 111, isDeleted: false },
            { type: 'lora', name: 'small.safetensors', versionId: 222, isDeleted: false },
        ] } });
    for (const id of ['b', 'c']) {
        recs.push({ id, libraryId: id, title: id, verdict: 'blocked',
            missing: { models: [], resources: [
                { type: 'lora', name: 'small.safetensors', versionId: 222, isDeleted: false },
            ] } });
    }
    return recs;
}

const PLAN = async (ids) => ({
    ok: true, unknown: 0, bytes: 0,
    items: ids.map(id => String(id) === '111'
        ? { versionId: '111', filename: 'huge.safetensors', bytes: 31_900_000_000 }
        : { versionId: '222', filename: 'small.safetensors', bytes: 244_000_000 }),
});

test('待っている件数の多い順に並べる（大きさ順ではない）', async () => {
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc,
        downloadIo: { start: async () => ({ ok: true }), plan: PLAN },
    });
    panel.setRecords(manyWaiting());
    await panel.downloadMissing();
    const rows = panel.root.allByClass('unbake-confirm-file').map(r => r.text);
    assert.equal(rows.length, 2, `内訳の行数が違う: ${rows.length}`);
    assert.match(rows[0], /small\.safetensors/,
        `件数の多い方が先に来ていない: ${rows.join(' | ')}`);
    assert.match(rows[1], /huge\.safetensors/);
});

test('何件が待っているかを一行に出す', async () => {
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc,
        downloadIo: { start: async () => ({ ok: true }), plan: PLAN },
    });
    panel.setRecords(manyWaiting());
    await panel.downloadMissing();
    const rows = panel.root.allByClass('unbake-confirm-file').map(r => r.text);
    assert.match(rows[0], /3 件が待つ/, `件数が出ていない: ${rows[0]}`);
    assert.match(rows[1], /1 件が待つ/, `件数が出ていない: ${rows[1]}`);
    // **数え方を書く。** 合計が記録数と合わないので、書かないと誤読される。
    assert.match(panel.root.byClass('unbake-confirm').text, /合計はレコード数と一致しません/,
        '数え方を書いていない');
});

test('選択の外で待っている分も数える', async () => {
    /*
     * **母集団は全記録。** 「ほかにも待っている」ことが判らないと、
     * 1件のために大きいものを先に落とすことになる。
     */
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc,
        downloadIo: { start: async () => ({ ok: true }), plan: PLAN },
    });
    panel.setRecords(manyWaiting());
    // 1件だけ選ぶ（`a` は huge と small の両方を待っている）。
    const box = panel.root.allByClass('unbake-pick')[0];
    box.checked = true;
    await box.dispatch('click', {});
    await panel.downloadMissing();
    const rows = panel.root.allByClass('unbake-confirm-file').map(r => r.text);
    const small = rows.find(r => /small/.test(r));
    assert.match(small, /3 件が待つ/,
        `選択の外を数えていない（選択内だけなら 1 件になる）: ${small}`);
});

test('数えようが無いときは何も言わない', async () => {
    /*
     * **「0 件が待つ」は読む手間だけを足す。**
     *
     * 不足に名前が無く版IDしか無い形（名前は計画が後から付ける）では、
     * 記録の側と突き合わせる鍵が無い。**判らないことを 0 と書かない。**
     */
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc,
        downloadIo: {
            start: async () => ({ ok: true }),
            plan: async (ids) => ({ ok: true, unknown: 0, bytes: 1,
                items: ids.map(id => ({ versionId: String(id), filename: '後から付いた名前.safetensors', bytes: 1 })) }),
        },
    });
    panel.setRecords([{
        id: '1', libraryId: '1', title: 'r1', verdict: 'blocked',
        // **名前が無い。** 版IDだけで、突き合わせる鍵にならない。
        missing: { models: [], resources: [{ type: 'lora', versionId: 111, isDeleted: false }] },
    }]);
    await panel.downloadMissing();
    const row = panel.root.allByClass('unbake-confirm-file')[0].text;
    assert.doesNotMatch(row, /件が待つ/, `数えようが無いのに言っている: ${row}`);
});

test('計画が名前を付け替えても、件数は消えない', async () => {
    /*
     * 実機（2026-08-26）。計画は解決後のファイル名を返すので、そのまま被せると
     * 記録の `missing` に載っている名前と食い違う——`redcraft22INT8INT4_…` が
     * `redcraftREDMIXHybridA2A_…` に変わり、**待っている件数が黙って 0 になった**。
     */
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc,
        downloadIo: {
            start: async () => ({ ok: true }),
            plan: async (ids) => ({ ok: true, unknown: 0, bytes: 1,
                items: ids.map(id => ({ versionId: String(id), filename: '解決後の名前.safetensors', bytes: 1 })) }),
        },
    });
    panel.setRecords([withMissing('1', '111'), withMissing('2', '111')]);
    await panel.downloadMissing();
    const row = panel.root.allByClass('unbake-confirm-file')[0].text;
    assert.match(row, /解決後の名前/, '表示は解決後の名前で出す');
    assert.match(row, /2 件が待つ/, `名前を付け替えたら件数が消えた: ${row}`);
});

test('同じレコードを1つのモデルに二重に数えない', async () => {
    /*
     * 不足は `models`（グラフのノードが要求する）と `resources`
     *（レシピが挙げる）の**両方に同じ名前が出る**ことがある。素直に足すと
     * 1件のレコードが2件に見え、**待っている件数が実際より多く出る**。
     */
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc,
        downloadIo: {
            start: async () => ({ ok: true }),
            plan: async (ids) => ({ ok: true, unknown: 0, bytes: 1,
                items: ids.map(id => ({ versionId: String(id), filename: 'both.safetensors', bytes: 1 })) }),
        },
    });
    panel.setRecords([{
        id: 'a', libraryId: 'a', title: 'a', verdict: 'blocked',
        missing: {
            // **同じ名前が両側に出る。**
            models: [{ name: 'both.safetensors', folder: 'loras' }],
            resources: [{ type: 'lora', name: 'both.safetensors', versionId: 777, isDeleted: false }],
        },
    }]);
    await panel.downloadMissing();
    const row = panel.root.allByClass('unbake-confirm-file')[0].text;
    assert.match(row, /1 件が待つ/, `二重に数えている: ${row}`);
});
