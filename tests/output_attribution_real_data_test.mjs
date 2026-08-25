/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 帰属を**実データで測る。**
 *
 * 単体の検査は「筋が通っているか」しか見ない。**指紋が実際に当たるかどうかは、
 * 実物の絵と実物の記録で測るしかない**——最初の版は筋としては正しかったが、
 * 実データでの帰属は **0件**だった（記録は寸法を `size` に持つのに `width` を
 * 見ていた／サンプラーの表記が A1111 と ComfyUI で違った）。
 *
 * ここは2つを測る。**混ぜないこと。**
 *
 *   **当てにいけた割合**（recall）… 指紋で帰属を主張できた件数
 *   **当てた中での正しさ**（precision）… 刻印を隠して指紋だけで当てさせ、
 *                                        隠した刻印と一致した割合
 *
 * 片方だけを「精度」と呼ぶと、**厳しくするほど良く見える**（当てにいく件数が
 * 減るだけ）という逆の結論が出る。
 *
 * `UNBAKE_OUTPUTS_JSON`（`/unbake/outputs` の生の出力を並べた JSON）と
 * `UNBAKE_RECIPES_DIR` を渡したときだけ走る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { attributeOutput, attributeOutputs, indexRecords, stampedRecordId } from '../web/core/outputAttribution.js';
import { libraryRowToRecord } from '../web/unbake.js';
import { setLocale } from '../web/i18n/index.js';

function inputs() {
    const outputsPath = process.env.UNBAKE_OUTPUTS_JSON;
    const dir = process.env.UNBAKE_RECIPES_DIR;
    if (!outputsPath || !fs.existsSync(outputsPath) || !dir || !fs.existsSync(dir)) return null;
    return {
        outputs: JSON.parse(fs.readFileSync(outputsPath, 'utf8')),
        records: fs.readdirSync(dir)
            .filter(name => name.endsWith('.recipe.json'))
            .map(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))),
    };
}

test('実データで、出力の多くが記録へ帰属する', (t) => {
    const supplied = inputs();
    if (!supplied) { t.skip('出力の控えかレシピの置き場が指定されていない'); return; }
    setLocale('en');
    const { outputs, records } = supplied;
    assert.ok(outputs.length >= 500, `出力が少なすぎる（${outputs.length}枚）`);
    assert.ok(records.length >= 100, `記録が少なすぎる（${records.length}件）`);

    const started = Date.now();
    const { byRecord, tally } = attributeOutputs(outputs, records);
    const attributed = tally.stamped + tally.inferred;
    console.log(`帰属: ${attributed}/${tally.total}（${(attributed * 100 / tally.total).toFixed(1)}%）`
        + ` ＝ 刻印 ${tally.stamped} ＋ 推定 ${tally.inferred}`
        + ` ／ 当てなかった ${tally.none}（うち読めない ${tally.unreadable}）`
        + ` ／ ${Date.now() - started}ms`);
    console.log(`絵を1枚以上持つ記録: ${byRecord.size}/${records.length}`);

    // **刻印だけでは16%しか届かない。** 指紋がそこを広げていること。
    assert.ok(tally.stamped > 0, '刻印つきの絵が1枚も無い＝走査が壊れている');
    assert.ok(tally.inferred > tally.stamped * 2,
        `指紋がほとんど効いていない（刻印 ${tally.stamped} / 推定 ${tally.inferred}）`);
    assert.ok(attributed / tally.total > 0.6,
        `帰属できた割合が低すぎる（${(attributed * 100 / tally.total).toFixed(1)}%）`);
});

test('刻印を隠して指紋だけで当てさせると、当てた分はほぼ正しい', (t) => {
    const supplied = inputs();
    if (!supplied) { t.skip('出力の控えかレシピの置き場が指定されていない'); return; }
    setLocale('en');
    const { outputs, records } = supplied;
    const indexed = indexRecords(records);

    let truthCount = 0;
    let attempted = 0;
    let correct = 0;
    for (const output of outputs) {
        const truth = stampedRecordId(output.raw);
        if (!truth) continue;
        truthCount += 1;
        // **印を外して同じ絵を当てさせる。** 印は残したままだと指紋を通らない。
        const blind = { ...output, raw: { prompt: output.raw.prompt } };
        const result = attributeOutput(blind, indexed);
        if (result.evidence !== 'inferred') continue;
        attempted += 1;
        if (result.recordId === truth) correct += 1;
    }

    console.log(`正解つき ${truthCount}枚 ／ 当てにいった ${attempted}枚`
        + `（${(attempted * 100 / truthCount).toFixed(1)}%）`
        + ` ／ そのうち正しかった ${correct}枚（${(correct * 100 / Math.max(1, attempted)).toFixed(1)}%）`);

    assert.ok(truthCount >= 100, `正解つきの絵が少なすぎる（${truthCount}枚）`);
    assert.ok(attempted / truthCount > 0.5,
        `当てにいけた割合が低すぎる（${attempted}/${truthCount}）`);
    // **当てた中での正しさ。** ここが落ちると、推定が確実そうな顔で嘘をつく。
    assert.ok(correct / attempted > 0.9,
        `当てた中の正しさが低すぎる（${correct}/${attempted}）`);

    // **この数は刻印つきの絵でしか測れていない。** 刻印が付くのは
    // LoRA Manager 経由で作った絵で、**測れた部分集合が母集団と同じとは限らない。**
    assert.ok(truthCount < outputs.length,
        '全部に刻印が付いている＝この検査は母集団を測れていない');
});

test('**製品が渡している形**（一覧の要約）でも、同じだけ帰属する', (t) => {
    const supplied = inputs();
    if (!supplied) { t.skip('出力の控えかレシピの置き場が指定されていない'); return; }
    setLocale('en');
    const { outputs, records } = supplied;

    // **ここが今回の見落としの本体。** 上の検査は**フルのレシピ**を渡していたが、
    // 画面が持っているのは `/unbake/records` の**要約**だけである。
    // 要約に比べる項目が無いと、比べられる本数が足りず**帰属が全件0**になる
    // ——node で 3,065枚を推定できたのに、実機の画面では **0枚**だった。
    // **測れた形と、製品が動く形を揃えること。**
    const summaries = records.map(recipe => libraryRowToRecord({
        id: recipe.id,
        title: recipe.title,
        checkpoint: recipe.checkpoint?.file_name || recipe.checkpoint?.name || null,
        base_model: recipe.base_model,
        modified: recipe.modified,
        prompt: String(recipe.gen_params?.prompt || '').slice(0, 400),
        negative_prompt: String(recipe.gen_params?.negative_prompt || '').slice(0, 400),
        seed: recipe.gen_params?.seed,
        steps: recipe.gen_params?.steps,
        cfg_scale: recipe.gen_params?.cfg_scale,
        sampler: recipe.gen_params?.sampler,
        size: recipe.gen_params?.size,
        loras: (recipe.loras || []).map(lora => ({
            file_name: lora.file_name || lora.name,
            strength: lora.strength_model ?? lora.strength,
        })),
    }));

    const { tally } = attributeOutputs(outputs, summaries);
    const attributed = tally.stamped + tally.inferred;
    console.log(`要約の形で帰属: ${attributed}/${tally.total}`
        + `（${(attributed * 100 / tally.total).toFixed(1)}%）`
        + ` ＝ 刻印 ${tally.stamped} ＋ 推定 ${tally.inferred}`);

    assert.ok(tally.inferred > 0,
        '要約の形だと推定が1件も出ない（比べる項目が要約に足りていない）');
    // フルのレシピほどではなくてよいが、**桁が違ってはいけない。**
    assert.ok(attributed / tally.total > 0.5,
        `要約の形での帰属が低すぎる（${(attributed * 100 / tally.total).toFixed(1)}%）`);
});
