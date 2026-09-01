/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **面が読む設定に、作る側が在ること**（`I-20260830-01`）。
 *
 * 設定は保存の形（snake）で持ち、面は camel で読む。写す場所は
 * `unbake.js` の `toDisplaySettings()` **1つだけ**。ここに1行足し忘れると、
 *
 *   - 保存は成功する（サーバには入っている）
 *   - 設定の画面も**入のまま見える**（生の設定を直接読むので）
 *   - その場で切り替えた時だけ効く（`panel.js` が `next.<snake>` を見るため）
 *   - **開き直すと切に戻る**
 *
 * という、一番読みにくい形になる。実際に2回起きた:
 *
 *     2026-08-28  `downloadable_only`  絞り込みが開き直すと外れる
 *     2026-08-30  `extra_bands`        色帯が出ない（利用者の報告）
 *
 * 1件ずつ直すと3件目が出るので、**読む側と作る側を突き合わせて**見る。
 * [[recurring_symptom_means_count_the_sources]] と同じ形——押された画面ではなく
 * 作る側を数える。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const entry = read('web/unbake.js');

/** `toDisplaySettings()` が作る鍵。 */
function producedKeys() {
    const start = entry.indexOf('function toDisplaySettings(settings) {');
    assert.ok(start >= 0, 'toDisplaySettings が無い');
    const end = entry.indexOf('async function readDisplaySettings()', start);
    assert.ok(end > start, 'toDisplaySettings の範囲が取れない');
    const block = entry.slice(start, end);
    return new Set([...block.matchAll(/^\s{8,}(\w+):/gm)].map(m => m[1]));
}

/** snake を camel へ。読む側が snake で書いていても対を見つけられるようにする。 */
const toCamel = (name) => name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

test('面が読む設定の鍵が、すべて toDisplaySettings で作られている', () => {
    const produced = producedKeys();
    assert.ok(produced.size > 10, `作る側が少なすぎる: ${produced.size}`);

    const panel = read('web/panel/panel.js');
    const wanted = new Set([...panel.matchAll(/\bdisplay\??\.(\w+)/g)].map(m => m[1]));
    assert.ok(wanted.size > 10, `読む側が少なすぎる: ${wanted.size}`);

    // **snake で読んでいても、camel の対が在れば足りている**
    // （`display?.foo_bar` は `display?.fooBar` の防御的な二重読み）。
    const missing = [...wanted].filter(key => !produced.has(key) && !produced.has(toCamel(key)));
    assert.deepEqual(missing.sort(), [],
        '面が読んでいるのに toDisplaySettings が作っていない鍵がある'
        + '（保存は効くのに開き直すと既定へ戻る形になる）');
});

test('色帯の設定が写されている（利用者の報告・2026-08-30）', () => {
    // **名指しで固定する。** 上の構造検査は「読む側が在れば」しか見ないので、
    // 面の読み方を変えた瞬間にこの1件だけ静かに落ちうる。
    const produced = producedKeys();
    assert.ok(produced.has('extraBands'), 'extraBands を作っていない');
    assert.match(entry, /extraBands:\s*settings\?\.extra_bands === true/,
        '保存の鍵（extra_bands）から読み出していない');
});

test('絞り込みの設定も写されている（2026-08-28 の同型）', () => {
    // 同じ形で先に踏んだ分。**直したことを検査で留める**（また外れたら赤くなる）。
    const produced = producedKeys();
    for (const key of ['downloadableOnly', 'needsNodeOnly', 'favoritesOnly', 'hiddenVerdicts']) {
        assert.ok(produced.has(key), `${key} を作っていない`);
    }
});

test('作る側の鍵が、保存の鍵から読まれている（camel を camel から読まない）', () => {
    // `foo: settings?.foo` のように **snake へ落とさず**書くと、サーバの形と
    // 食い違って常に undefined になる。写す場所の役目そのものが抜ける形。
    const start = entry.indexOf('function toDisplaySettings(settings) {');
    const end = entry.indexOf('async function readDisplaySettings()', start);
    const block = entry.slice(start, end);
    const offenders = [];
    for (const m of block.matchAll(/^\s{8,}(\w+):\s*(?:typeof\s+)?settings\?\.(\w+)/gm)) {
        const [, produced, from] = m;
        if (/[A-Z]/.test(from) && from !== produced) offenders.push(`${produced} <- ${from}`);
        if (from === produced && /[A-Z]/.test(produced)) offenders.push(`${produced} <- ${from}`);
    }
    assert.deepEqual(offenders, [], '保存の形（snake）以外から読んでいる鍵がある');
});
