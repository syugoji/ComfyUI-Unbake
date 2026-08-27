/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **資源の種類を1つに寄せる**（2026-08-26 実機の報告 + 316件の走査）。
 *
 * `civitai_139164303` は「再現に必要なチェックポイント情報がありません」と
 * 出ていたが、Civitai 側には在った——`type: "diffusionmodel"` だったので、
 * `checkpoint` しか見ていない振り分けが**チェックポイントごと落としていた**。
 *
 * 実測で出てくる値（316件）:
 *
 *     lora 305 / checkpoint 130 / embed 65 / **型が無い** 57 /
 *     upscaler 15 / vae 6 / embedding 3 / lycoris 2
 *     imagejobnetworkparams { strength = 1, triggerword = , type = lora } 13
 *
 * 最後のものは**構造体の文字列がそのまま型の欄に入っている**壊れた値で、
 * 中に本当の型が書いてある。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kindFromVersion, recipeFromCivitaiMeta, resourceKind } from '../web/core/civitaiClient.js';

test('実測で出た型を、全部そのまま寄せられる', () => {
    const table = [
        ['checkpoint', 'checkpoint'],
        // **これが `civitai_139164303` を落としていた値。**
        ['diffusionmodel', 'checkpoint'],
        ['model', 'checkpoint'],
        ['lora', 'lora'],
        ['locon', 'lora'],
        ['dora', 'lora'],
        ['lycoris', 'lora'],
        ['embed', 'embedding'],
        ['embedding', 'embedding'],
        ['textualinversion', 'embedding'],
        ['vae', 'vae'],
        ['upscaler', 'upscaler'],
    ];
    for (const [raw, want] of table) {
        assert.equal(resourceKind(raw), want, `${raw} の寄せ先が違う`);
        assert.equal(resourceKind(raw.toUpperCase()), want, `${raw} が大文字だと寄らない`);
    }
});

test('壊れた値の中から本当の型を取り出す', () => {
    // 実測 13件。Civitai 側が構造体の文字列をそのまま入れている。
    assert.equal(
        resourceKind('ImageJobNetworkParams { strength = 1, triggerword = , type = lora }'),
        'lora');
    assert.equal(
        resourceKind('ImageJobNetworkParams { strength = 0.2, triggerword = , type = lora }'),
        'lora');
});

test('似た語を取り違えない', () => {
    // `triggerword` の中の `word` などに引っかからないこと。
    assert.equal(resourceKind('prototype = lora'), null,
        '語の途中の type を拾っている');
});

test('判らないときは null（推測で振り分けない）', () => {
    // **推測で振り分けると、別の欄へ入った素材が「無い」ことになる。**
    for (const raw of ['', null, undefined, 'none', 'null', 'undefined', 'なにか']) {
        assert.equal(resourceKind(raw), null, `${JSON.stringify(raw)} を勝手に寄せている`);
    }
});

test('型が無い資源は、版に聞いて決める', () => {
    // **実測で 57件が型を持たない。** そのまま落としていた。
    const versions = new Map([['3072332', { model: { type: 'Checkpoint', name: 'X' },
                                            files: [{ name: 'x.safetensors', primary: true }] }]]);
    const meta = {
        prompt: 'a', seed: 1, steps: 20, cfgScale: 5,
        civitaiResources: [{ weight: 1, modelVersionId: 3072332 }],
    };
    const recipe = recipeFromCivitaiMeta({ id: 1 }, meta, versions);
    assert.ok(recipe.checkpoint, '型が無いだけでチェックポイントを落としている');
    assert.equal(recipe.checkpoint.modelVersionId, 3072332);
});

test('diffusionmodel をチェックポイントとして採る', () => {
    // 実機 `civitai_139164303` の形をそのまま。
    const meta = {
        prompt: 'a', seed: 266132482, steps: 20, cfgScale: 5,
        civitaiResources: [
            { type: 'diffusionmodel', weight: 1, modelVersionId: 3072332 },
            { type: 'lora', weight: 1, modelVersionId: 3116962 },
        ],
    };
    const recipe = recipeFromCivitaiMeta({ id: 139164303 }, meta, new Map());
    assert.ok(recipe.checkpoint, 'チェックポイントを落としている（実機の症状）');
    assert.equal(recipe.checkpoint.modelVersionId, 3072332);
    assert.equal(recipe.loras.length, 1, 'LoRA の数が合わない');
});

test('版から型を読む', () => {
    assert.equal(kindFromVersion({ model: { type: 'LORA' } }), 'lora');
    assert.equal(kindFromVersion({ model: { type: 'Checkpoint' } }), 'checkpoint');
    assert.equal(kindFromVersion({}), null);
    assert.equal(kindFromVersion(null), null);
});
