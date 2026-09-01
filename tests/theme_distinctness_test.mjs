/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 要件① — **上流と客の取り合いに見えないこと。**
 *
 * 全画面モードは見た目が LoRA Manager に寄りやすい。「配色と情報設計を変える」は
 * 意図であって観測ではないので、**寄った瞬間に赤くなる形**にしておく。
 *
 * 測るのは2つ:
 *   色     アクセントの色相が上流から十分離れていること
 *   情報設計 上流はモデルの**カード格子**、こちらは**行と表**。
 *          `grid-template-columns` を使った時点で寄り始めているので、そこで止める。
 *
 * **上流の値は実測して定数に落としてある。** 上流のチェックアウトを渡せば測り直す
 * （`--upstream`／`UNBAKE_UPSTREAM_DIR`）。渡さないときは定数で判定する
 * ——実測の出所を書かずに定数を置くと、由来が判らない数字が凍る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const THEME = fs.readFileSync(path.join(ROOT, 'web/panel/theme.css'), 'utf8');

/**
 * 上流 ComfyUI-Lora-Manager のアクセント色相。
 *
 * **実測 2026-08-20**（クリーン上流 v1.1.9 の `static/css/tokens/colors.css` 全体）:
 * `--color-accent-h` は **6種**（256=既定 / 213 / 300 / 190 / 265 / 175）。
 *
 * **最初は3つだと思っていた。** grep の出力を先頭20行で切っていたので、
 * 190 / 265 / 175 の3テーマが母集団から落ちていた。
 * この検査が上流の実物と突き合わせて赤くしたので気づいた——
 * **定数は「測った」ではなく「どこまで測ったか」まで書かないと同じ穴が開く。**
 * （結果は変わらなかった。色相75は6つ全部から100度以上離れている。）
 */
const UPSTREAM_ACCENT_HUES = [256, 213, 300, 190, 265, 175];

/** 色相環上の距離（度）。 */
function hueDistance(a, b) {
    const d = Math.abs(((a - b) % 360 + 360) % 360);
    return Math.min(d, 360 - d);
}

function declaredHues(css, name) {
    return [...css.matchAll(new RegExp('--' + name + '\\s*:\\s*(-?[0-9.]+)', 'g'))]
        .map(m => Number(m[1]));
}

function upstreamDir() {
    const i = process.argv.indexOf('--upstream');
    return (i >= 0 ? process.argv[i + 1] : process.env.UNBAKE_UPSTREAM_DIR) || null;
}

test('自分のアクセント色相が宣言されている', () => {
    const hues = declaredHues(THEME, 'unbake-accent-h');
    assert.ok(hues.length >= 1, 'theme.css に --unbake-accent-h が無い');
    assert.ok(hues.every(h => h >= 0 && h < 360), '色相の値が範囲外');
});

test('既定は宿主の青に合わせ、離す方は名前つきのテーマとして残っている', () => {
    // **この検査は 2026-08-22 に向きが変わった。**
    //
    // 元は「上流のアクセント色相から60度以上離れていること」を固定していた
    // ——別の道具だと一目で分かるように、という設計判断。**利用者がそれを覆した**:
    // 「LoRA Manager と ComfyUI では黒を基調に青がアクセント。これを既定にして」。
    //
    // **緩めたのではなく、守る対象を変えた。** 今固定するのは次の2つ:
    //   1. 既定が**宿主の実測値**から離れていないこと（黙って別の青へ流れない）
    //   2. **離す方の選択肢が消えていない**こと（`amber` を選べば元に戻せる）
    //
    // 宿主の値は稼働中の ComfyUI 0.27.0 から採った実測（2026-08-22）:
    //   `--p-primary-color: #60a5fa` → oklch(71.4% 0.143 255)
    const HOST_ACCENT_HUE = 255;
    const mine = declaredHues(THEME, 'unbake-accent-h');
    assert.ok(mine.length >= 4, `色相を ${mine.length} 個しか拾えていない＝走査が壊れている`);

    // 1. 既定（`.unbake-root` の束）が宿主から離れていないこと。
    const base = Number(THEME.match(/\.unbake-root \{[\s\S]*?--unbake-accent-h:\s*(\d+)/)?.[1]);
    assert.ok(Number.isFinite(base), '既定の色相を読めない');
    const drift = hueDistance(base, HOST_ACCENT_HUE);
    assert.ok(drift <= 15,
        `既定が宿主の青から ${drift}° ずれている（実測 ${HOST_ACCENT_HUE}°）。宿主を測り直したなら定数も直すこと`);

    // 2. 離す方が残っていること。**選択肢を消すと、戻す道が無くなる。**
    const amber = Number(THEME.match(/\[data-theme="amber"\]\s*\{[\s\S]*?--unbake-accent-h:\s*(\d+)/)?.[1]);
    assert.ok(Number.isFinite(amber), '琥珀のテーマが消えている（宿主へ揃えるのをやめる道が無い）');
    for (const upstream of UPSTREAM_ACCENT_HUES) {
        assert.ok(hueDistance(amber, upstream) >= 60,
            `琥珀が上流へ寄っている（${amber}° と ${upstream}°）`);
    }
});

test('上流の実物からも測り直す（--upstream を渡したときだけ走る）', (t) => {
    const dir = upstreamDir();
    const tokens = dir ? path.join(dir, 'static/css/tokens/colors.css') : null;
    if (!tokens || !fs.existsSync(tokens)) {
        t.skip('上流のチェックアウトが指定されていない（UNBAKE_UPSTREAM_DIR か --upstream）');
        return;
    }
    const measured = declaredHues(fs.readFileSync(tokens, 'utf8'), 'color-accent-h');
    assert.ok(measured.length > 0, '上流から色相を読めない＝走査が壊れている');
    // **定数が古くなっていたら、そのこと自体を赤くする。**
    const unknown = measured.filter(h => !UPSTREAM_ACCENT_HUES.includes(h));
    assert.deepEqual(unknown, [], '上流に未記録の色相がある。UPSTREAM_ACCENT_HUES を測り直すこと');

    const mine = declaredHues(THEME, 'unbake-accent-h');
    const tooClose = [];
    for (const hue of mine) {
        for (const upstream of measured) {
            if (hueDistance(hue, upstream) < 60) tooClose.push(hue + '° vs ' + upstream + '°');
        }
    }
    assert.deepEqual(tooClose, [], '上流の実物の配色に寄っている');
});

/* =========================================================================
   強調色は2通りに書いてある。**ずれても誰も気づかない形だった**
   （`I-20260830-22` / 2026-08-30 実機で判明）
   =========================================================================

   各テーマは同じ色を2つの書き方で持っている:

     --unbake-accent-l/c/h : 設計の意図（oklch の3値）
     --unbake-accent       : それを sRGB で描いた姿（16進）

   **画面の色を決めているのは16進のほう。** 16進は
   `.unbake-root[data-theme="…"]`（詳細度 0,2,0）に在り、`oklch()` は
   `@supports` の中の `.unbake-root`（0,1,0）に在るので、**名前つきの4テーマでは
   16進が勝つ**（稼働中の ComfyUI 8288 で `getComputedStyle` を実測）。
   つまり上の検査が上流との距離を測っている `--unbake-accent-h` は、
   **amber では画面に出ない値**である。16進だけ書き換えても赤くならない。

   **色相の値が間違っているのではない。** 5テーマすべてで、宣言どおりの
   `oklch(l c h)` と隣の16進は**画素まで同一**だった（canvas へ塗って画素を
   読む方式・対照として黒と白で 255 差を確認）。`paper` に見えた 11.7° の
   ずれは、sRGB の色域外の色を16進へ丸めた結果を oklch へ逆算したときにだけ
   現れる見かけの数字で、**実際には同じ色**である。

   だから角度の許容を決め直しても意味がない。止めるべきは
   **「2つの表記が黙ってずれること」**なので、ここで一致を留める。 */

/** sRGB の伝達関数（線形 → 表示値）。 */
function encodeSrgb(v) {
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
}

/**
 * `oklch(L% C H)` を sRGB へ。**色域外はそのことを返す**（黙って丸めない）。
 *
 * 丸め方はブラウザと完全に同じではありえない（CSS の色域マッピングは
 * 彩度を落としながら寄せる）。**色域内は厳密に、色域外は許容つきで**測る。
 */
function oklchToSrgb(L, C, H) {
    const l0 = L / 100;
    const a = C * Math.cos((H * Math.PI) / 180);
    const b = C * Math.sin((H * Math.PI) / 180);
    const l = (l0 + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (l0 - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (l0 - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    const linear = [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    ];
    const encoded = linear.map(encodeSrgb);
    const inGamut = encoded.every(v => v >= -0.001 && v <= 1.001);
    const rgb = encoded.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255));
    return { rgb, inGamut };
}

const hexToRgb = (hex) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb) => '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');

/** 各テーマの束から `l` `c` `h` と16進を取り出す。 */
function accentPairs() {
    const out = [];
    const re = /(\.unbake-root(?:\[data-theme="[a-z]+"\])?)\s*\{([\s\S]*?)\n\}/g;
    for (const [, selector, body] of THEME.matchAll(re)) {
        const get = (name) => new RegExp('--unbake-' + name + '\\s*:\\s*([^;]+);').exec(body)?.[1]?.trim();
        const l = get('accent-l');
        const c = get('accent-c');
        const h = get('accent-h');
        const hex = get('accent');
        if (!l || !c || !h || !hex?.startsWith('#')) continue;
        out.push({ selector, l: Number(String(l).replace('%', '')), c: Number(c), h: Number(h), hex });
    }
    return out;
}

test('[対照] 色の変換そのものが働いている', () => {
    // **変換器が定数を返していたら、下の検査は無条件に緑になる。**
    assert.equal(toHex(oklchToSrgb(0, 0, 0).rgb), '#000000', '黒を黒として描けていない');
    assert.equal(toHex(oklchToSrgb(100, 0, 0).rgb), '#ffffff', '白を白として描けていない');
    // 違う色は違う値になること（同じ物を返していないこと）。
    const a = toHex(oklchToSrgb(71, 0.143, 255).rgb);
    const b = toHex(oklchToSrgb(74, 0.15, 75).rgb);
    assert.notEqual(a, b, '別々の色相が同じ値になっている（変換が死んでいる）');
    // 色域の判定が両方の答えを返せること。
    assert.equal(oklchToSrgb(71, 0.143, 255).inGamut, true, '収まる色を色域外と言っている');
    assert.equal(oklchToSrgb(52, 0.16, 60).inGamut, false, '色域外の色を収まると言っている');
});

/**
 * 1組を突き合わせる。**判定は1箇所に置く**——本番と対照が同じ道を通らないと、
 * 許容を広げるだけで両方緑にできてしまう（実際に変異で素通りした）。
 *
 * 色域内は厳密に。色域外はブラウザの色域マッピングと丸め方が違いうるので
 * 少しだけ許す（それでも色相が動けば1チャンネルあたり十数は変わる）。
 */
function comparePair(l, c, h, hex) {
    const got = oklchToSrgb(l, c, h);
    const want = hexToRgb(hex);
    const slack = got.inGamut ? 1 : 4;
    const diff = Math.max(...got.rgb.map((v, i) => Math.abs(v - want[i])));
    return { ok: diff <= slack, diff, slack, inGamut: got.inGamut, drawn: toHex(got.rgb) };
}

test('強調色の2つの書き方が、同じ色を指している', () => {
    const pairs = accentPairs();
    // **走査が痩せたら空振りする。** 既定＋名前つき4つで5組ある。
    assert.ok(pairs.length >= 5,
        `強調色の組を ${pairs.length} 個しか拾えていない＝走査が壊れている`);

    const wrong = [];
    for (const p of pairs) {
        const r = comparePair(p.l, p.c, p.h, p.hex);
        if (!r.ok) {
            wrong.push(`${p.selector}: oklch(${p.l}% ${p.c} ${p.h}) は ${r.drawn} に描かれるが、`
                + `16進は ${p.hex}（差 ${r.diff} / 許容 ${r.slack}${r.inGamut ? '' : '・色域外'}）`);
        }
    }
    assert.deepEqual(wrong, [],
        '強調色の oklch と16進がずれている。**画面に出るのは16進のほう**なので、'
        + '色相の値だけ直しても絵は変わらない');
});

test('[対照] 少しずれた16進は、通さない', () => {
    // **許容そのものを留める。** 広げれば本番の検査は無条件に緑になるので、
    // 「この程度のずれは落ちる」を同じ判定器で固定しておく。
    const pairs = accentPairs();
    const amber = pairs.find(p => p.selector.includes('amber'));
    assert.ok(amber, '前提: amber が在る');
    assert.equal(comparePair(amber.l, amber.c, amber.h, amber.hex).ok, true,
        '前提: 今の組は通る');

    // 青だけ 0x1b → 0x3b（32/255）動かす。**人の目にも判る程度の差**。
    const nudged = amber.hex.slice(0, 5) + '3b';
    const r = comparePair(amber.l, amber.c, amber.h, nudged);
    assert.equal(r.ok, false,
        `${amber.hex} と ${nudged} の差 ${r.diff} を通している（許容 ${r.slack} が広すぎる）`);
});

test('[対照] 別のテーマの16進とは一致しない', () => {
    // 上の検査が「何と比べても通る」形になっていないこと。
    const pairs = accentPairs();
    const amber = pairs.find(p => p.selector.includes('amber'));
    const paper = pairs.find(p => p.selector.includes('paper'));
    assert.ok(amber && paper, '前提: amber と paper が在る');
    const got = oklchToSrgb(amber.l, amber.c, amber.h).rgb;
    const other = hexToRgb(paper.hex);
    const diff = Math.max(...got.map((v, i) => Math.abs(v - other[i])));
    assert.ok(diff > 20, `別のテーマの色と ${diff} しか違わない（比べる意味が無い）`);
});

test('記録の一覧がカード格子でなく行と表である', () => {
    // 上流はモデルの**カード格子**。記録の一覧を同じ形にすると、下流に立っている
    // ことが見えなくなるうえ、1件あたりの高さが増えて狭い器で潰れる。
    //
    // **例外は「絵を並べて比べる面」だけ。** Sweep の結果と、既に出ている絵の一覧は
    // どちらも比較そのものが目的で、表にすると比較できない。
    // **例外を名前で固定する**ために、格子の指定がその2つ以外に出ていないことを
    // ここで確かめる——数を数えるだけでは、次に足された格子が一覧側でも通ってしまう。
    //
    // **記録の一覧（`.unbake-table`）は表のまま。** そこが崩れたら下の2行が赤くなる。
    //
    // **`.unbake-tiles` は 2026-08-20 にユーザーの指示で足した3つ目の例外。**
    // 絵で選ぶための器で、比較の面と同じ理由（表にすると目的を果たせない）。
    // **表が既定であることは変えていない**——タイルは明示的に選んだときだけ出る。
    // `.unbake-sweep-controls` は**操作の並べ方**であってカード格子ではない
    // （選択肢の字が入る幅を持たせるために格子にした）ので、数える対象から外す。
    // `.unbake-sweep-picker-grid` は**差し替える相手を絵で選ぶ器**。
    // 名前だけでは「どちらが欲しい絵か」が判らないので、ここも比較の面と同じ理由で
    // 格子になる（2026-08-20・ユーザー指示）。
    // `.unbake-detail-cells` は **Sweep の格子を詳細へ移したもの**
    // （2026-08-22 利用者の指示で「振る」の面を畳んだ）。振った結果を並べて
    // 見比べるための器なので、比較の面と同じ理由で格子になる。
    const COMPARISON_VIEWS = [
        '.unbake-sweep-grid', '.unbake-variants-grid', '.unbake-tiles', '.unbake-sweep-picker-grid',
        '.unbake-detail-cells',
    ];
    const NOT_CARD_GRIDS = ['.unbake-sweep-controls'];
    // **コメントを外してから走査する。** 外さないと、規則を説明した文に
    // `grid-template-columns` と書いただけで格子が1つ増えたことになる
    // （2026-08-24 実際に誤爆した）。走査が空にならないことは下の
    // `grids.length > 0` が押さえている。
    const grids = [...stripBlockComments(THEME).matchAll(/([^}]*)\{[^}]*grid-template-columns[^}]*\}/g)]
        // **セレクタの末尾のクラス名まで詰める。** 行の末尾で取ると、
        // `.unbake-root[data-density="compact"] .unbake-variants-grid` のような
        // 上書きが「別の格子」に見えて、例外の一覧が実際より多く見える。
        .map(m => m[1].trim().split(/\r?\n/).at(-1).trim().split(/\s+/).at(-1))
        // 属性の絞り込み（`[data-columns="2"]`）は同じ器の上書きなので詰める。
        .map(selector => selector.replace(/\[[^\]]*\]/g, ''))
        .filter(selector => !NOT_CARD_GRIDS.includes(selector));
    assert.ok(grids.length > 0, '格子の指定を1つも拾えていない＝走査が壊れている');
    assert.deepEqual([...new Set(grids)].sort(), [...COMPARISON_VIEWS].sort(),
        '比較の面以外にカード格子を作り始めている');
    assert.match(THEME, /\.unbake-table/, '表のスタイルが無い');
    assert.match(THEME, /border-collapse/, '表として組んでいない');
});

test('判定済みを薄くする指定を入れていない', () => {
    // 判定対象を劣化させると見直せなくなる。**色帯で示す。**
    const dimming = [...THEME.matchAll(/opacity\s*:\s*0?\.\d+/g)].map(m => m[0]);
    assert.deepEqual(dimming, [], '判定済みを薄くする指定がある');
});

test('検査自体が発火することを確かめる', () => {
    assert.equal(hueDistance(75, 256), 179);
    assert.equal(hueDistance(250, 256), 6);
    assert.equal(hueDistance(350, 10), 20, '色相環をまたぐ距離を測れていない');
    assert.deepEqual(declaredHues('--unbake-accent-h: 75;', 'unbake-accent-h'), [75]);
});

/*
 * 設定の面の**字の階層**（2026-08-24 実機「視認性が悪い」）。
 *
 * 実測すると、項目名と説明文が **13px / weight 400 / 同じ色** で完全に一致していた。
 * 段落が並ぶ中から項目名を拾えないのはこれが原因で、**色を足す前に差を付ける**。
 * 見た目の話なので放っておくと簡単に戻る——形で固定しておく。
 *
 * 探すのは**文字列だけ**で行う。正規表現でセレクタを組むと、点や括弧を
 * 逃がし損ねた日に**空振りしたまま緑になる**（空集合に対する全称は必ず真）。
 */
function ruleBody(css, selector) {
    const cleaned = stripBlockComments(css);
    let from = 0;
    for (;;) {
        const at = cleaned.indexOf(selector, from);
        if (at < 0) return null;
        from = at + selector.length;
        // 前は行頭か閉じ括弧のあと（`.unbake-settings-labelrow` に化けないため）。
        const before = cleaned.slice(0, at).trimEnd().at(-1) || '}';
        const after = cleaned.slice(from).trimStart().at(0) || '';
        if ((before === '}' || before === '/') && after === '{') {
            const open = cleaned.indexOf('{', from);
            const close = cleaned.indexOf('}', open);
            if (open >= 0 && close > open) return cleaned.slice(open + 1, close);
        }
    }
}

/** CSS のコメントは入れ子にならないので、開きと閉じを順に追えば足りる。 */
function stripBlockComments(css) {
    let out = '';
    let at = 0;
    for (;;) {
        const open = css.indexOf('/' + '*', at);
        if (open < 0) return out + css.slice(at);
        out += css.slice(at, open);
        const close = css.indexOf('*' + '/', open);
        if (close < 0) return out;
        at = close + 2;
    }
}

/** `prop: value;` を1つ拾う。**文字列だけで探す。** */
function declaration(body, prop) {
    for (const part of String(body || '').split(';')) {
        const colon = part.indexOf(':');
        if (colon < 0) continue;
        if (part.slice(0, colon).trim() !== prop) continue;
        return part.slice(colon + 1).trim();
    }
    return null;
}

test('設定の項目名と説明文は、字の形で見分けが付く', () => {
    const label = ruleBody(THEME, '.unbake-settings-label');
    const help = ruleBody(THEME, '.unbake-settings-help');
    // 検出器が生きているか——どちらかが無いなら、以下は空に対する全称で必ず真。
    assert.ok(label, '.unbake-settings-label の規則が無い');
    assert.ok(help, '.unbake-settings-help の規則が無い');

    const labelWeight = Number(declaration(label, 'font-weight'));
    assert.ok(labelWeight >= 600, `項目名が太くない（font-weight: ${labelWeight}）`);
    assert.equal(declaration(label, 'color'), 'var(--unbake-text)',
        '項目名が本文の色でない（説明文と同じ muted に戻っている）');

    const labelSize = declaration(label, 'font-size');
    const helpSize = declaration(help, 'font-size');
    assert.notEqual(labelSize, helpSize,
        `項目名と説明文の大きさが同じ（${labelSize}）——実機で読めなかったのはこれ`);
    assert.ok(String(helpSize).includes('font-xs'), `説明文が1段下でない（${helpSize}）`);
    assert.equal(declaration(help, 'color'), 'var(--unbake-muted)',
        '説明文が本文と同じ強さで出ている');
});

test('入り切りの欄は、見出しと同じ行に印を置く', () => {
    // 縦に積むと、印だけが次の行の中央へ落ちて**どの項目のものか読めない**
    // （2026-08-24 実機）。器の側の規則が消えたら、そこへ戻る。
    const body = ruleBody(THEME, '.unbake-settings-field-check');
    assert.ok(body, '.unbake-settings-field-check の規則が無い（縦積みへ戻っている）');
    assert.equal(declaration(body, 'display'), 'flex', '横並びになっていない');
    // **向きまで見る。** 親の `column` は同じ強さで残るので、`display: flex` だけでは
    // 縦積みのままになる（2026-08-24 実機で、印が幅によらず中央へ落ちていた）。
    assert.equal(declaration(body, 'flex-direction'), 'row',
        '向きを言い直していない（親の column が残って縦積みになる）');
    assert.equal(declaration(body, 'align-items'), 'center', '印が行の中で揃っていない');
    const help = ruleBody(THEME, '.unbake-settings-field-check > .unbake-settings-help');
    assert.equal(declaration(help, 'flex-basis'), '100%',
        '説明が同じ行に割り込む（幅を全部使わせること）');
});
