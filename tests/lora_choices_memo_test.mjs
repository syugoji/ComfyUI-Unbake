/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * `objectInfo` から出す LoRA の選択肢を、**同じ物なら計算し直さない**
 * （`I-20260829-02`）。
 *
 * ここは記録1件ごとに `objectInfo` の**全ノード型**を舐めていた。費目が
 * 「記録の数 × 利用者が入れた拡張の数」に比例していて、記録と関係のないものが
 * 効いている。**鍵は物の同一性**（`WeakMap`）なので、控えが古くなる余地は無い
 * ——別の `/object_info` を取れば別の物になり、そこで自動的に外れる。
 *
 * **陳腐化しないことは、しないと言うだけでは守れない**ので、
 *
 *   1. 同じ物なら同じ配列（＝計算していない）
 *   2. 中身が同じでも**別の物**なら計算し直す
 *   3. 返す配列は凍っている（呼び手が書き換えたら次の記録が巻き添えになる）
 *
 * を機械で見る。あわせて、**その場で書き換えたら古い答えが残る**という前提も
 * 検査として書いておく——これは欠陥ではなく制約で、書いておかないと次に
 * 読む人が「なぜか反映されない」を不具合として追いかける。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loraChoices } from '../web/core/recipeReplayCapability.js';

/** 実物の形（`/object_info` の一部）。 */
const objectInfoWith = (values) => ({
    KSampler: { input: { required: { seed: ['INT', {}] } } },
    LoraLoader: { input: { required: { lora_name: [values, {}] } } },
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [['a.safetensors'], {}] } } },
});

test('選択肢を拾えている（前提）', () => {
    const info = objectInfoWith(['x.safetensors', 'y.safetensors']);
    assert.deepEqual([...loraChoices(info)], ['x.safetensors', 'y.safetensors']);
});

test('同じ物なら計算し直さない（返る配列が同一）', () => {
    const info = objectInfoWith(['x.safetensors']);
    const first = loraChoices(info);
    const second = loraChoices(info);
    assert.equal(first, second, '同じ物なのに計算し直している');
});

test('[対照] 中身が同じでも別の物なら計算し直す', () => {
    // **これが無いと「常に同じ配列を返す」でも上の検査は通る。**
    const a = objectInfoWith(['x.safetensors']);
    const b = objectInfoWith(['x.safetensors']);
    assert.notEqual(loraChoices(a), loraChoices(b), '別の物なのに使い回している');
    assert.deepEqual([...loraChoices(a)], [...loraChoices(b)], '答えが食い違っている');
});

test('モデルを入れ替えた別の物には、新しい一覧が出る', () => {
    // 実際の外れ方はこれ——ホストが `/object_info` を取り直すと別の物になる。
    const before = objectInfoWith(['x.safetensors']);
    const after = objectInfoWith(['x.safetensors', 'z.safetensors']);
    assert.deepEqual([...loraChoices(before)], ['x.safetensors']);
    assert.deepEqual([...loraChoices(after)], ['x.safetensors', 'z.safetensors']);
});

test('返る配列は凍っている（呼び手が書き換えられない）', () => {
    const info = objectInfoWith(['x.safetensors']);
    const choices = loraChoices(info);
    assert.ok(Object.isFrozen(choices), '凍っていない');
    assert.throws(() => choices.push('intruder.safetensors'), TypeError);
    assert.deepEqual([...loraChoices(info)], ['x.safetensors'], '控えが汚れている');
});

test('その場で書き換えると古い答えが残る（制約を明示する）', () => {
    // **不具合ではなく前提。** ホストは応答を持ち回るだけで書き換えない。
    // 書き換える人が現れたらここが赤くなり、前提が破れたことに気づける。
    const info = objectInfoWith(['x.safetensors']);
    assert.deepEqual([...loraChoices(info)], ['x.safetensors']);
    info.LoraLoader.input.required.lora_name = [['x.safetensors', 'w.safetensors'], {}];
    assert.deepEqual([...loraChoices(info)], ['x.safetensors'],
        'その場の書き換えが反映されている（前提が変わった＝この検査を書き直すこと）');
});

test('objectInfo が無い・形が違うときは空で返す（落とさない）', () => {
    for (const bad of [null, undefined, 'x', 42]) {
        assert.deepEqual([...loraChoices(bad)], []);
    }
});
