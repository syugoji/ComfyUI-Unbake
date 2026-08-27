/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **足りないノードは ComfyUI に教えてもらう**（2026-08-26 利用者の指示）。
 *
 * 入れ方を Unbake が真似る必要は無い。**元のグラフを ComfyUI へ落とせば、
 * Workflow Overview が足りないノードを並べ、入れる導線まで出す。**
 * こちらがするのは「そこへ連れて行く」ことだけ。
 *
 * ## 作り物は、走者の**実物の形**に合わせること
 *
 * ここは2回外した。原因はどちらも**存在しない場所から読んでいた**ことで、
 * **検査の作り物が自分の思い込みどおりだったので緑のまま**だった:
 *
 *   1回目: `job.warnings` ——そんな鍵は無い
 *   2回目: `job.cells[].workflow.warnings` ——走者は返す前に `workflow` と
 *          `recipe` を**明示的に落としている**（`serializableJob`）
 *
 * 実測（`SweepRunner` を実物の記録で回して鍵を数えた・2026-08-26）:
 *
 *   計画（`preflight`）のセル = id, labels, selections, seed, baseline,
 *                               signature, status, recipe, **workflow**
 *   走り終わったセル          = そこから recipe と workflow を**抜いたもの**
 *
 * だから下の作り物は、**走者が `workflow` を返さない**形にしてある。
 * 戻してしまうと、また存在しない場所を読んでも緑になる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUnbakePanel } from '../web/panel/panel.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale, t } from '../web/i18n/index.js';

setLocale('ja');

const record = { id: '1', libraryId: '1', title: 'r1', verdict: 'approximate' };

const MISSING_NODE_WARNING = t('core.recipeWorkflowBuilder.49', {
    p1: t('core.recipeWorkflowBuilder.46', { p1: 'SuperSamplerXYZ_NotInstalled' }),
});

/**
 * 実物どおりの走者。
 * - `preflight` は **`workflow` を持つ**セルを返す（注意書きはここに在る）
 * - `run` は **`workflow` を持たない**セルを返す（走者が落とすため）
 */
function runnerWith(warnings) {
    return () => ({
        preflight: () => ({
            cells: [{
                id: 'c1', labels: [], selections: {}, seed: 1, baseline: true,
                signature: 's', status: 'pending', recipe: {},
                workflow: { prompt: {}, warnings },
            }],
        }),
        run: async () => ({
            // **`workflow` も `recipe` も無い。** これが実物の形。
            cells: [{
                id: 'c1', labels: [], selections: {}, seed: 1, baseline: true,
                signature: 's', status: 'completed',
            }],
        }),
    });
}

function mount(io = {}) {
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc,
        loadRecord: async () => ({
            gen_params: { seed: 1, prompt: 'a' },
            checkpoint: { file_name: 'c.safetensors' }, loras: [],
        }),
        makeSweepRunner: runnerWith([MISSING_NODE_WARNING]),
        loadVariants: async () => ({ outputs: [] }),
        loadFreshOutputs: async () => [],
        ...io,
    });
    panel.setRecords([record]);
    return panel;
}

test('足りないノードが在れば、ComfyUI で開く導線を出す', async () => {
    const panel = mount({ openInComfy: async () => ({ ok: true, how: 'ui' }) });
    const button = panel.root.findAll(n => n.className === 'unbake-act unbake-act-replay')[0];
    await button.dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.match(panel.root.text, /Workflow Overview/,
        `導線が出ていない: ${panel.root.text.slice(-300)}`);
});

test('走者が返す姿では読めない（＝計画から読んでいる）', async () => {
    /*
     * **この検査がこの回の要。** 走り終わったセルには `workflow` が無いので、
     * そちらだけを見ていると**永久に出ない**——実機でまさにそうだった。
     */
    const panel = mount({
        openInComfy: async () => ({ ok: true }),
        makeSweepRunner: () => ({
            preflight: () => ({ cells: [{ signature: 's', workflow: { prompt: {}, warnings: [MISSING_NODE_WARNING] } }] }),
            // 走り終わりは `workflow` を持たない（実物どおり）。
            run: async () => ({ cells: [{ signature: 's', status: 'completed' }] }),
        }),
    });
    const button = panel.root.findAll(n => n.className === 'unbake-act unbake-act-replay')[0];
    await button.dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.match(panel.root.text, /Workflow Overview/,
        `走り終わりの姿しか見ていない: ${panel.root.text.slice(-300)}`);
});

test('足りないノードが無ければ、余計な導線を出さない', async () => {
    const panel = mount({
        openInComfy: async () => ({ ok: true }),
        makeSweepRunner: runnerWith(['なにか別の注意']),
    });
    const button = panel.root.findAll(n => n.className === 'unbake-act unbake-act-replay')[0];
    await button.dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.doesNotMatch(panel.root.text, /Workflow Overview/,
        '足りないノードが無いのに導線を出している');
});

test('開く口が無い環境では出さない', async () => {
    // **押しても何も起きない口を置かない。**
    const panel = mount({ openInComfy: null });
    const button = panel.root.findAll(n => n.className === 'unbake-act unbake-act-replay')[0];
    await button.dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.doesNotMatch(panel.root.text, /Workflow Overview/);
});
