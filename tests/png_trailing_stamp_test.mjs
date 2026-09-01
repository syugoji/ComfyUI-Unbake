/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **刻印の行を、PNG 経路でも落とす**（2026-08-31・監査 I-20260831-15）。
 *
 * 改造版の LoRA Manager は生成情報の後ろへ `Recipe metadata: {...}` を1行足す。
 * `exifText.js` は `trimTrailingStamp()` でこれを落としてから分類しており、
 * 冒頭にその理由も書いてある——「**JSON も条件行も末尾が汚れる**——JSON は
 * 途中で終わって `parse` が落ち、A1111 は条件行が最後でなくなる」。
 *
 * ところが **PNG 経路（`readPngText` → `buildRecordFromTextChunks`）は
 * その正規化を一度も通っていなかった**。`a1111Parameters.js` は
 * 「最後の非空行だけ」を設定行の候補にするので、刻印が1行足されているだけで
 * 候補から外れ、**設定が丸ごと読めなくなる**。
 *
 * 実測（修正前・同じ画像で対照）: 正規化なし = **params 0個**・negative 4,249字
 * （刻印ごと飲み込む）／刻印を落とした後 = **params 31個**・negative 1,053字。
 * `buildGenerationRecord` の出力は `verdict='blocked'` で checkpoint / seed /
 * steps / sampler が全部 null になる。
 *
 * **露出は手元の4,946ファイル中1件**（レシピ置き場1,254件のうち PNG は1件で、
 * その1件が該当。ComfyUI 出力3,692件に `parameters` チャンク持ちは0件）
 * ——ただし**該当する母集団の 1/1 が壊れていた**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildRecordFromTextChunks } from '../web/core/generationRecord.js';
import { setLocale } from '../web/i18n/index.js';

const SETTINGS = 'Steps: 40, Sampler: DPM++ 2M alt Karras, CFG scale: 4, Seed: 2068753628,'
    + ' Size: 512x960, Model hash: e4a30e4607, Model: majicmixRealistic_v6';
const STAMP = ' Recipe metadata: {"title": "civitai_2022747", "base_model": "SD 1.5", "loras": []}';

const withStamp = [
    'best quality, masterpiece',
    'Negative prompt: lowres, bad hands',
    SETTINGS,
    STAMP,
].join('\n');

const withoutStamp = [
    'best quality, masterpiece',
    'Negative prompt: lowres, bad hands',
    SETTINGS,
].join('\n');

const build = (parameters) => {
    setLocale('en');
    return buildRecordFromTextChunks({ parameters }, { name: 'x.png' });
};

test('刻印が1行付いていても、設定行を読める', () => {
    const stamped = build(withStamp);
    const clean = build(withoutStamp);

    // **対照と同じ結果になること。** 「読めた」だけでは、何を読んだか判らない。
    assert.equal(stamped.record?.seed, clean.record?.seed,
        `seed が刻印の有無で変わる: ${stamped.record?.seed} 対 ${clean.record?.seed}`);
    assert.equal(stamped.record?.steps, clean.record?.steps, 'steps が刻印の有無で変わる');
    assert.equal(stamped.record?.sampler, clean.record?.sampler, 'sampler が刻印の有無で変わる');
    assert.equal(stamped.record?.checkpoint, clean.record?.checkpoint, 'checkpoint が刻印の有無で変わる');
    assert.equal(stamped.record?.verdict, clean.record?.verdict,
        `判定が刻印の有無で変わる: ${stamped.record?.verdict} 対 ${clean.record?.verdict}`);
    // **読めていることを、値そのもので留める。** 両方 null でも「一致」するので。
    assert.equal(stamped.record?.seed, 2068753628, '設定行が読めていない');
});

test('negative が刻印ごと飲み込まれない', () => {
    const stamped = build(withStamp);
    const negative = String(stamped.record?.negative ?? stamped.record?.gen_params?.negative_prompt ?? '');
    assert.ok(!/Recipe metadata/.test(negative),
        `negative が刻印を飲み込んでいる（${negative.length}字）`);
    assert.ok(!/Steps:\s*40/.test(negative), 'negative が設定行まで飲み込んでいる');
    assert.match(negative, /lowres/, 'negative そのものが消えている');
});

test('刻印が2行以上あっても落とす', () => {
    // `trimTrailingStamp` は末尾から複数行ぶん遡る作りなので、そこも通す。
    const two = [withoutStamp, STAMP, ' Sweep metadata: {"cell": "cell-001"}'].join('\n');
    const record = build(two).record;
    assert.equal(record?.seed, build(withoutStamp).record?.seed, '刻印が2行だと読めない');
});

test('対照: 刻印の無い画像は今までどおり読める', () => {
    const record = build(withoutStamp).record;
    assert.equal(String(record?.seed), '2068753628');
    assert.equal(record?.steps, 40);
    assert.equal(record?.checkpoint, 'majicmixRealistic_v6');
});

test('対照: 条件行より前に在る `metadata:` らしき行は触らない', () => {
    // **落とすのは末尾側だけ**という `trimTrailingStamp` の約束を、こちらでも留める。
    const body = [
        'best quality, Recipe metadata: {"not": "a stamp"} in the prompt',
        'Negative prompt: lowres',
        SETTINGS,
    ].join('\n');
    const record = build(body).record;
    assert.equal(String(record?.seed), '2068753628', '本文中の語を刻印と読んで切っている');
});
