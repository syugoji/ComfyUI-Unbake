/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * **値が読めなかった定数ノードを畳まないこと**（2026-09-01・走査13周目）。
 *
 * `inlineLegacyConstants` は `Int` / `Float` / `String` の定数ノードを
 * 消費側へ埋め込んでから**元のノードを消す**。値は
 * `Number` / `number` / `value` / `String` / `string` のどれかから読む。
 *
 * **番人が `int` / `float` にしか無かった。** `string` は値の鍵を1つも持たない
 * とき `raw` が `undefined` のまま畳まれ、
 *
 *   - 消費側の入力が `undefined` になる → **JSON にすると鍵ごと消える**
 *   - `CLIPTextEncode` が `text` を失い、ComfyUI が投入を拒否する
 *   - **元のノードは削除済み**なので値は復元できない
 *   - 警告は「N個の定数を畳みました」＝**成功に見える**
 *
 * 同じ形の `Int` は番人が効いて無傷だった。**片方の兄弟にしか当たっていない**
 * ——このパッケージが繰り返す型。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inlineLegacyConstants } from '../web/core/recipeWorkflowBuilder.js';

/** 消費側が入力を保っているか（`undefined` は JSON で消えるので鍵の有無で見る）。 */
function consumerInput(prompt, id, key) {
    const inputs = prompt?.[id]?.inputs || {};
    return Object.prototype.hasOwnProperty.call(inputs, key) ? inputs[key] : '<鍵ごと消えた>';
}

test('値の鍵が想定外の String は畳まない（消費側の入力を壊さない）', () => {
    const prompt = {
        1: { class_type: 'String', inputs: { text: 'hello' } },
        2: { class_type: 'CLIPTextEncode', inputs: { text: ['1', 0] } },
    };
    const warnings = [];
    inlineLegacyConstants(prompt, warnings);

    assert.deepEqual(
        consumerInput(prompt, 2, 'text'), ['1', 0],
        '読めない値で畳んで、消費側の入力を壊している',
    );
    assert.ok(prompt['1'], '値を読めていないのに元のノードを消している（復元できない）');
    assert.deepEqual(warnings, [], 'やっていないことを「畳みました」と言っている');
});

test('対照: 同じ形の Int は前から守られている', () => {
    const prompt = {
        1: { class_type: 'Int', inputs: { text: 5 } },
        2: { class_type: 'KSampler', inputs: { steps: ['1', 0] } },
    };
    inlineLegacyConstants(prompt, []);
    assert.deepEqual(consumerInput(prompt, 2, 'steps'), ['1', 0]);
    assert.ok(prompt['1']);
});

test('対照: 値が読める String は今までどおり畳む', () => {
    for (const key of ['String', 'string', 'value']) {
        const prompt = {
            1: { class_type: 'String', inputs: { [key]: 'hello' } },
            2: { class_type: 'CLIPTextEncode', inputs: { text: ['1', 0] } },
        };
        const warnings = [];
        inlineLegacyConstants(prompt, warnings);
        assert.equal(consumerInput(prompt, 2, 'text'), 'hello', `${key} から読めていない`);
        assert.equal(prompt['1'], undefined, '畳んだのに元のノードが残っている');
        assert.equal(warnings.length, 1, '畳んだことを言っていない');
    }
});

test('対照: 値が読める Int / Float も今までどおり', () => {
    const prompt = {
        1: { class_type: 'Int', inputs: { value: '7' } },
        2: { class_type: 'Float', inputs: { number: '1.5' } },
        3: { class_type: 'KSampler', inputs: { steps: ['1', 0], cfg: ['2', 0] } },
    };
    inlineLegacyConstants(prompt, []);
    assert.equal(prompt['3'].inputs.steps, 7);
    assert.equal(prompt['3'].inputs.cfg, 1.5);
});

test('対照: 空文字は「読めた」——0 や null と混ぜない', () => {
    // `''` は値として記録されうる（負のプロンプトが空、など）。
    // **`undefined` / `null` だけを「読めなかった」とする。**
    const prompt = {
        1: { class_type: 'String', inputs: { value: '' } },
        2: { class_type: 'CLIPTextEncode', inputs: { text: ['1', 0] } },
    };
    inlineLegacyConstants(prompt, []);
    assert.equal(consumerInput(prompt, 2, 'text'), '', '空文字を「読めなかった」に混ぜている');
});

test('対照: 定数ノードが無ければ何もしない', () => {
    const prompt = { 1: { class_type: 'KSampler', inputs: { steps: 20 } } };
    const warnings = [];
    inlineLegacyConstants(prompt, warnings);
    assert.deepEqual(prompt, { 1: { class_type: 'KSampler', inputs: { steps: 20 } } });
    assert.deepEqual(warnings, []);
});
