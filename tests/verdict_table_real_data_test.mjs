/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 判定の表を**実データで1回通す。**
 *
 * 一覧の判定は長いあいだ `pending` 固定で、実データのチップは
 * `exact 0 / approx 0 / missing 0 / not built 346` ——**1件も絞れなかった。**
 * 絞り込みが仕事の道具で絞れないのは、機能が無いのと同じである。
 *
 * ここで見るのは4つ。
 *
 *  1. 実物の346件を通して、**判定が実際に散る**こと（全部 pending でも全部 blocked でもない）
 *  2. 表が**1つ**であること——`tally()` の合計が記録数と一致する
 *     （消費者ごとに別の表を持つと、この和が合わなくなる）
 *  3. **フォークの口（`/api/lm/*`）を1本も叩かない**こと
 *  4. **測っていない条件が言葉で出る**こと（`describeConditions()` が空でない）
 *
 * 所要は出すが**閾値では落とさない**。ここは node の値で、
 * ブラウザの値ではない（HTTP と描画がまるごと入っていない）。
 * **node の数字をブラウザの所要として引用しないこと。**
 *
 * `UNBAKE_RECIPES_DIR` と `UNBAKE_OBJECT_INFO` を渡したときだけ走る。
 * 任意で `UNBAKE_EMBEDDINGS` も渡せる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createVerdictTable, FIXED_CONDITIONS, VERDICT_OF } from '../web/core/verdictTable.js';
import { installEnvironment, resetEnvironment } from '../web/core/environment.js';
import { setLocale } from '../web/i18n/index.js';

function inputs() {
    const i = process.argv.indexOf('--recipes');
    const dir = i >= 0 ? process.argv[i + 1] : process.env.UNBAKE_RECIPES_DIR;
    const infoPath = process.env.UNBAKE_OBJECT_INFO;
    if (!dir || !fs.existsSync(dir) || !infoPath || !fs.existsSync(infoPath)) return null;
    const embeddingsPath = process.env.UNBAKE_EMBEDDINGS;
    const recipes = new Map();
    for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.recipe.json'))) {
        const data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        recipes.set(String(data.id || name.replace('.recipe.json', '')), data);
    }
    return {
        objectInfo: JSON.parse(fs.readFileSync(infoPath, 'utf8')),
        embeddings: embeddingsPath && fs.existsSync(embeddingsPath)
            ? JSON.parse(fs.readFileSync(embeddingsPath, 'utf8'))
            : [],
        recipes,
    };
}

test('実データ全件で判定が散り、フォークの口を1本も叩かない', async (t) => {
    const supplied = inputs();
    if (!supplied) { t.skip('レシピの置き場か /object_info の控えが指定されていない'); return; }
    setLocale('en');
    const { objectInfo, embeddings, recipes } = supplied;
    assert.ok(recipes.size >= 100, `実データが少なすぎる（${recipes.size}件）`);

    // **外へ出た呼び出しを全部数える。** 0件であることが、`/api/lm/*` へ
    // 配線し直していないことの証拠になる（禁止を文章で書いても機械は読まない）。
    const calls = [];
    installEnvironment({
        request: async (url) => { calls.push(String(url)); throw new Error('no network in this test'); },
        storage: null,
    });

    const table = createVerdictTable({
        loadRecord: async (id) => recipes.get(String(id)),
        collectInputs: async () => ({ objectInfo, embeddings }),
        concurrency: 8,
    });

    const records = [...recipes.keys()].map(id => ({ id, libraryId: id }));
    const { done, failed, ms } = await table.run(records);
    resetEnvironment();

    console.log(`判定 ${done}件 / ${ms}ms（${(ms / Math.max(1, done)).toFixed(1)}ms per record・**node の値**）`);

    assert.equal(done, records.length, '全件を回していない');

    // --- 1. 散っていること ------------------------------------------------
    const tally = table.tally(records.map(r => r.libraryId));
    console.log('判定の内訳:', JSON.stringify(tally));
    assert.equal(tally.pending, 0, `回したのに ${tally.pending}件が未判定のまま`);
    const kinds = Object.entries(tally).filter(([, n]) => n > 0).map(([k]) => k);
    assert.ok(kinds.length >= 2,
        `判定が1種類へ潰れている（${JSON.stringify(tally)}）——絞り込みの用を成さない`);
    // 「全部 blocked」も「1件も絞れない」に等しい。**再現できる側が在ること。**
    assert.ok(tally.reproducible + tally.approximate > 0,
        `再現できる記録が0件（${JSON.stringify(tally)}）——判定器が材料を受け取れていない疑い`);

    // --- 2. 表が1つ --------------------------------------------------------
    const sum = Object.values(tally).reduce((a, b) => a + b, 0);
    assert.equal(sum, records.length, '内訳の合計が記録数と合わない（表が分かれている）');
    assert.equal(table.size, records.length);

    // --- 3. フォークの口を叩いていない --------------------------------------
    const forkCalls = calls.filter(url => url.startsWith('/api/lm/'));
    assert.deepEqual(forkCalls, [],
        `フォークの口を ${forkCalls.length}回 叩いている: ${forkCalls.slice(0, 3).join(', ')}`);
    // **囲いが空でないことは主張しない。** 0本が正しい状態なので、
    // ここでは「観測手段が生きているか」を別に示す（下の自己検査）。

    // --- 4. 測っていないことが言葉で出る ------------------------------------
    const notMeasured = table.describeConditions();
    assert.ok(notMeasured.length >= 2,
        '条件が言葉で出ていない（「差が無い」を検出可能範囲抜きで出すことになる）');
    for (const line of notMeasured) {
        assert.doesNotMatch(line, /^\[.*\]$/, `未訳の鍵がそのまま出ている: ${line}`);
    }

    // 判定できなかった件数は、**不足とは別に**数えられていること。
    console.log(`判定できなかった記録: ${failed}件`);
});

test('判定器の語と画面の語の対応に抜けが無い', () => {
    // **対応表を組み立てない。** 抜けていると、未知の判定が黙って `blocked` に
    // 化けて「不足」として数えられる（打つ手がまるで違う）。
    assert.deepEqual(Object.keys(VERDICT_OF).sort(), ['compatible', 'exact', 'unavailable']);
    assert.deepEqual(
        [...new Set(Object.values(VERDICT_OF))].sort(),
        ['approximate', 'blocked', 'reproducible'],
    );
    // 固定した条件が実際に固定されていること（後から書き換えられない）。
    assert.equal(Object.isFrozen(FIXED_CONDITIONS), true);
    assert.equal(FIXED_CONDITIONS.catalog, 'none');
    assert.equal(FIXED_CONDITIONS.availabilityProbe, false);
});

test('外へ出た呼び出しを数える仕掛けが、実際に鳴る', async () => {
    // 上の検査は「0本だった」で緑になる形なので、**観測手段が生きていること**を
    // ここで示す。鳴らない検出器は、配線し直されても気づかない。
    const calls = [];
    installEnvironment({
        request: async (url) => { calls.push(String(url)); return { ok: false, status: 0 }; },
        storage: null,
    });
    const { environmentRequestOrNull } = await import('../web/core/environment.js');
    await environmentRequestOrNull()('/api/lm/known-models');
    resetEnvironment();
    assert.deepEqual(calls, ['/api/lm/known-models'], '呼び出しを数えられていない');
});

test('判定が「注記の有無」ではなく「絵が変わるか」で分かれる', async (t) => {
    // **元は 81.3% が同じ値だった**（実測346件: exact 22 / compatible 282 / blocked 42）。
    // 1件見て「近似」と答えるだけで81%当たる＝**絞れない**。原因は `compatible` が
    // 「何か注記がある」でしかなく、**忠実度を上げた処理まで同じ側に入れていた**こと。
    //
    // ここで固定するのは「特定の件数」ではなく**分かれ方**。母数が変われば数は動くが、
    // 「最頻値だけで大半が当たる」状態へ戻ったら赤くする。
    const supplied = inputs();
    if (!supplied) { t.skip('レシピの置き場か /object_info の控えが指定されていない'); return; }
    setLocale('ja');
    const { objectInfo, embeddings, recipes } = supplied;
    installEnvironment({
        request: async (url) => { throw new Error(`no network: ${url}`); },
        storage: null,
    });
    const table = createVerdictTable({
        loadRecord: async (id) => recipes.get(String(id)) || null,
        collectInputs: async () => ({ objectInfo, embeddings }),
    });
    const records = [...recipes.keys()].map(id => ({ id, libraryId: id }));
    await table.run(records);
    resetEnvironment();

    const tally = table.tally([...recipes.keys()]);
    const total = [...recipes.keys()].length;
    const top = Math.max(...Object.values(tally));

    // **最頻値だけで当たる率。** 元は 81.3%。ここが 7割を超えたら、
    // どの色を出しても見分けられない状態へ戻っている。
    assert.ok(top / total < 0.70,
        `最頻値だけで ${(top / total * 100).toFixed(1)}% 当たる＝絞れていない: ${JSON.stringify(tally)}`);

    // **三段とも実際に出ること。** 片方へ寄り切っていたら、段を分けた意味が無い。
    for (const key of ['reproducible', 'approximate', 'blocked']) {
        assert.ok(tally[key] > 0, `${key} が0件（段が機能していない）: ${JSON.stringify(tally)}`);
    }

    // **上の段は「絵が変わる注記が1件も無い」ことで決まる。**
    // ここが崩れると、また「注記があるだけ」で下の段へ落ちる。
    let checkedTop = 0;
    let checkedMid = 0;
    for (const id of recipes.keys()) {
        const row = table.get(id);
        if (!row || row.verdict === 'blocked') continue;
        if (row.verdict === 'reproducible') {
            assert.equal(row.riskCount, 0, `上の段なのに「絵が変わる」注記がある: ${id}`);
            checkedTop += 1;
        } else if (row.verdict === 'approximate') {
            assert.ok(row.riskCount > 0, `中の段なのに「絵が変わる」注記が0件: ${id}`);
            checkedMid += 1;
        }
    }
    assert.ok(checkedTop > 0 && checkedMid > 0,
        `両方の段を1件も確かめていない（上 ${checkedTop} / 中 ${checkedMid}）`);
});
