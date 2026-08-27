/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **落とせば試せるものだけを見る**（2026-08-26 利用者の指示）。
 *
 * 「再現不可」には**手元に無いだけ**のものと、**手掛かりが無くてどうにも
 * ならない**ものが混ざっている。前者は落とせば動くので打つ手が全く違う
 * ——混ざったままだと、落とせるものを探すのに一件ずつ開くことになる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createUnbakePanel } from '../web/panel/panel.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale, t } from '../web/i18n/index.js';

setLocale('ja');

/** 落とせる不足（版IDを持つ）。 */
const downloadable = (id) => ({
    id, libraryId: id, title: `落とせる${id}`, verdict: 'blocked',
    missing: { models: [], resources: [{ type: 'lora', name: `m${id}`, versionId: 100 + Number(id), isDeleted: false }] },
});
/** 手掛かりの無い不足（版IDも modelId も無い）。 */
const hopeless = (id) => ({
    id, libraryId: id, title: `打つ手なし${id}`, verdict: 'blocked',
    missing: { models: [], resources: [{ type: 'lora', name: `x${id}` }] },
});
const fine = (id) => ({ id, libraryId: id, title: `そのまま${id}`, verdict: 'reproducible' });

function mount(records) {
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), { documentRef: doc });
    panel.setRecords(records);
    return panel;
}

const titles = (panel) => panel.root.allByClass('unbake-col-title')
    .filter(n => n.className === 'unbake-col-title').map(n => n.textContent).filter(Boolean);

test('切っている間は何も絞らない', () => {
    const panel = mount([downloadable('1'), hopeless('2'), fine('3')]);
    assert.equal(titles(panel).length, 3, '切っているのに絞っている');
    const chip = panel.root.byClass('unbake-chip-downloadable');
    assert.ok(chip, '口が無い');
    assert.equal(chip.getAttribute('data-on'), 'false');
});

test('入れると、落とせば試せるものだけになる', async () => {
    const panel = mount([downloadable('1'), hopeless('2'), fine('3')]);
    await panel.root.byClass('unbake-chip-downloadable').dispatch('click', {});
    const shown = titles(panel);
    assert.deepEqual(shown, ['落とせる1'], `絞り方が違う: ${shown}`);
    assert.equal(panel.root.byClass('unbake-chip-downloadable').getAttribute('data-on'), 'true');
});

test('もう一度押すと元に戻る', async () => {
    const panel = mount([downloadable('1'), hopeless('2')]);
    const chip = panel.root.byClass('unbake-chip-downloadable');
    await chip.dispatch('click', {});
    await chip.dispatch('click', {});
    assert.equal(titles(panel).length, 2, '戻っていない');
});

test('判定ではなく不足の中身で決める', async () => {
    // **`approximate` でも足りない素材は在りうるし、`blocked` でも手掛かりが
    // 無ければ落とせない。** 判定で決めると、どちらも取り違える。
    const approximate = {
        id: '9', libraryId: '9', title: '近似だが落とせる', verdict: 'approximate',
        missing: { models: [], resources: [{ type: 'lora', name: 'y', versionId: 55 }] },
    };
    const panel = mount([approximate, hopeless('2')]);
    await panel.root.byClass('unbake-chip-downloadable').dispatch('click', {});
    assert.deepEqual(titles(panel), ['近似だが落とせる']);
});

test('口に印と件数が出る（空の四角にしない）', () => {
    // **何のための口か画面から読めないと、押されない**（2026-08-26 実機で
    // 「現在は何もないです」と報告された）。★（在る）と対になる形にして、
    // 「これは手元に無い」と一目で判るようにする。
    const panel = mount([downloadable('1'), downloadable('2'), hopeless('3')]);
    const chip = panel.root.byClass('unbake-chip-downloadable');
    assert.match(chip.textContent, /⤓/, `印が出ていない: ${JSON.stringify(chip.textContent)}`);
    assert.match(chip.textContent, /2/, '件数が出ていない');
});

test('色帯は既定で出ない（設定で点ける）', () => {
    // **判定の3色に黄と青が加わると賑やかになる。** 要る人だけが点ける。
    const panel = mount([downloadable('1')]);
    assert.equal(panel.root.getAttribute('data-bands'), 'off', '既定で色帯が出ている');
    panel.applyDisplay({ extra_bands: true });
    assert.equal(panel.root.getAttribute('data-bands'), 'on', '設定で点かない');
    panel.applyDisplay({ extra_bands: false });
    assert.equal(panel.root.getAttribute('data-bands'), 'off', '設定で消せない');
});

test('帯の色は、判定の3色と重ねない', () => {
    // **判定は「今どうか」、この2つは「どう扱うか」**で軸が別。
    const css = readFileSync(new URL('../web/panel/theme.css', import.meta.url), 'utf8');
    assert.match(css, /data-bands="on"\][^{]*\.unbake-chip-favorite\s*\{\s*--unbake-chip-band:\s*var\(--unbake-favorite\)/,
        'お気に入りの帯が黄になっていない（または旗の下に閉じていない）');
    assert.match(css, /data-bands="on"\][^{]*\.unbake-chip-downloadable\s*\{\s*--unbake-chip-band:\s*var\(--unbake-info\)/,
        '落とせるの帯が青になっていない（または旗の下に閉じていない）');
    for (const name of ['--unbake-ok', '--unbake-warn', '--unbake-bad']) {
        assert.doesNotMatch(css,
            new RegExp(`\.unbake-chip-(?:favorite|downloadable)\s*\{[^}]*var\(${name}\)`),
            `${name} を使い回している（判定の色と混ざる）`);
    }
});

test('入れたことを覚える', async () => {
    const written = [];
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc,
        settingsIo: { write: async (patch) => { written.push(patch); return { ok: true }; } },
    });
    panel.setRecords([downloadable('1')]);
    await panel.root.byClass('unbake-chip-downloadable').dispatch('click', {});
    assert.equal(written.at(-1)?.downloadable_only, true, '覚えていない');
});

// --- 落とし切っても再現できないものは出さない（2026-08-26 実機）------------

/**
 * **落とせるものと落とせないものが混ざった不足。**
 *
 * 実機の `Civitai_Recipe_72877227` がこの形で、落とせる 1 件・落とせない 3 件。
 * 全部落としても再現できないのに「落とせば試せる」に出ていた。
 */
const mixed = (id) => ({
    id, libraryId: id, title: `混ざり${id}`, verdict: 'blocked',
    missing: { models: [], resources: [
        { type: 'checkpoint', name: `ok${id}`, versionId: 900 + Number(id), isDeleted: false },
        { type: 'lora', name: `ng${id}` },
    ] },
});

test('落とせないものが1件でも残るなら「落とせば試せる」ではない', async () => {
    const panel = mount([downloadable('1'), mixed('2'), fine('3')]);
    await panel.root.byClass('unbake-chip-downloadable').dispatch('click', {});
    const shown = titles(panel);
    assert.deepEqual(shown, ['落とせる1'],
        `落とし切っても再現できないものを出している: ${shown.join(' / ')}`);
});

test('数え方も同じ（釦の数字と中身が食い違わない）', () => {
    // **数字だけ多いと、押してから「少ない」と感じることになる。**
    const panel = mount([downloadable('1'), mixed('2'), fine('3')]);
    const chip = panel.root.byClass('unbake-chip-downloadable');
    assert.match(chip.textContent, /1/, `数字が中身と合っていない: ${chip.textContent}`);
});

test('落とせるものだけなら、今までどおり出る', () => {
    // **全部を止めない。** 遮断が無ければ落とせば試せる。
    const panel = mount([downloadable('1'), downloadable('2')]);
    const chip = panel.root.byClass('unbake-chip-downloadable');
    assert.match(chip.textContent, /2/, `落とせるものまで外している: ${chip.textContent}`);
});
