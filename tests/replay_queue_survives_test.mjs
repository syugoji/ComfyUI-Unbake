/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **「時間がかかると次以降の生成が中断される」の正体**（2026-08-27 実機の報告）。
 *
 * 順番待ちの行列は**面の中の変数にしか無い**。だから画面を読み込み直すと、
 * 待っていた分は**一言も無く消える**。
 *
 * **これは絵に描いた餅ではない。** JS を差し替えるたび「Ctrl+F5 してください」と
 * 頼んでいるので、**こちらが更新を配るたびに利用者の待ち行列を落としていた**。
 * 長い生成の裏で何件も並べているときほど、失う量が大きい。
 *
 * もう1つ、**黙って諦める道**が在った。断られ続けて上限（`REPLAY_RETRY_LIMIT`）に
 * 当たった分は、**何も言わずに行列から消えて**いた。押した人からは
 * 「順番待ちだったのに、いつのまにか止まった」にしか見えない。
 *
 * ---
 *
 * **勝手に走らせない**のが要点。読み直したあと自動で投げると、
 * **押していない生成が始まる**——待ち行列を失うより困る。出すのは戻す口だけ。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createUnbakePanel } from '../web/panel/panel.js';
import { fakeDocument } from './fake_dom.mjs';
import { resetMemoryStorage } from '../web/core/storage.js';
import { setLocale } from '../web/i18n/index.js';

setLocale('ja');

const rec = (id) => ({
    id, libraryId: id, title: `Civitai_Recipe_${id}`, verdict: 'reproducible',
    recipe: { id, gen_params: { seed: 1 } },
});

/** 1件目を握ったままにする実行器（後続を待たせるため）。 */
function heldRunner() {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const started = [];
    return {
        release, started,
        makeSweepRunner: (target) => ({
            inputsReady: Promise.resolve(),
            requireEmptyQueue: async () => {},
            run: async () => {
                started.push(String(target?.id ?? target?.recipe?.id));
                await gate;
                return { cells: [] };
            },
        }),
    };
}

function mount(records, io = {}) {
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), { documentRef: doc, ...io });
    panel.setRecords(records);
    return { doc, panel };
}

const replayButtons = (panel) => panel.root.findAll(
    node => String(node.className || '').includes('unbake-act-replay'));
const logLines = (panel) => panel.root.allByClass('unbake-log')
    .flatMap(node => [...node.walk()])
    .map(node => String(node.textContent || '').trim())
    .filter(Boolean);

test('読み込み直した後、失った行列を戻す口が出る（勝手には走らせない）', async () => {
    resetMemoryStorage();
    const first = heldRunner();
    const a = mount([rec('1'), rec('2'), rec('3')], { makeSweepRunner: first.makeSweepRunner });
    const buttons = replayButtons(a.panel);
    buttons[0].dispatch('click', {});
    await new Promise(r => setTimeout(r, 0));
    buttons[1].dispatch('click', {});
    buttons[2].dispatch('click', {});
    await new Promise(r => setTimeout(r, 0));
    // 1件目が握られ、2・3件目が待っている状態。
    assert.deepEqual(first.started, ['1'], '1件目が走っていない（この検査が空振り）');

    // **面ごと作り直す**＝画面の読み込み直しと同じ。
    const second = heldRunner();
    const b = mount([rec('1'), rec('2'), rec('3')], { makeSweepRunner: second.makeSweepRunner });
    const said = logLines(b.panel).some(line => line.includes('2 件') && line.includes('順番待ち'));
    assert.ok(said, `失った行列を知らせていない: ${JSON.stringify(logLines(b.panel).slice(-3))}`);
    // **黙って走り出さない。**
    assert.deepEqual(second.started, [], '押していないのに生成が始まっている');

    first.release();
    second.release();
    await new Promise(r => setTimeout(r, 10));
});

test('戻す口を押すと、待っていた分が並び直す', async () => {
    resetMemoryStorage();
    const first = heldRunner();
    const a = mount([rec('1'), rec('2'), rec('3')], { makeSweepRunner: first.makeSweepRunner });
    const buttons = replayButtons(a.panel);
    buttons[0].dispatch('click', {});
    await new Promise(r => setTimeout(r, 0));
    buttons[1].dispatch('click', {});
    buttons[2].dispatch('click', {});
    await new Promise(r => setTimeout(r, 0));

    const second = heldRunner();
    const b = mount([rec('1'), rec('2'), rec('3')], { makeSweepRunner: second.makeSweepRunner });
    const resume = b.panel.root.find(node => String(node.textContent || '').includes('並べ直す'));
    assert.ok(resume, '戻す口が無い');
    await resume.dispatch('click', {});
    for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(second.started, ['2'], `戻した分が流れていない: ${second.started}`);

    first.release();
    second.release();
    await new Promise(r => setTimeout(r, 10));
});

test('二度目の読み込みでは、同じ知らせを繰り返さない', async () => {
    resetMemoryStorage();
    const first = heldRunner();
    const a = mount([rec('1'), rec('2')], { makeSweepRunner: first.makeSweepRunner });
    const buttons = replayButtons(a.panel);
    buttons[0].dispatch('click', {});
    await new Promise(r => setTimeout(r, 0));
    buttons[1].dispatch('click', {});
    await new Promise(r => setTimeout(r, 0));

    const b = mount([rec('1'), rec('2')], { makeSweepRunner: heldRunner().makeSweepRunner });
    assert.ok(logLines(b.panel).some(line => line.includes('順番待ち')), '1度目で知らせていない');
    const c = mount([rec('1'), rec('2')], { makeSweepRunner: heldRunner().makeSweepRunner });
    assert.ok(!logLines(c.panel).some(line => line.includes('順番待ち')),
        '控えを消していないので、読み直すたびに同じ知らせが出る');

    first.release();
    await new Promise(r => setTimeout(r, 10));
});

test('待つのを諦めたら、必ずそう言う', async () => {
    resetMemoryStorage();
    // **常に断る実行器。** 上限まで並び直したあと、黙って消えないことを見る。
    const { panel } = mount([rec('1')], {
        hostQueue: async () => ({ running: 0, pending: 0 }),
        makeSweepRunner: () => ({
            inputsReady: Promise.resolve(),
            requireEmptyQueue: async () => {},
            run: async () => {
                const error = new Error('busy');
                error.code = 'queue_not_empty';
                throw error;
            },
        }),
    });
    replayButtons(panel)[0].dispatch('click', {});
    for (let i = 0; i < 200; i++) await new Promise(r => setTimeout(r, 0));
    const said = logLines(panel).some(line => line.includes('順番が来ませんでした'));
    assert.ok(said, `諦めたのに黙っている: ${JSON.stringify(logLines(panel).slice(-3))}`);
});
