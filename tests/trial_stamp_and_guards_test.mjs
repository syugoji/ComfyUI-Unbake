/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * **焼いた印に読み手が居ること・書いた旗を見ること・訳が言語に追随すること**
 * （2026-09-01・走査8周目）。
 *
 * 3件とも「**書いた側は正しいのに、その値が誰にも使われていない**」形だった。
 *
 * 1. `recipeTrialRunner` は `extra_pnginfo: { unbake_trial: stamp }` を焼き、
 *    その注記は「これが無いと**どの試行の何番目かが失われる**」と書いている。
 *    ところが `unbake_trial` の読み手は **repo 全体で0件**だった
 *    （`STAMP_SOURCES` にも `outputs.RAW_KEYS` にも無い）。
 * 2. 同じファイルが `job.storage_persisted = this.persist(job)` と書き、
 *    その直前の注記が「**復旧できない状態では投げない**」と言っているのに、
 *    **その旗を誰も読まずに4件投げていた**。
 * 3. `recipeReplayCapability` の `BLOCKER_METADATA` は module 直下で `t()` を呼び、
 *    **読み込み時の言語で訳を凍らせて**いた（`setLocale` はその後に走る）。
 *
 * **綴りではなく挙動で見る。**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stampedRecordId, STAMP_KEYS } from '../web/core/outputAttribution.js';
import { setLocale, t } from '../web/i18n/index.js';

test('試行の印から記録へ辿れる（焼いた印に読み手が居る）', () => {
    const stamp = {
        schema: 'unbake.trial',
        version: 1,
        job_id: 'job-1',
        record_id: '137684933',
        candidate_index: 2,
        seed: 42,
    };
    assert.equal(
        stampedRecordId({ unbake_trial: stamp }), '137684933',
        '試行の印から記録へ辿れない（焼いているのに読み手が居ない）',
    );
    // 文字列で載っている形（PNG のテキストチャンクは文字列）でも読めること。
    assert.equal(stampedRecordId({ unbake_trial: JSON.stringify(stamp) }), '137684933');
});

test('試行の印が、走査へ渡す鍵の表に入っている', () => {
    // **表が1つであること**が要点。ここが漏れると、帰属は出来るのに
    // 走査が値を取ってこないので、結局1枚も当たらない。
    assert.ok(STAMP_KEYS.includes('unbake_trial'),
        '走査が試行の印を取りに行かない（帰属側だけ足しても当たらない）');
});

test('対照: 知らない印は何も返さない', () => {
    assert.equal(stampedRecordId({ unknown_stamp: { record_id: 'x' } }), null);
    assert.equal(stampedRecordId({ unbake_trial: { seed: 1 } }), null,
        'record_id を持たない印から id を捏造している');
});

test('保存できなければ試行を投げない（書いた旗を読む）', async () => {
    const { RecipeTrialRunner } = await import('../web/core/recipeTrialRunner.js');
    const submitted = [];
    const runner = new RecipeTrialRunner({
        objectInfo: {},
        request: async (input) => {
            if (input === '/queue') {
                return { ok: true, status: 200, json: async () => ({ queue_running: [], queue_pending: [] }) };
            }
            submitted.push(input);
            return { ok: true, status: 200, json: async () => ({ prompt_id: 'x' }) };
        },
        analyze: async (record) => ({
            level: 'exact',
            reasons: [],
            audit: { ok: true, failures: [] },
            built: {
                prompt: { 3: { inputs: { seed: record.gen_params.seed } } },
                replayManifest: { manifest_hash: 'hash-1' },
            },
        }),
        now: () => 1_000_000,
        sleep: async () => {},
        randomSeed: () => 7,
        uuid: () => 'uuid-1',
        pollIntervalMs: 0,
        warn: () => {},
        // **保存が塞がれた環境**（容量超過・private mode）を作る。
        writeStored: () => false,
    });

    await assert.rejects(
        () => runner.start({ record: { id: 'rec-1', gen_params: { seed: 42 }, loras: [] } }),
        /could not save the trial job/,
        '保存に失敗したのに投げている',
    );
    assert.deepEqual(
        submitted.filter(url => url === '/prompt'), [],
        '保存に失敗したのに /prompt を投げた（投げた分の行方が判らなくなる）',
    );
    assert.equal(runner.running, false, '走行中のまま残っている');
});

test('再現不可の札が、言語の切り替えに追随する', async () => {
    const module = await import('../web/core/recipeReplayCapability.js');
    // module 直下で `t()` を呼んでいると、ここで捕まえた訳は import 時点の
    // 言語（既定＝英語）で凍る。**使うたびに引いていれば追随する。**
    setLocale('ja');
    const ja = module.blockerMetadata('downloadable');
    setLocale('en');
    const en = module.blockerMetadata('downloadable');
    setLocale('ja');

    assert.equal(ja.blockerLabel, t('core.recipeReplayCapability.6'));
    assert.notEqual(
        ja.blockerLabel, en.blockerLabel,
        '札が言語に追随していない（読み込み時の訳で凍っている）',
    );
});

test('対照: 知らない blocker には札を作らない', async () => {
    const module = await import('../web/core/recipeReplayCapability.js');
    assert.equal(module.blockerMetadata(''), null);
    assert.equal(module.blockerMetadata('nonexistent'), null);
});
