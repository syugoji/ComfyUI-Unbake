/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **新しい警告を、分類表へ入れ忘れたまま出さない**
 *（2026-08-28 実機・利用者の報告「全く同じ絵を出力できたのに再現性・中」）。
 *
 * `recipeWarningSeverity.js` は未分類の警告を `unknown` にし、`riskCount` は
 * **unknown も危険として数える**（分類漏れを安全側に倒すため。この判断自体は正しい）。
 * 裏返すと、**警告を1つ足すたびに、足した本人が判定を下げる**。
 *
 * この形は既に**4回**起きている（同ファイルの注記より）:
 * 2026-08-10 に18種176件・2026-08-11 に57件・2026-08-12 に8件、そして今回。
 * **注記は増えたが、注記を守る機械が無かった。**
 *
 * ここは2つを見る:
 *   1. **足した警告が分類表に載っていること**（上限を超えたら赤）
 *   2. 分類そのものが言語で変わること——**これは今も残っている欠陥**で、
 *      下の実測値がその大きさを示している
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { classifyWarning, KEY_SEVERITY, SEVERITY } from '../web/core/recipeWarningSeverity.js';
import { LOCALE_META, setLocale, t } from '../web/i18n/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 未分類の上限。**0**。
 *
 * 2026-08-28 に鍵で分類する形へ寄せた時点で、全56種・全12言語で 0 になった
 *（それまでは ja 21 / en 54）。**新しい警告を足したら `KEY_SEVERITY` へも足す**
 * ——足さないと `unknown` になり、危険と同じ点数で数えられる。
 * **この数字は上げない。** 上げたくなったら、上げる前に分類する。
 */
const UNCLASSIFIED_CEILING = 0;

/** **本物に近い値で測る。** 差し込み口へ字を入れると、数字を見る規則が当たらない。 */
const PARAMS = { p1: 1024, p2: 1024, p3: 832, p4: 1216, count: 2, list: 'X', name: 'N', n: 2 };

async function warningKeys() {
    const source = await readFile(join(ROOT, 'web/core/recipeWorkflowBuilder.js'), 'utf8');
    const keys = new Set();
    for (const match of source.matchAll(/warnings\s*\.?\s*push\(\s*(?:\.\.\.)?\s*t\(\s*'([^']+)'/g)) {
        keys.add(match[1]);
    }
    for (const match of source.matchAll(/warnings\.push\(\s*\n\s*t\(\s*'([^']+)'/g)) {
        keys.add(match[1]);
    }
    return [...keys];
}

const unclassifiedIn = (locale, keys) => {
    setLocale(locale);
    return keys.filter(key => classifyWarning(t(key, PARAMS)) === SEVERITY.UNKNOWN);
};

test('組み立てが出す警告が、全部分類されている', async () => {
    const keys = await warningKeys();
    assert.ok(keys.length >= 50, `警告の拾い方が壊れている: ${keys.length} 種`);

    /*
     * **鍵の表に載っていること自体を見る。** 載っていなくても、古い日本語の
     * 言い回しの表（`RULES`）に当たれば分類はされる——が、それは
     * **日本語でだけ通る**という元の欠陥そのものなので、ここで塞ぐ。
     */
    const notInTable = keys.filter(key => !(key in KEY_SEVERITY));
    assert.deepEqual(notInTable, [],
        `鍵の表に無い警告がある（訳文の表に頼ると言語で判定が変わる）: ${notInTable.join(' / ')}`);

    try {
        for (const locale of Object.keys(LOCALE_META)) {
            const missing = unclassifiedIn(locale, keys);
            assert.equal(missing.length, UNCLASSIFIED_CEILING,
                `${locale}: 未分類が ${missing.length} 種。`
                + '新しい警告を足したら KEY_SEVERITY へも足すこと'
                + '——未分類は危険と同じ点数で数えられ、足した本人が判定を下げる: '
                + missing.join(' / '));
        }
    } finally { setLocale('en'); }
});

test('埋め込みグラフの寸法を残した件は「改善」に数える', async () => {
    /*
     * 直したその日に、この1件で「全く同じ絵が出たのに再現性・中」が起きた。
     * **忠実度を上げた処理が自分のスコアを下げる**のは、この面が
     * 2026-08-10 に一度直したはずの形である。
     */
    try {
        for (const locale of ['ja', 'en']) {
            setLocale(locale);
            const message = t('core.recipeWorkflowBuilder.sizeFromGraph', PARAMS);
            assert.equal(classifyWarning(message), SEVERITY.IMPROVEMENT,
                `${locale}: 改善として数えていない（危険と同じ点数になる）`);
        }
    } finally { setLocale('en'); }
});

test('12言語すべてで、同じ警告が同じ分類になる', async () => {
    /*
     * **判定が画面の言語で変わってはいけない。** 表を訳文の言い回しへ当てていた
     * 間は、英語で動かすとほぼ全部が危険側に数えられていた（実測 54/56）。
     * ここが赤くなるのは、**また訳文に判断を持たせたとき**である。
     */
    const keys = await warningKeys();
    const first = {};
    const differences = [];
    try {
        for (const locale of Object.keys(LOCALE_META)) {
            setLocale(locale);
            for (const key of keys) {
                const severity = classifyWarning(t(key, PARAMS));
                if (!(key in first)) first[key] = severity;
                else if (first[key] !== severity) {
                    differences.push(`${key}: ${first[key]} != ${severity} (${locale})`);
                }
            }
        }
    } finally { setLocale('en'); }
    assert.deepEqual(differences, [],
        `言語で分類が変わっている（訳文に判断を持たせた）: ${differences.join(' / ')}`);
});
