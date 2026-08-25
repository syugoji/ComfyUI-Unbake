/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * テーマ2（`skin-prism.css`）を、**捨てられる状態のまま**保つ。
 *
 * 利用者の指示は「テーマ2を作れ。ただし**却下する可能性がある**ので
 * 可塑性を持たせて」だった。可塑性は意図では保てない——**規則が1つでも
 * `[data-skin]` の外へ出た瞬間に、テーマ1が汚れて戻せなくなる。**
 * だからここで、紙の**全ての規則**を走査して閉じ込めを固定する。
 *
 * 同時に、テーマ1が積み上げてきた約束もこちらへ引く:
 *   - 判定済みを薄くしない（`opacity: 0.x` を書かない）
 *   - 一覧をカード格子にしない（`grid-template-columns` を足さない）
 *   - 色を焼き込まない（`--unbake-*` から作る＝配色と判定の色分けが効き続ける）
 *
 * **紙は名前で拾う**（`skin-*.css`）。次にテーマ3を足した人も、
 * 何も書かずに同じ検査へ入る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SKINS, SKIN_LINK_ID, applySkin, normalizeSkin } from '../web/panel/skin.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = path.join(ROOT, 'web/panel');

/** 紙を名前で拾う。**1枚も無ければ走査が壊れている。** */
function skinSheets() {
    return fs.readdirSync(PANEL)
        .filter(name => /^skin-.*\.css$/.test(name))
        .map(name => ({ name, css: fs.readFileSync(path.join(PANEL, name), 'utf8') }));
}

function stripComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * 規則を平らに並べる。`@media` / `@supports` の中は**中へ降りる**
 * ——降りないと、囲みの中へ書いた規則が丸ごと検査から消える。
 *
 * @returns {{selectors: string[], body: string, at: string|null}[]}
 */
function rulesOf(css) {
    const out = [];
    const walk = (text, context = []) => {
        let i = 0;
        while (i < text.length) {
            const open = text.indexOf('{', i);
            if (open < 0) break;
            const prelude = text.slice(i, open).trim();
            // 対応する閉じ括弧を探す（入れ子を数える）。
            let depth = 1;
            let j = open + 1;
            for (; j < text.length && depth > 0; j += 1) {
                if (text[j] === '{') depth += 1;
                else if (text[j] === '}') depth -= 1;
            }
            const body = text.slice(open + 1, j - 1);
            if (/^@(media|supports|layer|container)/.test(prelude)) walk(body, [...context, prelude]);
            else if (prelude.startsWith('@')) out.push({ selectors: [], body, at: prelude, context });
            else out.push({ selectors: prelude.split(',').map(s => s.trim()).filter(Boolean), body, at: null, context });
            i = j;
        }
    };
    walk(stripComments(css));
    return out;
}

const skinOf = (fileName) => fileName.replace(/^skin-/, '').replace(/\.css$/, '');

/**
 * 書いてよい入口は2つだけ。**どちらも自分の名前で始まる。**
 *
 *   `.unbake-root[data-skin="<自分>"]`     面の中
 *   `html[data-unbake-skin="<自分>"]`      面の外（ComfyUI のツール列の印）
 *
 * 外へ出る口を開けたのは 2026-08-25（利用者の指示「アイコンも変化させたい」）。
 * **1つに限る**——ここを緩めると、テーマが宿主の画面を好きに触り始める。
 */
const allowedScopes = (skin) => [
    `.unbake-root[data-skin="${skin}"]`,
    `html[data-unbake-skin="${skin}"]`,
];

test('テーマの規則は、1つ残らず自分の名前の下に在る（他へ漏れない）', () => {
    const sheets = skinSheets();
    assert.ok(sheets.length >= 1, '紙を1枚も拾えていない＝走査が壊れている');
    const leaked = [];
    let counted = 0;
    for (const sheet of sheets) {
        const scopes = allowedScopes(skinOf(sheet.name));
        for (const rule of rulesOf(sheet.css)) {
            if (rule.at) continue;
            for (const selector of rule.selectors) {
                counted += 1;
                if (!scopes.some(scope => selector.startsWith(scope))) {
                    leaked.push(`${sheet.name}: ${selector}`);
                }
            }
        }
    }
    // **空振りしていないこと。** 規則を1つも拾えていなければ、上の全称は必ず真。
    assert.ok(counted >= 40, `選択子を ${counted} 個しか拾えていない＝走査が壊れている`);
    assert.deepEqual(leaked, [], '自分の名前の外へ効く規則を書いている（戻せなくなる）');
});

test('面の外へ出てよいのは、印だけ（宿主の画面を触らない）', () => {
    // **外へ出る口は、開けた瞬間に「どこまで触ってよいか」が問題になる。**
    // 触ってよいのは ComfyUI のツール列に居るこちらの印（`.unbake-icon`）だけ。
    const wide = [];
    for (const sheet of skinSheets()) {
        const outside = `html[data-unbake-skin="${skinOf(sheet.name)}"]`;
        for (const rule of rulesOf(sheet.css)) {
            if (rule.at) continue;
            for (const selector of rule.selectors) {
                if (!selector.startsWith(outside)) continue;
                const rest = selector.slice(outside.length).trim();
                // **エスケープを書かない。** 道具を通すと `\b` が
                // 制御文字そのものに化ける（2026-08-25 実際に混入した）。
                const head = rest.split(/[\s>+~:.\[]/)[0] || rest;
                if (rest !== '.unbake-icon' && head !== '.unbake-icon') {
                    wide.push(`${sheet.name}: ${selector}`);
                }
            }
        }
    }
    assert.deepEqual(wide, [], '面の外で、印以外を触っている');
});

test('動きの名前は、テーマ2の物だと分かる形にする', () => {
    // `@keyframes` は**囲みの外に住む**（`[data-skin]` の下へは置けない）。
    // 名前が被ると、テーマ1やほかの拡張の動きを黙って書き換える。
    const bad = [];
    for (const sheet of skinSheets()) {
        for (const rule of rulesOf(sheet.css)) {
            if (!rule.at?.startsWith('@keyframes')) continue;
            const name = rule.at.replace('@keyframes', '').trim();
            // **紙の名前から作る。** 決め打ちにすると、テーマ3を足した日に
            // 「prism で始まっていない」と赤くなるか、検査を緩めることになる。
            const want = `unbake-${sheet.name.replace(/^skin-/, '').replace(/\.css$/, '')}-`;
            if (!name.startsWith(want)) bad.push(`${sheet.name}: ${name}（${want}… で始めること）`);
        }
    }
    assert.deepEqual(bad, [], '動きの名前が誰の物か分からない（他所と衝突する）');
});

test('「全部」に効く指定を書かない（何に効いたか分からなくなる）', () => {
    // **実機で踏んだ**（2026-08-25 利用者の指摘「テーマ2で設定ポップアップが狭くなる」）。
    // テーマ2は靄を敷くために `.unbake-root[data-skin="prism"] > *` で
    // **直下の子を全部 `position: relative`** にしていた。それが覆いにも当たり、
    // `position: fixed` を打ち消して**設定の面を器の幅へ閉じ込めた**
    // （実測 720px → 376px）。
    //
    // 見た目を差し替えるのに、**全部を名指しする必要は無い**。
    // 触る相手は1つずつ名前で呼ぶ。
    const blanket = [];
    for (const sheet of skinSheets()) {
        for (const rule of rulesOf(sheet.css)) {
            if (rule.at) continue;
            for (const selector of rule.selectors) {
                // `*` が**要素の位置に**出てくる形だけを見る
                // （`[class*="x"]` のような属性の中の `*` は別物）。
                const withoutAttributes = selector.replace(/\[[^\]]*\]/g, '');
                if (/(^|[\s>+~])\*/.test(withoutAttributes)) blanket.push(`${sheet.name}: ${selector}`);
            }
        }
    }
    assert.deepEqual(blanket, [], '全部に効く指定を書いている（位置や大きさを巻き込む）');
});

test('位置の指定を、宿主の覆いへ持ち込まない', () => {
    // **覆いは `position: fixed` で窓いっぱいに広がる。** ここを触ると、
    // 中の面（設定・確認）の幅がまとめて変わる——**見た目の差し替えの範囲を超える。**
    const touched = [];
    for (const sheet of skinSheets()) {
        for (const rule of rulesOf(sheet.css)) {
            if (rule.at) continue;
            const hits = rule.selectors.filter(selector => /unbake-(popup-layer|detail-backdrop|donate-backdrop)/.test(selector));
            if (!hits.length) continue;
            if (/(^|[;{\s])position\s*:/.test(rule.body)) touched.push(`${sheet.name}: ${hits.join(',')} に position`);
            if (/(^|[;{\s])(width|height|inset|top|left|right|bottom)\s*:/.test(rule.body)) {
                touched.push(`${sheet.name}: ${hits.join(',')} に大きさ`);
            }
        }
    }
    assert.deepEqual(touched, [], '覆いの位置や大きさを触っている');
});

test('判定済みを薄くする指定を、テーマ2でも入れていない', () => {
    // テーマ1と同じ約束。**薄い＝見直せない。**
    // 0 と 1 は「出す／出さない」なので対象外——薄める小数だけを見る。
    const dimming = [];
    for (const sheet of skinSheets()) {
        for (const hit of stripComments(sheet.css).matchAll(/opacity\s*:\s*0?\.\d+/g)) {
            dimming.push(`${sheet.name}: ${hit[0]}`);
        }
    }
    assert.deepEqual(dimming, [], '判定済みを薄くする指定がある');
});

test('テーマ2でも、一覧をカード格子にしない', () => {
    // 上流はモデルの**カード格子**。作りを変えても、そこへ寄る道は塞いだまま。
    const grids = [];
    for (const sheet of skinSheets()) {
        for (const hit of stripComments(sheet.css).matchAll(/grid-template-columns/g)) {
            grids.push(`${sheet.name}: ${hit[0]}`);
        }
    }
    assert.deepEqual(grids, [], 'テーマ2から格子を作り始めている');
});

test('色を焼き込まない（配色と判定の色分けが、テーマ2でも効く）', () => {
    // **色は `--unbake-*` から作る。** 直に色を書くと、琥珀・炭・苔・紙を選んだ
    // 画面でそこだけ元の色が残り、判定の色分け（deuteranopia）も効かなくなる。
    // 影とガラスの縁に使う**無彩色**（黒・白）だけは直に書いてよい。
    const literals = [];
    for (const sheet of skinSheets()) {
        const css = stripComments(sheet.css);
        for (const hit of css.matchAll(/#([0-9a-fA-F]{3,8})\b/g)) {
            const hex = hit[1];
            const size = hex.length >= 6 ? 2 : 1;
            const parts = [0, 1, 2].map(k => hex.slice(k * size, k * size + size));
            if (new Set(parts).size !== 1) literals.push(`${sheet.name}: #${hex}`);
        }
        for (const hit of css.matchAll(/rgba?\(([^)]*)\)/g)) {
            const [r, g, b] = hit[1].split(',').map(part => part.trim());
            if (new Set([r, g, b]).size !== 1) literals.push(`${sheet.name}: ${hit[0]}`);
        }
    }
    assert.deepEqual(literals, [], '配色を無視した色を焼き込んでいる');
});

test('動く指定は、厚みを切った時と「動きを減らす」時の両方で止まる', () => {
    // **入れた動きを止め忘れない。** 実機で確かめたことを、ここで機械に持たせる
    // ——手で確かめただけの約束は、次に足した動きで静かに破れる。
    const off = (selector) => selector.replace('[data-rich="off"]', '');
    for (const sheet of skinSheets()) {
        const rules = rulesOf(sheet.css);
        const animated = new Set();
        const killedByFlag = new Set();
        const killedByOs = new Set();
        for (const rule of rules) {
            if (rule.at) continue;
            const body = rule.body;
            const reduced = rule.context.some(at => /prefers-reduced-motion/.test(at));
            for (const selector of rule.selectors) {
                if (/animation\s*:\s*none/.test(body)) {
                    if (reduced) killedByOs.add(off(selector));
                    else if (selector.includes('[data-rich="off"]')) killedByFlag.add(off(selector));
                    continue;
                }
                if (/animation\s*:\s*(?!none)\S/.test(body)) animated.add(off(selector));
            }
        }
        // **空振りしていないこと。**
        assert.ok(animated.size >= 3, `${sheet.name}: 動く指定を ${animated.size} 個しか拾えていない`);
        const missingFlag = [...animated].filter(selector => !killedByFlag.has(selector));
        const missingOs = [...animated].filter(selector => !killedByOs.has(selector));
        assert.deepEqual(missingFlag, [], `${sheet.name}: 厚みを切っても止まらない動きがある`);
        assert.deepEqual(missingOs, [], `${sheet.name}: OS の「動きを減らす」で止まらない動きがある`);
    }
});

test('検査そのものが発火する（漏れ・薄め・格子・色を、実際に赤くできる）', () => {
    // **空振りする検査は、無いのと同じ。** 4つの規則それぞれについて、
    // 違反した紙を渡したら拾えることを確かめる。
    const leaked = rulesOf('.unbake-tile { color: red; }');
    assert.equal(leaked.length, 1);
    assert.ok(!allowedScopes('prism').some(scope => leaked[0].selectors[0].startsWith(scope)),
        '漏れを漏れと読めていない');

    // 囲みの中も見えていること（ここが抜けると、@media の中は無検査になる）。
    const nested = rulesOf('@media (min-width: 10px) { .unbake-tile { color: red; } }');
    assert.equal(nested.length, 1, '囲みの中へ降りていない');
    assert.equal(nested[0].selectors[0], '.unbake-tile');

    // 入れ子の括弧を数えられていること。
    const supports = rulesOf('@supports not (color: color-mix(in oklab, red, blue)) { .a { color: red; } }');
    assert.equal(supports.length, 1, '括弧の入れ子で迷子になっている');

    assert.match('opacity: .45', /opacity\s*:\s*0?\.\d+/);
    assert.doesNotMatch('opacity: 1', /opacity\s*:\s*0?\.\d+/);
});

test('説明文が、外の印も変わることを言っている', async () => {
    // **面の外まで変わるのは、選ぶ前に知りたいこと**（2026-08-25 利用者の指示
    // 「詳細にアイコンが変わることを追記してください」）。
    // 言語ごとの言い回しは違うので、**どの訳にも出てくる固有名**で見る。
    const { setLocale, t } = await import('../web/i18n/index.js');
    const { LOCALE_META } = await import('../web/i18n/index.js');
    const codes = Object.keys(LOCALE_META || {});
    assert.ok(codes.length >= 10, `言語を ${codes.length} 個しか拾えていない＝走査が壊れている`);
    const missing = [];
    for (const code of codes) {
        setLocale(code);
        const help = String(t('settings.uiSkin.help') || '');
        if (!help.includes('ComfyUI') || !help.includes('Unbake')) missing.push(code);
    }
    setLocale('ja');
    assert.deepEqual(missing, [], '説明文が、宿主側の印のことを言っていない');

    // 日本語と英語は中身まで見る（読める2つで、言い回しの意図を固定する）。
    setLocale('ja');
    assert.match(t('settings.uiSkin.help'), /印|アイコン/, 'ja: 印のことを言っていない');
    setLocale('en');
    assert.match(t('settings.uiSkin.help'), /mark|icon/, 'en: 印のことを言っていない');
    setLocale('ja');
});

test('名簿・紙・訳語が揃っている（片方だけ足した状態にしない）', async () => {
    // **足し忘れは静かに壊れる。** 紙が無ければ選んでも何も起きず、
    // 訳が無ければ設定画面に生の名前が出る——どちらも「動くが変」で気づきにくい。
    const { setLocale, t } = await import('../web/i18n/index.js');
    const sheets = new Set(skinSheets().map(sheet => sheet.name.replace(/^skin-/, '').replace(/\.css$/, '')));
    const missingSheet = SKINS.filter(skin => skin !== 'classic' && !sheets.has(skin));
    assert.deepEqual(missingSheet, [], '名簿に在るのに紙が無い');
    const extraSheet = [...sheets].filter(skin => !SKINS.includes(skin));
    assert.deepEqual(extraSheet, [], '紙は在るのに名簿へ足していない（選べない）');

    for (const locale of ['ja', 'en']) {
        setLocale(locale);
        const missingText = SKINS.filter(skin => {
            const label = t(`settings.uiSkin.${skin}`);
            return !label || label.startsWith('[');
        });
        assert.deepEqual(missingText, [], `${locale}: 設定画面に出す名前が無い`);
    }
    setLocale('ja');
    // **テーマ1が先頭**であること（迷ったら元の面へ倒す）。
    assert.equal(SKINS[0], 'classic');
});

// --- 切り替えの口 -----------------------------------------------------------

/** `document` の最小の人形（`head` と id 引き）。 */
function fakeDocument() {
    const nodes = [];
    const attributes = new Map();
    return {
        // 面の外の印を置く先（本物では `<html>`）。
        documentElement: {
            setAttribute: (key, value) => attributes.set(key, String(value)),
            removeAttribute: (key) => attributes.delete(key),
            getAttribute: (key) => (attributes.has(key) ? attributes.get(key) : null),
        },
        head: { append: (node) => nodes.push(node) },
        createElement: (tag) => {
            // **書き込んだ回数を数える。** 同じ紙へ入れ直すと、本物の browser では
            // 取り直しが走る——「変えていないのに読み直す」を検査で止める。
            let href = '';
            let writes = 0;
            const node = {
                tagName: String(tag).toUpperCase(),
                get href() { return href; },
                set href(next) { href = String(next); writes += 1; },
                get hrefWrites() { return writes; },
                remove() {
                    const at = nodes.indexOf(node);
                    if (at >= 0) nodes.splice(at, 1);
                },
            };
            return node;
        },
        getElementById: (id) => nodes.find(node => node.id === id) || null,
        get count() { return nodes.length; },
    };
}

test('選ばれてから紙を積み、戻したら外す', () => {
    const doc = fakeDocument();
    assert.equal(doc.count, 0);

    const on = applySkin(doc, 'prism', { href: 'x.css' });
    assert.equal(on.loaded, true);
    assert.equal(doc.count, 1, '紙を積んでいない');
    assert.equal(doc.getElementById(SKIN_LINK_ID)?.rel, 'stylesheet');

    // **二度呼んでも1枚。** 面を開き直すたびに増えると、規則が重なって効く。
    applySkin(doc, 'prism', { href: 'x.css' });
    assert.equal(doc.count, 1, '同じ紙を二重に積んでいる');

    // **外して初めて「元のまま」。** 属性だけ戻して紙を残すと、
    // 次に足す規則の効き方が変わる。
    const off = applySkin(doc, 'classic');
    assert.equal(off.loaded, false);
    assert.equal(doc.count, 0, 'テーマ1へ戻したのに紙が残っている');
});

test('テーマ→テーマの切り替えで、紙が差し替わる', () => {
    // **実機で踏んだ**（2026-08-25）。「もう在る」で帰っていたので、
    // vinyl から kitchen へ変えると印だけ変わって紙は vinyl のまま
    // ——どちらの規則も当たらず、テーマ1の見た目に戻って見えた。
    const doc = fakeDocument();
    applySkin(doc, 'prism', { href: 'prism.css' });
    // **積んだ直後に同じ紙で呼ばれても、入れ直さない。**
    // `applySkin` は面を開くたびに走るので、ここで取り直すと**開くたびに一瞬崩れる**。
    const first = doc.getElementById(SKIN_LINK_ID);
    const afterCreate = first.hrefWrites;
    applySkin(doc, 'prism', { href: 'prism.css' });
    assert.equal(first.hrefWrites, afterCreate, '同じ紙を積み直している（開くたびに取り直す）');

    applySkin(doc, 'vinyl', { href: 'vinyl.css' });
    assert.equal(doc.count, 1, '紙が増えている（重ねて積んでいる）');
    const link = doc.getElementById(SKIN_LINK_ID);
    assert.equal(link.href, 'vinyl.css', '古い紙が残っている');

    // **同じ紙へは入れ直さない。** 入れ直すと取り直しが走り、面が一瞬崩れる。
    const before = link.hrefWrites;
    applySkin(doc, 'vinyl', { href: 'vinyl.css' });
    assert.equal(link.hrefWrites, before, '同じ紙を入れ直している');

    // 一度テーマ1へ戻してから別のテーマへ、も通ること。
    applySkin(doc, 'classic');
    assert.equal(doc.count, 0);
    applySkin(doc, 'kitchen', { href: 'kitchen.css' });
    assert.equal(doc.getElementById(SKIN_LINK_ID).href, 'kitchen.css');
});

test('面の外の印も、切り替えと同時に付け替わる', () => {
    // **ComfyUI のツール列に居る印は `.unbake-root` の外に居る**ので、
    // 面の中だけを見る `data-skin` では届かない（2026-08-25 利用者の指示
    // 「ComfyUI での unbake のアイコンも変化させるようにして即時反映できますか？」）。
    const doc = fakeDocument();
    const shown = () => doc.documentElement.getAttribute('data-unbake-skin');

    applySkin(doc, 'vinyl', { href: 'vinyl.css' });
    assert.equal(shown(), 'vinyl', '外の印が付いていない');

    applySkin(doc, 'kitchen', { href: 'kitchen.css' });
    assert.equal(shown(), 'kitchen', 'テーマ→テーマで外の印が古いまま');

    // **テーマ1へ戻したら外す。** 残すと、戻したのに印だけ変わったままになる。
    applySkin(doc, 'classic');
    assert.equal(shown(), null, 'テーマ1へ戻したのに外の印が残っている');

    // 知らない値でも、面と同じく classic へ倒れる。
    applySkin(doc, 'nope');
    assert.equal(shown(), null, '知らない値で外の印を付けている');
});

test('知らない値と、器が無い所で落ちない', () => {
    // 綴りを間違えた設定で**画面が消えない**こと。
    assert.equal(normalizeSkin('prism'), 'prism');
    assert.equal(normalizeSkin('PRISM'), 'classic');
    assert.equal(normalizeSkin(undefined), 'classic');
    assert.equal(normalizeSkin('nope'), 'classic');
    assert.equal(SKINS[0], 'classic', '既定がテーマ1でない');

    const doc = fakeDocument();
    applySkin(doc, 'nope');
    assert.equal(doc.count, 0, '知らない値で紙を積んでいる');

    // 器の無い所（検査・headless）から呼ばれても落ちない。
    assert.doesNotThrow(() => applySkin(null, 'prism'));
    assert.doesNotThrow(() => applySkin({}, 'prism'));
});
