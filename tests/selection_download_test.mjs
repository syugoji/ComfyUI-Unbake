/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 実機で報告された4巡目（2026-08-20）。
 *
 *   ⑮ Ctrl+A などでレコードを一括選択したい
 *   ⑯ 選んだものからモデルのダウンロードと再現を行いたい
 *   ⑰ モデルの自動ダウンロードのボタンが見つからない
 *
 * **⑰は「無い」が正しかった。** 落とす仕掛けはサーバ側に在り
 * （`/unbake/download`・手順20/21）、不足を種類分けする層も在ったのに、
 * **画面から呼ぶ配線が1本も無かった**——この決定でずっと直しているのと同じ形。
 *
 * ここで固定するのは、**取り返しのつかない操作の周りの決めごと**でもある:
 * 選択と絞り込みを混ぜないこと、総量を見せてから落とすこと、
 * 「落とせない」と「不足が無い」を分けること。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createUnbakePanel } from '../web/panel/panel.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale, t } from '../web/i18n/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const rec = (id, extra = {}) => ({
    id, libraryId: id, title: `Civitai_Recipe_${id}`, verdict: 'reproducible', ...extra,
});

/** 版IDつきの不足を持つ記録（＝落とせるもの）。 */
const withMissing = (id, versionId, name = `model-${versionId}`) => rec(id, {
    verdict: 'blocked',
    missing: {
        models: [],
        resources: [{ type: 'lora', name, versionId, modelId: null, isDeleted: false }],
    },
});

function mount(records, { display = null, ...io } = {}) {
    const doc = fakeDocument();
    // **既定は表**（2026-08-28）。渡された display は必ず勝つ。
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc, display: { listView: 'table', ...(display || {}) }, ...io,
    });
    panel.setRecords(records);
    return panel;
}

const key = (panel, k, options = {}) => panel.root.dispatch('keydown', {
    key: k, preventDefault() {}, stopPropagation() {}, ...options,
});

// --- ⑮ 一括選択 -------------------------------------------------------------

test('チェックで1件ずつ選べる', () => {
    setLocale('en');
    const panel = mount([rec('a'), rec('b')]);
    const boxes = panel.root.allByClass('unbake-pick');
    assert.equal(boxes.length, 2, '選ぶ口が行に無い');

    boxes[0].checked = true;
    boxes[0].dispatch('click', {});
    assert.deepEqual(panel.selected, ['a']);

    // **描き直した後の口を取り直す**（2026-08-26）。元は古い節点を使い回して
    // いたので、`data-checked="true"` が付いた**本物の状態を一度も踏んで
    // いなかった**——実機では外せないのに、この検査は緑のままだった。
    const after = panel.root.allByClass('unbake-pick');
    assert.equal(after[0].getAttribute('data-checked'), 'true', '選んだ印が付いていない');
    after[0].checked = false;
    after[0].dispatch('click', {});
    assert.deepEqual(panel.selected, [], 'チェックを外せない');
});

test('Ctrl+A で見えているものを全部選び、もう一度で解除する', () => {
    setLocale('en');
    const panel = mount([rec('a'), rec('b'), rec('c')]);
    key(panel, 'a', { ctrlKey: true });
    assert.deepEqual(panel.selected.sort(), ['a', 'b', 'c']);
    // **戻せること。** 全部選んだ後に戻せない形を作らない。
    key(panel, 'a', { ctrlKey: true });
    assert.deepEqual(panel.selected, []);
});

test('Ctrl+A が選ぶのは「絞り込みで見えているもの」だけ', () => {
    setLocale('en');
    const panel = mount([rec('a', { title: 'alpha' }), rec('b', { title: 'beta' })]);
    const search = panel.root.byClass('unbake-search');
    search.value = 'alpha';
    search.dispatch('input', {});
    key(panel, 'a', { ctrlKey: true });
    assert.deepEqual(panel.selected, ['a'], '見えていないものまで選んでいる');
});

test('入力欄の中の Ctrl+A は、字の全選択のほうを優先する', () => {
    setLocale('en');
    const panel = mount([rec('a'), rec('b')]);
    let prevented = false;
    panel.root.dispatch('keydown', {
        key: 'a', ctrlKey: true,
        target: { tagName: 'INPUT' },
        preventDefault() { prevented = true; },
        stopPropagation() {},
    });
    assert.deepEqual(panel.selected, [], '入力欄の中でも記録を選んでいる');
    assert.equal(prevented, false, '字の全選択を奪っている');
});

test('Esc で選択を解除する', () => {
    setLocale('en');
    const panel = mount([rec('a')]);
    key(panel, 'a', { ctrlKey: true });
    assert.equal(panel.selected.length, 1);
    key(panel, 'Escape');
    assert.deepEqual(panel.selected, []);
});

test('選択は絞り込みと別物（見えなくなっても消えない・でも操作の対象からは外す）', () => {
    setLocale('en');
    const panel = mount([rec('a', { title: 'alpha' }), rec('b', { title: 'beta' })]);
    key(panel, 'a', { ctrlKey: true });
    assert.equal(panel.selected.length, 2);

    const search = panel.root.byClass('unbake-search');
    search.value = 'alpha';
    search.dispatch('input', {});
    // **選択そのものは残る**（確かめてから戻ってくる使い方を壊さない）。
    assert.equal(panel.selected.length, 2);
    // **でも「今見えている1件」だけが対象**だと画面に書く。
    const line = panel.root.byClass('unbake-selection-count').textContent;
    assert.match(line, /1/, `対象の件数が出ていない: ${line}`);
    assert.equal(line, t('select.countHidden', { n: 1, hidden: 1 }));
});

test('タイルでも同じ口で選べる', () => {
    setLocale('en');
    const panel = mount([rec('a')], { display: { listView: 'tiles' } });
    const box = panel.root.byClass('unbake-tile').byClass('unbake-pick');
    assert.ok(box, 'タイルに選ぶ口が無い');
    box.checked = true;
    box.dispatch('click', {});
    assert.deepEqual(panel.selected, ['a']);
    assert.equal(panel.root.byClass('unbake-tile').getAttribute('data-selected'), 'true');
});

// --- ⑯ 選んだものを再現する --------------------------------------------------

test('束で回すのは、選んだものだけ', async () => {
    setLocale('en');
    const ran = [];
    const panel = mount([rec('a'), rec('b'), rec('c')], {
        batchIo: {
            makeRunner: (record) => ({
                async requireEmptyQueue() {},
                async run() { ran.push(record.id); return { id: `job-${record.id}` }; },
            }),
            templateFor: () => ({ id: 'seeds', mode: 'seeds_only', axes: [], seeds: [1] }),
        },
    });
    const boxes = panel.root.allByClass('unbake-pick');
    boxes[1].checked = true;
    boxes[1].dispatch('click', {});

    await panel.root.byClass('unbake-batch-run').dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(ran, ['b'], `選んでいないものまで回している: ${ran.join(',')}`);
});

// --- ⑰ 不足モデルを落とす ----------------------------------------------------

/**
 * 内訳の面で「落とす」を押す（2026-08-26 から、構えて押し直す形ではなく
 * **内訳を並べて選ばせる面**が出る）。返るのは落とし終わりの結果。
 */
async function confirmPick(panel) {
    const go = panel.root.byClass('unbake-confirm-go');
    assert.ok(go, `内訳の面が出ていない: ${panel.root.text.slice(-260)}`);
    const [result] = await go.dispatch('click', {});
    return result;
}

test('落とすボタンが在り、口が無ければ出さない', () => {
    setLocale('en');
    const without = mount([rec('a')]);
    assert.equal(without.root.byClass('unbake-download-missing'), null,
        '押しても何も起きないボタンを出している');

    const withIo = mount([rec('a')], { downloadIo: { start: async () => ({ ok: true }) } });
    assert.ok(withIo.root.byClass('unbake-download-missing'), '落とすボタンが無い');
});

test('1回目の押しでは落とさない（総量を見せて止まる）', async () => {
    setLocale('en');
    const started = [];
    const panel = mount([withMissing('a', '111'), withMissing('b', '222')], {
        downloadIo: {
            start: async (versionId) => { started.push(versionId); return { ok: true, path: 'x' }; },
            plan: async (ids) => ({
                ok: true, unknown: 0, resolved: ids.length, bytes: 42 * 1024 * 1024 * 1024,
                items: ids.map(id => ({ versionId: id, filename: `m${id}.safetensors`, bytes: 21 * 1024 * 1024 * 1024 })),
            }),
        },
    });
    key(panel, 'a', { ctrlKey: true });

    const picking = await panel.downloadMissing();
    // **1バイトも落とさない。** 実測で、19件の待ち行列の10本目が 34 GB だった。
    assert.deepEqual(started, [], '確認の前に落とし始めている');
    assert.equal(picking.picking, true);
    assert.equal(picking.models, 2);
    const go = panel.root.byClass('unbake-confirm-go');
    assert.ok(go, '内訳の面が出ていない');
    assert.match(go.textContent, /42/, `総量が進む口に出ていない: ${go.textContent}`);

    // 面の「落とす」で落ちる。
    const result = await confirmPick(panel);
    assert.deepEqual(started, ['111', '222']);
    assert.equal(result.downloaded, 2);
});

test('探している間は、押せなくして語も差し替える', async () => {
    // **押したのに何も起きない、を作らない**（2026-08-25 利用者の指示）。
    // 記録が多いと数え上げと大きさの問い合わせに間が空く。
    setLocale('en');
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const panel = mount([withMissing('a', '111')], {
        downloadIo: {
            start: async () => ({ ok: true }),
            // 大きさの問い合わせを止めて、探している最中の姿を捕まえる。
            plan: async () => { await held; return { ok: true, unknown: 0, bytes: 42, items: [] }; },
        },
    });
    key(panel, 'a', { ctrlKey: true });
    const button = panel.root.byClass('unbake-download-missing');
    const idle = button.textContent;

    const pending = panel.downloadMissing();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(button.getAttribute('data-scanning'), 'true', '探している姿になっていない');
    assert.equal(button.disabled, true, '探している間に押せてしまう');
    assert.notEqual(button.textContent, idle, '語が変わっていない');

    release();
    await pending;
    // **どの道を通っても戻す。** 戻さないと、押せない釦が残る。
    assert.equal(button.getAttribute('data-scanning'), null, '探している姿が残っている');
    assert.equal(button.disabled, false, '押せないままになっている');
    assert.ok(panel.root.byClass('unbake-confirm-go'), '内訳の面が出ていない');
});

test('選び直すと、見せた総量は無効になる', async () => {
    setLocale('en');
    const started = [];
    const panel = mount([withMissing('a', '111'), withMissing('b', '222')], {
        downloadIo: {
            start: async (id) => { started.push(id); return { ok: true }; },
            plan: async () => ({ ok: true, unknown: 0, bytes: 1, items: [] }),
        },
    });
    key(panel, 'a', { ctrlKey: true });
    await panel.downloadMissing();

    // 顔ぶれが変わったのに、見せた総量のまま落とし始めてはいけない。
    const box = panel.root.allByClass('unbake-pick')[0];
    box.checked = false;
    box.dispatch('click', {});
    assert.equal(panel.root.byClass('unbake-download-missing').getAttribute('data-armed'), null);

    await panel.downloadMissing();
    assert.deepEqual(started, [], '選び直したのに、そのまま落とし始めている');
});

test('「既にある」を失敗と混ぜない', async () => {
    setLocale('en');
    const panel = mount([withMissing('a', '111'), withMissing('b', '222')], {
        downloadIo: {
            // **実物と同じ形にする。** サーバは `code` も返している
            // （`download.py` の `DownloadError(..., "already")`）のに、
            // ここは `error` しか返していなかった——**種類で見分ける実装に
            // 変えた瞬間に赤くなった**。作り物の形が本物とずれていた。
            start: async (id) => (id === '111'
                ? { ok: false, code: 'already', error: 'already there: m111.safetensors' }
                : { ok: true, path: 'm222.safetensors', verified: true }),
            plan: async () => ({ ok: true, unknown: 0, bytes: 1, items: [] }),
        },
    });
    key(panel, 'a', { ctrlKey: true });
    await panel.downloadMissing();
    const result = await confirmPick(panel);
    assert.equal(result.already, 1, '既にあるものを失敗に数えている');
    assert.equal(result.downloaded, 1);
    assert.equal(result.failed, 0);
});

test('「既にある」の見分けが、英語の文言に依らない', async () => {
    // **文言を1文字変えるか訳した瞬間、件数が黙って「失敗」へ移る**——
    // 元はそういう作りだった（`error` が "already there" で始まるかを見ていた）。
    setLocale('en');
    const panel = mount([withMissing('a', '111')], {
        downloadIo: {
            start: async () => ({ ok: false, code: 'already', error: 'すでに置き場に在ります' }),
            plan: async () => ({ ok: true, unknown: 0, bytes: 1, items: [] }),
        },
    });
    key(panel, 'a', { ctrlKey: true });
    await panel.downloadMissing();
    const result = await confirmPick(panel);
    assert.equal(result.already, 1, `文言が変わると数え方が変わる: ${JSON.stringify(result)}`);
    assert.equal(result.failed, 0);
});

test('「いま引いている最中」を「既にある」と混ぜない', async () => {
    // **打つ手が違う。** 置き場に在るなら何もしなくてよいが、
    // 引いている最中なら待つ話になる（サーバの種類も分けた）。
    setLocale('en');
    const panel = mount([withMissing('a', '111')], {
        downloadIo: {
            start: async () => ({ ok: false, code: 'downloading',
                                  error: 'this version is already downloading' }),
            plan: async () => ({ ok: true, unknown: 0, bytes: 1, items: [] }),
        },
    });
    key(panel, 'a', { ctrlKey: true });
    await panel.downloadMissing();
    const result = await confirmPick(panel);
    assert.equal(result.already, 0, '引いている最中を「既にある」に数えている');
    assert.equal(result.failed, 1);
});

test('「不足が無い」と「不足はあるが落とせない」を分ける', async () => {
    setLocale('en');
    // 遮られてはいるが、理由がモデル不足ではない記録（不足ノード・プロンプト欠落）。
    // 実測: 59件の遮断のうち、落とせるモデルを持つのは20件だった。
    const panel = mount([rec('a', { verdict: 'blocked', missing: { models: [], resources: [] } })], {
        downloadIo: { start: async () => ({ ok: true }) },
    });
    key(panel, 'a', { ctrlKey: true });
    const result = await panel.downloadMissing();
    assert.equal(result.blocked, 0);
    const logs = panel.root.byClass('unbake-log').text;
    assert.ok(logs.includes(t('download.nothingMissing')),
        '「不足が無い」ことを言っていない（押した人には壊れて見える）');
});

test('版IDの無い不足は落とさない（似た名前を勝手に落とさない）', async () => {
    setLocale('en');
    const started = [];
    const panel = mount([rec('a', {
        verdict: 'blocked',
        missing: { models: [{ name: 'someModel.safetensors', reason: 'not installed' }], resources: [] },
    })], {
        downloadIo: { start: async (id) => { started.push(id); return { ok: true }; }, plan: async () => ({ ok: true, bytes: 0, unknown: 0, items: [] }) },
    });
    key(panel, 'a', { ctrlKey: true });
    await panel.downloadMissing();
    await panel.downloadMissing();
    assert.deepEqual(started, [], '版IDが判らないものを落としている');
});

// --- 境界 -------------------------------------------------------------------

test('落とす口は識別子しか送らない（URL も置き場も画面から渡さない）', async () => {
    /*
     * **守っているのは「URL を渡さない」こと。**
     *
     * 元はここが「本文が `{ versionId: String(versionId) }` という字面である
     * こと」を見ていた。字面を固定すると **足すたびに必ず一度立ち止まる** ので
     * 見張りとしては良く、実際 2026-08-26 に `modelId` を足したときここで
     * 止まって足してよいかを考え直した。
     *
     * ただし字面のままにすると、次に足す人は **中身を見ずに字面だけ直す**
     * ことになる。だから **許した鍵の一覧** に変える——増やすにはこの一覧を
     * 触ることになるので、立ち止まる効果は残る。
     *
     * `modelId` を許した理由: 消えた版を受け皿（civarchive）から探す入口が
     * モデルIDを求めるため。**数字の識別子であって URL でも置き場でもない**
     * ので、「落とし先を決めるのはサーバ側」という約束は変わらない。
     */
    const source = await readFile(join(ROOT, 'web/unbake.js'), 'utf8');
    const block = source.match(/const downloadIo = \{[\s\S]*?\n    \};/);
    assert.ok(block, '落とす口が無い');

    const body = block[0].match(/async start\(versionId[\s\S]*?return response\.json\(\);/);
    assert.ok(body, '落とす口の本文が読めない');

    const ALLOWED = new Set(['versionId', 'modelId']);
    const SHAPE = new Set(['method', 'headers', 'body']);
    const keys = [...body[0].matchAll(/(\w+):\s/g)]
        .map(match => match[1])
        .filter(name => !SHAPE.has(name) && name !== 'Content-Type');
    const extra = keys.filter(name => !ALLOWED.has(name));
    assert.deepEqual(extra, [],
        `許していない鍵を送っている: ${extra.join(', ')}（増やすならこの一覧を直す）`);

    // **ここが本体。** 識別子が増えるのは構わないが、URL や置き場は渡さない
    // ——渡せる形にした瞬間、画面へ細工をした人が任意の場所から落とせる。
    assert.doesNotMatch(body[0], /downloadUrl|https?:|path|dir|folder/i,
        'URL か置き場を画面から渡している');

    // **検出器が生きていること。** 鍵を拾えていなければ、何も見ずに緑になる。
    assert.ok(keys.includes('versionId'), `鍵を拾えていない: ${keys.join(', ')}`);
});

test('台帳（/api/lm/*）を新しく呼ばない', async () => {
    // 不足の種類分けは上流の台帳も見られる作りだが、**こちらからは渡さない**
    // ——`/api/lm/*` を新しく呼ばないという境界がここに掛かっている。
    const source = await readFile(join(ROOT, 'web/panel/panel.js'), 'utf8');
    assert.match(source, /classifyMissing\(record\?\.missing, null\)/,
        '台帳を渡している（/api/lm/* を呼びに行く）');
    // **コメントは外して見る。** 規約そのものを書いた行に当たって、
    // 「呼んでいる」と読むところだった（この検査自身が最初にそうなった）。
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /['\"`][^'\"`]*\/api\/lm\//, '/api/lm/* を直接呼んでいる');
});

// --- 伴走モデル（2026-08-26 の到達性の棚卸し）--------------------------------

test('拡散モデルの伴走が、押す前の総量に入る', async () => {
    // **本体だけ落としても何も動かない。** Civitai は Flux / Qwen-Image /
    // HiDream / Chroma / Z-Image / Krea 2 / Anima について拡散モデルしか
    // 配らないので、テキストエンコーダと VAE は別に要る——しかも
    // **落とし終わってから初めて足りないと判る**（実測: Krea 2 は 12GB と
    // 表示され、実際には +8.3GB 必要だった）。
    setLocale('en');
    const asked = [];
    const panel = mount([withMissing('a', '111')], {
        downloadIo: {
            start: async () => ({ ok: true, path: 'x' }),
            plan: async (ids) => ({
                ok: true, unknown: 0, resolved: ids.length, bytes: 4 * 1024 ** 3,
                items: ids.map(id => ({
                    versionId: id, filename: `anima.safetensors`,
                    kind: 'diffusion_models', baseModel: 'Anima', bytes: 4 * 1024 ** 3,
                })),
            }),
        },
        companionIo: {
            status: async (base) => {
                asked.push(base);
                return { companions: [], missingCount: 2, missingBytes: 4 * 1024 ** 3, missingUnknown: 0 };
            },
            download: async () => [{ ok: true }],
        },
    });

    const armed = await panel.downloadMissing();
    assert.deepEqual(asked, ['Anima'], '系統を伴走の口へ渡していない');
    // **合計は本体＋伴走。** ここが本体だけだと、押した人は半分の数字を見る。
    assert.equal(armed.bytes, 8 * 1024 ** 3,
        `総量に伴走が入っていない: ${armed.bytes / 1024 ** 3} GB`);
});

test('伴走は本体のあとに落とす（止めていたら始めない）', async () => {
    setLocale('en');
    const order = [];
    const panel = mount([withMissing('a', '111')], {
        downloadIo: {
            start: async (versionId) => { order.push(`main:${versionId}`); return { ok: true, path: 'x' }; },
            plan: async (ids) => ({
                ok: true, unknown: 0, resolved: ids.length, bytes: 1,
                items: ids.map(id => ({
                    versionId: id, filename: 'anima.safetensors',
                    kind: 'diffusion_models', baseModel: 'Anima', bytes: 1,
                })),
            }),
        },
        companionIo: {
            status: async () => ({ companions: [], missingCount: 1, missingBytes: 1, missingUnknown: 0 }),
            download: async (base) => { order.push(`companion:${base}`); return [{ ok: true }]; },
        },
    });

    await panel.downloadMissing();      // 内訳の面が出る
    await confirmPick(panel);           // 本当に落とす
    // **順番が逆だと、本体が失敗したときに使い道の無いエンコーダだけが残る。**
    assert.deepEqual(order, ['main:111', 'companion:Anima'],
        `落とす順が違う: ${order.join(' → ')}`);
});

test('伴走の口が無くても、本体は落とせる', async () => {
    // **足した口が無い環境で全部止まらないこと。** 止まると、伴走のために
    // 落とせなくなるという逆の壊れ方をする。
    setLocale('en');
    const started = [];
    const panel = mount([withMissing('a', '111')], {
        downloadIo: {
            start: async (versionId) => { started.push(versionId); return { ok: true, path: 'x' }; },
            plan: async (ids) => ({
                ok: true, unknown: 0, resolved: ids.length, bytes: 1,
                items: ids.map(id => ({ versionId: id, filename: 'x', baseModel: 'Anima', bytes: 1 })),
            }),
        },
    });
    await panel.downloadMissing();
    await confirmPick(panel);
    assert.deepEqual(started, ['111']);
});

// --- 名前しか無い不足を引き直す（2026-08-26 実機）----------------------------

test('名前しか無い不足を、ファイル名で引き直して落とせるようにする', async () => {
    /*
     * グラフの中だけに名前が在る素材（`Power Lora Loader` が束ねていた LoRA）は
     * 記録の `loras` に入らないので版IDを持たない。だから「不足」とは出るのに
     * **落とす候補に出てこなかった**。
     *
     * 実測（`civitai_139981506` の6本）: **4本はファイル名だけで版を特定できた**。
     */
    setLocale('ja');
    const asked = [];
    const panel = mount([rec('a', {
        verdict: 'blocked',
        missing: { models: [], resources: [{ type: 'lora', name: 'cunny_animaV1.0-000009.safetensors' }] },
    })], {
        downloadIo: {
            start: async () => ({ ok: true }),
            plan: async (ids) => ({ ok: true, unknown: 0, bytes: 1,
                items: ids.map(id => ({ versionId: id, filename: 'x', bytes: 1 })) }),
            lookupByName: async (name) => {
                asked.push(name);
                return { versionId: 2979711, modelId: 2653665,
                         fileName: 'cunny_animaV1.0-000009.safetensors' };
            },
        },
    });
    key(panel, 'a', { ctrlKey: true });
    const armed = await panel.downloadMissing();
    assert.deepEqual(asked, ['cunny_animaV1.0-000009.safetensors'], '名前で引き直していない');
    assert.equal(armed.models, 1, `落とす候補に入っていない: ${JSON.stringify(armed)}`);
});

test('引けなかったものは、落とせるふりをしない', async () => {
    // 実測で6本中2本は Civitai の検索に出てこない（消えたか、別の所から来た）。
    setLocale('ja');
    const panel = mount([rec('a', {
        verdict: 'blocked',
        missing: { models: [], resources: [{ type: 'lora', name: '見つからないもの.safetensors' }] },
    })], {
        downloadIo: {
            start: async () => ({ ok: true }),
            plan: async () => ({ ok: true, unknown: 0, bytes: 0, items: [] }),
            lookupByName: async () => null,
        },
    });
    key(panel, 'a', { ctrlKey: true });
    const result = await panel.downloadMissing();
    assert.notEqual(result?.armed, true, '引けていないのに落とす構えになっている');
});

test('引く件数に上限を置き、切ったことを言う', async () => {
    setLocale('ja');
    const many = Array.from({ length: 30 }, (_, index) => ({
        type: 'lora', name: `m${index}.safetensors`,
    }));
    const asked = [];
    const panel = mount([rec('a', { verdict: 'blocked', missing: { models: [], resources: many } })], {
        downloadIo: {
            start: async () => ({ ok: true }),
            plan: async () => ({ ok: true, unknown: 0, bytes: 0, items: [] }),
            lookupByName: async (name) => { asked.push(name); return null; },
        },
    });
    key(panel, 'a', { ctrlKey: true });
    await panel.downloadMissing();
    // **一覧を開くたびに何十回も外へ問い合わせない。**
    assert.ok(asked.length <= 24, `上限を超えて引いている: ${asked.length}`);
    assert.match(panel.root.text, /件だけ引き直します/, '切ったことを言っていない');
});

test('口が無い環境でも落とし込みは動く', async () => {
    setLocale('ja');
    const panel = mount([withMissing('a', '111')], {
        downloadIo: {
            start: async () => ({ ok: true }),
            plan: async () => ({ ok: true, unknown: 0, bytes: 1, items: [] }),
        },
    });
    key(panel, 'a', { ctrlKey: true });
    const picking = await panel.downloadMissing();
    assert.equal(picking.picking, true, '引く口が無いだけで止まっている');
});

test('「今は聞けなかった」を「見つからない」と混ぜない', async () => {
    /*
     * Civitai は問い合わせが続くと 503 を返す。それを「入手先が判っていません」
     * と言うと、**待てば通るものを永久に諦めさせる**。実機（2026-08-26）で
     * 6件すべてがこれだった——Python から叩いても同じ 503 だったので、
     * 相手側の一時的な制限だと確かめてある。
     */
    setLocale('ja');
    const panel = mount([rec('a', {
        verdict: 'blocked',
        missing: { models: [{ name: 'x.safetensors' }], resources: [] },
    })], {
        downloadIo: {
            start: async () => ({ ok: true }),
            plan: async () => ({ ok: true, unknown: 0, bytes: 0, items: [] }),
            lookupByName: async () => ({ match: null, reason: 'http-503' }),
        },
    });
    key(panel, 'a', { ctrlKey: true });
    await panel.downloadMissing();
    assert.match(panel.root.text, /今は答えられませんでした/,
        `待てば通ることを言っていない: ${panel.root.text.slice(-260)}`);
});

test('本当に見つからないときは、待てとは言わない', async () => {
    // **待てば通ると言うと、通らないものを待たせ続ける。**
    setLocale('ja');
    const panel = mount([rec('a', {
        verdict: 'blocked',
        missing: { models: [{ name: 'y.safetensors' }], resources: [] },
    })], {
        downloadIo: {
            start: async () => ({ ok: true }),
            plan: async () => ({ ok: true, unknown: 0, bytes: 0, items: [] }),
            lookupByName: async () => ({ match: null, reason: 'none' }),
        },
    });
    key(panel, 'a', { ctrlKey: true });
    await panel.downloadMissing();
    assert.doesNotMatch(panel.root.text, /今は答えられませんでした/,
        '見つからないものを「待てば通る」と言っている');
});
