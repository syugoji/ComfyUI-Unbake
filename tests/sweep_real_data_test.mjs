/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * Sweep を**実データで1回通す。**
 *
 * `sweep_runner_test.mjs` は計画をダブルへ差し替えて筋だけを測っている。それだけだと
 * **実物のレシピでは1件も計画が組めない**という壊れ方が緑のまま通る——雛形が
 * 提案する軸（LoRA強度・CFG・Steps・prompt追記）が、組み上がったグラフの上で
 * 本当に「その入力だけ」を動かせるかは、**実際に組んで突き合わせないと判らない。**
 *
 * ここで見るのは3つ。
 *
 *  1. 実物のレシピから雛形を出すと、**そのまま計画が組める**こと
 *  2. `assertOnlySweepInputsChanged` が実データで**通る**こと
 *     （落ちるなら、雛形が宣言していない入力を動かしている）
 *  3. セルごとの signature が**全部違う**こと
 *     （同じなら「既に出ている」と誤判定して、別条件の絵を使い回す）
 *
 * `UNBAKE_RECIPES_DIR` と `UNBAKE_OBJECT_INFO` を渡したときだけ走る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { buildSweepPlan } from '../web/core/recipeSweep.js';
import { buildBuiltinSweepTemplates, loraTargetIdentity } from '../web/core/sweepAxes.js';
import { setLocale } from '../web/i18n/index.js';

function inputs() {
    const i = process.argv.indexOf('--recipes');
    const dir = i >= 0 ? process.argv[i + 1] : process.env.UNBAKE_RECIPES_DIR;
    const infoPath = process.env.UNBAKE_OBJECT_INFO;
    if (!dir || !fs.existsSync(dir) || !infoPath || !fs.existsSync(infoPath)) return null;
    return {
        objectInfo: JSON.parse(fs.readFileSync(infoPath, 'utf8')),
        recipes: fs.readdirSync(dir)
            .filter(n => n.endsWith('.recipe.json'))
            .map(n => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))),
    };
}

test('実データのレシピから、雛形どおりに計画が組める', (t) => {
    const supplied = inputs();
    if (!supplied) { t.skip('レシピの置き場か /object_info の控えが指定されていない'); return; }
    setLocale('en');
    const { objectInfo, recipes } = supplied;
    assert.ok(recipes.length >= 100, `実データが少なすぎる（${recipes.length}件）`);

    // LoRA を持つレシピだけを見る（LoRA 軸のある雛形を通したいので）。
    const withLoras = recipes.filter(r => Array.isArray(r.loras) && r.loras.length > 0);
    assert.ok(withLoras.length >= 20, `LoRA を持つレシピが少なすぎる（${withLoras.length}件）`);

    const tally = { planned: 0, unbuildable: 0, contractFailed: 0 };
    const contractFailures = [];
    let signatureChecked = 0;

    for (const recipe of withLoras.slice(0, 60)) {
        for (const template of buildBuiltinSweepTemplates(recipe)) {
            let plan;
            try {
                plan = buildSweepPlan(recipe, template, { objectInfo });
            } catch (error) {
                const message = String(error?.message || error);
                if (message.includes('unintended graph inputs')) {
                    // **これは組み立ての失敗ではなく、契約違反。** 区別して数える
                    // ——混ぜると「組めないレシピが多い」に見えて、雛形の誤りが埋もれる。
                    tally.contractFailed += 1;
                    if (contractFailures.length < 5) {
                        contractFailures.push(`${recipe.id}/${template.id}: ${message.slice(0, 160)}`);
                    }
                } else {
                    tally.unbuildable += 1;
                }
                continue;
            }
            tally.planned += 1;

            // セルの signature が全部違うこと。**同じだと別条件の絵を使い回す。**
            const signatures = plan.cells.map(cell => cell.signature);
            assert.equal(new Set(signatures).size, signatures.length,
                `${recipe.id}/${template.id}: signature が重複している`);
            assert.equal(plan.cells.filter(cell => cell.baseline).length, 1,
                `${recipe.id}/${template.id}: 基準が1つでない`);
            signatureChecked += signatures.length;
        }
    }

    console.log(`  実データ: 計画 ${tally.planned}件 / 組めない ${tally.unbuildable}件 `
        + `/ 契約違反 ${tally.contractFailed}件（セル ${signatureChecked}個の signature を照合）`);

    assert.ok(tally.planned >= 20,
        `実データで組めた計画が少なすぎる（${tally.planned}）＝雛形か組み立てが実物で壊れている`);
    // **契約違反は0でなければならない。** 1件でもあれば、その雛形は宣言していない
    // 入力を動かしており、出た絵を並べても比較になっていない。
    assert.deepEqual(contractFailures, [],
        `宣言した軸以外を動かす雛形がある（${tally.contractFailed}件）`);
});

// --- lora_swap（キャラを変数にする軸）を実データで通す -----------------------
//
// **軸を足しただけでは足りない。** 差し替えは LoRA の名前だけでなく、
// ノードの題も別名の印も変える。契約検査がそこまで数えていると、
// **正しい差し替えが全件「宣言外の入力を動かした」として弾かれる**
// ——実測（60件）で 58件が落ち、うち 44件は `_meta` だけが理由だった。
// ここはその状態へ戻ったら赤くなる。

test('実データで LoRA を差し替えても、契約検査が通る', (t) => {
    const supplied = inputs();
    if (!supplied) { t.skip('レシピの置き場か /object_info の控えが指定されていない'); return; }
    setLocale('en');
    const { objectInfo, recipes } = supplied;
    const installed = objectInfo?.LoraLoader?.input?.required?.lora_name?.[0];
    if (!Array.isArray(installed) || installed.length < 5) {
        t.skip('導入済み LoRA の一覧が /object_info から読めない');
        return;
    }

    const withLoras = recipes.filter(r => Array.isArray(r.loras) && r.loras.length > 0);
    assert.ok(withLoras.length >= 20, `LoRA を持つレシピが少なすぎる（${withLoras.length}件）`);

    let tried = 0;
    let planned = 0;
    const failures = [];
    /** 3セルが同じグラフになった記録。**0でなければならない。** */
    const duplicated = [];
    for (const recipe of withLoras) {
        if (tried >= 60) break;
        const used = new Set(recipe.loras.map(l => String(l.file_name || '')));
        const alternatives = installed.filter(name => !used.has(name)).slice(0, 2);
        if (alternatives.length < 2) continue;
        tried += 1;
        const template = {
            id: 'swap', name: 'swap', mode: 'cartesian', recipeId: recipe.id, seeds: [],
            axes: [{
                id: 'lora-swap', kind: 'lora_swap', label: 'character',
                target: loraTargetIdentity(recipe.loras[0], 0),
                values: [
                    { label: 'base', value: String(recipe.loras[0].file_name || ''), baseline: true },
                    { label: 'a', value: alternatives[0], baseline: false },
                    { label: 'b', value: alternatives[1], baseline: false },
                ],
            }],
        };
        try {
            const plan = buildSweepPlan(recipe, template, { objectInfo, embeddings: [] });
            if (plan.cells.length === 3) planned += 1;
            // **セルごとに違うグラフであること。** ここは別に数える——
            // 落ちた件数へ混ぜると、「組めなかった」と「同じ絵を3枚組んだ」が
            // 同じ数字になり、後者が見えなくなる（実際に一度そうなった）。
            const signatures = new Set(plan.cells.map(cell => cell.signature));
            if (signatures.size !== plan.cells.length) duplicated.push(String(recipe.id));
        } catch (error) {
            failures.push(String(error.message));
        }
    }

    console.log(`差し替えを試した記録: ${tried} ／ 計画が組めた: ${planned} ／ 落ちた: ${failures.length}`);
    assert.ok(tried >= 20, `試せた記録が少なすぎる（${tried}件）＝走査が壊れている`);

    // **契約違反0件。** 落ちてよいのは「そもそも再現できない記録」だけなので、
    // 契約の文言（宣言外の入力）で落ちたものは1件も無いこと。
    const contractFailures = failures.filter(message => /unintended graph inputs/.test(message));
    assert.deepEqual(contractFailures, [],
        `契約検査が ${contractFailures.length}件を弾いた: ${contractFailures.slice(0, 2).join(' / ')}`);

    // **同じグラフを3枚組んでいないこと。** これは赤くならずに比較を壊す形で、
    // 実測（2026-08-20）で2件がこれに当たっていた。真因は
    // 「埋め込みグラフを持つ記録では `recipe.loras` を書き換えても
    // ノードの `lora_name` が動かない」で、`signature` まで一致するため
    // 実行側は片方を「既に出ている」と見なして**別条件の絵を使い回していた。**
    assert.deepEqual(duplicated, [],
        `差し替えたのに同じグラフを組んだ記録が ${duplicated.length}件ある`);

    // 差し替えと無関係な理由（プロンプトが無い・checkpoint が無い）で落ちた分は残る。
    // **グラフに居ない LoRA を差し替えようとした**ものもここに入る——
    // 黙って何もしないより、計画の時点で落ちるほうが安い。
    console.log(`差し替えと無関係な理由で落ちた: ${failures.length}件`);
    assert.ok(planned >= tried * 0.7,
        `計画が組めた割合が低すぎる（${planned}/${tried}）——差し替えの軸が実データに当たっていない`);
});
