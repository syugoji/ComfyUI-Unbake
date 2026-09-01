/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **鍵ではなく、中身を見る**（`D-20260901-01`・2026-09-01）。
 *
 * `i18n_test.mjs` は**鍵集合の一致**を固定している。だから訳が1つ抜ければ赤くなる。
 * ところが**値が壊れても緑のまま**で、実際に2件残っていた:
 *
 *   - `donate.paypalUnit` … **英語にだけ金額が無い**（`PayPal: US␣␣␣␣␣per unit`）。
 *     他の11言語はすべて「1米ドル」と言っている。**生まれた時から壊れていた**
 *     （導入コミット `5dfb8f9a`・2026-08-24）。**寄付の面である。**
 *   - `settings.palette.help` … **英語だけ1文少ない**。導入時は `ja` と一致していたのに、
 *     `ja` が伸びて他言語が追随し、`en` だけ据え置かれた。
 *
 * どちらも `en` で、しかも `en` は `meta.reviewed: true`——**人の目を通ったことに
 * なっている面**に残っていた。**宣言は検査ではない。**
 *
 * ここは4つを見る。どれも**言い回しを固定しない**——訳は書き換わってよい。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATALOGS, DEFAULT_LOCALE } from '../web/i18n/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = Object.keys(CATALOGS);
const OTHERS = LOCALES.filter(code => code !== DEFAULT_LOCALE);

test('語の間に空白が2つ以上続く値が無い（何かが抜けた跡）', () => {
    // `donate.paypalUnit` の壊れ方がこれだった——`US` の後が**空白5文字**。
    // **機構は断定しない**（`$1` が消える形は既知の罠と同型だが、実測は現物だけ）。
    // 跡は形として残るので、形で数える。
    const found = [];
    for (const code of LOCALES) {
        for (const [key, value] of Object.entries(CATALOGS[code])) {
            if (/\S {2,}\S/.test(String(value))) found.push(`${code}:${key}`);
        }
    }
    assert.deepEqual(found, [],
        `語の間に空白が続いている（値が抜けた跡）: ${found.join(', ')}`);
});

/**
 * 寄付の単価。**言い回しは固定しない**——`US$1` / `1 USD` / `每份 1 美元` /
 * `۱ دلار` / `1구좌 1미국달러` はどれも正しい。数字と通貨の印が在ることだけを見る。
 *
 * **ここが覆えない範囲を先に書いておく。** 「金額だけを綺麗に消す」変異は
 * この検査を素通りする——`up to 100` の `100` が数字として残るからである
 * （実測: `fr` の `1 USD` から `1` だけ抜いても緑だった）。
 * 「上限の 100 以外の数字が在ること」にできない理由は **`ar` が単価を数字でなく
 * 語で書いている**ため（`دولار أمريكي واحد` ＝「1米ドル」）。全言語に効く数字の
 * 規則が作れないので、**ここは覆えないと認める**。
 *
 * **実際に起きた壊れ方は上の「空白が2つ以上続く」で捕まる**（`US␣␣␣␣␣per unit`）。
 */
const CURRENCY = /\$|USD|ドル|美元|доллар|دلار|دولار|달러|doları|dólar/i;

test('寄付の単価が全言語で金額を言っている', () => {
    const broken = LOCALES.filter(code => {
        const value = String(CATALOGS[code]['donate.paypalUnit'] ?? '');
        return !/[0-9٠-٩۰-۹]/.test(value) || !CURRENCY.test(value);
    });
    assert.deepEqual(broken, [],
        `donate.paypalUnit に金額か通貨が無い: ${broken.join(', ')}`
        + '（**寄付の面**なので、消えると受け取れない）');
});

/**
 * 句や節の数。**言語をまたいで比べられる粒度**にする。
 *
 * 最初は「文の数」で数えたが、`log.civitaiPost` が偽陽性になった——`en` だけ
 * em ダッシュで2文を1文に繋いでいて、**中身は同じ**なのに1つ少なく見える。
 * 区切り記号（`;` と em / en ダッシュ）も切れ目に数えると解消する。
 * **除外一覧を書かずに済む形を選んだ**（除外は腐るので）。
 */
function clauses(value) {
    return String(value ?? '')
        .replace(/(?<=\d)\.(?=\d)/g, ' ')            // 小数点は文末でない
        .split(/[.。！!？?;；]|[—–](?= )/)
        .filter(part => part.trim()).length;
}

test('英語だけ中身が薄い鍵が無い', () => {
    // **`en` が基準なのに、`en` だけ置き去りになる**という向きの壊れ方。
    // 鍵の一致では絶対に出ない（鍵は在るので）。
    const thin = [];
    for (const [key, value] of Object.entries(CATALOGS[DEFAULT_LOCALE])) {
        const theirs = OTHERS
            .filter(code => key in CATALOGS[code])
            .map(code => clauses(CATALOGS[code][key]))
            .sort((a, b) => a - b);
        // 比べる相手が少ないと中央値が揺れる。8言語以上あるときだけ見る。
        if (theirs.length < 8) continue;
        const median = theirs[Math.floor(theirs.length / 2)];
        const mine = clauses(value);
        if (mine < median) thin.push(`${key}（en=${mine} 中央値=${median}）`);
    }
    assert.deepEqual(thin, [],
        '英語だけ他言語より句が少ない。**訳が伸びたのに原文が据え置かれた**印:\n  '
        + thin.join('\n  '));
});

test('中国語に和文の波ダッシュが無い', async () => {
    // U+301C は**和文の記号**。`ja` では正しいので触らない——
    // だから「全言語で0件」ではなく**中国語だけ**を見る。
    for (const code of ['zh', 'zh-TW']) {
        const body = await readFile(join(ROOT, `web/i18n/locales/${code}.js`), 'utf8');
        const count = (body.match(/〜/g) || []).length;
        assert.equal(count, 0, `${code}.js に波ダッシュ (U+301C) が ${count} 件`);
    }
});

/**
 * `zh` の中で割れていた語。**寄せ先だけでなく、捨てた側の不在も見る。**
 *
 * 不在だけを見ると、**その鍵ごと消えても緑**になる。両方見る。
 */
const ZH_TERMS = [
    { drop: '比较实验', keep: 'Sweep', why: '製品語彙。訳すと `app.tooltip` の英語表記と割れる' },
    { drop: '卡片', keep: '图块', why: '多数側へ寄せた（5対2）' },
    { drop: '橙', keep: '琥珀', why: '`settings.theme.amber` と揃える' },
    { drop: '栏位', keep: '字段', why: '`栏位` は台湾語彙。簡体側は `字段`' },
    { drop: '回放', keep: '运行', why: '`回放` は録画の再生。ここは「もう一度回す」' },
    { drop: '书库', keep: '记录库', why: '`书库` は蔵書。ここは記録の置き場' },
    // **製品語彙は英語のまま残す**（`app.tooltip` が `Replay Manifest` を英語で持つ）。
    { drop: '方案', keep: 'Manifest', why: '製品語彙。訳すと画面の中で2つの呼び名になる' },
    // **製品語彙との衝突を避ける。** `column.record.long` は `Generation Record` を
    // 英語のまま持っているので、`生成记录` と書くとその概念を指してしまう。
    // 原文は `generation settings`（設定）で、記録そのものではない。
    { drop: '生成记录', keep: '生成参数', why: '製品語彙 `Generation Record` と衝突する' },
];

/**
 * **ここが守れないもの**（正直に書いておく）。
 *
 * `zh` の意味の誤り12件のうち、上の用語表で覆えるのは**語彙の決めごとだけ**である。
 * 「`Run the sweep` という操作指示が落ちている」「`已取消下载` が実行中を止めた意味に
 * なっている」といった**訳文そのものの誤り**は、正しい訳の綴りを固定しない限り
 * 機械では見つけられない——そして**正しい訳の綴りを固定してはいけない**
 * （母語話者が言い回しを直すたびに赤くなる。`I-20260830-13` の目的はまさにそれを
 * 回すことなので、本末転倒になる）。
 *
 * だから**あの12件を守っているのは検査ではなく、レビューの記録のほう**である
 * （`_Planning/decisions/artifacts/I-20260830-13/findings-zh.md`）。
 */

/**
 * `zh-TW` にも同じ決めごとを置く（`D-20260901-02` の所見を適用した分）。
 *
 * **`zh` の表をそのまま使えない**——繁体と簡体で字が違うし、`zh-TW` にしか無い
 * 論点も在る。同じ語彙の決定を**2つの面で別々に留める**。
 */
const ZH_TW_TERMS = [
    { drop: '比較實驗', keep: 'Sweep', why: '製品語彙' },
    { drop: '卡片', keep: '圖塊', why: '多数側へ寄せた（5対3）' },
    { drop: '橙', keep: '琥珀', why: '`settings.palette.help` と `settings.theme.amber` に揃える' },
    { drop: '方案', keep: 'Manifest', why: '製品語彙（`Replay Manifest`）' },
    { drop: '軸的宣告', keep: 'Sweep 範本', why: '`sweep template` が消えていた' },
];

test('繁体中国語の用語が1つに寄っている', async () => {
    const body = await readFile(join(ROOT, 'web/i18n/locales/zh-TW.js'), 'utf8');
    for (const { drop, keep, why } of ZH_TW_TERMS) {
        const dropped = body.split(drop).length - 1;
        assert.equal(dropped, 0, `zh-TW.js に「${drop}」が ${dropped} 件（→「${keep}」・${why}）`);
        assert.ok(body.includes(keep),
            `寄せ先「${keep}」が1つも無い——鍵ごと消えていないか確かめること`);
    }
});

test('中国語の用語が1つに寄っている', async () => {
    const body = await readFile(join(ROOT, 'web/i18n/locales/zh.js'), 'utf8');
    for (const { drop, keep, why } of ZH_TERMS) {
        const dropped = body.split(drop).length - 1;
        assert.equal(dropped, 0, `zh.js に「${drop}」が ${dropped} 件（→「${keep}」・${why}）`);
        assert.ok(body.includes(keep),
            `寄せ先「${keep}」が1つも無い——鍵ごと消えていないか確かめること`);
    }
});

test('機械が読んだことを、母語話者が読んだことにしていない', async () => {
    // **「調べていない」「機械が調べた」「母語話者が読んだ」は別の行に書く。**
    // `reviewed` は母語話者を指す（各カタログ冒頭の注記がそう書いている）。
    for (const code of LOCALES) {
        const body = await readFile(join(ROOT, `web/i18n/locales/${code}.js`), 'utf8');
        if (!body.includes('machineReviewed')) continue;
        const meta = /export const meta = \{[\s\S]*?\};/.exec(body)?.[0] || '';
        assert.match(meta, /reviewed:\s*false/,
            `${code}: 機械レビューを入れたのに reviewed が false でない`);
    }
});
