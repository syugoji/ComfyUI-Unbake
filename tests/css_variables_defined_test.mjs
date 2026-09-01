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
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * **テーマの紙も見る**（`I-20260830-23`）。
 *
 * ここは `theme.css` 1枚しか読んでいなかった。テーマ2〜4 の紙は
 * `--unbake-*` を借りたうえで自前の変数（`--prism-edge` 等）も持つので、
 * **綴りを1文字間違えると、そこから連なる宣言が丸ごと死ぬ**
 * （`--prism-edge` 1つで見出し帯の枠・浮かせる面の枠・9箇所の影が道連れ）。
 *
 * 定義は**紙をまたいだ和集合**で見る——skin は `theme.css` の変数を借りる作り。
 */
/*
 * **一覧を手で書かない。** 手書きの一覧は、1行消しても検査が緑のままだった
 * （変異で確認）——つまり「対象を広げたこと」自体が守られていない。しかも
 * 5枚目の紙を足した人は、ここへ追記しないと**素通りする側へ落ちる**。
 * ディスクに在る紙を数えて、全部見る。
 */
const SHEETS = readdirSync(join(ROOT, 'web/panel'))
    .filter(name => name.endsWith('.css'))
    .sort()
    .map(name => `web/panel/${name}`);
const SOURCES = SHEETS.map(rel => ({ rel, text: readFileSync(join(ROOT, rel), 'utf8') }));
const CSS = SOURCES.map(item => item.text).join('\n');

/**
 * **新しい書き方には、必ず後退先がある**（`I-20260830-25`）。
 *
 * `color-mix()` などが読めない実装では、その値を持つカスタムプロパティは
 * *計算時に無効*になる——そして**前の宣言へは戻らない**。無効な変数を使った
 * 宣言は丸ごと捨てられるので、`background` を1つ落とすだけで
 * **その中の全部の層**（下地・中心の札・溝）が同時に消える。
 *
 * 紙はどれも `@supports not (color: color-mix(…))` の塊で後退先を置いている。
 * **19件中18件は置けていて、1件だけ抜けていた**——数が合っているかどうかは
 * 人が数えないと判らない形だったので、ここで機械に数えさせる。
 */
function guardBlocks(text) {
    const flat = text.replace(/\/\*[\s\S]*?\*\//g, '');
    const out = [];
    for (let at = flat.indexOf('@supports'); at >= 0; at = flat.indexOf('@supports', at + 1)) {
        const open = flat.indexOf('{', at);
        if (open < 0) break;
        const head = flat.slice(at, open);
        let depth = 0;
        let end = open;
        for (; end < flat.length; end += 1) {
            if (flat[end] === '{') depth += 1;
            else if (flat[end] === '}') { depth -= 1; if (depth === 0) break; }
        }
        out.push({ head, body: flat.slice(open, end + 1), negative: /@supports\s+not\b/.test(head) });
    }
    return { flat, blocks: out };
}

const MODERN = /(oklch|oklab|color-mix|\blab\(|\blch\()/;

test('新しい色の書き方を使う変数には、読めないときの後退先がある', () => {
    const missing = [];
    let checked = 0;
    for (const { rel, text } of SOURCES) {
        const { flat, blocks } = guardBlocks(text);

        // 素の部分＝どの `@supports` にも入っていない所。
        let plain = flat;
        for (const b of blocks) plain = plain.replace(b.body, ' ');

        const modern = [...new Set([...plain.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)]
            .filter(m => MODERN.test(m[2])).map(m => m[1]))];

        // 後退先は「読めないとき」の塊（`@supports not …`）の中に在る。
        const fallbacks = new Set(blocks.filter(b => b.negative && MODERN.test(b.head))
            .flatMap(b => [...b.body.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1])));

        // 使える実装だけが入る塊（`@supports (…)`）で上書きする形も後退先を持つ
        // ——素の側が既に読める値なので、ここは対象外。
        for (const name of modern) {
            checked += 1;
            if (!fallbacks.has(name)) missing.push(`${rel}: ${name}`);
        }
    }
    // **空振りしていないこと。** 0 件を数えて緑になるのが一番たちが悪い。
    assert.ok(checked >= 15,
        `新しい書き方の変数を ${checked} 個しか見ていない＝走査が壊れている`);
    assert.deepEqual(missing, [],
        '後退先の無い変数が在る（読めない実装では、これを使う宣言が丸ごと消える）');
});

test('見る紙が、テーマの紙をすべて覆っている', () => {
    // **空振りしていないこと。** 一覧が痩せたら、未定義の変数はいくらでも通る。
    assert.ok(SHEETS.includes('web/panel/theme.css'), '土台の紙を見ていない');
    const skins = SHEETS.filter(rel => /skin-/.test(rel));
    assert.ok(skins.length >= 3, `テーマの紙が ${skins.length} 枚しか対象になっていない`);
});

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

test('各紙の var() が、その紙が実際に読める範囲で定義されている', () => {
    /*
     * **和集合で見ない**（2026-08-31・監査 I-20260831-30）。
     *
     * 元は4枚を1本に連結した文字列に対して定義と使用を数えていたので、
     * 「`theme.css` の var() が全部定義されている」という名前に反して、
     * **`theme.css` が skin 専用の変数を使っていても緑**になった。
     * skin は**選ばれた時だけ**読み込まれるので、既定のテーマでは未定義になる。
     *
     * 規則は**非対称**である:
     *   `theme.css` … 常に読まれる。**自紙だけ**で閉じていなければならない。
     *   `skin-*.css` … theme の後ろに重ねて読まれる。**theme + 自紙**でよい。
     */
    const themeRel = 'web/panel/theme.css';
    const theme = SOURCES.find(item => item.rel === themeRel);
    assert.ok(theme, 'theme.css が見つからない（走査が壊れている）');

    const failures = [];
    for (const sheet of SOURCES) {
        const scope = sheet.rel === themeRel
            ? sheet.text                       // 自紙だけ
            : `${theme.text}\n${sheet.text}`;  // theme + 自紙
        const have = defined(scope);
        for (const name of used(sheet.text).keys()) {
            if (!have.has(name)) failures.push(`${sheet.rel}: ${name}`);
        }
    }
    assert.deepEqual(failures, [],
        `その紙が読める範囲に定義の無い変数: ${failures.join(' / ')}`);
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
