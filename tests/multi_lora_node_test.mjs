/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **1つのノードが何本も LoRA を持つ形**（2026-08-26 実測で見つけた）。
 *
 * `lora_name` だけを見ていたので、`Lora Loader (LoraManager)` を使った絵は
 * **LoRA が1本も採れていなかった**。手元の 897 枚のうち 34 枚（3.8%）が
 * これで、1枚あたり8本入っていた。
 *
 * **採れないより悪い**——「LoRA を使っていない」という別の嘘になるので、
 * 判定は「そのまま再現できる」に見え、実際には8本ぶん違う絵が出る。
 *
 * 下の値は実物（`ComfyUI_00251_.png` の node 10）から採った。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readMultiLoraWidget } from '../web/core/generationRecord.js';

/** 実測した inputs（名前と強度だけ残して縮めたもの）。 */
const REAL = {
    text: '<lora:0_11Xx_B:0.25> <lora:CADENZA:0.50> <lora:USNR STYLE_XL_lokr:1.00>',
    loras: {
        __value__: [
            { name: '0_11Xx_B', strength: 0.25, clipStrength: 0.25, active: true },
            { name: 'CADENZA', strength: 0.5, clipStrength: 0.5, active: true },
            { name: 'USNR STYLE_XL_lokr', strength: 1, clipStrength: 1, active: true },
        ],
    },
};

test('1つのノードから何本も採る', () => {
    const got = readMultiLoraWidget(REAL);
    assert.equal(got.length, 3, '本数が合わない');
    assert.deepEqual(got.map(item => item.name),
        ['0_11Xx_B', 'CADENZA', 'USNR STYLE_XL_lokr']);
    // **強度も落とさない。** 落とすと絵が変わるのに「同じ材料」に見える。
    assert.deepEqual(got.map(item => item.strength), [0.25, 0.5, 1]);
});

test('切ってある LoRA は入れない', () => {
    // **効いていないものを効いていることにしない。** すると「同じ材料なのに
    // 絵が違う」という、一番読みにくい食い違いになる。
    const got = readMultiLoraWidget({
        loras: { __value__: [
            { name: 'on', strength: 1, active: true },
            { name: 'off', strength: 1, active: false },
        ] },
    });
    assert.deepEqual(got.map(item => item.name), ['on']);
});

test('名前に空白が入っていても切らない', () => {
    // 実測 `USNR STYLE_XL_lokr`。写しの `text` を空白で割ると壊れる。
    const got = readMultiLoraWidget(REAL);
    assert.ok(got.some(item => item.name === 'USNR STYLE_XL_lokr'),
        '空白のところで切れている');
});

test('プロンプト本文の <lora:…> は採らない', () => {
    // **一度は「写しからも読む」ようにしたが、実測で撤回した。**
    // 手元の 895 枚で、その経路が当たるのは `CLIPTextEncode` 系の9ノードだけ
    // ——本命（`loras` を持つのに `__value__` が無いノード）は**0件**だった。
    // ComfyUI はプロンプト本文の A1111 記法を LoRA として適用しないので、
    // 採ると「使っていない LoRA を使ったことにする」嘘になる。
    assert.deepEqual(readMultiLoraWidget({ text: '<lora:a:0.25> <lora:b c:1.00>' }), []);
});

test('関係のないノードから何も採らない', () => {
    // **拾いすぎない。** `loras` も `text` も無いノードは黙って通す。
    assert.deepEqual(readMultiLoraWidget({ ckpt_name: 'x.safetensors' }), []);
    assert.deepEqual(readMultiLoraWidget({}), []);
    assert.deepEqual(readMultiLoraWidget(null), []);
});

test('グラフの要約が、この形からも LoRA を採る', async () => {
    // **配線まで見る。** 読める関数が在ることと、要約が呼ぶことは別
    //（今日それで2回踏んだ）。
    const { recordFromPrompt } = await import('../web/core/generationRecord.js')
        .then(m => ({ recordFromPrompt: m.recordFromPrompt || m.summarizePrompt }));
    assert.ok(typeof recordFromPrompt === 'function', '要約の入口が見つからない');
    const summary = recordFromPrompt({
        1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'c.safetensors' } },
        10: { class_type: 'Lora Loader (LoraManager)', inputs: REAL },
    });
    assert.equal(summary.loras.length, 3,
        `要約が複数LoRAノードを読んでいない（${summary.loras.length} 本）`);
});
