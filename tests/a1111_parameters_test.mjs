/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * A1111 の `parameters` を読む（2026-08-23 利用者の報告で足した）。
 *
 * **書いてあるのに1つも読んでいなかった。** 落とし込んだ PNG の記録は
 * `hasA1111: true` を立てながら checkpoint も LoRA も seed も全部 `null` で
 * 保存されていた。ここで固定するのは、**そのとき実際に落ちていたもの**:
 *
 *  1. 設定行を素朴にカンマで切ると、JSON の中で割れて版 ID が全部消える
 *  2. `<lora:…>` と `Civitai resources` は**件数が一致しない**（添字で繋がない）
 *  3. グラフが無いだけの記録を `blocked`（再現不可）と呼ばない
 *
 * 例文は実データ（利用者の記録1件）と**同じ構造**にしてある——設定行に
 * `Hashes` と `Civitai resources` の JSON が入り、タグ3本に対し資源は2件、
 * negative が複数行。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    applyA1111ToSummary, loraTagsIn, looksLikeParameterLine, parseA1111Parameters,
    parseAirUrn, recipeFromA1111, splitParameterLine,
} from '../web/core/a1111Parameters.js';
import { buildRecordFromTextChunks, summarizePrompt } from '../web/core/generationRecord.js';
import { setLocale } from '../web/i18n/index.js';

/** 実データと同じ構造の例文。 */
const SAMPLE = [
    'masterpiece, best quality, a cat in a hat',
    '<lora:local_only_lora:0.7> <lora:scenery_p3:1.0> <lora:detailer_v3:0.5>',
    'Negative prompt: lowres, worst quality,',
    'jpeg artifacts, watermark',
    'Steps: 30, Sampler: er_sde, CFG scale: 4.5, Seed: 941290178, Size: 832x1216,'
    + ' Clip skip: 2, Model: miaomiaoHarem_anima15,'
    + ' Hashes: {"LORA:local_only_lora":"8103482F7F"}, Version: ComfyUI,'
    + ' Civitai resources: [{"modelName":"Scenery Enhancer","versionName":"Anima-P3",'
    + '"weight":1.0,"air":"urn:air:anima:lora:civitai:1646240@2920606"},'
    + '{"modelName":"Detailer","versionName":"v3","weight":0.5,'
    + '"air":"urn:air:anima:lora:civitai:2632704@2955921"}]',
].join('\n');

// --- 設定行の切り方 ---------------------------------------------------------

test('設定行は括弧の内側のカンマで切らない', () => {
    // **素朴に切ると JSON が割れる。** 実データではそこに LoRA 8本ぶんの
    // 版 ID が入っていたので、割れると丸ごと消える。
    const line = 'Steps: 30, Hashes: {"a":"1","b":"2"}, Civitai resources: [{"x":1},{"y":2}], Seed: 5';
    assert.deepEqual(splitParameterLine(line), [
        'Steps: 30',
        'Hashes: {"a":"1","b":"2"}',
        'Civitai resources: [{"x":1},{"y":2}]',
        'Seed: 5',
    ]);
    // 素朴な切り方なら6つに割れる＝この検査が本当に効いている。
    assert.equal(line.split(',').length, 6);
});

test('引用符の中のカンマでも切らない', () => {
    assert.deepEqual(splitParameterLine('Model: a, Hashes: {"x":"1,2"}'),
        ['Model: a', 'Hashes: {"x":"1,2"}']);
});

test('知っている鍵が2つそろって初めて設定行と認める', () => {
    assert.equal(looksLikeParameterLine('Steps: 30, Sampler: euler'), true);
    // プロンプトの中の「鍵: 値」を設定と読まない。
    assert.equal(looksLikeParameterLine('a cat, wearing: a hat, holding: a fish'), false);
    assert.equal(looksLikeParameterLine('Steps: 30'), false, '鍵1つで設定行にしている');
});

// --- 全体 -------------------------------------------------------------------

test('prompt・negative・設定を切り分ける', () => {
    const parsed = parseA1111Parameters(SAMPLE);
    assert.equal(parsed.ok, true);
    assert.match(parsed.positive, /^masterpiece/);
    // **negative は複数行になりうる。** 1行目だけ取ると後半が消える。
    assert.equal(parsed.negative, 'lowres, worst quality,\njpeg artifacts, watermark');
    assert.equal(parsed.params.seed, '941290178');
    assert.equal(parsed.params.model, 'miaomiaoHarem_anima15');
    assert.deepEqual(parsed.hashes, { 'LORA:local_only_lora': '8103482F7F' });
    assert.equal(parsed.resources.length, 2);
});

test('設定行が無い画像でも、prompt は返す', () => {
    // 「読めなかった」と「設定を書いていない画像だった」は別。
    const parsed = parseA1111Parameters('just a prompt\nNegative prompt: bad');
    assert.equal(parsed.ok, true);
    assert.equal(parsed.positive, 'just a prompt');
    assert.equal(parsed.negative, 'bad');
    assert.deepEqual(parsed.params, {});
});

test('空なら ok=false（「空の記録」を作らない）', () => {
    assert.equal(parseA1111Parameters('').ok, false);
    assert.equal(parseA1111Parameters(null).ok, false);
});

test('air の URN から種別と版 ID を取る', () => {
    assert.deepEqual(parseAirUrn('urn:air:anima:lora:civitai:1646240@2920606'),
        { kind: 'lora', source: 'civitai', modelId: 1646240, modelVersionId: 2920606 });
    assert.equal(parseAirUrn('not a urn'), null);
    assert.equal(parseAirUrn(null), null);
});

test('`<lora:名前:効き目>` を拾う（効き目が無ければ 1）', () => {
    assert.deepEqual(loraTagsIn('<lora:a:0.7> x <lora:b>'),
        [{ name: 'a', strength: 0.7 }, { name: 'b', strength: 1 }]);
});

// --- 記録の項目へ写す -------------------------------------------------------

test('項目を埋める（グラフから取れた値は上書きしない）', () => {
    const filled = applyA1111ToSummary(summarizePrompt(null), SAMPLE);
    assert.equal(filled.checkpoint, 'miaomiaoHarem_anima15');
    assert.equal(filled.seed, 941290178);
    assert.equal(filled.steps, 30);
    assert.equal(filled.cfg, 4.5);
    assert.equal(filled.sampler, 'er_sde');
    assert.equal(filled.width, 832);
    assert.equal(filled.height, 1216);
    assert.equal(filled.loras.length, 3);
    assert.equal(filled.loras[0].hash, '8103482F7F', 'hash を落としている（引き直せなくなる）');

    // **グラフの値が勝つ。** テキストは「グラフが無いときの次善」。
    const fromGraph = { ...summarizePrompt(null), checkpoint: 'real.safetensors', seed: 7 };
    const merged = applyA1111ToSummary(fromGraph, SAMPLE);
    assert.equal(merged.checkpoint, 'real.safetensors', 'グラフの値を上書きしている');
    assert.equal(merged.seed, 7, 'グラフの値を上書きしている');
});

// --- レシピを組む -----------------------------------------------------------

test('タグと資源を添字で対応付けない（1つずれて全部が別の版になる）', () => {
    // **実データがそうだった。** タグ9本に対し資源8件——先頭の1本は
    // 手元にだけ在る LoRA で、Civitai 側の並びに無い。
    const recipe = recipeFromA1111(SAMPLE, { id: 'x', title: 'X' });
    assert.equal(recipe.loras.length, 3, 'タグの数で作っていない');
    assert.equal(recipe.civitai_resources.length, 2, '資源を捨てている');
    assert.equal(recipe.loras[0].file_name, 'local_only_lora');
    // 資源の方の版 ID が LoRA へ紛れ込んでいないこと。
    assert.equal('modelVersionId' in recipe.loras[0], false,
        'タグの LoRA に、対応の取れていない版 ID を付けている');
});

test('checkpoint は資源から版 ID を採る（対応が一意なとき）', () => {
    const withCheckpoint = SAMPLE.replace(
        '"air":"urn:air:anima:lora:civitai:1646240@2920606"}',
        '"air":"urn:air:anima:checkpoint:civitai:934764@3153747"}');
    const recipe = recipeFromA1111(withCheckpoint, {});
    assert.equal(recipe.checkpoint.file_name, 'miaomiaoHarem_anima15');
    assert.equal(recipe.checkpoint.modelVersionId, 3153747);
});

test('checkpoint が判らないならレシピを組まない', () => {
    // 土台の無いグラフは投入できない。**「組めた」と言って後で落ちる方が悪い。**
    const noModel = SAMPLE.replace(' Model: miaomiaoHarem_anima15,', '');
    assert.equal(recipeFromA1111(noModel, {}), null);
});

test('効き目は `weight` と `strength` の両方に入れる', () => {
    // 読む側が割れている（記録の組み立ては `weight`・組み立て器は `strength`）。
    const recipe = recipeFromA1111(SAMPLE, {});
    assert.equal(recipe.loras[1].weight, 1);
    assert.equal(recipe.loras[1].strength, 1);
});

test('原文を持ち回る（組み立て器が書式から判断している）', () => {
    assert.equal(recipeFromA1111(SAMPLE, {}).a1111_parameters, SAMPLE);
});

// --- 記録として出てくる形 ---------------------------------------------------

test('落とし込んだ A1111 の画像が、空の殻にならない', () => {
    setLocale('en');
    const built = buildRecordFromTextChunks({ parameters: SAMPLE },
        { kind: 'local_file', filename: 'x.png' });
    assert.equal(built.ok, true);
    const record = built.record;
    // **これが全部 null で保存されていた**（2026-08-23 利用者の報告）。
    assert.equal(record.checkpoint, 'miaomiaoHarem_anima15', 'checkpoint が空のまま');
    assert.equal(record.seed, 941290178, 'seed が空のまま');
    assert.equal(record.steps, 30, 'steps が空のまま');
    assert.equal(record.loras.length, 3, 'LoRA が空のまま');
    assert.ok(record.positive, 'prompt が空のまま');
});

test('グラフが無いだけの記録を「再現不可」と呼ばない', () => {
    setLocale('en');
    const built = buildRecordFromTextChunks({ parameters: SAMPLE },
        { kind: 'local_file', filename: 'x.png' });
    // `blocked` は手の打ちようが無いという意味。**組めば済むものに付けない。**
    assert.equal(built.record.verdict, 'pending', '組めるのに再現不可と出している');
    assert.equal(built.record.needsBuild, true, '組む必要があることを伝えていない');
    assert.ok(built.record.recipe, 'レシピを組んでいない（再現の側へ入れない）');
});

test('本当に材料の無い画像は、今までどおり再現不可', () => {
    setLocale('en');
    // **`pending` を配りすぎない。** 材料が無いものまで「まだ組んでいない」に
    // すると、判定の欄が全部 pending になって意味を失う。
    const built = buildRecordFromTextChunks({ parameters: 'just a prompt' },
        { kind: 'local_file', filename: 'x.png' });
    assert.equal(built.record.verdict, 'blocked');
    assert.equal(built.record.needsBuild, undefined);
});
