/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 工程4 — **表示のポリシー**（裁定⑤⑥）。
 *
 *  1. **中身をぼかして隠さない。** 成人向けの関門そのものは 2026-08-25 に
 *     撤去した（利用者の判断）が、この規則は残す——**見た目で隠すのは
 *     隠したことにならない**（ページに来ている以上、開発者ツールでも保存でも
 *     読めるし、配信のキャプチャにも乗る）。次に誰かが「隠す」を作るとき、
 *     CSS で済ませる道をここで塞いでおく。
 *  2. **モード型の設定を足さない。** 密度は**閾値**で決まり続ける
 *  3. 閾値・並び替え・モデル順・商用可否の設定が、**実際に効く**
 *  4. 商用可否には**判定日を必ず併記**する
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMPACT_WIDTH, createUnbakePanel, SORT_KEYS } from '../web/panel/panel.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale } from '../web/i18n/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function narrowTo(panel, width) {
    panel.root.getBoundingClientRect = () => ({ width, height: 600 });
    panel.setWidth(width);
    return panel;
}

const mount = (display, records) => {
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), { documentRef: doc, display });
    panel.setRecords(records);
    return panel;
};

const rec = (id, extra = {}) => ({
    id, libraryId: id, title: `T${id}`, verdict: 'reproducible', ...extra,
});

// --- 1. 見た目で隠さない ---------------------------------------------------

test('成人向けを CSS のぼかしで隠していない', async () => {
    // **バイト列がページへ届いた時点で、隠したことにならない。**
    // 開発者ツールでも保存でも読めるし、配信ソフトのキャプチャにも乗る。
    const css = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');

    // **`filter: blur` は今までどおり全面禁止。** これは要素そのものを
    // ぼかす指定で、絵に掛ければ「隠したつもり」になる。
    //
    // **`backdrop-filter` は今は1つも無い**（2026-08-23 に帯から外した・
    // 下の「帯を平らに塗らない」が全面で禁じている）。この見分けを残すのは、
    // 2つが別物だからで——**要素をぼかす**のは中身を隠す行為、
    // **背面をぼかす**のは帯の見た目にすぎない。混ぜると理由が読めなくなる。
    const contentBlur = [...css.matchAll(/(?<!backdrop-)filter\s*:\s*[^;]*blur/gi)]
        .map(m => m[0]);
    assert.deepEqual(contentBlur, [], 'ぼかしで隠している（関門はサーバ側に置くこと）');

    // **絵に掛かるぼかしは、種類を問わず禁止。** 規則の見出しに絵を指す名前が
    // 在るのに `blur` を書いていたら、それは中身を隠している。
    const IMAGE_SELECTORS = /(image|img|media|preview|stage|thumb)/i;
    const blurred = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
        .filter(([, , body]) => /blur\s*\(/i.test(body))
        .map(([, selector]) => selector.trim().split(/\r?\n/).pop().trim())
        .filter(selector => IMAGE_SELECTORS.test(selector));
    assert.deepEqual(blurred, [], `絵にぼかしを掛けている: ${blurred.join(' / ')}`);

    // 画面側にも「隠す」ための仕掛けを置いていないこと。
    for (const name of ['web/panel/panel.js', 'web/unbake.js']) {
        const text = await readFile(join(ROOT, name), 'utf8');
        assert.doesNotMatch(text, /blur\(|blurMature|mature_blur/i,
            `${name} が見た目で隠そうとしている`);
    }

    // **検出器が生きていること。** 見つからなければ緑、の形なので。
    assert.match('filter: blur(8px);', /(?<!backdrop-)filter\s*:\s*[^;]*blur/i);
    assert.doesNotMatch('backdrop-filter: blur(8px);', /(?<!backdrop-)filter\s*:\s*[^;]*blur/i);
    assert.ok(IMAGE_SELECTORS.test('.unbake-tile-media'), '絵を指す名前を拾えていない');
});

// --- 2. モード型の設定を足さない -------------------------------------------

test('密度は閾値で決まり続ける（モードの設定を足していない）', async () => {
    const settings = await readFile(join(ROOT, 'unbake/settings.py'), 'utf8');
    const keys = [...settings.matchAll(/^\s*"([a-z_]+)":\s/gm)].map(m => m[1]);
    assert.ok(keys.length >= 8, `設定の鍵を拾えていない（${keys.length}件）`);

    // **禁じているのは「密度をモードで持つこと」。**
    // 器の幅で決まり続けるべきものを設定へ逃がすと、狭い器に広い版が出せてしまい、
    // 「同じコンポーネントを両方の器へ差す」が実装2つに割れていく。
    //
    // **`list_view` は密度ではない**（2026-08-20 にユーザーの指示で追加）。
    // 表とタイルは**同じ記録・同じ絞り込み・同じ並び**を描き、変わるのは並べ方だけで、
    // 密度は今までどおり幅が決める。絵で選びたいのと字で比べたいのは目的が違い、
    // 閾値では表せない——**幅がいくつだから絵にする、という関係が無い。**
    const ALLOWED = new Set(['list_view']);
    const modeLike = keys.filter(key => /(^|_)(mode|layout|view|density)(_|$)/.test(key))
        .filter(key => !ALLOWED.has(key));
    assert.deepEqual(modeLike, [],
        `モード型の設定を足している（決定⑤が崩れる）: ${modeLike.join(', ')}`);
    // **密度そのものを設定で持っていないこと。**
    for (const forbidden of ['density', 'compact', 'compact_mode', 'layout']) {
        assert.ok(!keys.includes(forbidden), `密度をモードで持っている: ${forbidden}`);
    }
    // 閾値の側は在ること（無いと、この検査は何も見ていない）。
    // **行数の上限（`row_limit`）は 2026-08-25 に撤去した**ので、
    // 残っている閾値は幅だけ。
    assert.ok(keys.includes('compact_width'), '閾値の設定 compact_width が無い');
    // 検出器が生きていること。
    assert.ok(/(^|_)(mode|layout|view|density)(_|$)/.test('display_mode'));
});

// --- 3. 設定が実際に効く ---------------------------------------------------

test('狭いと判断する幅を、設定で動かせる', () => {
    setLocale('en');
    const records = [rec('1')];
    // 既定では 600px は広い。
    assert.equal(narrowTo(mount(null, records), 600).density, 'full');
    // 閾値を上げると同じ幅が狭くなる。
    assert.equal(narrowTo(mount({ compactWidth: 800 }, records), 600).density, 'compact');
    // 既定の定数は変えていない。
    assert.equal(COMPACT_WIDTH, 520);
});

test('狭くても行を切らない（器の中でスクロールさせる）', () => {
    // **元は12行で切って残りを全画面へ送っていた**が、実機で
    // 「レコードが多いとサイドバーで途中までしか見られない」と報告された
    // （2026-08-20）。切る代わりに器の中でスクロールさせる形にし、
    // **行数の設定そのものは 2026-08-25 に撤去した**——既定のままなら何も
    // 起きない設定で、戻す先は利用者が一度嫌った挙動だった。
    setLocale('en');
    const records = Array.from({ length: 30 }, (_, i) => rec(String(i)));
    const rows = (panel) => panel.root.allByClass('unbake-table')[0]
        .findAll(n => n.tagName === 'TR').length - 1; // 見出しを引く

    assert.equal(rows(narrowTo(mount(null, records), 300)), 30, '狭いところで行を切っている');
    // 広いところでも同じ（切る道が1つも残っていない）。
    assert.equal(rows(narrowTo(mount(null, records), 900)), 30);
});

test('並び替えの軸が効き、知らない軸は既定へ落ちる', () => {
    setLocale('en');
    const records = [
        rec('a', { title: 'Zebra', modified: 1, favorite: false }),
        rec('b', { title: 'Apple', modified: 3, favorite: true }),
        rec('c', { title: 'Mango', modified: 2, favorite: false }),
    ];
    // **列の本数に依存しない取り方をする。** 「4つおきの TD」で拾っていたら、
    // 商用可否の列が増えた瞬間に別の列を読み始めた（列が5本になったため）。
    const titles = (display) => mount(display, records).root
        .allByClass('unbake-table')[0]
        .findAll(n => n.tagName === 'TR')
        // **列は名前で拾う。** 「最初の TD」で拾っていたら、参照画像の列を
        // 先頭へ足した瞬間に別の列を読み始めた（2026-08-20）。
        // 見出しの TH も同じ名前を持つので、**TD であることも要る。**
        .map(row => row.children.find(cell => cell.tagName === 'TD' && cell.className === 'unbake-col-title'))
        .filter(Boolean)
        .map(cell => cell.textContent);

    // 既定は更新の新しい順。
    assert.deepEqual(titles(null), ['Apple', 'Mango', 'Zebra']);
    assert.deepEqual(titles({ sortKey: 'title' }), ['Apple', 'Mango', 'Zebra']);
    // **知らない軸は既定へ落とす。** 落とさないと綴り違いで黙って元の順になる。
    assert.deepEqual(titles({ sortKey: 'no-such-axis' }), titles(null));
    assert.ok(SORT_KEYS.has('favorite') && !SORT_KEYS.has('no-such-axis'));
});

test('モデル順にまとめられる', () => {
    setLocale('en');
    const records = [
        rec('1', { checkpoint: 'B', modified: 4 }),
        rec('2', { checkpoint: 'A', modified: 3 }),
        rec('3', { checkpoint: 'B', modified: 2 }),
        rec('4', { checkpoint: 'A', modified: 1 }),
    ];
    const models = (display) => mount(display, records).root
        .allByClass('unbake-col-model')
        .filter(n => n.tagName === 'TD')
        .map(n => n.textContent);
    assert.deepEqual(models(null), ['B', 'A', 'B', 'A']);
    assert.deepEqual(models({ groupByCheckpoint: true }), ['B', 'B', 'A', 'A']);
});

// --- 4. 商用可否 -----------------------------------------------------------

test('商用可否は判定日と対でしか出ない', () => {
    setLocale('en');
    const panel = mount(null, [
        rec('1', { commercialOk: 'YES', licenseCheckedAt: '2026-08-14' }),
        // 日付の無い可否は**値ごと出さない**。出典の無い可否は、出さないより悪い。
        rec('2', { commercialOk: 'NO', licenseCheckedAt: null }),
        rec('3', { commercialOk: null, licenseCheckedAt: '2026-08-14' }),
    ]);
    const cells = panel.root.allByClass('unbake-col-license')
        .filter(n => n.tagName === 'TD')
        .map(n => n.textContent);
    assert.equal(cells.length, 3);
    assert.match(cells[0], /YES/);
    assert.match(cells[0], /2026-08-14/);
    assert.equal(cells[1], '—', '判定日の無い可否を出している');
    assert.equal(cells[2], '—');
});

test('商用可否の列は設定で消せる', () => {
    setLocale('en');
    const records = [rec('1', { commercialOk: 'YES', licenseCheckedAt: '2026-08-14' })];
    assert.equal(mount(null, records).root.allByClass('unbake-col-license').length, 2); // 見出し＋行
    assert.equal(mount({ showCommercialOk: false }, records).root.allByClass('unbake-col-license').length, 0);
});

// --- 面の記述そのものが壊れていないか（2026-08-23）-------------------------
//
// **コメントを二重に閉じても、検査は全部緑のままだった。** 検査はどれも
// 「特定の文字列が在るか」しか見ないので、規則の外に説明文が転がっていても
// 気づけない。ブラウザは黙って読み飛ばすので、画面で色が1つ抜けるだけになる
// ——利用者の「帯が地の色で出る」も、まさにこの種の壊れ方だった。

test('theme.css の記述が壊れていない', async () => {
    const css = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');

    const opens = (css.match(/\/\*/g) || []).length;
    const closes = (css.match(/\*\//g) || []).length;
    assert.equal(opens, closes, 'コメントの開きと閉じが釣り合っていない');

    // 括弧は文字列の中に出てこない書き方をしているので、数で足りる。
    assert.equal((css.match(/\{/g) || []).length, (css.match(/\}/g) || []).length,
        '波括弧が釣り合っていない');

    // **説明文が規則の外へこぼれていないか。** コメントを外した残りに
    // 日本語が在れば、それは閉じ損ねた文である。
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const leaked = stripped.split(/\r?\n/)
        .map((line, index) => ({ at: index + 1, line: line.trim() }))
        .filter(item => /[ぁ-んァ-ン一-龯]/.test(item.line));
    assert.deepEqual(leaked, [], 'コメントの外に説明文がこぼれている');

    // **検出器が生きていること。** 見つからなければ緑、の形なので。
    const broken = 'a { color: red; } /* 説明 */ こぼれた文 */';
    assert.notEqual((broken.match(/\/\*/g) || []).length, (broken.match(/\*\//g) || []).length);
});

// --- 帯を平らに塗らない（2026-08-23 利用者から3度の報告）--------------------
//
// **`@supports` で分けたのが間違いだった。** あれは「その指定を*書けるか*」しか
// 見ない——Vivaldi は `backdrop-filter` を書けるので分岐に入るが、実際には
// ぼかしが効いていない。結果、分岐の中の平らな色だけが残り、黒い帯になった。
//
// 直し方は「分岐を持たない」。濃さは常にグラデーションで決め、ぼかしは
// 効く環境でだけ乗るおまけにする。**この検査は、分岐が戻ってこないことを見張る。**

test('タイルの帯は、どの環境でもグラデーションで濃さを決める', async () => {
    const withComments = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');
    // **説明文を外してから見る。** 外さないと、この検査を説明したコメント自体に
    // 当たる（実際に当たった）——見張る相手は規則であって、散文ではない。
    const css = withComments.replace(/\/\*[\s\S]*?\*\//g, '');
    const ruleOf = (name) => [...css.matchAll(/([^{}]*)\{([^}]*)\}/g)]
        .filter(([, selector]) => selector.trim().split('\n').pop().trim() === name)
        .map(([, , body]) => body);

    for (const name of ['.unbake-tile-head', '.unbake-tile-foot']) {
        const bodies = ruleOf(name);
        assert.ok(bodies.length > 0, `${name} の規則が無い`);
        const background = bodies.map(body => body.match(/background:[^;]*/)).filter(Boolean);
        assert.ok(background.length > 0, `${name} に背景の指定が無い`);
        for (const [text] of background) {
            assert.match(text, /linear-gradient/,
                `${name} を平らな色で塗っている（ぼかしが効かない環境で黒い帯になる）`);
        }
    }

    // **`backdrop-filter` を条件にした分岐を作らない。** 書けるかどうかと、
    // 効くかどうかは別なので、分けた側の見た目が環境によって割れる。
    assert.doesNotMatch(css, /@supports[^{]*backdrop-filter/,
        'ぼかしの有無で見た目を分けている（書けるかと効くかは別）');

    // **すりガラスそのものを使わない**（2026-08-23 利用者の指示で LoRA Manager
    // へ揃えた）。効くかどうかが環境で割れるうえ、**効いても背面の色を持ち込む**
    // ——`saturate(0.12)` にしてもなお12%は通り、金色の絵の上で
    // 「黒と黄色が混ざった色」になった。濃淡の影だけで字を読ませる。
    assert.doesNotMatch(css, /backdrop-filter/,
        'すりガラスが戻っている（背面の色を着るので帯が無彩色でなくなる）');
    // **検出器が生きていること。** 見つからなければ緑、の形なので。
    assert.match('@supports (backdrop-filter: blur(1px)) { a { b: c } }',
        /@supports[^{]*backdrop-filter/);
});

// --- 新しい色の書き方に、必ず後退先を持たせる（2026-08-23）------------------
//
// **読めない実装では、その値を使った宣言が丸ごと捨てられる。** 枠は継承色に
// なり、`border-inline-start: 3px solid var(--…)` は**太さごと**消える
// ——利用者の環境で「枠が黄土色・色帯が 1px」として出ていた症状が、これで全部
// 説明できた（`boxShadow` が `none` だったので、ホバーの輪ではないと判った）。

test('色の変数には、素の値の後退先が在る', async () => {
    const css = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');
    const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');

    // `@supports` の外で、oklch だけで定義されている変数を探す。
    const guarded = flat.slice(flat.indexOf('@supports (color: oklch'));
    const before = flat.slice(0, flat.indexOf('@supports (color: oklch'));
    const definedPlainly = new Set();
    for (const [, name, value] of before.matchAll(/(--unbake-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
        if (!/(oklch|oklab|color-mix|lab|lch)\(/.test(value)) definedPlainly.add(name);
    }
    const guardedNames = [...guarded.matchAll(/(--unbake-[a-z0-9-]+)\s*:/g)].map(m => m[1]);
    const missing = guardedNames.filter(name => !definedPlainly.has(name));
    assert.deepEqual([...new Set(missing)], [],
        '後退先の無い色の変数が在る（読めない実装で宣言ごと捨てられる）');

    // **名前だけでは足りない。** 配色は5つ在り、同じ名前が塊ごとに定義される
    // ——1つの塊から後退先が落ちても、名前で見る限り気づけない（実際に
    // 変異を仕込んで素通りした）。**数で突き合わせる。**
    const plainlyDeclared = [...before.matchAll(/(--unbake-[a-z0-9-]+)\s*:\s*([^;]+);/g)]
        .filter(([, name, value]) => guardedNames.includes(name)
            && !/(oklch|oklab|color-mix|lab|lch)\(/.test(value));
    assert.ok(plainlyDeclared.length >= guardedNames.length,
        `後退先が ${plainlyDeclared.length} 件しかない（読める側は ${guardedNames.length} 件）`);

    // **仕掛けが在ること自体も見る。** `@supports` を消したら、この検査は
    // 「調べる相手が無い」まま緑になってしまう。
    assert.match(css, /@supports \(color: oklch\(0% 0 0\)\)/,
        '読める実装だけが入る塊が無い');
    assert.ok(definedPlainly.size >= 10,
        `素の値で置いた変数が ${definedPlainly.size} 個しかない（後退先が痩せている）`);
});

// --- 見た目を厚くする旗（2026-08-24 利用者の指示）---------------------------
//
// **切れることを先に決めてから足した。** 切ったときの見た目が「元のまま」で
// あることを、言葉ではなく構造で保証する——**リッチな指定が旗の外に1つでも
// 漏れていたら、切ったつもりで残る所ができる。**

test('厚みの指定は、全部 data-rich の下に閉じている', async () => {
    const withComments = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');
    const css = withComments.replace(/\/\*[\s\S]*?\*\//g, '');

    // 旗の節がどこから始まるか。ここより後ろは全部 `data-rich` を名乗ること。
    const marker = '.unbake-root[data-rich="on"]';
    const at = css.indexOf(marker);
    assert.ok(at > 0, '厚みの節が無い');

    const tail = css.slice(at);
    const selectors = [...tail.matchAll(/([^{}]+)\{/g)]
        .map(m => m[1].trim())
        //  の中の段（ /  / ）は規則ではない。
        .filter(text => text && !text.startsWith('@') && !/^\d/.test(text)
            && text !== 'from' && text !== 'to');
    assert.ok(selectors.length >= 15, `節の中の規則が ${selectors.length} 本しか無い`);

    const leaked = selectors.filter(selector => selector.split(',')
        .some(part => !part.includes('[data-rich="on"]')));
    assert.deepEqual(leaked, [], '旗の外へ漏れている指定が在る（切っても残る）');
});

test('厚みの旗が、設定から面まで繋がっている', async () => {
    const panel = await readFile(join(ROOT, 'web/panel/panel.js'), 'utf8');
    const entry = await readFile(join(ROOT, 'web/unbake.js'), 'utf8');
    const settings = await readFile(join(ROOT, 'unbake/settings.py'), 'utf8');
    // **口が1つでも欠けると、設定は在るのに効かない。**
    assert.match(settings, /"rich_ui": True,/, 'Python 側に項目が無い');
    assert.match(entry, /richUi: settings\?\.rich_ui !== false,/, '入口が面へ渡していない');
    assert.match(panel, /'data-rich': richUi \? 'on' : 'off',/, '面が属性を書いていない');
    assert.match(panel, /root\.setAttribute\('data-rich'/, '切り替えたときに書き換えていない');
});

test('動きは、OS の「動きを減らす」設定に従う', async () => {
    const css = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');
    const marker = '@media (prefers-reduced-motion: reduce)';
    assert.ok(css.includes(marker), '減らす設定を見ていない');

    // **塊の終わりまでを、括弧を数えて取る。** 末尾までを丸ごと見ると、
    // 名前を書き換えた塊まで一緒に読んでしまい、**変異が素通りする**
    // （2026-08-24 実際に素通りした）。
    const blocks = [];
    let at = 0;
    for (;;) {
        const found = css.indexOf(marker, at);
        if (found < 0) break;
        const open = css.indexOf('{', found);
        let depth = 0;
        let end = open;
        for (let i = open; i < css.length; i += 1) {
            if (css[i] === '{') depth += 1;
            else if (css[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
        }
        blocks.push(css.slice(open, end));
        at = end;
    }
    assert.ok(blocks.length >= 1, '減らす設定の塊が取れていない');

    // 厚みの節の動きを止めている塊が、少なくとも1つ在ること。
    const stopping = blocks.filter(body => body.includes('[data-rich="on"]'));
    assert.ok(stopping.length >= 1, '厚みの節の動きを、減らす設定で止めていない');
    const body = stopping[0];
    assert.ok(body.includes('transition: none'), '移り変わりを止めていない');
    assert.ok(body.includes('animation: none'), '現れ方の動きを止めていない');
    assert.ok(body.includes('transform: none'), '浮き上がりを止めていない');
});

test('絞り込みの色帯は、枠ではなく重ねて描く', async () => {
    // **角を落としても線が残った**（2026-08-25 実機）。枠で描くと、帯（2.4px）と
    // 上下の枠（0.8px）の境目が**端数の画素**へ落ち、分数ズームで筋になる
    // ——10倍に拡大すると綺麗なのに実寸で線が出る、という形だった。
    // **重ねて描けば境目そのものが無くなる。**
    const withComments = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');
    const css = withComments.replace(/\/\*[\s\S]*?\*\//g, '');

    const at = css.indexOf('.unbake-chip {');
    assert.ok(at > 0, '絞り込みの規則が無い');
    const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
    // **枠で描いていないこと。**
    assert.ok(!body.includes('border-left: 3px'), '帯を枠で描いている（境目が筋になる）');
    assert.ok(body.includes('position: relative'), '重ねる先が無い');
    assert.ok(body.includes('--unbake-chip-band:'), '帯の色を1箇所で決めていない');

    // 重ねる層が在ること。
    const beforeAt = css.indexOf('.unbake-chip::before {');
    assert.ok(beforeAt > 0, '重ねる層が無い');
    const before = css.slice(css.indexOf('{', beforeAt) + 1, css.indexOf('}', beforeAt));
    assert.ok(before.includes('position: absolute'), '重なっていない');
    // **枠の外側まで覆う。** 覆わないと、そこに境目が残る。
    assert.ok(before.includes('top: -1px') && before.includes('bottom: -1px'),
        '枠の外側まで覆っていない');
    assert.ok(before.includes('background: var(--unbake-chip-band)'), '帯の色を使っていない');

    // 判定ごとの色が、帯の変数で書かれていること（枠の色ではなく）。
    for (const verdict of ['reproducible', 'approximate', 'blocked']) {
        const rule = css.indexOf(`.unbake-chip[data-verdict="${verdict}"]`);
        assert.ok(rule > 0, `${verdict} の色が無い`);
        const line = css.slice(rule, css.indexOf('}', rule));
        assert.ok(line.includes('--unbake-chip-band:'), `${verdict} が帯の変数を使っていない`);
    }
});

test('詳細ウィンドウの出た絵は、サイドバーの狭さで畳まない', async () => {
    // **器の広さで決めるべきものを、別の器の広さで決めていた**（2026-08-25 実機）。
    // 「詰めた形」はサイドバーの幅で付くが、詳細は画面いっぱいに開く器なので、
    // そこまで畳むと 1038px の幅に**1列だけ**が並ぶ（実測: 1枚 1014x272）。
    const withComments = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');
    const css = withComments.replace(/\/\*[\s\S]*?\*\//g, '');

    // 畳む指定が在ること（検出器が空振りしていないか）。
    const collapse = '.unbake-root[data-density="compact"] .unbake-variants-grid';
    assert.ok(css.includes(collapse), '狭いときに畳む指定が無い');

    // **詳細の中だけは戻す。**
    const restore = '.unbake-root[data-density="compact"] .unbake-detail .unbake-variants-grid';
    const at = css.indexOf(restore);
    assert.ok(at > 0, '詳細の中で畳みを戻していない');
    const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
    assert.ok(body.includes('repeat(auto-fill'), '詳細でも1列のままになっている');

    // **戻す指定は、畳む指定より後ろに在ること。** 前に置くと効かない。
    assert.ok(at > css.indexOf(collapse), '戻す指定が畳む指定より前に在る（効かない）');
});

test('並びの向きを、矢印だけでなく言葉で出す', () => {
    // **実機で踏んだ**（2026-08-25「取り込んだ記録が一番上に来ない」）。
    // 正体は逆順の旗が立っていたことだったが、**画面には矢印しか出ておらず**、
    // それが「今どちらか」を意味するのか「押すとどうなるか」なのか読めなかった。
    setLocale('ja');
    const records = [
        rec('a', { title: 'Apple', modified: 3 }),
        rec('b', { title: 'Zebra', modified: 1 }),
    ];
    const dirButton = (display) => mount(display, records).root.byClass('unbake-sort-direction');

    // 日付は「新しい順／古い順」と言う（昇順・降順では、どちらが新しいか読めない）。
    const natural = dirButton({ sortKey: 'modified', sortDescending: false });
    assert.match(natural.getAttribute('title'), /新しい順/, '今の並びを言葉で出していない');
    const flipped = dirButton({ sortKey: 'modified', sortDescending: true });
    assert.match(flipped.getAttribute('title'), /古い順/, '逆順にしたことを言葉で出していない');

    // **読み上げにも同じ言葉を渡す**（矢印は読み上げでは何も言わない）。
    assert.equal(flipped.getAttribute('aria-label'), flipped.getAttribute('title'));

    // 日付以外は「素の順／逆順」（鍵ごとに自然な順が違うので、断定しない）。
    const byTitle = dirButton({ sortKey: 'title', sortDescending: true });
    assert.match(byTitle.getAttribute('title'), /逆順/);
});

test('鍵ごとの自然な順を保つ（日付は新しい順、名前は A→Z）', () => {
    // **1つの旗で全部を「昇順/降順」と呼ぶと嘘になる。** 日付を古い順から
    // 始めると一覧の主語（最近いじった記録）が埋もれ、名前を Z→A から始めると
    // 探せない。**旗は「逆さにするか」だけを持つ。**
    setLocale('en');
    const records = [
        rec('a', { title: 'Apple', modified: 1 }),
        rec('z', { title: 'Zebra', modified: 9 }),
    ];
    const titlesOf = (display) => mount(display, records).root.allByClass('unbake-table')[0]
        .findAll(n => n.tagName === 'TR')
        .map(row => row.children.find(c => c.tagName === 'TD' && c.className === 'unbake-col-title'))
        .filter(Boolean).map(c => c.textContent);

    assert.deepEqual(titlesOf({ sortKey: 'modified' }), ['Zebra', 'Apple'], '日付が新しい順で始まっていない');
    assert.deepEqual(titlesOf({ sortKey: 'title' }), ['Apple', 'Zebra'], '名前が A→Z で始まっていない');
});

// --- 設定は「保存できた」だけでは足りない（2026-08-25 利用者の指示）----------
//
// > 「チェックポイントごとにまとめる」を OFF にしたあと再読み込みが必要になった
//
// 面は開いたときの値を `const` で抱えていたので、保存は成功するのに一覧が
// 古いままだった。**同じ穴は設定を足すたびに開く**ので、規約ではなく構造で見張る:
// 表示設定の鍵は、**`applyDisplay` が見ている**か、**理由つきで外してある**かの
// どちらかでなければならない。

/** その場で当てなくてよい鍵と、その理由。**「面が持っていない」ものだけ。** */
const APPLY_EXEMPT = new Map([
    ['language', '面を組み直す（`onLanguageChange` → `rebuildSidebar`）。見出しは組むときに1回だけ文字を入れる'],
    ['favoriteIds', '印は記録側に持ち、押した面がその場で描き直す'],
    ['unfavoriteIds', '同上（上流の印を打ち消す名簿）'],
    ['sidebarOverlay', '器（宿主のサイドバー）の担当。`sidebarOverlay.js` が見る'],
    ['sidebarWidth', '同上。掴み手で変えた値がそのまま保存される'],
    ['hiddenVerdicts', '面の中の絞り込み帯が持ち、押した時点で効く'],
    ['favoritesOnly', '同上（★の絞り込み）'],
    // **上の2つと同じ種類。** 面の中の絞り込み帯が持ち、押した時点で効く。
    ['downloadableOnly', '同上（⤓ の絞り込み）'],
    ['needsNodeOnly', '同上（⊞ の絞り込み・2026-08-28）'],
    ['disableDarkReader', '文書の `<meta>` に効く錠。面ではなく `unbake.js` が保存時に当て直す'],
]);

test('表示設定の鍵は、全部 applyDisplay が見ているか、理由つきで外してある', async () => {
    const unbake = await readFile(join(ROOT, 'web/unbake.js'), 'utf8');
    const panel = await readFile(join(ROOT, 'web/panel/panel.js'), 'utf8');

    const start = unbake.indexOf('function toDisplaySettings');
    assert.ok(start > 0, 'toDisplaySettings が見つからない（検査が空振りしている）');
    const body = unbake.slice(start, unbake.indexOf('async function readDisplaySettings'));
    const keys = [...new Set([...body.matchAll(/^\s{8,}([a-zA-Z][a-zA-Z0-9]*):/gm)].map(m => m[1]))];
    // **空集合に対する全称は必ず真。** 鍵が拾えていないなら、以下は全部素通りする。
    assert.ok(keys.length >= 15, `表示設定の鍵が ${keys.length} 個しか拾えていない`);

    const applyStart = panel.indexOf('function applyDisplay');
    assert.ok(applyStart > 0, 'applyDisplay が見つからない');
    const applyBody = panel.slice(applyStart, panel.indexOf('function applyWidth'));
    const camel = (name) => name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    const seen = new Set([...applyBody.matchAll(/next\.([a-zA-Z_][a-zA-Z0-9_]*)/g)].map(m => camel(m[1])));
    assert.ok(seen.size >= 10, `applyDisplay が見ている鍵が ${seen.size} 個しか拾えていない`);

    const unhandled = keys.filter(key => !seen.has(key) && !APPLY_EXEMPT.has(key));
    assert.deepEqual(unhandled, [],
        'その場で効かない表示設定がある。`applyDisplay` で見るか、'
        + '面が持っていない理由を APPLY_EXEMPT へ書くこと');

    // **外した理由が古くなっていないかも見る。** 面が見るようになった鍵が
    // 除外表に残り続けると、次に足す人が「見なくてよい」と読む。
    const staleExempt = [...APPLY_EXEMPT.keys()].filter(key => seen.has(key));
    assert.deepEqual(staleExempt, [], 'applyDisplay が見ているのに除外表に残っている鍵がある');
});

test('詰めた見せ方へ切り替わる幅も、その場で効く', () => {
    // **密度は器の幅が決める**（モードを足さない）が、**閾値は設定で動く**。
    // 閾値を読み込み時の値で固定していると、設定で変えても読み直すまで効かない
    // ——まとめの旗と同じ形の穴。器の幅（実測 900）は動かさずに閾値だけ動かす。
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc, display: { compactWidth: 400 },
    });
    assert.equal(panel.density, 'full', '前提（広い器で full）が崩れている');
    panel.applyDisplay({ compact_width: 1200 });
    assert.equal(panel.density, 'compact', '閾値を上げても詰めた見せ方にならない');
    panel.applyDisplay({ compact_width: 400 });
    assert.equal(panel.density, 'full', '閾値を戻しても元へ戻らない');
});
