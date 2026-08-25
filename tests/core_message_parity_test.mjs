/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **実データを通して、両方の言語がちゃんと出てくることを確かめる。**
 *
 * 中核の文言145件を機械で鍵へ移した。移し替えが正しかったことは、
 * 改修の前後で実レシピ346件・13,251件の文言を突き合わせ、
 * **日本語側が1件も変わっていない**ことで確かめてある（その基準は改修前の状態なので
 * ここには残せない）。ここで恒久的に押さえるのは、**そこから戻っていないこと**:
 *
 *   - 日本語で回すと、日本語の文が出る（鍵がむき出しの `[code]` にならない）
 *   - 英語で回すと、**日本語の文が1つも出ない**（モデル名などデータ由来は別）
 *   - どちらでも件数が同じ（片方の言語でだけ文が消えていない）
 *
 * 実レシピが要るので `UNBAKE_RECIPES_DIR` を渡したときだけ走る。
 * `/object_info` があれば判定側も通るが、無くても組み立て側は通る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { setLocale } from '../web/i18n/index.js';
import { buildRecipeWorkflow } from '../web/core/recipeWorkflowBuilder.js';

/** 句読点を含む日本語＝**こちらが書いた文**。モデル名は含まない。 */
const JAPANESE_SENTENCE = /[぀-ゟ゠-ヿ一-鿿][^\n]*[。、]/;
const BARE_KEY = /\[core\.[\w.]+\]/;

function recipesDir() {
    const i = process.argv.indexOf('--recipes');
    return i >= 0 ? process.argv[i + 1] : process.env.UNBAKE_RECIPES_DIR;
}

function objectInfo() {
    const p = process.env.UNBAKE_OBJECT_INFO;
    if (!p || !fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** 組み立てて、出てきた文言を全部集める。 */
function messagesFor(recipe, info) {
    const out = [];
    try {
        const built = buildRecipeWorkflow(recipe, info ? { objectInfo: info } : undefined);
        for (const key of ['warnings', 'notes', 'approximations']) {
            for (const v of built?.[key] ?? []) {
                if (typeof v === 'string') out.push(v);
                else if (v && typeof v === 'object' && typeof v.message === 'string') out.push(v.message);
            }
        }
    } catch (error) {
        out.push(String(error?.message ?? error));
    }
    return out;
}

test('実レシピを両方の言語で通す（UNBAKE_RECIPES_DIR）', (t) => {
    const dir = recipesDir();
    if (!dir || !fs.existsSync(dir)) {
        t.skip('レシピの置き場が指定されていない（UNBAKE_RECIPES_DIR）');
        return;
    }
    const info = objectInfo();
    const files = fs.readdirSync(dir).filter(n => n.endsWith('.recipe.json')).sort();
    assert.ok(files.length > 0, 'レシピが0件＝走査が壊れている');

    const recipes = [];
    for (const name of files) {
        try { recipes.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))); } catch { /* 壊れた1件で止めない */ }
    }

    setLocale('ja');
    const ja = recipes.map(r => messagesFor(r, info));
    setLocale('en');
    const en = recipes.map(r => messagesFor(r, info));
    setLocale('en');

    // 件数が同じ＝片方の言語でだけ文が消えていない。
    const countMismatch = ja.map((m, i) => (m.length === en[i].length ? null : i)).filter(v => v !== null);
    assert.deepEqual(countMismatch.slice(0, 3), [], '言語によって出る文言の数が違う');

    const jaTotal = ja.reduce((s, m) => s + m.length, 0);
    assert.ok(jaTotal > 100, `文言が少なすぎる（${jaTotal}）＝走査が実質空回りしている`);

    // 日本語で回したのに鍵がむき出し＝カタログの抜け。
    const bare = ja.flat().filter(m => BARE_KEY.test(m));
    assert.deepEqual(bare.slice(0, 3), [], '日本語のカタログに抜けがある');
    const bareEn = en.flat().filter(m => BARE_KEY.test(m));
    assert.deepEqual(bareEn.slice(0, 3), [], '英語のカタログに抜けがある');

    // **英語で回したら日本語の文が出ない。** ここが本丸。
    const leaked = [...new Set(
        en.flat().flatMap(m => m.split('\n')).filter(line => JAPANESE_SENTENCE.test(line)),
    )];
    assert.deepEqual(leaked.slice(0, 3), [], '英語なのに日本語の文が残っている');

    // 逆向きも見る（日本語で回したのに日本語の文が1つも無い＝そもそも出ていない）。
    const jaSentences = ja.flat().filter(m => JAPANESE_SENTENCE.test(m));
    assert.ok(jaSentences.length > 0, '日本語で回しても日本語の文が出ない＝経路を通っていない');
});
