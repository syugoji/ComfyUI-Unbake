/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **判定は、画面の言語で変わらない**（`I-20260830-30`）。
 *
 * 分類表に無い文は `unknown` になり、`riskCount` は unknown を risk として
 * 数える——つまり**分類し忘れただけの文が「絵が変わる」に化ける**。
 * ところが古い表（`RULES`）は `/乱数源/` のような**日本語の言い回し**で
 * 当てていたので、ja だけが救われて en が落ちる形になっていた。
 * `DEFAULT_LOCALE` は `'en'` なので、**公開版の既定が壊れている側**である。
 *
 * ## なぜ既存の検査が素通りしたか
 *
 * 鍵の集め方が `warnings.push(t('key'` の綴りに依存しており、直後が
 * `(wasRecorded ? …` になっている形を**1つも拾わなかった**。しかも
 * 1回の push で「先頭の文＋任意の節」を連結している箇所が13あり、
 * 連結後の文は**どの型にも全体一致しない**ので永久に未分類だった。
 *
 * ここでは**鍵ではなく、実際に画面へ出る文**を12言語ぶん組み立てて分類する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyWarning, summarizeWarnings, SEVERITY } from '../web/core/recipeWarningSeverity.js';
import { t, setLocale, LOCALE_META } from '../web/i18n/index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = Object.keys(LOCALE_META);

/** `warnings.push(...)` の中で使われている鍵を、**綴りに頼らず**拾う。 */
function warningKeys() {
    const src = fs.readFileSync(path.join(ROOT, 'web/core/recipeWorkflowBuilder.js'), 'utf8');
    const pushes = [];
    for (let at = src.indexOf('warnings.push('); at >= 0; at = src.indexOf('warnings.push(', at + 1)) {
        let depth = 0;
        let end = at + 'warnings.push'.length;
        for (; end < src.length; end += 1) {
            if (src[end] === '(') depth += 1;
            else if (src[end] === ')') { depth -= 1; if (depth === 0) break; }
        }
        const body = src.slice(at, end + 1);
        const keys = [...body.matchAll(/\bt\(\s*'(core\.recipeWorkflowBuilder\.[^']+)'/g)]
            .map(m => m[1]);
        if (keys.length) pushes.push(keys);
    }
    return pushes;
}

const PUSHES = warningKeys();

/** 差し込み口を埋めた文。**実際に画面へ出るのと同じ形。** */
const render = (key) => t(key, { p1: '1', p2: '2', p3: '3', p4: '4', p5: '5', p6: '6' });

test('警告の押し出しを拾えている（前提）', () => {
    assert.ok(PUSHES.length >= 40,
        `警告の押し出しを ${PUSHES.length} 箇所しか拾えていない＝走査が壊れている`);
    assert.ok(LOCALES.length >= 10, `言語を ${LOCALES.length} 個しか見ていない`);
    const multi = PUSHES.filter(keys => keys.length > 1);
    assert.ok(multi.length >= 5,
        `連結して押している箇所が ${multi.length} 個しか無い＝走査が壊れている`);
});

test('どの言語でも、警告が未分類にならない', () => {
    const unclassified = [];
    for (const locale of LOCALES) {
        setLocale(locale);
        for (const keys of PUSHES) {
            // **連結したまま**分類する（実際に押される形）。
            const text = keys.map(render).join('');
            if (!text.trim()) continue;
            if (classifyWarning(text) === SEVERITY.UNKNOWN) {
                unclassified.push(`${locale}: ${keys.join('+')}`);
            }
        }
    }
    setLocale('en');
    assert.deepEqual(unclassified.slice(0, 12), [],
        `未分類の警告が ${unclassified.length} 件（unknown は risk として数えられる）`);
});

test('同じ警告は、どの言語でも同じ重さになる', () => {
    const split = [];
    for (const keys of PUSHES) {
        const seen = new Map();
        for (const locale of LOCALES) {
            setLocale(locale);
            const text = keys.map(render).join('');
            if (!text.trim()) continue;
            const severity = classifyWarning(text);
            if (!seen.has(severity)) seen.set(severity, []);
            seen.get(severity).push(locale);
        }
        if (seen.size > 1) {
            split.push(`${keys.join('+')}: `
                + [...seen].map(([sev, ls]) => `${sev}=${ls.join(',')}`).join(' / '));
        }
    }
    setLocale('en');
    assert.deepEqual(split, [], '同じ警告が言語によって違う重さになっている');
});

test('ja と en で、内訳と riskCount が完全に一致する', () => {
    const of = (locale) => {
        setLocale(locale);
        return summarizeWarnings(PUSHES.map(keys => keys.map(render).join('')).filter(Boolean));
    };
    const ja = of('ja');
    const en = of('en');
    setLocale('en');
    assert.equal(ja.riskCount, en.riskCount,
        `riskCount が ja=${ja.riskCount} / en=${en.riskCount} に割れている`);
    for (const bucket of ['improvement', 'neutral', 'risk', 'unknown']) {
        assert.equal(ja[bucket].length, en[bucket].length,
            `${bucket} の件数が ja=${ja[bucket].length} / en=${en[bucket].length} に割れている`);
    }
    // **空振り検出。** 全部 0 件なら、この一致は何も言っていない。
    assert.ok(ja.improvement.length + ja.neutral.length + ja.risk.length >= 20,
        '分類できた警告が少なすぎる＝走査が壊れている');
});

test('[対照] 分類器は、知らない文を unknown と言える', () => {
    setLocale('en');
    assert.equal(classifyWarning('この文はどの型にも当たらないはずの文章です'), SEVERITY.UNKNOWN,
        '何を渡しても分類がつく（先頭一致が広すぎる）');
    assert.equal(classifyWarning(''), SEVERITY.UNKNOWN, '空文字に重さが付いている');
});

test('[対照] 連結した警告は、先頭の文の重さになる', () => {
    setLocale('en');
    // 実物の形: 64（ADetailer 段の復元＝改善）＋ 66（検出モデルが無く省略＝危険）。
    const lead = t('core.recipeWorkflowBuilder.64', { p1: '2', p2: 'a / b' });
    const tail = t('core.recipeWorkflowBuilder.66', { p1: '1', p2: 'c' });
    assert.equal(classifyWarning(lead), classifyWarning(lead + tail),
        '連結すると重さが変わる（判断は先頭の文が持つ）');
    assert.notEqual(classifyWarning(lead), SEVERITY.UNKNOWN, '前提: 先頭の文は分類できる');
});
