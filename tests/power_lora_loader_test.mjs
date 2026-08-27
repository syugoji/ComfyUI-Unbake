/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **束ねる LoRA ノードを、落とさずに開く**（2026-08-26 実機の報告）。
 *
 * `civitai_139981506` は `Power Lora Loader (rgthree)` で **7本の LoRA を
 * 束ねて**いた。ノードが無いと丸ごと落ちるので、**まったく違う絵**になる
 * （利用者の報告「かなり異なる画像が生成された」）。
 *
 * このノードは `lora_N` を順に適用して `MODEL` と `CLIP` を返すだけなので、
 * `LoraLoader` の数珠つなぎと**同じ計算**になる。だから変換してよい。
 *
 * 下の形は**実物**（`civitai_139981506` の node 271）から採った。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandPowerLoraLoader, packsFor } from '../web/core/recipeWorkflowBuilder.js';

/** `LoraLoader` は在るが、束ねるノードは無い環境。 */
const OBJECT_INFO = { LoraLoader: {}, KSampler: {}, CheckpointLoaderSimple: {} };

function realPrompt() {
    return {
        44: { class_type: 'UNETLoader', inputs: { unet_name: 'anima.safetensors' } },
        45: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen.safetensors' } },
        271: {
            class_type: 'Power Lora Loader (rgthree)',
            inputs: {
                PowerLoraLoaderHeaderWidget: { type: 'PowerLoraLoaderHeaderWidget' },
                lora_1: { on: true, lora: 'cunny_animaV1.0-000009.safetensors', strength: 0.5 },
                lora_2: { on: true, lora: 'anima-base-1-painterly-v2.safetensors', strength: 0.5 },
                // **切ってある。** 効かせてはいけない。
                lora_8: { on: false, lora: 'anima-turbo-lora-v0.2.safetensors', strength: 1 },
                '➕ Add Lora': '',
                model: ['44', 0],
                clip: ['45', 0],
            },
        },
        // MODEL を使う相手と CLIP を使う相手。
        300: { class_type: 'KSampler', inputs: { model: ['271', 0], seed: 1 } },
        301: { class_type: 'CLIPTextEncode', inputs: { clip: ['271', 1], text: 'a' } },
    };
}

test('切ってある LoRA を効かせない', () => {
    const prompt = realPrompt();
    const got = expandPowerLoraLoader(prompt, OBJECT_INFO);
    assert.equal(got.converted, 2, `本数が違う: ${got.converted}`);
    assert.deepEqual(got.loras, [
        'cunny_animaV1.0-000009.safetensors',
        'anima-base-1-painterly-v2.safetensors',
    ]);
    const names = Object.values(prompt)
        .filter(node => node.class_type === 'LoraLoader')
        .map(node => node.inputs.lora_name);
    assert.ok(!names.includes('anima-turbo-lora-v0.2.safetensors'),
        '切ってある LoRA を効かせている');
});

test('順に数珠つなぎになる（順番が効き方を決める）', () => {
    const prompt = realPrompt();
    expandPowerLoraLoader(prompt, OBJECT_INFO);
    const loaders = Object.entries(prompt)
        .filter(([, node]) => node.class_type === 'LoraLoader')
        .sort((a, b) => Number(a[0]) - Number(b[0]));
    assert.equal(loaders.length, 2);
    const [firstId, first] = loaders[0];
    const [, second] = loaders[1];
    // 1本目は元の model/clip から、2本目は1本目から。
    assert.deepEqual(first.inputs.model, ['44', 0]);
    assert.deepEqual(first.inputs.clip, ['45', 0]);
    assert.deepEqual(second.inputs.model, [firstId, 0]);
    assert.deepEqual(second.inputs.clip, [firstId, 1]);
});

test('元のノードを指していた線を、連鎖の端へ付け替える', () => {
    const prompt = realPrompt();
    expandPowerLoraLoader(prompt, OBJECT_INFO);
    assert.equal(prompt['271'], undefined, '束ねるノードが残っている');
    const lastId = Object.entries(prompt)
        .filter(([, node]) => node.class_type === 'LoraLoader')
        .sort((a, b) => Number(b[0]) - Number(a[0]))[0][0];
    // 0番は MODEL、1番は CLIP。**取り違えると線がずれる。**
    assert.deepEqual(prompt['300'].inputs.model, [lastId, 0]);
    assert.deepEqual(prompt['301'].inputs.clip, [lastId, 1]);
});

test('効き目をそのまま写す', () => {
    const prompt = realPrompt();
    prompt['271'].inputs.lora_1.strength = 0.75;
    // rgthree は CLIP 側を別に持てる。**在ればそちらを使う。**
    prompt['271'].inputs.lora_2.strengthTwo = 0.25;
    expandPowerLoraLoader(prompt, OBJECT_INFO);
    const loaders = Object.entries(prompt)
        .filter(([, node]) => node.class_type === 'LoraLoader')
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([, node]) => node.inputs);
    assert.equal(loaders[0].strength_model, 0.75);
    assert.equal(loaders[0].strength_clip, 0.75, '別の値が無ければ両方同じ');
    assert.equal(loaders[1].strength_model, 0.5);
    assert.equal(loaders[1].strength_clip, 0.25, 'CLIP 側の値を使っていない');
});

test('LoraLoader が無ければ触らない', () => {
    // **置き換え先が無いのに崩すと、元のグラフより悪くなる。**
    const prompt = realPrompt();
    const got = expandPowerLoraLoader(prompt, { KSampler: {} });
    assert.equal(got.converted, 0);
    assert.ok(prompt['271'], '置き換え先が無いのに壊している');
});

test('LoRA が1本も入っていなければ、素通りさせる', () => {
    const prompt = realPrompt();
    prompt['271'].inputs.lora_1.on = false;
    prompt['271'].inputs.lora_2.on = false;
    expandPowerLoraLoader(prompt, OBJECT_INFO);
    assert.equal(prompt['271'], undefined);
    // **線を切らない。** 元の model/clip へ直結する。
    assert.deepEqual(prompt['300'].inputs.model, ['44', 0]);
    assert.deepEqual(prompt['301'].inputs.clip, ['45', 0]);
});

test('None は入れない', () => {
    const prompt = realPrompt();
    prompt['271'].inputs.lora_2.lora = 'None';
    const got = expandPowerLoraLoader(prompt, OBJECT_INFO);
    assert.equal(got.converted, 1, '空の LoRA を入れている');
});

// --- A: どのパックを入れればよいか -------------------------------------------

test('入れるべきパックの名前が出る', () => {
    // 「不足ノード: X」だけでは、**何を入れればよいか判らない**。
    assert.deepEqual(packsFor(['Power Lora Loader (rgthree)']), ['rgthree-comfy']);
    assert.deepEqual(packsFor(['JoinStringMulti']), ['ComfyUI-KJNodes']);
    // 同じパックの複数ノードは1つに畳む。
    assert.deepEqual(
        packsFor(['Power Lora Loader (rgthree)', 'Display Any (rgthree)']),
        ['rgthree-comfy']);
});

test('判らないものは黙る（推測で名前を出さない）', () => {
    // **入れても直らないものを入れさせない。**
    assert.deepEqual(packsFor(['知らないノード']), []);
    assert.deepEqual(packsFor([]), []);
    assert.deepEqual(packsFor(null), []);
});

// --- 文字を繋ぐノード（2026-08-26 実機）--------------------------------------

import { inlineJoinStringMulti } from '../web/core/recipeWorkflowBuilder.js';

/**
 * 実物の形（`civitai_139981506`）。**飾りではない**——このノードが
 * プロンプト本文を組み立てて `KSampler.positive` まで届いている:
 *
 *     316 + 317 → 315(JoinStringMulti) → 314(PreviewAny/素通し)
 *              → 354(CLIPTextEncode).text → 19(KSampler).positive
 */
function joinPrompt() {
    return {
        316: { class_type: 'PrimitiveStringMultiline', inputs: { value: 'highres, absurdres' } },
        317: { class_type: 'PrimitiveStringMultiline', inputs: { value: 'extra' } },
        315: {
            class_type: 'JoinStringMulti',
            inputs: {
                inputcount: 3, delimiter: ' ', return_list: false,
                'Update inputs': null, string_1: ['316', 0], string_2: ['317', 0],
            },
        },
        314: { class_type: 'PreviewAny', inputs: { source: ['315', 0] } },
    };
}

test('繋いだ結果を、そのまま埋め込む', () => {
    const prompt = joinPrompt();
    const got = inlineJoinStringMulti(prompt, { LoraLoader: {} });
    assert.equal(got.folded, 1);
    assert.equal(prompt['315'], undefined, '繋ぐノードが残っている');
    // **区切りをそのまま使う。** 変えると本文が変わる。
    assert.equal(prompt['314'].inputs.source, 'highres, absurdres extra');
});

test('導入済みなら触らない', () => {
    const prompt = joinPrompt();
    const got = inlineJoinStringMulti(prompt, { JoinStringMulti: {} });
    assert.equal(got.folded, 0);
    assert.ok(prompt['315'], '在るノードを畳んでいる');
});

test('読めない入力が1つでも在れば触らない', () => {
    // **途中まで畳むと、繋がる順も中身も変わる。**
    const prompt = joinPrompt();
    prompt['316'] = { class_type: 'なにか', inputs: { a: ['999', 0] } };
    const got = inlineJoinStringMulti(prompt, {});
    assert.equal(got.folded, 0);
    assert.ok(prompt['315'], '読めないのに畳んでいる');
});

test('並びを返す形は扱わない', () => {
    // `return_list: true` は返るものが文字列ではない。
    const prompt = joinPrompt();
    prompt['315'].inputs.return_list = true;
    assert.equal(inlineJoinStringMulti(prompt, {}).folded, 0);
});

test('区切りが空でも繋ぐ', () => {
    const prompt = joinPrompt();
    prompt['315'].inputs.delimiter = '';
    inlineJoinStringMulti(prompt, {});
    assert.equal(prompt['314'].inputs.source, 'highres, absurdsextra'.replace('absurds', 'absurdres'));
});
