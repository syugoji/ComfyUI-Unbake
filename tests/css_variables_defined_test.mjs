/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **使っている色が定義されていること。**
 *
 * 2026-08-26 に実際にやった: 新しいボタンへ `var(--unbake-border)` と
 * `var(--unbake-fg-dim)` を書いたが、**どちらも定義されていなかった**
 * （実在するのは `--unbake-line` と `--unbake-muted`）。
 *
 * CSS は未定義の変数を**黙って捨てる**——構文としては正しいので、
 * lint も構文検査も通り、**画面を開いて初めて枠線が消えていると判る**。
 * しかもその画面は記録の詳細という奥まった所なので、気づかない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = readFileSync(join(ROOT, 'web/panel/theme.css'), 'utf8');

/** `--名前:` の形で**定義**されているもの。 */
function defined(css) {
    const out = new Set();
    for (const m of css.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) out.add(m[1]);
    return out;
}

/** `var(--名前)` の形で**使われて**いるもの。 */
function used(css) {
    const out = new Map();
    for (const m of css.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*([,)])/g)) {
        // **既定値つき（`var(--x, #fff)`）は除く。** 未定義でも絵は崩れない。
        if (m[2] === ',') continue;
        out.set(m[1], (out.get(m[1]) || 0) + 1);
    }
    return out;
}

test('theme.css の var() が全部定義されている', () => {
    const have = defined(CSS);
    const missing = [...used(CSS).keys()].filter(name => !have.has(name));
    assert.deepEqual(missing, [], `定義の無い変数: ${missing.join(', ')}`);
});

test('検査そのものが空振りしていない', () => {
    // **0件を合格と読まない。** 正規表現が壊れれば、何も見ずに緑になる。
    assert.ok(defined(CSS).size >= 20, '定義を1つも拾えていない');
    assert.ok(used(CSS).size >= 20, '使用を1つも拾えていない');
    // 実在しない名前を混ぜたら赤くなること（検査器の生死）。
    const broken = CSS + '\n.x { color: var(--unbake-does-not-exist); }';
    const have = defined(broken);
    assert.ok([...used(broken).keys()].some(n => !have.has(n)), '未定義を見つけられない');
});
