/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **日本語の約物が、他の言語の画面へ出ない**（`I-20260830-19`, `I-20260830-20`）。
 *
 * 区切りの読点 `、` と件数の全角括弧 `（）` を直書きしていたので、英語の画面へ
 * `Missing node: A、B` と出て、アラビア語では連綴の途中に U+FF08 が落ちて
 * フォントごと飛んでいた（実測11箇所＋5箇所）。
 *
 * ## なぜ既存の検査が素通りしたか
 *
 * `i18n_test.mjs` のべた書き検出は**仮名と漢字しか見ていなかった**ので、
 * 約物は網の外だった。網を広げたが、**広げたこと自体を測る検査が無いと
 * 元へ戻しても気づけない**（変異検査が指摘した）ので、ここで直接固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** べた書き検出の網（`i18n_test.mjs` の宣言をそのまま読む）。 */
function detector() {
    const source = fs.readFileSync(path.join(ROOT, 'tests/i18n_test.mjs'), 'utf8');
    const line = /^const JAPANESE = (\/\[.*?\]\/);$/m.exec(source);
    assert.ok(line, 'べた書き検出の網が読めない');
    // eslint-disable-next-line no-eval
    return eval(line[1]);
}

test('網が、区切りの読点と件数の括弧を捕まえる', () => {
    const net = detector();
    for (const ch of ['、', '（', '）']) {
        assert.equal(net.test(ch), true,
            `${ch} が網から漏れている（この字は英語の画面へそのまま出た）`);
    }
});

test('[対照] 網は、記号として使う字まで拾わない', () => {
    // `＋` は釦の絵柄で、訳す物ではない。**全角形の塊ごと足すとここで壊れる。**
    const net = detector();
    for (const ch of ['＋', '★', '⤓', '⊞', '⛶']) {
        assert.equal(net.test(ch), false,
            `${ch} まで拾っている（訳す物でない字を訳せと言い出す）`);
    }
});

test('[対照] 網は、仮名と漢字を引き続き捕まえる', () => {
    const net = detector();
    for (const ch of ['あ', 'ア', '漢']) {
        assert.equal(net.test(ch), true, `${ch} を見落としている`);
    }
});

test('区切りは訳せる形で書く（`join` に直書きしない）', () => {
    for (const rel of ['web/panel/panel.js', 'web/core/recipeWorkflowBuilder.js']) {
        const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        const hits = [...source.matchAll(/\.join\(\s*['"][^'"]*[、。（）][^'"]*['"]\s*\)/g)];
        assert.deepEqual(hits.map(m => m[0]), [], `${rel} に区切りの直書きが残っている`);
    }
});

test('釦の吹き出しは、パレットの項目名と別の鍵を使う', () => {
    // 兼用すると、**短さと名前という相反する要求**が1つの文へ乗る。日本語は
    // 短いほうへ倒れて「全画面」になり、案内が指す項目がパレットから消えていた。
    const panel = fs.readFileSync(path.join(ROOT, 'web/panel/panel.js'), 'utf8');
    assert.match(panel, /title: t\('app\.fullscreenTip'\)/, '釦が専用の鍵を使っていない');
    assert.doesNotMatch(panel, /title: t\('app\.openFullscreen'\)/,
        '釦がパレットの項目名を兼用している');
});
