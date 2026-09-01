/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **A1111 が書いた手掛かりを、読まずに捨てない**
 * （2026-08-31・監査 I-20260831-24, I-20260831-25）。
 *
 * ## `Lora hashes` を誰も読んでいなかった（-24）
 *
 * `applyA1111ToSummary` と `recipeFromA1111` は `Hashes: {…}`（`parsed.hashes`）
 * だけを見る。A1111 / Forge / Civitai が実際に書くのは
 * `Lora hashes: "名前: ハッシュ, 名前2: ハッシュ2"` という**別の鍵**で、
 * これは `params` に文字列として入ったまま**リポジトリ全体で一度も参照されない**。
 *
 * 実測: 手元の A1111 画像168枚のうち **39枚が `Lora hashes` を持ち、そのうち
 * `Hashes` も持つものは0枚**。つまりその39枚の LoRA 52本すべてが `hash=null`。
 * ハッシュが無いと `modelResolver` はハッシュ照合の段を素通りし、名前一致まで
 * 落ちる——`modelEvidence.js` が「同名の別物を掴みうる」と警告している状態。
 * 12桁で来るので `shortHash` の条件を満たし、**拾えばバイト同一まで格上げできた。**
 *
 * ## 版IDを持っているのに `Model:` が無いだけで組まない（-25）
 *
 * `recipeFromA1111` は `params.model` が空なら即 `null`。だが直後に
 * `resources.find(kind==='checkpoint')` を引いており、Civitai の素の形は
 * **版IDを持っている**。版IDをファイル名へ解決する口は `checkpoint.modelVersionId`
 * を要求するので、**レシピが組まれない限りその経路は一度も走らない**
 * ——版IDが在るのに版IDで引けない、という循環になっていた。
 *
 * 実測: 168枚のうち122枚が `Model:` を持たず、**そのうち97枚は版ID付きの
 * checkpoint を持っている**。利用者から見ると「Civitai が版まで書いているのに
 * 再現不可」になる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyA1111ToSummary, recipeFromA1111 } from '../web/core/a1111Parameters.js';

const withLoraHashes = [
    'a cat <lora:styleA:0.8> <lora:styleB:0.5>',
    'Negative prompt: lowres',
    'Steps: 20, Sampler: Euler, CFG scale: 7, Seed: 1, Size: 512x512, Model: base,'
    + ' Lora hashes: "styleA: bdc544997a42, styleB: 0123456789ab"',
].join('\n');

const versionOnly = [
    'a cat',
    'Negative prompt: lowres',
    'Steps: 20, Sampler: Euler, CFG scale: 7, Seed: 1, Size: 512x512,'
    + ' Civitai resources: [{"type":"checkpoint","modelVersionId":1283437,'
    + '"modelName":"WAI-NSFW-illustrious-SDXL","modelVersionName":"v9.0"}]',
].join('\n');

test('Lora hashes に書いてあるハッシュを拾う', () => {
    const summary = applyA1111ToSummary({}, withLoraHashes);
    const byName = Object.fromEntries((summary.loras || []).map(item => [item.name, item.hash]));
    assert.equal(byName.styleA, 'bdc544997a42',
        `Lora hashes を読んでいない: ${JSON.stringify(summary.loras)}`);
    assert.equal(byName.styleB, '0123456789ab');
});

test('組んだレシピにも同じハッシュが載る', () => {
    const recipe = recipeFromA1111(withLoraHashes, {});
    assert.ok(recipe, 'レシピが組めていない（前提が崩れている）');
    const byName = Object.fromEntries((recipe.loras || []).map(item => [item.file_name || item.name, item.hash]));
    assert.equal(byName.styleA, 'bdc544997a42', `レシピ側でハッシュが落ちている: ${JSON.stringify(recipe.loras)}`);
});

test('対照: Hashes 形式は今までどおり読める', () => {
    const both = [
        'a cat <lora:styleA:0.8>',
        'Negative prompt: lowres',
        'Steps: 20, Sampler: Euler, CFG scale: 7, Seed: 1, Size: 512x512, Model: base,'
        + ' Hashes: {"LORA:styleA": "aaaabbbbcccc"}',
    ].join('\n');
    const summary = applyA1111ToSummary({}, both);
    assert.equal(summary.loras?.[0]?.hash, 'aaaabbbbcccc', '元から読めていた形を壊している');
});

test('Model: が無くても、版IDを持つ checkpoint ならレシピを組む', () => {
    const recipe = recipeFromA1111(versionOnly, {});
    assert.ok(recipe, 'Civitai が版まで書いているのに組んでいない');
    assert.equal(recipe.checkpoint?.modelVersionId, 1283437,
        `版IDが載っていない: ${JSON.stringify(recipe.checkpoint)}`);
    // **ファイル名は判らないので、判らないと書く。** 推測で埋めない。
    assert.ok(!recipe.checkpoint?.file_name,
        `名前を知らないのに埋めている: ${JSON.stringify(recipe.checkpoint)}`);
});

test('対照: 手掛かりが何も無ければ、今までどおり組まない', () => {
    const nothing = [
        'a cat',
        'Negative prompt: lowres',
        'Steps: 20, Sampler: Euler, CFG scale: 7, Seed: 1, Size: 512x512',
    ].join('\n');
    assert.equal(recipeFromA1111(nothing, {}), null,
        '土台が何も判らないのに組んでいる（投入時に落ちる方が読みにくい）');
});

test('対照: Model: が在るときは今までどおりそれを使う', () => {
    const recipe = recipeFromA1111(withLoraHashes, {});
    assert.equal(recipe.checkpoint?.file_name, 'base');
});
