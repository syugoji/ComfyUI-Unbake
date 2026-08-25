/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 警告の重さの分類。
 *
 * **表に無い文は `unknown` として危険と同じ点数で数えられる。** つまり
 * 分類し忘れた警告は、**再現性の判定を理由もなく下げる**——2026-08-25 に
 * 実際に起きた（タイル分割の注意を足したら `civitai_137676446` が
 * 「完全ワークフロー」から落ちていた）。
 *
 * **足した警告は、必ずここで分類まで見る。**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SEVERITY, classifyWarning, summarizeWarnings } from '../web/core/recipeWarningSeverity.js';
import { setLocale, t } from '../web/i18n/index.js';

test('タイル分割の注意は、判定を下げない', () => {
    // グラフは記録どおりで、これは**運用上の注意**にすぎない。
    for (const locale of ['ja', 'en']) {
        setLocale(locale);
        const message = t('core.recipeWorkflowBuilder.tiledDecode');
        assert.ok(message && !message.startsWith('['), `${locale}: 訳が無い`);
        assert.equal(classifyWarning(message), SEVERITY.NEUTRAL,
            `${locale}: 分類されていない（unknown は危険と同じ点数で数えられる）`);
    }
    setLocale('ja');
});

test('元からタイル分割の記録は、「切り替えました」と言わない', () => {
    // **やっていないことを言わない**（2026-08-25 実測 `civitai_137676446`:
    // 記録そのものが `VAEDecodeTiled`（tile_size 224）で書かれていたのに
    // 「最後の段がとても大きいため切り替えました」と出していた）。
    for (const locale of ['ja', 'en']) {
        setLocale(locale);
        const message = t('core.recipeWorkflowBuilder.tiledDecodeFromRecord');
        assert.ok(message && !message.startsWith('['), `${locale}: 訳が無い`);
        // 「こちらが切り替えた」と読める言い方をしないこと。
        assert.ok(!/復号をタイル分割へ切り替えています|decoding is switched to tiles/.test(message),
            `${locale}: こちらが切り替えたと言っている`);
        assert.ok(/元から|already/.test(message), `${locale}: 元からそうだと言っていない`);
        // **止まり得ることは、こちらでも同じだけ言う。**
        assert.ok(/止ま|stall/.test(message), `${locale}: 止まり得ることを言っていない`);
        assert.equal(classifyWarning(message), SEVERITY.NEUTRAL,
            `${locale}: 分類されていない（unknown は危険と同じ点数で数えられる）`);
    }
    setLocale('ja');
});

test('LoRA まわりで足した文は、すべて判定を下げない側にある', () => {
    // **表に無い文は unknown＝危険と同じ点数**で、再現性の判定を理由もなく下げる。
    // 足した文をここへ書き足し忘れる、が実際に起きた失敗なので、まとめて見る。
    for (const locale of ['ja', 'en']) {
        setLocale(locale);
        for (const key of [
            'core.recipeWorkflowBuilder.expandedLoras',
            'core.recipeWorkflowBuilder.bypassedLoraCarrier',
        ]) {
            const message = t(key, { p1: 'Lora Loader (LoraManager)', p2: 8 });
            assert.ok(message && !message.startsWith('['), `${locale}: ${key} の訳が無い`);
            assert.equal(classifyWarning(message), SEVERITY.NEUTRAL,
                `${locale}: ${key} が分類されていない（unknown は危険と同じ点数）`);
        }
    }
    setLocale('ja');
});

test('分類されない文は unknown として数える（検出器が生きている）', () => {
    // **この検査が空振りしていないこと。** 何でも neutral を返す実装なら、
    // 上の検査は意味を持たない。
    const summary = summarizeWarnings(['まったく見覚えのない文です']);
    assert.ok(summary.unknown.length >= 1, '未知の文を unknown として数えていない');
    assert.ok(summary.riskCount >= 1, '未知の文を危険側に数えていない');
});

test('判定を下げない側は、危険の点数に入らない', () => {
    setLocale('ja');
    const summary = summarizeWarnings([t('core.recipeWorkflowBuilder.tiledDecode')]);
    assert.equal(summary.riskCount, 0,
        `注意だけなのに危険として数えている（${JSON.stringify(summary.unknown)}）`);
});

// --- 大きすぎる再現を縮める（2026-08-25 利用者の指示）-----------------------

test('縮めたことは、判定を下げない注意として扱う', async () => {
    setLocale('ja');
    const message = t('core.recipeWorkflowBuilder.cappedSize', {
        p1: 2560, p2: 3712, p3: 1760, p4: 2552,
    });
    assert.ok(message && !message.startsWith('['), '訳が無い');
    // **記録より小さいのは事実**なので、改善でも危険でもない。
    const summary = summarizeWarnings([message]);
    assert.equal(summary.unknown.length, 0,
        `分類されていない（unknown は危険と同じ点数で数えられる）: ${JSON.stringify(summary.unknown)}`);
    // **数字がそのまま出ること。** 縮めたのに元の寸法しか出ないと、差が読めない。
    assert.ok(message.includes('2560x3712') && message.includes('1760x2552'),
        `寸法が入っていない: ${message}`);
});
