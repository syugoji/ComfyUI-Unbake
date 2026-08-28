/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 版 ID を**本当のファイル名**へ置き換える（2026-08-23 利用者の問いから）。
 *
 * 動機は実測1件。利用者の画像が持っていた版4件を Civitai の公開 API で
 * 照合したところ、**1件は名前が一致しなかった**:
 *
 *     <lora:ZodaPlus:1>  →  zodaplus_v1_anima.safetensors
 *
 * 名前で探すと在るのに見つからない。ここで固定するのは、
 * **その置き換えで壊れうるところ**:
 *
 *  1. 同じ解決結果を2つの LoRA へ当てない
 *  2. 短い語を含みで判定しない（無関係な名前へ当たる）
 *  3. 効き目はプロンプト側を残す（実際に掛かったのはそちら）
 *  4. 引けなかった件数を黙って0にしない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    applyResolvedResources, looksLikeSameModel, normalizeName,
} from '../web/core/civitaiResources.js';

/** 利用者の画像と同じ形（タグが資源より1本多い）。 */
const RECIPE = {
    checkpoint: { file_name: 'miaomiaoHarem_anima15', modelVersionId: 3153747, strength: 1 },
    loras: [
        { file_name: 'local_only_lora', weight: 0.7, strength: 0.7, hash: '8103482F7F' },
        { file_name: 'ZodaPlus', weight: 1, strength: 1, hash: null },
        { file_name: 'Scenery_enchancer-Anima-P3', weight: 0.5, strength: 0.5, hash: null },
    ],
    civitai_resources: [
        { modelName: 'MiaoMiao Harem', kind: 'checkpoint', modelVersionId: 3153747, weight: null },
        { modelName: 'ZodaPlus', kind: 'lora', modelVersionId: 2955921, weight: 1 },
        { modelName: 'Scenery Enhancer', kind: 'lora', modelVersionId: 2920606, weight: 0.5 },
    ],
};

/** 実測した応答（Civitai 公開 API・2026-08-23）。 */
const RESOLVED = [
    { versionId: 3153747, filename: 'miaomiaoHarem_anima15.safetensors', kind: 'checkpoints', sha256: 'EEBCD007A03B6E45' },
    { versionId: 2955921, filename: 'zodaplus_v1_anima.safetensors', kind: 'loras', sha256: '4DCBF077AD39AA3B' },
    { versionId: 2920606, filename: 'Scenery_enchancer-Anima-P3.safetensors', kind: 'loras', sha256: 'D55A8187E0CE712A' },
];

test('名前の比べ方（拡張子と区切りを落とす）', () => {
    assert.equal(normalizeName('Scenery_enchancer-Anima-P3.safetensors'), 'sceneryenchanceranimap3');
    // **これが動機。** 表記と実体が一致しない。
    assert.equal(looksLikeSameModel('ZodaPlus', 'zodaplus_v1_anima.safetensors'), true);
    assert.equal(looksLikeSameModel('Scenery_enchancer-Anima-P3', 'Scenery_enchancer-Anima-P3.safetensors'), true);
    assert.equal(looksLikeSameModel('local_only_lora', 'zodaplus_v1_anima.safetensors'), false);
});

test('短い語は含みで判定しない（無関係な名前へ当たる）', () => {
    // `v1` は `zodaplus_v1_anima` に含まれるが、同じものではない。
    assert.equal(looksLikeSameModel('v1', 'zodaplus_v1_anima.safetensors'), false);
    assert.equal(looksLikeSameModel('add', 'addetail_xl.safetensors'), false);
    // 完全一致なら短くても認める。
    assert.equal(looksLikeSameModel('lcm', 'lcm.safetensors'), true);
});

test('表記の違う LoRA を、版 ID 経由で本当のファイル名にする', () => {
    const out = applyResolvedResources(RECIPE, RESOLVED);
    assert.equal(out.recipe.checkpoint.file_name, 'miaomiaoHarem_anima15.safetensors');
    assert.equal(out.recipe.checkpoint.hash, 'EEBCD007A03B6E45');
    const names = out.recipe.loras.map(l => l.file_name);
    assert.deepEqual(names, [
        'local_only_lora',                            // 資源に無い＝そのまま
        'zodaplus_v1_anima.safetensors',              // **表記と違う実体**
        'Scenery_enchancer-Anima-P3.safetensors',
    ]);
    assert.equal(out.recipe.loras[1].hash, '4DCBF077AD39AA3B', 'hash を付けていない（索引で引けない）');
    assert.equal(out.recipe.loras[1].modelVersionId, 2955921);
    assert.equal(out.replaced, 3);
    assert.equal(out.added, 0);
    assert.equal(out.unresolved, 0);
});

test('効き目はプロンプト側を残す（実際に掛かったのはそちら）', () => {
    const differing = {
        ...RECIPE,
        civitai_resources: RECIPE.civitai_resources.map(item => (
            item.kind === 'lora' ? { ...item, weight: 0.1 } : item)),
    };
    const out = applyResolvedResources(differing, RESOLVED);
    assert.equal(out.recipe.loras[1].weight, 1, '資源の効き目で上書きしている');
    assert.equal(out.recipe.loras[1].strength, 1);
});

test('同じ解決結果を2つの LoRA へ当てない', () => {
    // 同じ模型の版を2つ書いた記録。**片方だけが当たる。**
    const twice = {
        ...RECIPE,
        loras: [
            { file_name: 'ZodaPlus', weight: 1, strength: 1 },
            { file_name: 'zodaplus_v1_anima', weight: 0.4, strength: 0.4 },
        ],
        civitai_resources: [
            { kind: 'lora', modelVersionId: 2955921, weight: 1 },
        ],
    };
    const out = applyResolvedResources(twice, RESOLVED);
    // 当たるのは先に見つかった1本だけ。**2本目は表記のまま残る。**
    // （`replaced` は checkpoint の分も数えるので、名前で見る。）
    assert.deepEqual(out.recipe.loras.map(l => l.file_name),
        ['zodaplus_v1_anima.safetensors', 'zodaplus_v1_anima'],
        '1つの解決結果を2本へ当てている');
    assert.equal(out.recipe.loras.length, 2, '本数が変わっている');
    assert.equal(out.recipe.loras[1].hash, undefined, '当たっていない方に hash を付けている');
});

test('プロンプトに書かれていない資源は足す（落とすと絵が変わる）', () => {
    const missingFromPrompt = { ...RECIPE, loras: [RECIPE.loras[0]] };
    const out = applyResolvedResources(missingFromPrompt, RESOLVED);
    assert.equal(out.added, 2, '書かれていない資源を落としている');
    assert.deepEqual(out.recipe.loras.map(l => l.file_name), [
        'local_only_lora', 'zodaplus_v1_anima.safetensors', 'Scenery_enchancer-Anima-P3.safetensors',
    ]);
    // 足した分の効き目は資源が持っている（プロンプト側に無いので）。
    assert.equal(out.recipe.loras[2].weight, 0.5);
});

test('引けなかった件数を黙って0にしない', () => {
    // **出さないと「全部そろった」と読まれる。**
    const out = applyResolvedResources(RECIPE, [RESOLVED[0]]);
    assert.equal(out.unresolved, 2, '引けなかった分を数えていない');
    // 引けた分だけは反映される（1件の失敗で全部を捨てない）。
    assert.equal(out.recipe.checkpoint.file_name, 'miaomiaoHarem_anima15.safetensors');
    assert.equal(out.recipe.loras[1].file_name, 'ZodaPlus', '引けていないのに名前を変えている');
});

test('1件も引けなければ、中身を変えない', () => {
    const out = applyResolvedResources(RECIPE, []);
    assert.deepEqual(out.recipe.checkpoint, RECIPE.checkpoint, 'checkpoint を書き換えている');
    assert.deepEqual(out.recipe.loras, RECIPE.loras, 'LoRA を書き換えている');
    assert.equal(out.replaced, 0);
    assert.equal(out.added, 0);
});

test('失敗の応答（ok=false）を解決結果として扱わない', () => {
    const out = applyResolvedResources(RECIPE, [
        { ok: false, versionId: 2955921, error: 'not found' },
        RESOLVED[1],
    ]);
    assert.equal(out.recipe.loras[1].file_name, 'zodaplus_v1_anima.safetensors');
});

// --- 種別（`D-20260828-01` 群B）-----------------------------------------------

test('embed / VAE / 拡大器を LoRA として積まない', () => {
    /*
     * 元は「checkpoint でなければ LoRA」で拾っていたので、**プロンプトに
     * 書かれていない資源を足す**経路が embed / vae / upscaler を
     * `LoraLoader` へ押し込んでいた。リポジトリ自身の実測分布（316件）に
     * embed 65 / upscaler 15 / vae 6 が在るので、珍しい形ではない。
     *
     * 押し込まれると絵が変わるだけでなく、**「同じ材料で再現した」という
     * 主張ごと嘘になる。**
     */
    const recipe = {
        checkpoint: { file_name: 'base', modelVersionId: 1 },
        loras: [],
        civitai_resources: [
            { modelName: 'E', kind: 'embedding', modelVersionId: 11, weight: 1 },
            { modelName: 'V', kind: 'vae', modelVersionId: 12, weight: 1 },
            { modelName: 'U', kind: 'upscaler', modelVersionId: 13, weight: 1 },
            { modelName: 'L', kind: 'lora', modelVersionId: 14, weight: 0.6 },
        ],
    };
    const resolved = [
        { versionId: 11, filename: 'e.pt', kind: 'embedding' },
        { versionId: 12, filename: 'v.safetensors', kind: 'vae' },
        { versionId: 13, filename: 'u.pth', kind: 'upscaler' },
        { versionId: 14, filename: 'l.safetensors', kind: 'lora' },
    ];
    const out = applyResolvedResources(recipe, resolved);
    const names = (out.recipe.loras || []).map(item => item.file_name);
    assert.deepEqual(names, ['l.safetensors'],
        `LoRA でないものを積んでいる: ${JSON.stringify(names)}`);
});

test('lycoris / locon / dora は LoRA として積む', () => {
    // **絞りすぎない。** これらは `LoraLoader` で載る（種別を寄せる側が決める）。
    const recipe = {
        checkpoint: null,
        loras: [],
        civitai_resources: [
            { modelName: 'A', kind: 'lycoris', modelVersionId: 21, weight: 1 },
            { modelName: 'B', kind: 'locon', modelVersionId: 22, weight: 1 },
        ].map(item => ({ ...item, kind: item.kind })),
    };
    // `normalizeResources` を通した後の形（`resourceKind` が寄せる）を模す。
    recipe.civitai_resources = recipe.civitai_resources.map(item => ({ ...item, kind: 'lora' }));
    const out = applyResolvedResources(recipe, [
        { versionId: 21, filename: 'a.safetensors' },
        { versionId: 22, filename: 'b.safetensors' },
    ]);
    assert.equal((out.recipe.loras || []).length, 2, 'LyCORIS / LoCon を落としている');
});
