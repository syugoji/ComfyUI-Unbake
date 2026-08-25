/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 工程3 — **束で回す**ための3つ。
 *
 *  1. **門は投入の直前**（手順12）。判定を作り直さず、表を読むだけ
 *  2. **単位は「まだ出していない条件」**（手順13）。記録ではない
 *  3. **並べ替えは絞り込みの後**（手順14）。**2つの効果を足し算しない**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    buildBatch, checkpointLoadCount, checkpointOf, gateForSubmission,
    orderByCheckpoint, pendingConditions,
} from '../web/core/batchQueue.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const rec = (id, verdict, checkpoint) => ({ id, libraryId: id, verdict, checkpoint });

// --- ① 門 ------------------------------------------------------------------

test('遮断された記録を投げない。未判定も投げない', () => {
    const { ready, blocked, pending } = gateForSubmission([
        rec('a', 'reproducible', 'ck1'),
        rec('b', 'approximate', 'ck1'),
        rec('c', 'blocked', 'ck2'),
        rec('d', 'pending', 'ck2'),
    ]);
    assert.deepEqual(ready.map(r => r.id), ['a', 'b']);
    assert.deepEqual(blocked.map(r => r.id), ['c']);
    // **`pending` は「まだ組んでいない」で「不足」とは別。** 投げないが、
    // 落としたのとも別に数える——理由が違えば打つ手も違う。
    assert.deepEqual(pending.map(r => r.id), ['d']);
});

test('門は判定を作り直さず、記録に写っている値だけを読む', async () => {
    // 独自に判定すると「一覧では再現可なのに投げると弾かれる」が起きる。
    const source = await readFile(join(ROOT, 'web/core/batchQueue.js'), 'utf8');
    assert.doesNotMatch(source, /analyzeRecipeReplayCapability|buildRecipeWorkflow/,
        '門が自前で判定している（表を読むだけにすること）');
});

// --- ② 単位は「まだ出していない条件」 ---------------------------------------

test('既に出ている条件は並ばない', () => {
    const done = { 'rec-a': ['s1', 's2'] };
    assert.deepEqual(
        pendingConditions(rec('rec-a', 'reproducible', 'ck'), ['s1', 's2', 's3'], id => done[id] || []),
        ['s3'],
    );
    assert.deepEqual(
        pendingConditions(rec('rec-b', 'reproducible', 'ck'), ['s1'], id => done[id] || []),
        ['s1'],
    );
});

test('全部出ている記録は束から外れる（が、数には残る）', () => {
    const records = [rec('a', 'reproducible', 'ck1'), rec('b', 'reproducible', 'ck1')];
    const batch = buildBatch(records, {
        stampedSignatures: id => (id === 'a' ? ['s1'] : []),
        wantedSignaturesOf: () => ['s1'],
    });
    assert.deepEqual(batch.items.map(item => item.id), ['b']);
    assert.equal(batch.skipped.alreadyDone, 1, '飛ばした件数が出ていない');
    assert.deepEqual(batch.items[0].pendingSignatures, ['s1']);
});

// --- ③ 並べ替え -------------------------------------------------------------

test('同じ checkpoint をまとめ、モデル内の順序は変えない', () => {
    const records = [
        rec('1', 'reproducible', 'B'), rec('2', 'reproducible', 'A'),
        rec('3', 'reproducible', 'B'), rec('4', 'reproducible', 'A'),
    ];
    assert.deepEqual(orderByCheckpoint(records).map(r => r.id), ['2', '4', '1', '3']);
});

test('checkpoint が不明なものは最後（判っている分の連続を切らない）', () => {
    const records = [rec('1', 'reproducible', null), rec('2', 'reproducible', 'A'), rec('3', 'reproducible', 'A')];
    assert.deepEqual(orderByCheckpoint(records).map(r => r.id), ['2', '3', '1']);
});

test('ロード回数は種類の数ではなく切り替わった回数', () => {
    // 飛び飛びに現れると、種類が2つでもロードは4回になる。
    assert.equal(checkpointLoadCount([
        rec('1', 'x', 'A'), rec('2', 'x', 'B'), rec('3', 'x', 'A'), rec('4', 'x', 'B'),
    ]), 4);
    assert.equal(checkpointLoadCount([
        rec('1', 'x', 'A'), rec('3', 'x', 'A'), rec('2', 'x', 'B'), rec('4', 'x', 'B'),
    ]), 2);
    assert.equal(checkpointLoadCount([]), 0);
});

test('checkpoint は文字列でもオブジェクトでも読める', () => {
    assert.equal(checkpointOf({ checkpoint: 'ck.safetensors' }), 'ck.safetensors');
    assert.equal(checkpointOf({ checkpoint: { file_name: 'ck.safetensors' } }), 'ck.safetensors');
    assert.equal(checkpointOf({}), '');
});

test('絞り込みと並べ替えの効果を、足し算できない形で返す', () => {
    // **これが手順14の本体。** 段ごとの値をそのまま返すので、
    // 呼び手が「N回減った＋M回減った」と足す余地が無い。
    const records = [
        rec('1', 'reproducible', 'A'), rec('2', 'blocked', 'B'),
        rec('3', 'reproducible', 'B'), rec('4', 'reproducible', 'A'),
        rec('5', 'blocked', 'A'),
    ];
    const batch = buildBatch(records, {
        stampedSignatures: () => [],
        wantedSignaturesOf: () => ['s1'],
    });
    // 何もしないとき / 絞った後 / 並べ替えた後 の3つが順に返る。
    assert.equal(batch.loads.all, checkpointLoadCount(records));
    assert.ok(batch.loads.filtered <= batch.loads.all);
    assert.ok(batch.loads.ordered <= batch.loads.filtered);
    // **最終値は1つ。** 2つの削減量を足すと、元の回数を超えることすらある
    // （実データで 305回に対し「498回減った」になった）。
    const naive = (batch.loads.all - checkpointLoadCount(orderByCheckpoint(records)))
        + (batch.loads.all - batch.loads.filtered);
    const actual = batch.loads.all - batch.loads.ordered;
    assert.ok(naive >= actual, '足し算のほうが小さい＝この検査が意味を成していない');
});
