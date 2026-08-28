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
    const svg = await readFile(join(ROOT, 'web/icon-card.svg'), 'utf8');
    const plate = /<rect[^>]*fill="(#[0-9a-fA-F]{6})"/.exec(svg)?.[1];
    assert.ok(plate, '地の板が無い（透過のまま置くと、暗い地で沈む）');
    const egg = fillsOf(svg).find(color => color !== plate.toLowerCase());
    assert.ok(egg, '卵の色が板と同じ（形が出ない）');

    // **形が読める＝板と地・卵と地のどちらかが立っていればよい。**
    // 暗い地では板が、明るい地では卵が立つ、という組み合わせを選んである。
    for (const background of BACKGROUNDS) {
        const readable = Math.max(contrast(plate, background), contrast(egg, background));
        assert.ok(readable >= 3,
            `${background} の上で ${readable.toFixed(2)}:1 しかない（3:1 を下回る）`);
    }
    // 卵と板の対比。**小さいときに形が潰れない**ための下限。
    assert.ok(contrast(plate, egg) >= 4.5,
        `卵と板の対比が ${contrast(plate, egg).toFixed(2)}:1（小さいと潰れる）`);
});

test('サイドバーの絵は、板を持たない（マスクとして当てるため）', async () => {
    // 板を足すと `mask-image` では**四角い塊**になる。カード用の直しを
    // こちらへ持ち込まないための見張り。
    const svg = await readFile(join(ROOT, 'web/icon.svg'), 'utf8');
    assert.doesNotMatch(svg, /<rect/, 'マスク用の絵に板が入っている（四角い塊になる）');
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
    assert.match(icon, /icon-card\.svg$/, `カード用を指していない: ${icon}`);
    // Registry は clone しない。**URL でなければ読めない。**
    assert.match(icon, /^https:\/\//, '相対パスでは Registry が読めない');
});
