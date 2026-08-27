/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **同じ鍵を2度書かない。**
 *
 * 2026-08-26 に実際にやった: `download.progress` を足したら**既に在った**。
 * JS のオブジェクトは後ろが勝つので、**新しく書いた文言は一度も出ず**、
 * 画面には古い方（`{index}/{total} {name}`）が出ていた。**構文は正しく、
 * 検査も全部緑のまま**で、実機で数字が出ないことでしか気づけなかった。
 *
 * 読み込んだ後のオブジェクトでは重複は消えている（後ろだけ残る）ので、
 * **原文を読む**しかない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'web/i18n/locales');

/** `"鍵": …` の行から鍵を拾う。**コメントの中は読まない。** */
function keysOf(text) {
    const out = [];
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
        const match = /^"([^"]+)"\s*:/.exec(line);
        if (match) out.push(match[1]);
    }
    return out;
}

test('翻訳カタログに同じ鍵が2度出てこない', () => {
    const files = readdirSync(DIR).filter(name => name.endsWith('.js'));
    assert.ok(files.length >= 10, `カタログを読めていない（${files.length}件）`);

    const problems = [];
    for (const name of files) {
        const keys = keysOf(readFileSync(join(DIR, name), 'utf8'));
        assert.ok(keys.length >= 50, `${name}: 鍵を拾えていない（${keys.length}件）`);
        const seen = new Set();
        for (const key of keys) {
            if (seen.has(key)) problems.push(`${name}: ${key}`);
            seen.add(key);
        }
    }
    assert.deepEqual(problems, [],
        `同じ鍵を2度書いている（後ろが勝つので、前に書いた文言は出ない）:\n${problems.join('\n')}`);
});

test('検出器が生きている', () => {
    // **0件を合格と読まない。** 行の読み方が壊れれば、何も見ずに緑になる。
    const sample = '{\n    "a": "1",\n    // "a": コメントは読まない\n    "b": "2",\n    "a": "3",\n}';
    const keys = keysOf(sample);
    assert.deepEqual(keys, ['a', 'b', 'a'], `拾い方が違う: ${keys}`);
});
