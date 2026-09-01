/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **札は、それが指している値から作る**（`I-20260901-05`・2026-09-01）。
 *
 * `core.sweep.tpl.promptDetail.sharp` の英語の札は **`outline`**（輪郭＝描き込みが
 * *減る* 側）だったが、`sweepAxes.js` でその札が付く値は
 * **`sharp focus, intricate details`**（描き込みを *増やす* 側）だった。
 * 同じ族の `desc` も `nothing / highly detailed / **sharp focus**` と書いており、
 * **札だけが逆を向いていた。**
 *
 * **11言語すべてが、その誤った英語を忠実に訳していた**——輪郭／轮廓／윤곽／контур／
 * contorno／contour／kontur／الحدود／خط بیرونی。**原文が誤っていると、訳が正しいほど
 * 同じ誤りが12箇所へ増える。** 訳のレビューでは見つからない（訳は原文に忠実なので）。
 * 実際、`zh-TW` の機械レビューは「訳は忠実だが**原文側の誤記の疑い**」として
 * 自分から確度を下げて挙げてきた。
 *
 * ここで留めるのは**関係**であって綴りではない。札の語が、その札が付く値の中に
 * 在ること——`sharp focus` ⊂ `sharp focus, intricate details`、
 * `detail` ⊂ `highly detailed`。**札の言い回しは自由に変えてよい。**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATALOGS, DEFAULT_LOCALE } from '../web/i18n/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** `{ label: t('KEY'), value: 'LITERAL' … }` の組を拾う。 */
function labelledValues(source) {
    const found = [];
    const re = /\{\s*label:\s*t\(\s*'([^']+)'\s*\)\s*,\s*value:\s*'([^']*)'/g;
    for (const hit of source.matchAll(re)) found.push({ key: hit[1], value: hit[2] });
    return found;
}

test('軸の札が、その札の付く値と同じ向きを指している', async () => {
    const source = await readFile(join(ROOT, 'web/core/sweepAxes.js'), 'utf8');
    const pairs = labelledValues(source);
    assert.ok(pairs.length >= 3, `札と値の組が拾えていない（${pairs.length}）`);

    const en = CATALOGS[DEFAULT_LOCALE];
    const wrong = [];
    let checked = 0;
    for (const { key, value } of pairs) {
        // **空の値は基準点**（`no append`）。指すものが無いので比べようがない。
        if (!value.trim()) continue;
        const label = String(en[key] ?? '');
        assert.ok(label, `${key} が en に無い`);
        checked += 1;
        // 札の語（3文字以上）のどれかが、値の中に在ること。
        // `detail` ⊂ `highly detailed` のような語幹の一致も通す。
        const words = label.toLowerCase().match(/[a-z]{3,}/g) || [];
        const hay = value.toLowerCase();
        if (!words.some(w => hay.includes(w))) {
            wrong.push(`${key}: 札 "${label}" が値 "${value}" のどこにも無い`);
        }
    }
    assert.ok(checked >= 2, `比べた組が少なすぎる（${checked}）`);
    assert.deepEqual(wrong, [],
        '札が、それの付く値と別のことを言っている。**原文が誤っていると、'
        + '訳が正しいほど同じ誤りが全言語へ増える**:\n  ' + wrong.join('\n  '));
});

test('直した札が全言語で「輪郭」側へ戻っていない', async () => {
    // **綴りは固定しない。** 各言語が「輪郭」と言っていないことだけを見る
    // ——これは*直した当の誤り*なので、戻ったら赤くする。
    const OUTLINE = ['outline', '輪郭', '轮廓', '輪廓', '윤곽', 'контур',
                     'contorno', 'contour', 'kontur', 'الحدود', 'خط بیرونی'];
    const back = [];
    for (const [code, table] of Object.entries(CATALOGS)) {
        const value = String(table['core.sweep.tpl.promptDetail.sharp'] ?? '').toLowerCase();
        if (OUTLINE.some(w => value === w.toLowerCase())) back.push(code);
    }
    assert.deepEqual(back, [],
        `「輪郭」側へ戻っている: ${back.join(', ')}（値は "sharp focus, intricate details"）`);
});
