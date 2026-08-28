/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **一覧のカードに出る絵が、暗い地で見えること**
 *（2026-08-29 利用者の報告・画面写真つき「視認性が悪い」）。
 *
 * 原因は**1つのファイルを、要求が正反対の2箇所で使っていた**こと:
 *
 *   `web/icon.svg`  … サイドバー。`mask-image` として当てるので**中の色に
 *                     意味が無く**、たまたま `#000` になっていた
 *   `pyproject.toml` の `Icon` … Registry / ComfyUI-Manager のカード。
 *                     **普通の画像として描かれる**ので色がそのまま出る
 *
 * 実測（WCAG の相対輝度比）: 黒 `#000000` は Manager のカード地 `#2b2d31` に対して
 * **1.52:1**、ページ地 `#1e1f22` では **1.27:1**。ほぼ見えない。
 *
 * **1枚で両方は満たせない。** マスクは背景を持てず（板を足すと四角い塊になる）、
 * カードは地の色が判らない場所で浮く必要がある。だからファイルを分けた。
 * ここは**分けたままであること**を見張る——片方を直すときに、もう片方へ
 * 引っ張られるのが元の壊れ方だった。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** WCAG 2.x の相対輝度比。**「見える」を数字で言うため。** */
function contrast(a, b) {
    const channel = (value) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (hex) => {
        const raw = hex.replace('#', '');
        const [r, g, blue] = [0, 2, 4].map(i => parseInt(raw.slice(i, i + 2), 16));
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(blue);
    };
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high + 0.05) / (low + 0.05);
}

/** 実測した地（`ComfyUI-Manager` のカードとページ・明るいテーマ・中間）。 */
const BACKGROUNDS = ['#2b2d31', '#1e1f22', '#ffffff', '#8a8f98'];

const fillsOf = (svg) => [...svg.matchAll(/fill="(#[0-9a-fA-F]{6})"/g)].map(m => m[1].toLowerCase());

test('カードの絵は、どの地に置いても形が読める', async () => {
    const svg = await readFile(join(ROOT, 'web/icon.svg'), 'utf8');

    /*
     * **板は階調を持つ。** 一色で見ると、明るい端で潰れているのを見逃す
     *（2026-08-29 実測: 白い卵は素焼きの明るい端で 5.36。一番明るい端が
     *  効くので、両端とも下限に掛ける）。
     */
    const plate = [...svg.matchAll(/stop-color="(#[0-9a-fA-F]{6})"/g)].map(m => m[1].toLowerCase());
    assert.ok(plate.length >= 2, '階調の定義が無い');
    /*
     * **定義だけでなく、塗っていることを見る。** 階調を定義したまま `<rect>` を
     * 落とすと、色は読めるのに**板は描かれない**——透過のまま置かれ、
     * 明るい地では白い卵ごと消える。定義と描画を別々に確かめる
     *（2026-08-29: 変異検査でここが緑のまま通った）。
     */
    const painted = /<rect[^>]*width="24"[^>]*height="24"[^>]*fill="url\(#[^)]+\)"/.test(svg);
    assert.ok(painted, '地の板を塗っていない（透過のまま置くと、明るい地で消える）');
    const egg = fillsOf(svg).find(color => !plate.includes(color));
    assert.ok(egg, '卵の色が板と同じ（形が出ない）');

    // **形が読める＝板と地・卵と地のどちらかが立っていればよい。**
    for (const background of BACKGROUNDS) {
        const readable = Math.max(
            ...plate.map(color => contrast(color, background)),
            contrast(egg, background),
        );
        assert.ok(readable >= 3,
            `${background} の上で ${readable.toFixed(2)}:1 しかない（3:1 を下回る）`);
    }
    // 卵と板の対比。**小さいときに形が潰れない**ための下限。階調の両端で見る。
    for (const color of plate) {
        assert.ok(contrast(color, egg) >= 4.5,
            `卵と板（${color}）の対比が ${contrast(color, egg).toFixed(2)}:1（小さいと潰れる）`);
    }
});

test('サイドバーの絵は、板を持たない（マスクとして当てるため）', async () => {
    // 板を足すと `mask-image` では**四角い塊**になる。カード用の直しを
    // こちらへ持ち込まないための見張り。
    const svg = await readFile(join(ROOT, 'web/icon-mask.svg'), 'utf8');
    assert.doesNotMatch(svg, /<rect/, 'マスク用の絵に板が入っている（四角い塊になる）');

    // **面が見ているのも同じファイル。** 名前を変えたのに CSS が古い方を
    // 指していると、印が丸ごと出なくなる（`mask-image` が 404 になる）。
    const css = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');
    assert.match(css, /mask-image:\s*url\("\.\.\/icon-mask\.svg"\)/,
        '面が指しているマスクが違う');
});

test('Registry が指しているのは、カード用の方', async () => {
    /*
     * **同じ物を指すと元へ戻る。** `icon.svg` を指していたのが今回の欠陥で、
     * しかも「サイドバーと同じ卵を指す」と**わざわざ書いてあった**
     * ——意図した上での間違いだったので、字で戻せてしまう。
     */
    const toml = await readFile(join(ROOT, 'pyproject.toml'), 'utf8');
    const icon = /^Icon\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
    assert.ok(icon, 'Icon の宣言が無い');
    /*
     * **指し先は動かせない。** Registry は提出時の値を保持していて、
     * `api.comfy.org/nodes/comfyui-unbake` が返す `icon` は
     * `.../web/icon.svg` のまま——**この宣言を直しても再提出まで反映されない**
     *（2026-08-29 に実測。別ファイルへ差し替えたのにカードが変わらなかった）。
     * だから**その URL が返す中身**をカード用にしてある。ここも同じ URL を指す。
     */
    assert.match(icon, /\/web\/icon\.svg$/, `Registry が持っている URL と違う: ${icon}`);
    // Registry は clone しない。**URL でなければ読めない。**
    assert.match(icon, /^https:\/\//, '相対パスでは Registry が読めない');
});

// --- そもそも読めるか -------------------------------------------------------

/**
 * **最低限の整形式検査。** 依存を入れずに、実際に踏んだ壊れ方を見る。
 *
 * 2026-08-29: コメントの中に `---`（区切り線のつもり）と `--unbake-accent`
 * を書いた。**XML はコメント内の `--` を禁じている**ので、SVG は読めない物に
 * なり、**Registry でアイコンが丸ごと消えた**。
 *
 * この検査が字面の照合しか持っていなかったのが穴だった——`<rect` が在るか、
 * 色が何か、は**壊れたファイルでも通る**。読めるかどうかを先に見る。
 */
function xmlProblems(svg) {
    const problems = [];
    for (const [, body] of svg.matchAll(/<!--([\s\S]*?)-->/g)) {
        if (body.includes('--')) problems.push('コメントの中に `--` がある（XML は許さない）');
        if (body.endsWith('-')) problems.push('コメントが `-` で終わっている');
    }
    // 開きと閉じの数。**自己終端は数えない。**
    const opens = [...svg.matchAll(/<([a-zA-Z][\w:-]*)(?=[\s/>])/g)]
        .filter(m => !svg.slice(m.index).startsWith('</'));
    const selfClosing = (svg.match(/\/>/g) || []).length;
    const closes = (svg.match(/<\/[a-zA-Z]/g) || []).length;
    if (opens.length !== selfClosing + closes) {
        problems.push(`開きと閉じが合わない（開き ${opens.length} / 自己終端 ${selfClosing} / 閉じ ${closes}）`);
    }
    if (!/^\s*<svg[\s>]/.test(svg)) problems.push('根が svg でない');
    return problems;
}

test('両方の絵が、そもそも読める形をしている', async () => {
    for (const name of ['web/icon.svg', 'web/icon-mask.svg']) {
        const svg = await readFile(join(ROOT, name), 'utf8');
        assert.deepEqual(xmlProblems(svg), [],
            `${name} が読めない: ${xmlProblems(svg).join(' / ')}`);
    }
});
