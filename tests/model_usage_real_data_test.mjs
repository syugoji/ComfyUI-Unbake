/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 共有度の索引を、**実データで1回測る。**
 *
 * `ported_modules_test.mjs` の側は組み立てをダブルに差し替えて筋だけを固定している。
 * それだけだと「組み立てが実物では例外を投げ続けて、全件が failures に落ちる」
 * ような壊れ方が緑のまま通る——**数え上げの正しさは、数えられた件数を見ないと判らない。**
 *
 * `UNBAKE_RECIPES_DIR` と `UNBAKE_OBJECT_INFO` を渡したときだけ走る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { buildModelUsageIndex, rankMissingByUnlock, summarizeRecordModels } from '../web/core/recipeModelUsage.js';
import { buildRecipeWorkflow } from '../web/core/recipeWorkflowBuilder.js';

function recipesDir() {
    const i = process.argv.indexOf('--recipes');
    return i >= 0 ? process.argv[i + 1] : process.env.UNBAKE_RECIPES_DIR;
}

function objectInfo() {
    const p = process.env.UNBAKE_OBJECT_INFO;
    return p && fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

test('実データで共有度を数え切れる（UNBAKE_RECIPES_DIR + UNBAKE_OBJECT_INFO）', (t) => {
    const dir = recipesDir();
    const info = objectInfo();
    if (!dir || !fs.existsSync(dir) || !info) {
        t.skip('レシピの置き場か /object_info の控えが指定されていない');
        return;
    }
    const records = fs.readdirSync(dir)
        .filter(n => n.endsWith('.recipe.json'))
        .map(n => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')));
    assert.ok(records.length >= 100, `実データが少なすぎる（${records.length}件）`);

    const index = buildModelUsageIndex(records, { objectInfo: info, build: buildRecipeWorkflow });

    assert.equal(index.scanned, records.length);
    // **大半が組めていること。** 全部 failures に落ちても索引は「空だが例外なし」で返る。
    assert.ok(index.counted >= records.length * 0.8,
        `組めた件数が少なすぎる（${index.counted}/${index.scanned}）＝組み立てが実物で壊れている`);
    assert.ok(index.usage.size >= 10, `モデル名が拾えていない（${index.usage.size}種）`);

    // **共有されているものが実在すること。** 全部が「他0件」なら照合鍵が効いていない。
    const shared = [...index.usage.values()].filter(users => users.length >= 2);
    assert.ok(shared.length >= 5, `共有されているモデルが少なすぎる（${shared.length}種）＝照合鍵が効いていない`);

    // **自分を除く数えが実データで効いていること。**
    // 対象は「組めた記録」から選ぶ——組めない記録を掴むと、検査ではなく
    // 組み立ての例外でここが落ちる（実際に1度そうなった）。
    const failed = new Set(index.failures.map(f => f.id));
    const target = records.find(r => r.id && !failed.has(String(r.id)));
    assert.ok(target, '組めた記録が1件も無い');
    const rows = summarizeRecordModels(
        buildRecipeWorkflow(target, { objectInfo: info }), index, target.id
    );
    assert.ok(rows.length > 0, '要求しているモデルが1つも拾えていない');
    for (const row of rows) {
        const all = index.usage.get(row.name.replaceAll('\\', '/').toLowerCase()) || [];
        assert.ok(all.some(u => u.id === String(target.id)),
            `${row.name}: 索引に自分が載っていない＝索引と要約で拾い方が違う`);
        assert.equal(row.others, all.length - 1, `${row.name}: 自分自身を共有件数に数えている`);
    }

    // 並べ替えが「多い順」であること（不足解消の順番はここで決まる）。
    const ranked = rankMissingByUnlock([...index.usage.keys()].slice(0, 50), index);
    for (let i = 1; i < ranked.length; i += 1) {
        assert.ok(ranked[i - 1].unlocks >= ranked[i].unlocks, '解ける件数の多い順になっていない');
    }
    console.log(`  実データ: ${index.scanned}件中 ${index.counted}件を数え、`
        + `${index.usage.size}種のモデル・共有 ${shared.length}種（数えられなかった ${index.failures.length}件）`);
});
