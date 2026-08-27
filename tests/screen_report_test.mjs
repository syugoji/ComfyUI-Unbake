/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 実機で報告された6件（2026-08-20・スクリーンショット付き）。
 *
 *   ① 全画面から戻るボタンが無い（出口が Esc だけ）
 *   ② 記録の画像が1枚も出ていない
 *   ③ 言語を切り替える設定が欲しい
 *   ④ 記録が多いとサイドバーで途中までしか読めない
 *   ⑤ 判定の左の色が極端に薄い
 *   ⑥ サイドバーの幅を変えても、ComfyUI を再起動すると戻る
 *
 * **①〜⑥のうち大半は「壊れていた」のではなく「配線していなかった」。**
 * 画像は要素を1つも描いていなかったし、戻る口も言語の項目も無かった。
 * だから**在ることを固定する**試験になっている——「動くか」ではなく
 * 「画面へ出ているか」を見る。
 *
 * ⑥（幅を覚える）は `panel_mount_test.mjs` にある（測り方の試験と地続きのため）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createUnbakePanel } from '../web/panel/panel.js';
import { createSettingsView } from '../web/panel/settingsView.js';
import { fakeDocument } from './fake_dom.mjs';
import { CATALOGS, setLocale, t } from '../web/i18n/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const rec = (id, extra = {}) => ({
    id, libraryId: id, title: `T${id}`, verdict: 'reproducible', ...extra,
});

/**
 * 参照画像の**セル**（見出しではない）。
 *
 * 見出しの `th` も同じ名前を持つので、`byClass` で拾うと**常に見出しが返る**
 * ——中身を見ずに「属性が無い」と読むところだった。
 */
const previewCellOf = (panel) => panel.root.find(
    node => node.tagName === 'TD' && String(node.className).includes('unbake-col-preview'),
);

const mount = (records, display = null) => {
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), { documentRef: doc, display });
    panel.setRecords(records);
    return panel;
};

// --- ② 参照画像 -------------------------------------------------------------

test('参照画像を実際に描く（一覧に img が出る）', () => {
    setLocale('en');
    const panel = mount([rec('a', { previewUrl: '/unbake/record-preview?id=a' })]);
    const images = panel.root.findAll(node => node.tagName === 'IMG');
    assert.equal(images.length, 1, '画像を1つも描いていない');
    assert.equal(images[0].getAttribute('src'), '/unbake/record-preview?id=a');
    // **遅らせて取る。** 346件ぶんを一度に取りに行くと、開いた瞬間に346本の要求が出る。
    assert.equal(images[0].getAttribute('loading'), 'lazy');
});

test('画像が無い理由を、無いこと自体と区別する', () => {
    setLocale('en');
    const none = previewCellOf(mount([rec('a', { previewUrl: null })]));
    assert.equal(none.getAttribute('data-state'), 'none');
    // **2つの状態が別々の文言を持つ**（同じ字で出すと区別が消える）。
    // 成人向けの関門は 2026-08-25 に撤去したので、3つ目（サーバが送っていない）は
    // もう起きない。
    const texts = new Set(['list.preview.none', 'list.preview.failed'].map(k => t(k)));
    assert.equal(texts.size, 2, '無い理由が同じ言葉になっている');
});

// --- ④ 記録が多いとき -------------------------------------------------------

test('狭くても全件描く（切る道が1つも残っていない）', () => {
    setLocale('en');
    const records = Array.from({ length: 40 }, (_, i) => rec(String(i)));
    const rows = (panel) => panel.root.findAll(
        n => n.tagName === 'TR' && n.parentNode?.tagName === 'TBODY').length;
    const narrow = (display) => {
        const panel = mount(records, display);
        panel.root.getBoundingClientRect = () => ({ width: 300, height: 600 });
        panel.setWidth(300);
        return panel;
    };
    assert.equal(narrow(null).density, 'compact');
    assert.equal(rows(narrow(null)), 40, '狭いときに切っている');
    // **行数の上限は 2026-08-25 に撤去した**ので、設定でも切れない。
    assert.equal(rows(narrow({ rowLimit: 12 })), 40, '消したはずの設定がまだ効いている');
});

test('見出しは流れていかない（長い一覧を送っても列名が残る）', async () => {
    const css = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');
    assert.match(css, /\.unbake-table thead th\s*\{[^}]*position:\s*sticky/,
        '見出しを固定していない（長い一覧で列名が読めなくなる）');
    // **貼り付く位置は器の内容の縁。** `0` にすると器の余白ぶんの帯が上に空き、
    // そこを行が通って**見出しの上に前の行が覗く**（実測でそう見えていた）。
    assert.match(css, /\.unbake-table thead th\s*\{[^}]*top:\s*calc\(var\(--unbake-pad\) \* -1\)/,
        '器の余白を戻していない（見出しの上に行が覗く）');
});

test('重ねる面は、どれも高さの上限を持つ', async () => {
    // **上限が無い器は、内容が増えた日に黙ってポップアップでなくなる。**
    // 実際に踏んだ（2026-08-24）——支援の面だけ `max-block-size` が無く、
    // 節を足した分だけ器が伸びて画面を覆い、「背景が単色になる」と報告された。
    // **コメントを先に落とす。** ここで踏んだ（2026-08-24）——理由を書いた注記に
    // `max-block-size` の語が入っていたので、**宣言を消しても注記に当たって通った。**
    // 名前を探す見張りは、名前が書いてあるだけの場所も拾う。
    const css = stripComments(await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8'));
    const boxes = ['.unbake-confirm', '.unbake-picker', '.unbake-donate'];
    const missing = [];
    for (const sel of boxes) {
        const block = new RegExp(`^\\${sel} \\{([^}]*)\\}`, 'm').exec(css)?.[1] || '';
        if (!block) { missing.push(`${sel}（規則が無い）`); continue; }
        if (!/max-block-size|max-height/.test(block)) missing.push(sel);
    }
    assert.deepEqual(missing, [], '重ねる面に高さの上限が無い');

    // 検出器が生きているか——上限を消した形を作って、実際に拾えることを見る。
    const broken = css.replace(/(\.unbake-donate \{[^}]*?)max-block-size:[^;]*;/, '$1');
    assert.doesNotMatch(
        /^\.unbake-donate \{([^}]*)\}/m.exec(broken)?.[1] || '', /max-block-size|max-height/,
        '上限を消した形でも拾えてしまう（検査が素通りしている）',
    );
});

/** CSS のコメントを落とす。**名前だけを見る検査は、注記の中の名前も拾う。** */
function stripComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

test('最低限の明度差（地・面・線・字が互いに埋もれない）', async () => {
    // **実測 2026-08-24（稼働中の実機）で足りていなかった**:
    //   地 21 ／ 面 25 ／ 線 36 ／ 弱い字 70 ／ 字 93
    // 地と面の差が4しかなく、面の輪郭が枠線1本でしか読めない。
    // 線も地から11しか離れておらず、**表示80%倍率では 1px の枠が 0.8px** になる。
    //
    // **見るのは既定テーマの素の値。** ここは16進で書いてあるので、
    // ブラウザを使わずに測れる（`color-mix` は使わない層）。
    const css = stripComments(await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8'));
    const root = /^\.unbake-root \{([\s\S]*?)^\}/m.exec(css)?.[1] || '';
    assert.notEqual(root, '', '既定テーマの規則が読めない');

    /**
     * `#rrggbb` を **OKLab の明度**（0–100）へ。
     *
     * **相対輝度では測れない。** あちらは暗部で潰れ、実際に見える段差
     * （地 21 → 面 25）が **1.0** としか出ない。ここで見たいのは
     * *人がどれだけ違って見えるか*なので、実機の `getComputedStyle` が
     * 返すのと同じ尺度（`oklch(0.21 …)` の 0.21）で測る。
     */
    const lightness = (hex) => {
        const n = parseInt(hex.slice(1), 16);
        const lin = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
        const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(lin);
        const cbrt = Math.cbrt;
        const l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
        const m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
        const s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
        return (0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s) * 100;
    };
    const value = (name) => {
        const hex = new RegExp(`--unbake-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(root)?.[1];
        assert.ok(hex, `--unbake-${name} が16進で読めない`);
        return lightness(hex);
    };

    const bg = value('bg');
    const panel = value('panel');
    const line = value('line');
    const muted = value('muted');
    const text = value('text');

    // **面は地から離す。** 同じだと、どこからが器なのかが枠線1本でしか分からない。
    assert.ok(panel - bg >= 2, `面と地の差が足りない（${(panel - bg).toFixed(1)}）`);
    // **線は面から離す。** 細い線ほど先に見えなくなる（表示倍率で更に細る）。
    assert.ok(line - panel >= 6, `線と面の差が足りない（${(line - panel).toFixed(1)}）`);
    // **弱い字も読めること。** 「弱い」は薄いことではなく、主役でないこと。
    // **25 では緩すぎた**——変異（`#6a6a70`＝差 25.6）が素通りした。
    // 現行は 50.1 なので、**45 を下回ったら弱い字が「読みにくい字」に変わっている。**
    assert.ok(muted - panel >= 45, `弱い字と面の差が足りない（${(muted - panel).toFixed(1)}）`);
    // 主役の字は、弱い字よりはっきり上に居ること（段が潰れると強弱が消える）。
    assert.ok(text - muted >= 15, `字の強弱が潰れている（${(text - muted).toFixed(1)}）`);

    // **同じ色を2箇所に持っている。** 16進（後退先）と `oklch`（上書き）で、
    // **効くのは後者**——実際、16進だけ広げたら実機の明度は動かなかった（2026-08-24）。
    // **片方だけ直る事故を検査で塞ぐ**（値の同一ではなく、間隔の一致を見る）。
    const okBlock = /@supports \(color: oklch\(0% 0 0\)\) \{\s*\.unbake-root \{([\s\S]*?)\}/.exec(css)?.[1] || '';
    assert.notEqual(okBlock, '', 'oklch の上書き規則が読めない');
    const okL = (name) => {
        const v = new RegExp(`--unbake-${name}:\\s*oklch\\(([0-9.]+)%`).exec(okBlock)?.[1];
        assert.ok(v, `oklch 側の --unbake-${name} が読めない`);
        return Number(v);
    };
    const gaps = [
        ['面と地', panel - bg, okL('panel') - okL('bg')],
        ['線と面', line - panel, okL('line') - okL('panel')],
        ['弱い字と面', muted - panel, okL('muted') - okL('panel')],
    ];
    for (const [what, hex, ok] of gaps) {
        assert.ok(Math.abs(hex - ok) <= 6,
            `${what}の間隔が16進(${hex.toFixed(1)})と oklch(${ok}) で食い違っている`);
    }
});

test('強調色で塗ったボタンに、強調色の字を当てない', async () => {
    // **これが「カーソルを合わせると印が消える」の真因だった**（2026-08-24・実測で確定）。
    //
    //   color:      oklch(0.71 0.143 255)
    //   background: oklch(0.71 0.143 255)   ← 完全に同じ = 字が見えない
    //
    // 勝っていたのは `.unbake-tile-actions .unbake-act:hover { color: var(--unbake-accent) }`。
    // **`.unbake-act-replay` は地が強調色**なので、そこへ強調色の字を載せていた。
    //
    // **3回外したのは、表の行のボタンで読んでいたから。**
    // `.unbake-tile-actions …` の規則はタイルの上でしか当たらず、**当たる的で読まないと見えない。**
    const css = stripComments(await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8'));
    const offenders = [];
    for (const [, selector, body] of css.matchAll(/^([^\n{]*)\{([^}]*)\}/gm)) {
        // 字を強調色にする規則だけを見る。
        if (!/(^|;)\s*color\s*:\s*var\(--unbake-accent\)/.test(body)) continue;
        // その規則が「塗ってあるボタン」にも当たるか。
        // `-replay` を名指ししているか、`:not(.unbake-act-replay)` で外していれば安全。
        if (!/\.unbake-act\b/.test(selector)) continue;
        if (/:not\(\.unbake-act-replay\)/.test(selector)) continue;
        if (/\.unbake-act-replay/.test(selector)) { offenders.push(selector.trim()); continue; }
        offenders.push(selector.trim());
    }
    assert.deepEqual(offenders, [], '塗ってあるボタンに強調色の字を当てている（印が消える）');
});

test('塗りの上の字に、地の色を使わない', async () => {
    // **3回目でようやく原因に届いた件**（2026-08-24）。
    //
    // `.unbake-act-replay` の通常時には**理由まで書いてあった**——
    // 「`--unbake-bg` を使うと、明るいテーマ（紙）で白い字が薄い橙の上に乗って
    // 読めなくなる」。**その禁じ手を `:hover` 側だけがやっていた。**
    //
    // **注記は下流の機械が読まない。** 理由を書いても、次に触る人（や自分）が
    // 別の状態の規則へ同じことを書くのは止められない。**規則として測る。**
    const css = stripComments(await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8'));
    const offenders = [];
    for (const [, selector, body] of css.matchAll(/^([^\n{]*)\{([^}]*)\}/gm)) {
        // 強調色で塗る面（＝上に暗いインクを載せる前提の面）だけを見る。
        if (!/\.unbake-act-replay/.test(selector)) continue;
        if (!/(^|;)\s*color\s*:\s*var\(--unbake-bg\)/.test(body)) continue;
        offenders.push(selector.trim());
    }
    assert.deepEqual(offenders, [], '塗りの上の字に地の色を使っている（明るいテーマで消える）');

    // 検出器が生きているか——禁じ手を書いた形を作って、拾えることを見る。
    const broken = '.unbake-act-replay:hover {\n    color: var(--unbake-bg);\n}';
    assert.match(broken, /(^|\n)[^\n{]*\.unbake-act-replay[^\n{]*\{/, '走査の形が合っていない');
    assert.ok(/(^|;|\n)\s*color\s*:\s*var\(--unbake-bg\)/.test(broken), '禁じ手を拾えていない');
});

test('絵の上に重なる押せる四角は、小さくしすぎない', async () => {
    // **利用者の表示は80%倍率**（実測: `1px` の枠が `0.8px` として返る）。
    // 22px の四角は **17.6px** になり、中の印が読めるぎりぎりだった（2026-08-24 の指摘）。
    const css = stripComments(await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8'));
    const rule = /^\.unbake-tile-actions \.unbake-act \{([^}]*)\}/m.exec(css)?.[1];
    assert.ok(rule, 'タイルの操作の規則が無い');
    for (const axis of ['inline-size', 'block-size']) {
        const px = Number(new RegExp(`${axis}:\\s*(\\d+)px`).exec(rule)?.[1]);
        assert.ok(Number.isFinite(px), `${axis} が読めない`);
        // 80%倍率でも 22px を切らない大きさ（28 × 0.8 = 22.4）。
        assert.ok(px >= 27, `${axis} が小さい（${px}px → 80%倍率で ${(px * 0.8).toFixed(1)}px）`);
    }
});

test('走っている間は、タイルの操作列を hover 無しでも出す', async () => {
    // **これが「押したら印が消える」の真因だった**（2026-08-24）。
    // この列は普段 `opacity: 0` で、タイルを hover したときだけ出る。
    // **印を付けても、列が透明なら見えない。**
    const css = stripComments(await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8'));
    const rule = /^\.unbake-tile-actions\[data-busy="true"\] \{([^}]*)\}/m.exec(css)?.[1];
    assert.ok(rule, '走っている間に列を出す規則が無い');
    assert.match(rule, /opacity:\s*1/, '列を出していない');

    // 検出器が生きているか——列が既定で隠れていること自体を確かめる
    // （隠れていないなら、この規則は要らないので前提が変わっている）。
    const base = [...css.matchAll(/^\.unbake-tile-actions \{([^}]*)\}/gm)].map(m => m[1]).join('');
    assert.match(base, /opacity:\s*0/, '列が既定で隠れていない（前提が変わった）');
});

test('走っている印は、色の取り合いに参加しない', async () => {
    // **2回目の是正**（2026-08-24）。1回目は「地と字を対で決める」で直そうとしたが、
    // 実機ではまだ消えていた。**同じ的を複数の規則が奪い合う形**である限り、
    // 詳細度で勝っても**誰かが `:hover` に色を足した日にまた消える**。
    //
    // この的には既に4本が色を当てている（実測）——`.unbake-act` / `.unbake-act:hover` /
    // `.unbake-act-replay` / `.unbake-act-replay:hover`。
    // **だから走っている印は色を触らない。** 取り合いに参加しなければ負けない。
    const css = stripComments(await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8'));
    const busy = /^[^\n{]*\.unbake-act\[data-busy="true"\][^\n{]*\{([^}]*)\}/m.exec(css)?.[1];
    assert.ok(busy, '走っている印の規則が無い');
    assert.doesNotMatch(busy, /(^|;)\s*color\s*:/, '字の色を奪い合っている');
    assert.doesNotMatch(busy, /(^|;)\s*background(-color)?\s*:/, '地の色を奪い合っている');
    // **色以外で示す。** 印を回し、誰も使っていない `outline` を足す。
    assert.match(busy, /outline/, '色以外の目印が無い');

    /*
     * **回すのは印だけ**（2026-08-27 利用者の指摘「ボタンごと回転します」）。
     *
     * この検査は元々 `animation` を**釦の規則**へ要求していた。要求どおりに
     * 実装されていて、それが欠陥だった——2026-08-24 の決めごとは
     * 「**印そのものを回す**」で、釦を回せとは言っていない。
     * 28×28 のときは印しか見えないので誰も気づかず、
     * **▶ を 46×30 の錠剤にした瞬間に表に出た。**
     *
     * 見る先を擬似要素へ移す。**釦側には無いこと**も併せて要求する
     * （両方に在ると二重に回る）。
     */
    assert.doesNotMatch(busy, /animation/,
        '釦そのものを回している（地・枠・広げた的まで一緒に回る）');
    const head = '.unbake-act[data-busy="true"]::before {';
    const at = css.indexOf(head);
    assert.notEqual(at, -1, '走っている印の擬似要素が無い（印が丸ごと消える）');
    const mark = css.slice(at + head.length, css.indexOf('}', at));
    assert.match(mark, /animation/, '走っていることを動きで示していない');
    // 擬似要素も**色は触らない**（釦から継ぐ。触れば同じ取り合いに参加する）。
    assert.doesNotMatch(mark, /(^|;)\s*color\s*:/, '印の側で字の色を奪い合っている');

    // 検出器が生きているか——`outline` を他の誰かが使い始めたら、この前提は崩れる。
    //
    // **`data-held` だけは例外。** あれは「待たされている」という**姉妹の状態**で、
    // 同じボタンが同時に両方になることは無い（`markHeld` は `clearBusy` の後に走る）。
    // 目印を奪い合っているのではなく、**同じ語彙で別の状態を言っている。**
    const others = [...css.matchAll(/^([^\n{]*)\{([^}]*)\}/gm)]
        .filter(([, sel, body]) => /\.unbake-act/.test(sel)
            && !/data-busy/.test(sel) && !/data-held/.test(sel)
            && /(^|;)\s*outline\s*:/.test(body));
    assert.deepEqual(others.map(m => m[1].trim()), [],
        'ほかの規則も outline を使い始めた（目印が奪い合いになる）');
});

test('待たされている姿は、走っている姿と見分けが付く', async () => {
    // **「受け付けて処理中」と「今は取られていて始まっていない」は別の状態**
    // （2026-08-24 利用者の指示）。同じ姿にすると、
    // **受け付けたように見えて何も起きない**——一番読み違えやすい形になる。
    const css = stripComments(await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8'));
    const held = /^[^\n{]*\.unbake-act\[data-held="true"\][^\n{]*\{([^}]*)\}/m.exec(css)?.[1];
    assert.ok(held, '待たされている姿の規則が無い');
    // **回さない。** 回すと走っているものと並んで見分けが付かない。
    assert.match(held, /animation:\s*none/, '待っているのに回している');
    // **色の取り合いには参加しない**（走っている姿と同じ作法）。
    assert.doesNotMatch(held, /(^|;)\s*color\s*:/, '字の色を奪い合っている');
    assert.doesNotMatch(held, /(^|;)\s*background(-color)?\s*:/, '地の色を奪い合っている');
    // 枠の引き方が走っている姿と違うこと（実線と破線・色も別）。
    const busy = /^[^\n{]*\.unbake-act\[data-busy="true"\][^\n{]*\{([^}]*)\}/m.exec(css)?.[1] || '';
    const outlineOf = (body) => /(^|;)\s*outline\s*:([^;]*)/.exec(body)?.[2]?.trim() || '';
    assert.notEqual(outlineOf(held), outlineOf(busy), '2つの状態が同じ枠になっている');
});

/**
 * 規則1つ分の中身を取り出す。**文字列だけで探す。**
 *
 * 正規表現でセレクタを組むと、点や `$` を逃がし損ねた日に**空振りしたまま
 * 緑になる**（空集合に対する全称は必ず真）。2026-08-24 に実際に踏んだ。
 */
function blockOf(css, selector) {
    let from = 0;
    for (;;) {
        const at = css.indexOf(selector, from);
        if (at < 0) return '';
        from = at + selector.length;
        const before = css.slice(0, at).trimEnd().at(-1) || '}';
        const after = css.slice(from).trimStart().at(0) || '';
        if ((before === '}' || before === '/') && after === '{') {
            const open = css.indexOf('{', from);
            const close = css.indexOf('}', open);
            if (open >= 0 && close > open) return css.slice(open + 1, close);
        }
    }
}

test('浮かべた器は、一覧の地と同じ色にしない', async () => {
    // **実測 2026-08-24**: `--unbake-bg`（21%）と `--unbake-panel`（25%）は
    // 明度が4%しか違わず、ポップアップの地を `--unbake-panel` にすると
    // **どこからが浮いているのかが枠線1本でしか分からない**（実機の指摘）。
    //
    // **持ち上げ幅は 20% → 8% に下げた**（同じ日の追加指摘「薄い」）。
    // 覆いを詳細ウィンドウと同じ暗さにしたので、20% では白茶けて見えた。
    // **別の値であること**は変えていない——同じにすると上の問題へ戻る。
    const css = stripComments(await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8'));
    for (const sel of ['.unbake-popup', '.unbake-donate']) {
        const block = blockOf(css, sel);
        assert.notEqual(block, '', `${sel} の規則が無い`);
        assert.ok(block.includes('background: var(--unbake-overlay)'),
            `${sel}: 地から持ち上げていない`);
    }
    // 持ち上げの変数そのものが在ること。**後退先を先に置く**（`color-mix` の落とし穴）。
    assert.ok(css.includes('--unbake-overlay: var('),
        '後退先が無い（混色が使えない実装で透明になる）');
    assert.ok(css.includes('--unbake-overlay: color-mix('),
        '混色が使える実装での持ち上げが無い');
});

test('浮かべる面は詳細ウィンドウと同じ作りで、上限を持つ', async () => {
    // **2026-08-24 に方針を反転した。** 元は「器の中に閉じる」だったが、
    // 実測でサイドバーは 312px しかなく、設定も支援もそこでは窮屈だった。
    // 利用者の指示で**詳細ウィンドウと同じ全面の作り**へ揃える。
    //
    // 反転しても残す約束は2つ:
    //   1. **後ろを沈める布が在ること**（無いと、どこが操作できるのか判らない）
    //   2. **高さに上限が在ること**（無いと、内容が増えた日に黙ってページになる）
    // 「畳めること」は DOM 側の検査が持っている（`openLayers` / `closeOverlays`）。
    const css = stripComments(await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8'));
    for (const sel of ['.unbake-donate-backdrop', '.unbake-popup-layer']) {
        const block = blockOf(css, sel);
        assert.notEqual(block, '', `${sel} の規則が無い`);
        assert.ok(block.includes('position: fixed'), `${sel}: 全面の作りになっていない`);
        assert.ok(block.includes('background: oklch('), `${sel}: 後ろを沈める布が無い`);
    }
    for (const sel of ['.unbake-popup', '.unbake-donate']) {
        const block = blockOf(css, sel);
        assert.ok(/max-block-size: \d+vh/.test(block),
            `${sel}: 高さの上限が無い（内容が増えた日にページになる）`);
    }
});

test('絞り込みの並びは折り返す（サイドバーの幅は宿主が決める）', async () => {
    // 実測（2026-08-24・稼働中の ComfyUI）: サイドバーはどのタブでも 312px で
    // `min-width` も 312px。**こちらから広げることはできない。**
    // 折り返さない指定だとこの行が 365px になり、**外へ 67px はみ出して切れていた。**
    // **注記を先に落とす**（上と同じ理由——名前が書いてあるだけの場所を拾わない）。
    const css = stripComments(await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8'));
    const block = /^\.unbake-chips \{([^}]*)\}/m.exec(css)?.[1] || '';
    assert.notEqual(block, '', '絞り込みの規則が無い');
    assert.match(block, /flex-wrap:\s*wrap/, '折り返さない（狭い器で押し出す）');
    // `min-width: auto` の flex 子は中身より狭くならない。**縮められると明示する。**
    assert.match(block, /min-width:\s*0|min-inline-size:\s*0/, '縮められることを言っていない');
});

test('同じセレクタを2箇所へ書いていない', async () => {
    // **後ろの規則が勝つので、直したつもりの側が黙って捨てられる。**
    // 実際に踏んだ: 見出しの貼り付けが既に在るのに気づかず二重に書き、
    // 新しい方が効かないまま「直した」と読みかけた（2026-08-20）。
    const css = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');
    const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
    // **見るのは「同じ性質を二度書いたか」。** 同じセレクタを別の場所へ
    // 並べて書くこと自体は害が無い（打ち消し合わない）。害になるのは、
    // **同じ性質**が2箇所に在って後ろが勝つ形。
    const declared = new Map();   // セレクタ → 性質 → 回数
    let depth = 0;
    let selector = '';
    let block = '';
    let buffer = '';
    for (const ch of flat) {
        if (ch === '{') {
            if (depth === 0) { selector = buffer.trim().replace(/\s+/g, ' '); block = ''; }
            depth += 1;
            buffer = '';
        } else if (ch === '}') {
            depth -= 1;
            if (depth === 0 && selector && !selector.startsWith('@')) {
                const properties = declared.get(selector) || new Map();
                for (const line of block.split(';')) {
                    const at = line.indexOf(':');
                    const name = at < 0 ? '' : line.slice(0, at).trim();
                    if (name && !name.startsWith('--')) {
                        const values = properties.get(name) || [];
                        values.push(line.slice(at + 1).trim());
                        properties.set(name, values);
                    }
                }
                declared.set(selector, properties);
            }
            buffer = '';
        } else if (depth === 0) {
            buffer += ch;
        } else if (depth === 1) {
            block += ch;
        }
    }
    /**
     * **後退先の対だけは、二度書きを認める**（2026-08-23）。
     *
     * `oklch()` や `color-mix()` を読めない実装では、その宣言が**丸ごと捨てられる**
     * ——素の値を先に置いておくと、そちらが残る。これは打ち消し合いではなく、
     * 順番そのものが仕掛けである。利用者の環境で枠が黄土色になっていたのは、
     * この対が無かったせいだった。
     *
     * **認めるのは「後ろだけが新しい書き方」のときに限る。** 両方が素の値なら、
     * それはただの二度書きで、後ろが黙って勝つ。
     */
    const NEW_SYNTAX = /(oklch|oklab|color-mix|lab|lch)\(/;
    const isFallbackPair = (values) => values.length === 2
        && !NEW_SYNTAX.test(values[0]) && NEW_SYNTAX.test(values[1]);

    const clashes = [];
    for (const [rule, properties] of declared) {
        for (const [name, values] of properties) {
            if (values.length > 1 && !isFallbackPair(values)) clashes.push(`${rule} { ${name} }`);
        }
    }
    assert.deepEqual(clashes, [], `同じ性質を2度書いている: ${clashes.join(' / ')}`);

    // 検出器が生きていること（見出しの規則を実際に拾えているか）。
    assert.equal(declared.get('.unbake-table thead th')?.get('position')?.length, 1,
        '見出しの規則を拾えていない（検査が素通りしている）');
    // **順が逆なら通さない。** 新しい書き方を先に置くと、後退先の意味が無い。
    assert.equal(isFallbackPair(['#000', 'oklch(0% 0 0)']), true);
    assert.equal(isFallbackPair(['oklch(0% 0 0)', '#000']), false, '順が逆でも通している');
    assert.equal(isFallbackPair(['#000', '#111']), false, 'ただの二度書きを通している');
});

// --- ⑤ 判定の色 -------------------------------------------------------------

test('判定の色が、細い帯1本ではない', async () => {
    // **色は正しかった。** 実測すると帯は 3px 幅・行の高さで 17px しか塗られておらず、
    // 薄く見えていたのは**面積**だった。だから色ではなく面を広げる。
    const css = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');
    const block = css.match(/\.unbake-verdict\s*\{([^}]*)\}/);
    assert.ok(block, '判定の規則が無い');
    const width = block[1].match(/border-inline-start:\s*(\d+)px/);
    assert.ok(width && Number(width[1]) >= 6, `帯が ${width?.[1]}px しかない`);
    assert.match(block[1], /background:\s*color-mix/, '下地を敷いていない（面積が稼げていない）');

    // **透かして示さない。** 判定済みを薄くすると見直せなくなる。
    assert.doesNotMatch(block[1], /opacity/, '不透明度で示している');

    // 色は1箇所で決める（帯と下地で別々に書くと、片方だけ直す事故が起きる）。
    for (const verdict of ['reproducible', 'approximate', 'blocked', 'pending']) {
        const rule = css.match(new RegExp(`\\.unbake-verdict\\[data-verdict="${verdict}"\\]\\s*\\{([^}]*)\\}`));
        assert.ok(rule, `${verdict} の色が無い`);
        assert.match(rule[1], /--unbake-verdict-color:/, `${verdict} が色を2箇所で書いている`);
    }
});

// --- 列の指し方（②を入れたときに踏んだ）--------------------------------------

test('列幅を位置（nth-child）で指定していない', async () => {
    // **先頭へ列を1つ足しただけで、幅指定が全部1つ隣へずれた。**
    // ずれても画面は出るので、気づけるのは幅が変わったときだけ。
    const css = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');
    assert.doesNotMatch(css, /nth-child/, '列を位置で指している（列を足すとずれる）');
});

// --- ③ 言語 -----------------------------------------------------------------

test('言語の項目が在り、既定は「宿主に合わせる」', async () => {
    setLocale('en');
    const doc = fakeDocument();
    const view = createSettingsView({
        documentRef: doc,
        read: async () => ({ settings: { language: '' } }),
        write: async () => ({ settings: {} }),
    });
    await view.loaded;
    const select = view.root.findAll(node => node.tagName === 'SELECT')
        .find(node => node.getAttribute('aria-label') === t('settings.language'));
    assert.ok(select, '言語の項目が無い');

    const values = select.children.map(option => option.getAttribute('value'));
    assert.equal(values[0], '', '「宿主に合わせる」が先頭に無い');
    // 12言語ぶん＋「合わせる」。
    assert.equal(values.length, Object.keys(CATALOGS).length + 1);
    // **その言語自身の表記で出す。** 読めない言語で書かれた一覧からは選べない。
    const japanese = select.children.find(option => option.getAttribute('value') === 'ja');
    assert.equal(japanese.textContent, '日本語');
});

test('「宿主に合わせる」へ戻せる（空を送れる）', async () => {
    setLocale('en');
    const doc = fakeDocument();
    const view = createSettingsView({
        documentRef: doc,
        read: async () => ({ settings: { language: 'ja' } }),
        write: async (patch) => ({ settings: { language: patch.language } }),
    });
    await view.loaded;
    const select = view.root.findAll(node => node.tagName === 'SELECT')
        .find(node => node.getAttribute('aria-label') === t('settings.language'));
    assert.equal(select.value, 'ja');

    // **空を落とすと、一度選んだら二度と戻せない。** 他の項目は空＝「変えない」でよいが、
    // ここは空自体が選択肢。
    select.value = '';
    assert.ok(Object.hasOwn(view.collect(), 'language'), '空の言語を送っていない');
    assert.equal(view.collect().language, '');
});

test('言語を変えたら、呼び手に面の組み直しを頼む', async () => {
    setLocale('en');
    const doc = fakeDocument();
    const asked = [];
    const view = createSettingsView({
        documentRef: doc,
        read: async () => ({ settings: { language: '' } }),
        write: async (patch) => ({ settings: patch }),
        onLanguageChange: (code) => asked.push(code),
    });
    await view.loaded;
    // 見出し・列名・ボタンは面を作るときに一度だけ文字を入れているので、
    // 保存しただけでは古い言語のまま残る。
    await view.save({ language: 'ja' });
    assert.deepEqual(asked, ['ja'], '面の組み直しを頼んでいない');

    // 言語を含まない保存では頼まない（毎回組み直すと入力中の状態が飛ぶ）。
    await view.save({ compact_width: 600 });
    assert.deepEqual(asked, ['ja']);
});

// --- ① 戻る口 ---------------------------------------------------------------

test('全画面に戻る口が在る（出口が Esc だけではない）', async () => {
    const source = await readFile(join(ROOT, 'web/unbake.js'), 'utf8');
    assert.match(source, /unbake-fullscreen-close/, '戻るボタンを作っていない');
    assert.match(source, /t\('app\.closeFullscreen'\)/, '文言を鍵で持っていない');
    const css = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');
    assert.match(css, /\.unbake-fullscreen-close\s*\{/, 'ボタンに見た目が無い（描いても見えない）');
});

test('新しい文言が12言語すべてに在る', () => {
    const keys = [
        'app.closeFullscreen', 'app.closeFullscreen.help',
        'column.preview', 'list.preview.none', 'list.preview.failed',
        'settings.language', 'settings.language.help', 'settings.language.host',
    ];
    for (const [code, messages] of Object.entries(CATALOGS)) {
        for (const key of keys) {
            assert.ok(messages[key], `${code} に ${key} が無い`);
        }
    }
});
