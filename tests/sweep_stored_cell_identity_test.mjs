/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **保存済みの状態を重ねても、升の身元は今組んだ側のもの**
 * （2026-08-31・監査 I-20260831-06）。
 *
 * `{ ...cell, ...(previous || {}) }` の `previous` は **localStorage の保存済み
 * セル**で、`id` / `labels` / `baseline` を持っている。再固定していたのは
 * `recipe` / `workflow` / `signature` の3つだけなので、**身元まで上書きされて**いた。
 *
 * `storedCells` は署名で引くので、**雛形の軸の値を編集して升の並び位置が変わると、
 * 今の升に前回の別位置の `id` が乗る**。`id` は `cell-NNN` の位置由来
 * （`recipeSweep.js` の `cell-${cells.length + 1}`）なので、新しく増えた升の
 * 素の id と衝突しうる。
 *
 * **`dropCell` は先頭一致で拾う**（`find(item => String(item.id) === id)`）ので、
 * × を押した升とは**別の升が `skipped` になる**。押した升はそのまま投入されて
 * GPU を使い、次の更新で `completed` に戻る——「押したのに勝手に戻った」に見える。
 *
 * 同じ行は `baseline` も上書きするので、`*` の位置だけを動かした編集
 * （値は同じ＝署名も同じ）では**前回の基準が焼き直され**、PNG へ書く `baseline`
 * と画面の基準バッジが宣言と食い違う。
 *
 * **雛形IDは内容ハッシュではない**（`String(template?.id ?? '')`）ので、
 * 軸の値を編集しても保存の鍵は変わらない——だからこの経路は実際に通る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SweepRunner } from '../web/core/sweepRunner.js';

/**
 * 保存済みセルを重ねる所だけを取り出して測る。
 *
 * **原文から切り出す。** 模写すると、直したのは写しの方で実物は壊れたまま、
 * という形になる（この監査で何度も見た型）。
 */
async function mergeStoredCell(cell, previous) {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const source = await readFile(join(root, 'web/core/sweepRunner.js'), 'utf8');

    // **目印は `return` 文そのもの。** 注記の書き方は変わりうるが、
    // 「保存済みを重ねて返す」文の形は変わらない。ここが外れたら赤くなるが、
    // それは正しい——実物を測っていないのに緑、が一番悪い。
    const anchor = [
        '            return {',
        '                ...cell,',
        '                ...(previous || {}),',
    ].join('\n');
    const start = source.indexOf(anchor);
    assert.ok(start > 0, '切り出しの目印が見つからない（実装が動いた）');
    const end = source.indexOf('            };', start);
    assert.ok(end > start, '切り出しの終端が取れない');
    const body = source.slice(start, end + '            };'.length);
    assert.match(body, /previous/, '切り出した所に本体が入っていない');

    const factory = new Function('cell', 'previous', body);
    return factory(cell, previous);
}

const CELL = () => ({
    id: 'cell-003',
    signature: 'sweep-v1-aaaa',
    labels: ['X = highly detailed'],
    baseline: false,
    status: 'pending',
    recipe: { id: 'now' },
    workflow: { prompt: { now: true } },
});

const PREVIOUS = () => ({
    id: 'cell-002',                 // **前回の別位置**
    signature: 'sweep-v1-aaaa',
    labels: ['X = watercolor'],     // 前回の見出し
    baseline: true,                 // 前回の基準
    status: 'pending',
    recipe: { id: 'old' },
    workflow: { prompt: { old: true } },
});

test('升の id は、今組んだ側のものが残る', async () => {
    const merged = await mergeStoredCell(CELL(), PREVIOUS());
    assert.equal(merged.id, 'cell-003',
        `前回の id に上書きされている（× が別の升に効く）: ${merged.id}`);
});

test('見出しと基準も、今組んだ側のものが残る', async () => {
    const merged = await mergeStoredCell(CELL(), PREVIOUS());
    assert.deepEqual(merged.labels, ['X = highly detailed'],
        `前回の見出しが焼き直されている: ${JSON.stringify(merged.labels)}`);
    assert.equal(merged.baseline, false,
        '前回の基準が焼き直されている（PNG の baseline と画面のバッジが食い違う）');
});

test('対照: 進み具合は保存済みの側を引き継ぐ', async () => {
    // **重ねること自体が目的**なので、そこは殺していないこと。
    const previous = { ...PREVIOUS(), status: 'completed', output: { url: '/x.png' } };
    const merged = await mergeStoredCell(CELL(), previous);
    assert.equal(merged.status, 'completed', '保存済みの進み具合を引き継いでいない');
    assert.equal(merged.output?.url, '/x.png', '保存済みの出力を引き継いでいない');
});

test('対照: グラフと記録は今組んだものを使う', async () => {
    const merged = await mergeStoredCell(CELL(), PREVIOUS());
    assert.equal(merged.recipe.id, 'now');
    assert.deepEqual(merged.workflow.prompt, { now: true });
    assert.equal(merged.signature, 'sweep-v1-aaaa');
});

test('対照: 保存済みが無ければ、そのまま返る', async () => {
    const merged = await mergeStoredCell(CELL(), null);
    assert.equal(merged.id, 'cell-003');
    assert.equal(merged.status, 'pending');
});

test('SweepRunner が読める（切り出しが実物と同じ木から来ている）', () => {
    assert.equal(typeof SweepRunner, 'function');
});
