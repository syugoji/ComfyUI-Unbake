/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 束の効果を**実データで測る。**
 *
 * ここで固定したいのは数字そのものではなく、**2つの効果を足し算すると
 * 破綻する**という事実。実測（2026-08-20・記録346件）で、
 *
 *     一覧順・全件          305回
 *     モデル順だけ・全件     105回（65.6%減）
 *     門と未出だけ・一覧順     7回
 *     さらにモデル順（最終）    5回（98.4%減）
 *
 * となり、**足し算すると「498回減った」**——元が305回なのだから、
 * 数字として成立していない。同じ削減を二重に数えているからである。
 *
 * `UNBAKE_RECIPES_DIR` / `UNBAKE_OBJECT_INFO` / `UNBAKE_OUTPUTS_JSON` を
 * 渡したときだけ走る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { buildBatch, checkpointLoadCount, orderByCheckpoint } from '../web/core/batchQueue.js';
import { applyVerdicts, createVerdictTable } from '../web/core/verdictTable.js';
import { stampedRecordId } from '../web/core/outputAttribution.js';
import { setLocale } from '../web/i18n/index.js';

function inputs() {
    const dir = process.env.UNBAKE_RECIPES_DIR;
    const infoPath = process.env.UNBAKE_OBJECT_INFO;
    const outputsPath = process.env.UNBAKE_OUTPUTS_JSON;
    if (!dir || !fs.existsSync(dir) || !infoPath || !fs.existsSync(infoPath)) return null;
    const recipes = new Map();
    for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.recipe.json'))) {
        const data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        recipes.set(String(data.id), data);
    }
    return {
        recipes,
        objectInfo: JSON.parse(fs.readFileSync(infoPath, 'utf8')),
        embeddings: process.env.UNBAKE_EMBEDDINGS && fs.existsSync(process.env.UNBAKE_EMBEDDINGS)
            ? JSON.parse(fs.readFileSync(process.env.UNBAKE_EMBEDDINGS, 'utf8'))
            : [],
        outputs: outputsPath && fs.existsSync(outputsPath)
            ? JSON.parse(fs.readFileSync(outputsPath, 'utf8'))
            : [],
    };
}

test('実データで、絞り込みと並べ替えの効果は足し算にならない', async (t) => {
    const supplied = inputs();
    if (!supplied) { t.skip('レシピの置き場か /object_info の控えが指定されていない'); return; }
    setLocale('en');
    const { recipes, objectInfo, embeddings, outputs } = supplied;
    assert.ok(recipes.size >= 100, `記録が少なすぎる（${recipes.size}件）`);

    // 書庫と同じ並び（更新の新しい順）で一覧を作る。
    const rows = [...recipes.entries()].map(([id, recipe]) => ({
        id, libraryId: id,
        checkpoint: (recipe.checkpoint && (recipe.checkpoint.file_name || recipe.checkpoint.name)) || null,
        modified: recipe.modified || 0,
        verdict: 'pending',
    })).sort((a, b) => (b.modified - a.modified) || (a.id < b.id ? -1 : 1));

    const table = createVerdictTable({
        loadRecord: async (id) => recipes.get(String(id)),
        collectInputs: async () => ({ objectInfo, embeddings }),
        concurrency: 8,
    });
    await table.run(rows);
    const records = applyVerdicts(rows, table);

    const stamped = new Set();
    for (const output of outputs) {
        const id = stampedRecordId(output.raw);
        if (id) stamped.add(id);
    }

    const batch = buildBatch(records, {
        stampedSignatures: (id) => (stamped.has(id) ? ['done'] : []),
        wantedSignaturesOf: () => ['done'],
    });
    const modelOnly = checkpointLoadCount(orderByCheckpoint(records));

    console.log(`一覧順・全件        : ${batch.loads.all}回`);
    console.log(`モデル順だけ・全件   : ${modelOnly}回`
        + `（${((1 - modelOnly / batch.loads.all) * 100).toFixed(1)}%減）`);
    console.log(`門と未出だけ・一覧順 : ${batch.loads.filtered}回`);
    console.log(`さらにモデル順(最終) : ${batch.loads.ordered}回`
        + `（${((1 - batch.loads.ordered / batch.loads.all) * 100).toFixed(1)}%減）`);
    console.log(`回す件数 ${batch.items.length} ／ 飛ばした ${JSON.stringify(batch.skipped)}`);

    // 段ごとに効いていること。
    assert.ok(modelOnly < batch.loads.all, 'モデル順に並べても減っていない');
    assert.ok(batch.loads.filtered < batch.loads.all, '門と未出の絞り込みが効いていない');
    assert.ok(batch.loads.ordered <= batch.loads.filtered);

    // **足し算すると破綻する。** 元の回数を超える「削減」が出る。
    const naive = (batch.loads.all - modelOnly) + (batch.loads.all - batch.loads.filtered);
    const actual = batch.loads.all - batch.loads.ordered;
    console.log(`足し算すると ${naive}回減ったことになる（元は ${batch.loads.all}回）／実際は ${actual}回`);
    assert.ok(naive > batch.loads.all,
        '足し算しても元の回数を超えない＝この実データでは掛け算の話が示せていない');
    assert.ok(actual < batch.loads.all, '実際の削減が元の回数以上になっている＝数え方が壊れている');

    // 門が実際に何かを落としていること（0件なら門の検査が意味を成さない）。
    assert.ok(batch.skipped.blocked > 0, '門が1件も落としていない＝判定が効いていない');
});
