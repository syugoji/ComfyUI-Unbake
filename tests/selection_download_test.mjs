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
    const panel = createUnbakePanel(doc.createElement('div'), { documentRef: doc, display, ...io });
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

    boxes[0].checked = false;
    boxes[0].dispatch('click', {});
    assert.deepEqual(panel.selected, []);
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

    const armed = await panel.downloadMissing();
    // **1バイトも落とさない。** 実測で、19件の待ち行列の10本目が 34 GB だった。
    assert.deepEqual(started, [], '確認の前に落とし始めている');
    assert.equal(armed.armed, true);
    assert.equal(armed.models, 2);
    const button = panel.root.byClass('unbake-download-missing');
    assert.equal(button.getAttribute('data-armed'), 'true');
    assert.match(button.textContent, /42/, `総量がボタンに出ていない: ${button.textContent}`);

    // 2回目で落とす。
    const result = await panel.downloadMissing();
    assert.deepEqual(started, ['111', '222']);
    assert.equal(result.downloaded, 2);
    assert.equal(button.getAttribute('data-armed'), null, '待ちが残っている');
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
    assert.equal(button.getAttribute('data-armed'), 'true', '確認の段になっていない');
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
            start: async (id) => (id === '111'
                ? { ok: false, error: 'already there: m111.safetensors' }
                : { ok: true, path: 'm222.safetensors', verified: true }),
            plan: async () => ({ ok: true, unknown: 0, bytes: 1, items: [] }),
        },
    });
    key(panel, 'a', { ctrlKey: true });
    await panel.downloadMissing();
    const result = await panel.downloadMissing();
    assert.equal(result.already, 1, '既にあるものを失敗に数えている');
    assert.equal(result.downloaded, 1);
    assert.equal(result.failed, 0);
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

test('落とす口は版IDしか送らない（URL を画面から渡さない）', async () => {
    const source = await readFile(join(ROOT, 'web/unbake.js'), 'utf8');
    const block = source.match(/const downloadIo = \{[\s\S]*?\n    \};/);
    assert.ok(block, '落とす口が無い');
    assert.match(block[0], /JSON\.stringify\(\{ versionId: String\(versionId\) \}\)/,
        '版ID以外を送っている');
    assert.doesNotMatch(block[0], /downloadUrl|https?:/, 'URL を画面から渡している');
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
