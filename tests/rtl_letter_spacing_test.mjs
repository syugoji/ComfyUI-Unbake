/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **右横書きの訳文に文字送りが効いていないこと。**
 *
 * `letter-spacing` はグリフとグリフの間に空きを入れる。ラテン文字なら見出しが
 * 締まるだけだが、**アラビア文字は連綴（cursive joining）で1本に繋がって書く**ので、
 * 送りを入れると繋がりが視覚的に切れる。`tile.commercial.no` の ar は「لا」——
 * 合字1つのはずが、送りを入れると別々の2字に見える。ar / fa を出荷している
 * （`web/i18n/locales/` に12言語）以上、これを踏む相手が実在する。
 *
 * **画面を見ないと分からない壊れ方なので、検査は「宣言が在るか」で押さえる。**
 * 測るのは2つ:
 *   分類  `theme.css` の `letter-spacing` 宣言が全部、対象（GUARDED）か
 *         対象外（EXEMPT）のどちらかに載っていること。
 *         **新しく足した宣言は自動では対象外にならない**——載っていなければ赤くなる。
 *   無効化 GUARDED の各セレクタに `.unbake-root[dir="rtl"]` を前置した
 *         `letter-spacing: normal` が在ること。
 *
 * **順序は問わない。** 無効化側は元のセレクタに `.unbake-root[dir="rtl"]` を
 * 足した形なので詳細度が必ず勝つ。代わりに `!important` を禁じる
 * ——それを許すと順序と詳細度の両方が意味を失う。
 *
 * **対象外は「訳さない」という主張なので、機械で裏を取る。**
 * その class に `text: t(...)` が付いていないことを `web/panel/*.js` で確かめる。
 * 内容を根拠にした例外は放っておくと古くなる（実際 `.unbake-title` は
 * `t('app.title')` を通るので、今は全言語 "Unbake" でも GUARDED に入れてある）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const THEME_PATH = path.join(ROOT, 'web/panel/theme.css');
const THEME = fs.readFileSync(THEME_PATH, 'utf8');
const PANEL_DIR = path.join(ROOT, 'web/panel');

/**
 * 送りを持ったまま右横書きに入ると壊れるセレクタ。
 *
 * **判定は「`t()` を通るか」で行う**（2026-08-24 実測）。訳文の実体まで見て
 * 「今はラテンだから」と外すと、locale が1本増えた日に黙って壊れる。
 */
const GUARDED = [
    // `t('app.title')`。今は12言語すべて "Unbake" だが、鍵を通る以上いつでも訳され得る。
    '.unbake-title',
    // 列見出しは全部 `t('column.*')`。ar の `column.record.short` は「سجل」。
    '.unbake-table th',
    // `t('tile.commercial.yes' / '.no')`。ar は「نعم」「لا」。
    '.unbake-tile-commercial',
    // `t('donate.<節>.title')`。ar の `donate.mine.title` は「إلى أين يذهب」。
    '.unbake-donate-section-title',
    // `t('settings.group.*')`。ar の `settings.group.keys` は「المفاتيح」。
    '.unbake-settings-group-title',
    // `t('raindrop.group.*')`。ar の `raindrop.group.fresh` は「غير مستورَدة」。
    '.unbake-raindrop-group',
    // まとめの名札（表・タイルとも訳文が入る）。
    '.unbake-group-name',
    '.unbake-tile-group',
];

/** 送りを残してよいセレクタと、その理由。値は下の検査で裏を取る。 */
const EXEMPT = new Map([
    ['.unbake-tile-base', 'baseModelBadge() の返り値（SDXL / PONY / F1D …）。A-Z0-9. に畳んでいる'],
    ['.unbake-tile-name-id', '出力ファイル名の連番（civitai_ に続く数字）'],
]);

/** コメントを外す。CSS のコメントは入れ子にならないので最短一致で足りる。 */
function stripComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * `セレクタ { 宣言 }` を拾う。`[^{}]` なので `@media` の外枠は自分では合わず、
 * 中の規則の方が拾われる（欲しいのはそちら）。
 */
function rules(css) {
    return [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({
        selectors: m[1].split(',').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean),
        body: m[2],
        index: m.index,
    }));
}

/** `letter-spacing` を宣言している規則だけ、セレクタ単位に展開する。 */
function letterSpacingDeclarations(css) {
    const out = [];
    for (const rule of rules(css)) {
        const m = rule.body.match(/(^|[;{\s])letter-spacing\s*:\s*([^;}]+)/);
        if (!m) continue;
        const raw = m[2].trim();
        for (const selector of rule.selectors) {
            out.push({
                selector,
                value: raw.replace(/\s*!important$/, '').trim(),
                important: /!important\s*$/.test(raw),
                index: rule.index,
            });
        }
    }
    return out;
}

const DECLARATIONS = letterSpacingDeclarations(THEME);

test('theme.css に letter-spacing の宣言が実在する（検査が空振りしていない）', () => {
    // ここが0なら以下の検査は全部素通りする。**空集合に対する全称は必ず真。**
    assert.ok(DECLARATIONS.length >= 5, `letter-spacing の宣言が ${DECLARATIONS.length} 件しか無い`);
});

test('letter-spacing を持つセレクタが全部 GUARDED か EXEMPT に載っている', () => {
    const tracking = DECLARATIONS.filter(d => d.value !== 'normal');
    const unclassified = tracking
        .filter(d => !GUARDED.includes(d.selector) && !EXEMPT.has(d.selector))
        .map(d => `${d.selector} (letter-spacing: ${d.value})`);
    assert.deepEqual(unclassified, [],
        '分類されていない letter-spacing がある。訳文を出すなら GUARDED へ、'
        + '出さないなら理由つきで EXEMPT へ入れること');
});

test('送りを入れる宣言に !important が無い（前置の無効化が必ず勝つ前提）', () => {
    const forced = DECLARATIONS
        .filter(d => d.value !== 'normal' && d.important)
        .map(d => d.selector);
    assert.deepEqual(forced, []);
});

test('GUARDED の各セレクタに、右横書きでの letter-spacing: normal が在る', () => {
    const disabled = new Set(
        DECLARATIONS.filter(d => d.value === 'normal').map(d => d.selector),
    );
    const missing = GUARDED.filter(sel => !disabled.has(`.unbake-root[dir="rtl"] ${sel}`));
    assert.deepEqual(missing, [],
        '右横書きで文字送りが残る。`.unbake-root[dir="rtl"] <セレクタ>` に '
        + '`letter-spacing: normal` を足すこと');
});

test('GUARDED の各セレクタが theme.css に実在する（改名で検査が空振りしない）', () => {
    const declared = new Set(DECLARATIONS.filter(d => d.value !== 'normal').map(d => d.selector));
    const gone = GUARDED.filter(sel => !declared.has(sel));
    assert.deepEqual(gone, [],
        'GUARDED に載っているのに letter-spacing を持っていない。'
        + '消えたなら GUARDED からも消すこと（残すと守っているつもりで空振りする）');
});

/** `class: '<name>'` を含む `element()` の引数オブジェクトを、波括弧の対応で切り出す。 */
function objectLiteralsFor(source, className) {
    const out = [];
    const needle = `'${className}'`;
    for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + 1)) {
        const open = source.lastIndexOf('{', at);
        if (open < 0) continue;
        let depth = 0;
        for (let i = open; i < source.length; i += 1) {
            if (source[i] === '{') depth += 1;
            else if (source[i] === '}') {
                depth -= 1;
                if (depth === 0) { out.push(source.slice(open, i + 1)); break; }
            }
        }
    }
    return out;
}

function panelSources() {
    return fs.readdirSync(PANEL_DIR)
        .filter(name => name.endsWith('.js'))
        .map(name => ({ name, text: fs.readFileSync(path.join(PANEL_DIR, name), 'utf8') }));
}

test('EXEMPT の class は訳文を受け取っていない', () => {
    const sources = panelSources();
    const violations = [];
    for (const [selector, reason] of EXEMPT) {
        const className = selector.replace(/^\./, '');
        let seen = 0;
        for (const { name, text } of sources) {
            for (const literal of objectLiteralsFor(text, className)) {
                seen += 1;
                if (/text\s*:\s*t\s*\(/.test(literal)) {
                    violations.push(`${selector} は ${name} で t() の訳文を受け取っている（理由「${reason}」は既に古い）`);
                }
            }
        }
        if (seen === 0) violations.push(`${selector} が web/panel/*.js に見当たらない（改名か削除）`);
    }
    assert.deepEqual(violations, []);
});

test('letter-spacing を JS のインライン style で入れていない（CSS の検査を迂回しない）', () => {
    const hits = panelSources()
        .filter(({ text }) => /letterSpacing|letter-spacing/.test(text))
        .map(({ name }) => name);
    assert.deepEqual(hits, []);
});
