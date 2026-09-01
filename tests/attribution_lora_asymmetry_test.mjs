/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **片側だけが空**という組み合わせを作る（`I-20260830-31`）。
 *
 * 空は「未知」として飛ばす作りなので、**7項目のうち一番強い `loras` を落とした
 * まま「6項目を比べて100%一致」**と主張していた。LoRA を1本も使っていない絵が、
 * LoRA 3本の記録へ `agreement: 1` でぶら下がる。しかも**正解の記録が同居すると
 * 同点になり**、合っている絵まで「どの記録のものでもない」へ落ちる。
 * 画面には「LoRA は比べていない」とは出ない。
 *
 * ## なぜ既存の検査が素通りしたか
 *
 * 対がどれも**両側とも LoRA を持つ**。片側だけが空という組み合わせが1本も無い
 * ので、「空は未知として飛ばす」という設計が正しいかを**一度も観測していない**。
 *
 * ## 向きは片方だけ
 *
 * 絵の側はグラフを歩いて数えているので `[]` は**確かに0本**。だが記録の側の
 * `[]` は当てにならない——一覧が持つ要約は LoRA を持たないことがあり、
 * そちらを「確かに0本」と読むと**薄い記録が軒並み帰属できなくなる**。
 * だから塞ぐのは「記録は持つ・絵は持たない」だけで、逆向きは今までどおり。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { attributeOutput, indexRecords } from '../web/core/outputAttribution.js';

/** LoRA の本数だけを変えられるグラフ。ほかの条件は記録と完全に一致させる。 */
function graph({ loras = ['charA.safetensors'] } = {}) {
    const nodes = {
        1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'base.safetensors' } },
    };
    let modelRef = 1;
    let id = 10;
    for (const name of loras) {
        nodes[id] = {
            class_type: 'LoraLoader',
            inputs: { lora_name: name, strength_model: 0.8, model: [modelRef, 0] },
        };
        modelRef = id;
        id += 1;
    }
    nodes[3] = { class_type: 'CLIPTextEncode', inputs: { text: 'a girl', clip: [modelRef, 1] } };
    nodes[4] = { class_type: 'CLIPTextEncode', inputs: { text: 'bad hands', clip: [modelRef, 1] } };
    nodes[5] = { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } };
    nodes[6] = {
        class_type: 'KSampler',
        inputs: {
            seed: 42, steps: 20, cfg: 7, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 1,
            model: [modelRef, 0], positive: [3, 0], negative: [4, 0], latent_image: [5, 0],
        },
    };
    return nodes;
}

const record = (overrides = {}) => ({
    id: 'rec-a',
    checkpoint: { file_name: 'base.safetensors' },
    loras: [{ file_name: 'charA.safetensors', strength_model: 0.8 }],
    gen_params: {
        prompt: 'a girl', negative_prompt: 'bad hands', seed: 42,
        steps: 20, cfg_scale: 7, sampler: 'DPM++ 2M Karras', size: '1024x1024',
    },
    ...overrides,
});

const attribute = (loras, records) => attributeOutput(
    { filename: 'x_00001_.png', raw: { prompt: JSON.stringify(graph({ loras })) } },
    indexRecords(records),
);

test('前提: 条件がそろっていれば帰属する', () => {
    const result = attribute(['charA.safetensors'], [record()]);
    assert.equal(result.recordId, 'rec-a', `帰属していない: ${JSON.stringify(result)}`);
    assert.equal(result.evidence, 'inferred');
});

test('LoRA を1本も使っていない絵は、LoRA を持つ記録へぶら下がらない', () => {
    const many = record({
        id: 'rec-loras',
        loras: [
            { file_name: 'charA.safetensors', strength_model: 0.8 },
            { file_name: 'styleB.safetensors', strength_model: 0.6 },
            { file_name: 'detailC.safetensors', strength_model: 0.4 },
        ],
    });
    const result = attribute([], [many]);
    assert.equal(result.recordId, null,
        `LoRA 0本の絵が LoRA 3本の記録へぶら下がっている（一致率 ${result.agreement}）`);
});

test('正解の記録が同居していても、そちらへ正しく着く', () => {
    // **同点で落ちない。** 元は LoRA を無視するので両方が 1.0 になり、
    // `tied: 2` → `evidence: 'none'` で**合っている絵まで**帰属しなくなっていた。
    const withLoras = record({
        id: 'rec-loras',
        loras: [{ file_name: 'charA.safetensors', strength_model: 0.8 }],
    });
    const without = record({ id: 'rec-plain', loras: [] });
    const result = attribute([], [withLoras, without]);
    assert.equal(result.recordId, 'rec-plain',
        `LoRA を持たない記録へ着いていない: ${JSON.stringify(result)}`);
});

test('[対照] 逆向き（絵は LoRA・記録は空）は落とさない', () => {
    /*
     * 一覧が持つ要約は LoRA を持たないことがある（`libraryRowToRecord` は
     * 無ければ `[]` を入れる）。そこを「確かに0本」と読むと、
     * **薄い記録が軒並み帰属できなくなる**——直しすぎの番犬。
     */
    const thin = record({ id: 'rec-thin', loras: [] });
    const result = attribute(['charA.safetensors'], [thin]);
    assert.equal(result.recordId, 'rec-thin',
        `薄い記録が帰属できなくなっている: ${JSON.stringify(result)}`);
});

test('[対照] 両側が LoRA を持ち、中身が違うときは今までどおり率で見る', () => {
    // ここまで塞ぐと「1本違うだけで別の絵」になり、当たりが落ちる。
    const other = record({
        id: 'rec-other',
        loras: [{ file_name: 'somethingElse.safetensors', strength_model: 0.8 }],
    });
    const result = attribute(['charA.safetensors'], [other]);
    assert.equal(result.recordId, 'rec-other',
        `LoRA が1本違うだけで落としている: ${JSON.stringify(result)}`);
    assert.ok(result.agreement < 1, `不一致が率に出ていない: ${result.agreement}`);
});

test('[対照] 記録も絵も LoRA を持たないなら、今までどおり帰属する', () => {
    const plain = record({ id: 'rec-plain', loras: [] });
    const result = attribute([], [plain]);
    assert.equal(result.recordId, 'rec-plain', '両方 0本なのに帰属していない');
});
