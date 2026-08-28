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

import { classifyWarning, SEVERITY } from '../web/core/recipeWarningSeverity.js';
import { setLocale, t } from '../web/i18n/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 未分類の上限。**実測 2026-08-28**（`ja` 21 / `en` 54・警告は全56種）。
 *
 * **減らすのは自由、増やすのは赤。** 新しい警告を足したら分類表へも足す、
 * という運用をこの数字が支える（`NODE_TEST_PROJECT_FLOOR` と同じ考え方）。
 * 数字を上げるときは、**なぜ分類できないのかを書いてから**上げること。
 */
const UNCLASSIFIED_CEILING = { ja: 21, en: 54 };

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

test('分類できない警告の数が増えていない', async () => {
    const keys = await warningKeys();
    assert.ok(keys.length >= 50, `警告の拾い方が壊れている: ${keys.length} 種`);
    try {
        for (const [locale, ceiling] of Object.entries(UNCLASSIFIED_CEILING)) {
            const missing = unclassifiedIn(locale, keys);
            assert.ok(missing.length <= ceiling,
                `${locale}: 未分類が ${missing.length} 種（上限 ${ceiling}）。`
                + `新しい警告を足したら recipeWarningSeverity.js の分類表へも足すこと`
                + `——未分類は危険と同じ点数で数えられ、**足した本人が判定を下げる**。\n  `
                + missing.join('\n  '));
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

test('分類が言語で変わることを、数字で残しておく', async () => {
    /*
     * **これは合格の記録ではなく、欠陥の大きさの記録である。**
     * 分類表は日本語の言い回しに当てているので、英語で動かすと
     * ほとんどの警告が `unknown`＝危険として数えられる——
     * **同じライブラリでも、画面の言語で判定が変わる。**
     * 直すなら鍵で分類する形（言語に依らない）へ寄せる。
     */
    const keys = await warningKeys();
    const ja = unclassifiedIn('ja', keys).length;
    const en = unclassifiedIn('en', keys).length;
    setLocale('en');
    assert.ok(en > ja,
        '言語差が消えている。消えたなら上限と、この検査の書き方を測り直すこと');
});
