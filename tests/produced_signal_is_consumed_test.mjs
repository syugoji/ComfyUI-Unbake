/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **「なぜ空なのか」を作る側が渡しているなら、受け手は読むこと**
 * （2026-08-31・走査3周目）。
 *
 * このパッケージで**3回**起きている型である:
 *
 *   1. `unknownTotals` … サーバは「総量の判らない本数」をわざわざ数えて渡すのに、
 *      **唯一の消費者が捨てて**いた（`I-20260830-16`）。
 *      結果 `670 B / 200 B（100%）` と言い切って固まった。
 *   2. `rateLimited` / `retryAfter` … `model_previews` が 429 を区別して返すのに、
 *      `sweepView` が `if (!item?.ok) continue;` で**理由を見ずに全部落として**いた。
 *      上限に当たった名前が待ち行列から消え、描き直すと同じ勢いでまた叩く。
 *   3. `reachable` / `stoppedBy` … `scanAllOutputs` が
 *      `end` / `unreachable` / `no-progress` を区別して返すのに、
 *      呼び手が `.outputs` しか取らず、**繋がらなかった回が「絵が0枚」**になった。
 *
 * **どれも「作る側が正しく、受け手が捨てる」。** だから作る側を直しても再発する。
 * ここは**渡している事実に読み手が居ること**を留める。
 *
 * **綴りの照合であることは承知している。** 守りたいのは挙動だが、
 * 「捨てていない」を挙動で書くと消費者ごとの筋書きが要る——**まず読まれていること**を
 * 固定して、次に同じ形が増えたときに気づけるようにする。
 * 消費者を書き換えて鍵を読まなくしたら、ここが赤くなる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 作る側が「なぜ空なのか」を載せている鍵と、それを読むはずの相手。
 *
 * **足すときは消費者も名指しすること。** 名指しできないなら、
 * それは「渡しているだけで誰も読まない」＝この検査が捕まえたい状態である。
 */
const SIGNALS = [
    {
        name: 'unknownTotals',
        produced: 'unbake/routes.py',
        consumers: ['web/panel/panel.js'],
        why: '総量の判らない本数。読まないと、判っている分の合計で割って 100% と言い切る（`I-20260830-16`）。',
    },
    {
        name: 'rateLimited',
        produced: 'unbake/model_previews.py',
        consumers: ['web/panel/sweepView.js'],
        why: '上限に当たったこと。読まないと「見本の無いモデル」と区別が付かず、待たずに叩き続ける。',
    },
    {
        name: 'retryAfter',
        produced: 'unbake/model_previews.py',
        consumers: ['web/panel/sweepView.js'],
        why: 'どれだけ待てばよいか。読まないと、待つ長さを自分で決めることになる。',
    },
    {
        name: 'known',
        produced: 'unbake/routes.py',
        consumers: ['web/core/modelCompanions.js', 'web/panel/panel.js'],
        why: '伴走の表がその系統を知っているか。読まないと「表に無い」が「何も要りません」になる（実測で 42 系統中 26 が表に無い）。',
    },
    {
        name: 'stoppedBy',
        produced: 'web/core/scanAllOutputs.js',
        consumers: ['web/unbake.js'],
        why: '走査が終わった理由（`end` / `unreachable` / `no-progress`）。読まないと、繋がらなかった回が「0枚」になる。',
    },
    {
        name: 'reachable',
        produced: 'web/core/scanAllOutputs.js',
        consumers: ['web/unbake.js'],
        why: '1ページでも読めたか。上と対で、嘘の 0 を控えないための旗。',
    },
];

/**
 * **注記は読み手ではない。**
 *
 * 最初はファイル全体へ当てていたが、変異で素通りした——受け手が値を読むのを
 * やめても、**その経緯を説明する注記が同じ語を含んでいる**ので緑のままだった。
 * 実行される所だけを見る。
 */
function codeOnly(text) {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, ' ')        // ブロック注記（JS / Python の docstring 風も含む）
        .replace(/(^|[^:])\/\/.*$/gm, '$1 ')      // 行注記（`://` を巻き込まない）
        .replace(/^\s*#.*$/gm, ' ')               // Python の行注記
        .replace(/"""[\s\S]*?"""/g, ' ');         // Python の docstring
}

/** 作る側は、鍵として書いてあればよい（`"name": …` / `name=…`）。 */
const produces = (text, name) =>
    new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(codeOnly(text));

/**
 * 受け手は、**その鍵を読んでいる**こと。
 *
 * **素の識別子では足りない**（変異で判明）。`panel.js` には `known` という
 * 局所変数が7つ在り、`status.known` を読むのをやめても素の照合は緑のままだった。
 * 属性として触っている形だけを見る。
 */
const consumes = (text, name) => {
    const code = codeOnly(text);
    return new RegExp(`\\.\\s*${name}(?![A-Za-z0-9_])`).test(code)
        || new RegExp(`\\[\\s*['"]${name}['"]\\s*\\]`).test(code)
        || new RegExp(`(?<![A-Za-z0-9_])${name}\\s*:`).test(code);
};

test('作る側が「なぜ空なのか」を渡している鍵に、読み手が居る', async () => {
    assert.ok(SIGNALS.length >= 5, `一覧が痩せている（${SIGNALS.length}）`);
    const orphans = [];
    for (const signal of SIGNALS) {
        const source = await readFile(join(ROOT, signal.produced), 'utf8');
        // **作る側に在ることを先に確かめる。** 改名で消えていたら、
        // 下の「読み手が居る」は何も測っていない。
        assert.ok(produces(source, signal.name),
            `${signal.produced} に ${signal.name} が無い（改名か削除。一覧を直すこと）`);
        for (const consumer of signal.consumers) {
            const text = await readFile(join(ROOT, consumer), 'utf8');
            if (!consumes(text, signal.name)) {
                orphans.push(`${signal.name}: ${consumer} が読んでいない — ${signal.why}`);
            }
        }
    }
    assert.deepEqual(orphans, [],
        '渡しているのに誰も読まない事実が在る。**受け手を直すこと**'
        + '（作る側を直しても、捨てているのは受け手なので直らない）:\n  '
        + orphans.join('\n  '));
});

test('覚え書きが空でない', () => {
    for (const signal of SIGNALS) {
        assert.ok(String(signal.why).trim().length >= 20,
            `${signal.name}: なぜ読む必要があるかが書かれていない`);
    }
});
