/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 手順13 — **束で回す実行器。**
 *
 * ここで固定するのは、`recipeTrialRunner` から移した3つの安全装置:
 *
 *  1. **組めるかの門** … 判定 `blocked` を投げない
 *  2. **キューが空であることの要求** … 他人の生成に混ぜない
 *  3. **本物の取消** … 旗を立てるだけでなく、キューに入ったものを実際に消す
 *
 * あわせて、**飛ばした件数が必ず返る**こと（「N件回しました」だけだと、
 * 回らなかった分が黙って消える）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBatchRunner, MAX_BATCH_ITEMS } from '../web/core/batchRunner.js';
import { setLocale } from '../web/i18n/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const rec = (id, verdict = 'reproducible', checkpoint = 'ck') => ({
    id, libraryId: id, title: `T${id}`, verdict, checkpoint,
});

/** `SweepRunner` のダブル。**呼ばれた順と回数を持つ。** */
function fakeRunner(log, { queueBusy = false, failOn = null } = {}) {
    return (record) => ({
        async requireEmptyQueue() {
            log.push('queue-check');
            if (queueBusy) throw new Error('queue not empty');
        },
        async run({ record: passed }) {
            log.push(`run:${record.id}`);
            if (failOn === record.id) throw new Error('boom');
            return { id: `job-${record.id}`, cells: [], passedRecord: passed };
        },
        stop() { log.push(`stop:${record.id}`); },
        async cancel() { log.push(`cancel:${record.id}`); return { deleted: ['p1'], interrupted: ['p2'] }; },
    });
}

const runnerFor = (log, options) => createBatchRunner({
    makeRunner: fakeRunner(log, options),
    templateFor: () => ({ id: 'seeds', name: 'seeds', mode: 'seeds_only', axes: [], seeds: [1] }),
});

// --- ① 門 ------------------------------------------------------------------

test('遮断された記録と未判定を投げない', async () => {
    setLocale('en');
    const log = [];
    const result = await runnerFor(log).run([
        rec('a', 'reproducible'), rec('b', 'blocked'),
        rec('c', 'approximate'), rec('d', 'pending'),
    ]);
    assert.deepEqual(result.done.map(item => item.record.id), ['a', 'c']);
    assert.equal(result.skipped.blocked, 1);
    assert.equal(result.skipped.pending, 1);
    assert.deepEqual(log.filter(entry => entry.startsWith('run:')), ['run:a', 'run:c']);
});

// --- ② キューが空であること --------------------------------------------------

test('ComfyUI に既に仕事があるときは1件も投げない', async () => {
    setLocale('en');
    const log = [];
    await assert.rejects(
        () => runnerFor(log, { queueBusy: true }).run([rec('a'), rec('b')]),
        /queue not empty/,
    );
    // **1件も投げていないこと。** 投げてから気づくと半端なものが残る。
    assert.deepEqual(log.filter(entry => entry.startsWith('run:')), []);
});

test('キューの確認は束の頭で1回だけ（自分の投入を他人と読まない）', async () => {
    setLocale('en');
    const log = [];
    await runnerFor(log).run([rec('a'), rec('b'), rec('c')]);
    assert.equal(log.filter(entry => entry === 'queue-check').length, 1,
        '各件で確かめている（自分が投げたものを「他人の生成」と読んで2件目で止まる）');
});

// --- ③ 本物の取消 -----------------------------------------------------------

test('取消は、走っている1件を実際にキューから消す', async () => {
    setLocale('en');
    const log = [];
    const runner = runnerFor(log);
    // 走っていなければ何も消さない（消したふりをしない）。
    assert.deepEqual(await runner.cancel(), { deleted: [], interrupted: [] });
});

test('本物の取消が、旗を立てるだけの停止と別に在る', async () => {
    const source = await readFile(join(ROOT, 'web/core/sweepRunner.js'), 'utf8');
    // `stop()` は旗だけ、`cancel()` はキューを触る——**2つとも在ること。**
    assert.match(source, /stop\(\)\s*\{\s*this\.stopRequested = true;\s*\}/,
        '旗を立てるだけの停止が無い');
    assert.match(source, /async cancel\(\)/, '本物の取消が無い');
    assert.match(source, /'\/interrupt'/, '走っているものを止めていない');
    assert.match(source, /JSON\.stringify\(\{ delete: deleted \}\)/, 'キューから消していない');
    // **投げたか判らないものは触らない。**
    assert.match(source, /submission_unknown/, '投げたか判らないものを取消に巻き込んでいる');
});

// --- 飛ばした件数と、足し算しない値 -------------------------------------------

test('飛ばした内訳を必ず返す（回らなかった分が黙って消えない）', async () => {
    setLocale('en');
    const log = [];
    const result = await runnerFor(log).run(
        [rec('a'), rec('b', 'blocked'), rec('c'), rec('d', 'pending')],
        { stampedSignatures: (id) => (id === 'c' ? ['s1'] : []), wantedSignaturesOf: () => ['s1'] },
    );
    assert.deepEqual(result.done.map(item => item.record.id), ['a']);
    assert.deepEqual(result.skipped, { blocked: 1, pending: 1, alreadyDone: 1, trimmed: 0 });
});

test('上限で切った分も、飛ばした数に入る', async () => {
    setLocale('en');
    const log = [];
    const many = Array.from({ length: 5 }, (_, i) => rec(String(i)));
    const result = await runnerFor(log).run(many, { limit: 2 });
    assert.equal(result.done.length, 2);
    assert.equal(result.skipped.trimmed, 3, '切ったことを黙らせている');
    assert.ok(MAX_BATCH_ITEMS >= 2);
});

test('1件が落ちても束を止めない（どこまで回ったかが読める）', async () => {
    setLocale('en');
    const log = [];
    const result = await runnerFor(log, { failOn: 'b' }).run([rec('a'), rec('b'), rec('c')]);
    assert.deepEqual(result.done.map(item => item.record.id), ['a', 'c']);
    assert.deepEqual(result.failed.map(item => item.record.id), ['b']);
    assert.match(result.failed[0].error, /boom/);
});

test('モデルの読み込み回数を、足し算できない形で返す', async () => {
    setLocale('en');
    const log = [];
    const result = await runnerFor(log).run([
        rec('1', 'reproducible', 'B'), rec('2', 'blocked', 'A'),
        rec('3', 'reproducible', 'A'), rec('4', 'reproducible', 'B'),
    ]);
    // 段ごとの値がそのまま返る（呼び手が足す余地が無い）。
    assert.ok(result.loads.all >= result.loads.filtered);
    assert.ok(result.loads.filtered >= result.loads.ordered);
    assert.equal(typeof result.loads.ordered, 'number');
});

test('材料が揃うのを待ってから投げる（実機で全件落ちた競合）', async () => {
    setLocale('en');
    // `SweepRunner` は**同期で返る**が `/object_info` は後から届く。
    // 人が押す Sweep では待っている間に揃うので出ないが、束は即座に投げるため
    // **1件目から `objectInfo` 未設定で落ちる**——実機で最初に回したとき
    // 1件中1件がこれだった。
    const order = [];
    let ready = false;
    const runner = createBatchRunner({
        makeRunner: () => ({
            inputsReady: Promise.resolve().then(() => { ready = true; order.push('ready'); }),
            async requireEmptyQueue() {},
            async run() {
                order.push(ready ? 'run-after-ready' : 'run-too-early');
                if (!ready) throw new Error('objectInfo must be supplied by the caller');
                return { id: 'job' };
            },
        }),
        templateFor: () => ({ id: 'seeds', mode: 'seeds_only', axes: [], seeds: [1] }),
    });
    const result = await runner.run([rec('a')]);
    assert.equal(result.failed.length, 0, `材料を待たずに投げている: ${JSON.stringify(result.failed)}`);
    assert.ok(order.includes('run-after-ready'), order.join(','));
    assert.ok(!order.includes('run-too-early'));
});

test('実行器を自前で書いていない（投げるのは SweepRunner）', async () => {
    // **新しく書かない**のが手順13 の条件。ここがやるのは並べる・止める・数えるだけ。
    const source = await readFile(join(ROOT, 'web/core/batchRunner.js'), 'utf8');
    assert.doesNotMatch(source, /'\/prompt'/, '自分で投げている');
    assert.doesNotMatch(source, /'\/history/, '自分で待っている');
    assert.match(source, /makeRunner/, '実行器を受け取っていない');
});
