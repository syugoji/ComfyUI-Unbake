/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **自分で焼いた印を、自分で読めること**（`I-20260830-24`）。
 *
 * 読む側の鍵が `unbake_sweep_cell` だったが、**その字で焼く書き手はこの repo に
 * 1つも無い**——`sweepRunner.js` が焼くのは `unbake_sweep` である。つまり
 * Sweep で出した絵を読み直すと「どのセルから出たか」が**必ず消え**、
 * フォークが焼いた古い絵（`lora_manager_sweep`）だけが読めていた。
 *
 * ## なぜ既存の検査が素通りしたか
 *
 * `SWEEP_STAMP_KEYS` を通す検査が0本。帰属側は**別の表**（`STAMP_SOURCES`、
 * こちらは `unbake_sweep` で正しい）を見ているので、表が2本あることに
 * 誰も気づかなかった。
 *
 * ここでは**本物の書き手が作った印を、本物の読み手へ通す**（往復で測る）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SWEEP_STAMP_KEY, SWEEP_STAMP_KEYS, buildRecordFromTextChunks }
    from '../web/core/generationRecord.js';
import { buildSweepStamp } from '../web/core/sweepRunner.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 実物の絵が持つ最小構成（印だけの PNG は無い——必ずグラフも焼かれる）。 */
const PROMPT = JSON.stringify({
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a.safetensors' } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: 'pos', clip: ['1', 1] } },
    5: { class_type: 'KSampler', inputs: {
        seed: 7, steps: 20, cfg: 4, sampler_name: 'euler', scheduler: 'normal',
        model: ['1', 0], positive: ['3', 0] } },
});

test('本物の印が、本物の読み手に読める（往復）', () => {
    const stamp = buildSweepStamp('rec-1', 'tpl-1', 'job-1', { id: 'cell-9' });
    const withStamp = buildRecordFromTextChunks(
        { prompt: PROMPT, [SWEEP_STAMP_KEY]: JSON.stringify(stamp) });
    assert.equal(withStamp.ok, true, `読めない: ${JSON.stringify(withStamp).slice(0, 160)}`);

    // **対照: 印を外すと消えるもの**が、印を付けると出る。これが「読めている」の意味。
    const withoutStamp = buildRecordFromTextChunks({ prompt: PROMPT });
    const a = JSON.stringify(withStamp.record);
    const b = JSON.stringify(withoutStamp.record);
    assert.notEqual(a, b, '印を足しても結果が変わらない（読まれていない）');
    // 読み手が印から組むのは `record.sweep`（job/cell/signature/labels）。
    assert.ok(withStamp.record?.sweep, `sweep が組まれていない: ${a.slice(0, 200)}`);
    assert.equal(withStamp.record.sweep.cellId, 'cell-9', 'セルの id が入っていない');
    assert.equal(withStamp.record.sweep.jobId, 'job-1', 'ジョブの id が入っていない');
    assert.equal(withoutStamp.record?.sweep ?? null, null, '前提: 印が無ければ sweep は空');
});

test('書き手が使う鍵が、読み手の一覧に入っている', () => {
    assert.ok(SWEEP_STAMP_KEYS.includes(SWEEP_STAMP_KEY), '読み手が自分の鍵を見ていない');
});

test('書き手は literal を持たず、読み手の定数を使う', () => {
    // **表を2本にしない。** literal に戻すと、読む側だけが別の字を見る状態へ戻る。
    const runner = fs.readFileSync(path.join(ROOT, 'web/core/sweepRunner.js'), 'utf8');
    assert.match(runner, /import \{ SWEEP_STAMP_KEY \}/, '読み手の定数を輸入していない');
    // **コメントを外してから数える。** 由来の説明に字が出るのは正しい。
    const code = runner.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const literals = [...code.matchAll(/(^|[^A-Za-z_])unbake_sweep\s*:/g)];
    assert.deepEqual(literals.map(m => m[0].trim()), [],
        `書き手が literal の鍵を持っている（${literals.length}箇所）`);
    // 焼く場所は2つ（`extra_data` と `extra_pnginfo`）。**両方が定数を使う。**
    const uses = [...code.matchAll(/\[SWEEP_STAMP_KEY\]\s*:/g)].length;
    assert.equal(uses, 2, `定数で焼いている箇所が ${uses} 個（2 個であるはず）`);
});

test('フォークが焼いた古い印も、引き続き読める', () => {
    // 過去の出力を捨てない。**新しい鍵を足したせいで古いものが読めなくならない。**
    assert.ok(SWEEP_STAMP_KEYS.includes('lora_manager_sweep'),
        '上流の印を読む道が消えている');
});

test('[対照] 書き手のいない鍵を読み手の一覧に置かない', () => {
    // `unbake_sweep_cell` は**書き手がいない幽霊**だった。復活させない。
    // **原文ではなく一覧を見る**——由来を説明するコメントに字が出るのは正しい。
    assert.ok(!SWEEP_STAMP_KEYS.includes('unbake_sweep_cell'),
        '書き手のいない鍵が一覧へ戻っている');
    for (const key of SWEEP_STAMP_KEYS) {
        assert.ok(typeof key === 'string' && key.trim(), `空の鍵が混ざっている: ${JSON.stringify(key)}`);
    }
});
