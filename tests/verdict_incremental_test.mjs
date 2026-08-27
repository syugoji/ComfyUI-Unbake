/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **取り込んだ分だけを判定し直す**（2026-08-26 利用者の指示）。
 *
 * 実機で URL を1本ドロップするたびに「判定を回しています（353件）…
 * 判定が終わりました（353件 / 5981ms）」と出ていた。**取り込んだ1件のために
 * 他の 352件を組み直していた。**
 *
 * `run()` は計算済みの行を飛ばす作りなので、原因は組み立て側ではなく
 * **読み直しが全件の控えを捨てていた**こと。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerdictTable } from '../web/core/verdictTable.js';

const INPUTS = { objectInfo: { CheckpointLoaderSimple: {} }, embeddings: [] };

function tableOf(records) {
    const loaded = [];
    const table = createVerdictTable({
        loadRecord: async (id) => {
            loaded.push(String(id));
            return { gen_params: { seed: 1, prompt: 'a' }, checkpoint: null, loras: [] };
        },
        collectInputs: async () => INPUTS,
    });
    return { table, loaded, records };
}

const recs = (n) => Array.from({ length: n }, (_, i) => ({ libraryId: String(i + 1) }));

test('2回目は、計算済みを組み直さない', async () => {
    const { table, loaded, records } = tableOf(recs(5));
    await table.run(records);
    assert.equal(loaded.length, 5);
    const again = await table.run(records);
    assert.equal(again.done, 0, '計算済みを組み直している');
    assert.equal(loaded.length, 5, '記録を読み直している');
});

test('捨てた1件だけが組み直る', async () => {
    // **これが差分判定の要。** 全件捨てると全件組み直しになる。
    const { table, loaded, records } = tableOf(recs(5));
    await table.run(records);
    table.invalidate(['3']);
    const again = await table.run([...records, { libraryId: '6' }]);
    assert.equal(again.done, 2, `組み直した件数が違う: ${again.done}`);
    assert.deepEqual(loaded.slice(5).sort(), ['3', '6']);
});

test('全件捨てると全件組み直る（今までの形）', async () => {
    const { table, loaded, records } = tableOf(recs(5));
    await table.run(records);
    table.invalidate(records.map(record => record.libraryId));
    const again = await table.run(records);
    assert.equal(again.done, 5);
    assert.equal(loaded.length, 10);
});
