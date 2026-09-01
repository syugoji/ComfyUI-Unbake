/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **起動時に印だけを読む**（`I-20260829-01`）ことを固定する。
 *
 * 走査の転送は実測 23.7MiB で、その **97% が `prompt`**（実行グラフ）。同じデータで
 * 検算すると `prompt` は帰属を**1件も増やしていなかった**——印だけでも全部読んでも
 * `stamped 906 / named 1670 / inferred 0`、紐付いた記録はどちらも 323 だった。
 *
 * ここで守るのは4つ:
 *
 *   1. **鍵の表が1つであること。** 走査が literal で書き写すと、印を1つ足したときに
 *      走査だけが取り落とし、**帰属が黙って減る**（減ったことは画面に出ない）。
 *   2. **サーバの宣言と一致すること。** `RAW_KEYS` から `prompt` を除いた分が印。
 *   3. **`prompt` を取っていないことを「無かった」と読ませない。** `none` に混ぜると、
 *      推定が**走っていない**ことが「推定したが当たらなかった」に見える。
 *   4. **開いた時に足す側が、索引を組み直さないこと。** 組み直すと `note` / `forget` の
 *      書き換えが消え、**消した絵が戻る**（2026-08-29 に直したばかりの不具合）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STAMP_KEYS, attributeOutputs, stampedRecordId } from '../web/core/outputAttribution.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('印の鍵が、サーバの宣言から prompt を除いた分と一致する', () => {
    const source = read('unbake/outputs.py');
    const block = source.match(/^RAW_KEYS: Tuple\[str, \.\.\.\] = \(([\s\S]*?)^\)/m);
    assert.ok(block, 'RAW_KEYS が読めない');
    const keys = [...block[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
    assert.ok(keys.includes('prompt'), 'サーバ側に prompt が無い（前提が変わっている）');
    assert.deepEqual([...STAMP_KEYS].sort(), keys.filter(k => k !== 'prompt').sort(),
        '印の鍵がサーバの宣言とずれている');
});

test('走査は鍵の表を読む（literal で書き写さない）', () => {
    const entry = read('web/unbake.js');
    // 周回は `core/scanAllOutputs.js` へ切り出したので、入口は口と鍵を渡す形。
    assert.match(entry, /scanAllOutputs\(\s*scanOutputs\s*,\s*\{[\s\S]{0,120}?keys:\s*\[\.\.\.STAMP_KEYS\]/,
        '起動時の走査が STAMP_KEYS を使っていない');
    // **印の名前が入口へ literal で現れないこと。** 現れたら表が2つになっている。
    for (const key of STAMP_KEYS) {
        assert.ok(!new RegExp(`['"\`]${key}['"\`]`).test(entry),
            `入口に印の名前が literal で書かれている: ${key}`);
    }
});

/** 印つきの1枚（`stampedRecordId` が実際に読む形）。 */
const stamped = {
    filename: 'x_00001_.png', subfolder: '',
    raw: { unbake_sweep: JSON.stringify({ record_id: 'r1' }) },
};
/** 印も名乗りも無く、`prompt` でしか判らない1枚。 */
const bare = { filename: 'plain_00002_.png', subfolder: '', raw: {} };
const RECORDS = [{ id: 'r1', gen_params: { sampler: 'euler', steps: 20 } }];

test('印は prompt を取っていなくても、そのまま帰属する', () => {
    assert.equal(stampedRecordId(stamped.raw), 'r1', '前提: 印が読めること');
    const { byRecord, tally } = attributeOutputs([stamped], RECORDS, { promptsLoaded: false });
    assert.deepEqual([...byRecord.keys()], ['r1']);
    assert.equal(tally.stamped, 1);
    assert.equal(tally.deferred, 0, '印で決まった分まで先送りにしている');
});

test('prompt を取っていない分は deferred で、none に混ぜない', () => {
    const { byRecord, tally } = attributeOutputs([bare], RECORDS, { promptsLoaded: false });
    assert.equal(byRecord.size, 0, '推定していないのに帰属している');
    assert.equal(tally.deferred, 1, '先送りとして数えていない');
    assert.equal(tally.none, 0, '「推定したが当たらなかった」に混ぜている');
    assert.ok(Number.isFinite(tally.deferred), '内訳が NaN（鍵を持っていない）');
});

test('[対照] prompt を取っている場合は従来どおり none になる', () => {
    // **対照が無いと「常に deferred を返す」でも上の検査は通る。**
    const { tally } = attributeOutputs([bare], RECORDS, { promptsLoaded: true });
    assert.equal(tally.deferred, 0, '取っているのに先送り扱いにしている');
    assert.equal(tally.none, 1);
});

test('[対照] 既定（指定なし）は従来どおり', () => {
    const { tally } = attributeOutputs([bare], RECORDS);
    assert.equal(tally.deferred, 0);
    assert.equal(tally.none, 1);
});

test('内訳の合計が枚数と合う（どの分類にも落ちない枚が出ない）', () => {
    const { tally } = attributeOutputs([stamped, bare], RECORDS, { promptsLoaded: false });
    const sum = tally.stamped + tally.named + tally.inferred + tally.none + tally.deferred;
    assert.equal(sum, tally.total, `内訳の合計が合わない: ${JSON.stringify(tally)}`);
});

test('開いた時に prompt を足す側が、索引を組み直さない', () => {
    // **ここが再発の入口。** 組み直すと `note` / `forget` の書き換えが消え、
    // 「消した絵が戻る」が復活する。足すのは手元の配列の `raw` だけであること。
    const entry = read('web/unbake.js');
    const start = entry.indexOf('async function fillVariantPrompts(');
    assert.ok(start >= 0, 'prompt を足す関数が無い');
    const body = entry.slice(start, entry.indexOf('\n    async function loadVariants(', start));
    assert.ok(body.length > 0, '関数の範囲が取れない');
    assert.doesNotMatch(body, /ensureVariantIndex|attributeOutputs|variantIndex\s*=/,
        '索引を組み直している（note / forget の書き換えが消える）');
    assert.match(body, /readOutputRaw\(/, '名指しの読み口を使っていない');
    assert.match(body, /\['prompt'\]/, 'prompt 以外まで取りに行っている');
});

test('同じ絵を2回引かない（引き直しの抑制が生きている）', () => {
    /*
     * **原文の綴りではなく、抑えが在ることを見る**（2026-08-31・監査 I-20260831-20）。
     *
     * 元はここで `promptsFilled.has(id)` / `.add(id)` という**綴りそのもの**を
     * 照合していた。それは「引き直しを防いでいる」ではなく
     * **「記録 id 単位で覆っている」を固定していた**——索引は後から増えるので、
     * その形だと新しく出した絵の条件が永久に読まれない。
     * 綴りを留める検査は、欠陥ごと留めてしまう。
     *
     * **挙動そのものは `tests/variant_prompt_fill_test.mjs` が測る**
     * （同じ絵は二度聞かない／新しい絵は聞く／記録が違えば別に数える）。
     * ここに残すのは「抑えを外して毎回引くようになっていないか」だけにする。
     */
    const entry = read('web/unbake.js');
    const start = entry.indexOf('async function fillVariantPrompts(');
    const body = entry.slice(start, entry.indexOf('\n    async function loadVariants(', start));
    assert.match(body, /promptsAsked/,
        '引き直しの抑えが消えている（毎回サーバへ行く形になっていないか）');
});
