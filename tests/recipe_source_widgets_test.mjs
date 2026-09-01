/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **供給ノードの口の名前を、Python と JS で1つに留める**（`I-20260831-72`）。
 *
 * 兄弟の `recipe_source_node_test.mjs` は**出力の並び**を留めているのに、
 * **入力（widget）の名前は誰も留めていなかった**。片方だけ変えると:
 *
 *   - `setNodeWidget` は口が無ければ**何もせず `false` を返す**
 *   - 呼び手は戻り値を見ていなかったので、**ノードは置けているのに束が空**の
 *     まま `{ok: true}` を返す
 *   - 画面上は正常に見える（節も配線も在る）。**差し替えても絵が変わらない**
 *
 * 同じ関数の20行下は「繋げなかったことを黙らない」として `wired < plan.length`
 * を警告している。**同じ規律が、値を書き込む側にだけ当たっていなかった。**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8');

/** `nodes.py` の `INPUT_TYPES` が宣言している口。 */
function pythonWidgets() {
    const source = read('unbake/nodes.py');
    const start = source.indexOf('def INPUT_TYPES');
    assert.ok(start >= 0, 'INPUT_TYPES が読めない');
    const block = source.slice(start, source.indexOf('def supply', start));
    const required = block.slice(block.indexOf('"required"'));
    // **注記は数えない。** 説明文が口の名前を引用している。
    const code = required.replace(/^\s*#.*$/gm, ' ');
    return [...code.matchAll(/"([a-z_]+)"\s*:\s*\(/g)].map(hit => hit[1]);
}

/** `web/unbake.js` が読み書きしている口。 */
function browserWidgets() {
    const source = read('web/unbake.js').replace(/^\s*\/\/.*$/gm, ' ');
    const names = new Set();
    for (const hit of source.matchAll(/\bstamp\(\s*'([a-z_]+)'/g)) names.add(hit[1]);
    for (const hit of source.matchAll(/setNodeWidget\([^,]+,\s*'([a-z_]+)'/g)) names.add(hit[1]);
    for (const hit of source.matchAll(/widgetValue\(\s*'([a-z_]+)'\s*\)/g)) names.add(hit[1]);
    return [...names];
}

test('ブラウザが触る口は、全部 nodes.py が宣言している', () => {
    const declared = pythonWidgets();
    assert.ok(declared.length >= 3, `口が拾えていない: ${declared}`);
    const used = browserWidgets();
    assert.ok(used.length >= 3, `使っている口が拾えていない: ${used}`);
    const unknown = used.filter(name => !declared.includes(name));
    assert.deepEqual(unknown, [],
        '`nodes.py` に無い口へ書こうとしている。**`setNodeWidget` は false を返すだけ**'
        + `なので、画面は正常に見えたまま束が空になる: ${unknown.join(', ')}`);
});

test('束を運ぶ口 recipe が両側に在る', () => {
    // **これが本体。** `image` / `url` は出どころの控えだが、`recipe` が
    // 書けないと、この節は**何も供給しない**。
    assert.ok(pythonWidgets().includes('recipe'), 'nodes.py に recipe が無い');
    assert.ok(browserWidgets().includes('recipe'), 'unbake.js が recipe へ書いていない');
});

test('書き込みの戻り値を捨てていない', () => {
    const source = read('web/unbake.js');
    const start = source.indexOf('function attachRecipeSourceNode');
    assert.ok(start >= 0, 'attachRecipeSourceNode が読めない');
    const body = source.slice(start, source.indexOf('\n    function ', start + 10));
    const code = body.replace(/^\s*\/\/.*$/gm, ' ');

    // **裸の `setNodeWidget(...)` を1文として呼ばない**——それが元の欠陥。
    const bare = [...code.matchAll(/^\s*setNodeWidget\(/gm)];
    assert.deepEqual(bare.map(hit => hit[0].trim()), [],
        '戻り値を見ずに widget へ書いている（口が無くても黙って進む）');

    // 書けなかったことを**声に出す**（この関数の建前は「置けなかったことは
    // 声に出して先へ進む」で、配線側は既にそうしている）。
    assert.match(code, /missingWidget/,
        '書けなかった口を報告していない');
});

test('報告の文言が全言語に在る', () => {
    const en = read('web/i18n/locales/en.js');
    assert.ok(en.includes('"node.recipeSource.missingWidget"'),
        'en.js に鍵が無い');
    // 残る11言語は `i18n_test.mjs` が鍵集合の一致で留める。ここは
    // **鍵が en に在ること**だけを見て、二重に数えない。
});
