/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **再生の口が小さくて狙いにくい**（2026-08-27 利用者の指摘）。
 *
 * 実測（127.0.0.1:8188・タイル1枚 217px）: 一覧のタイルに載る口は
 * **▶ ⇱ 🗑 ☆ の4つが全部 28×28px**。利用者の画面は**表示 80%** なので
 * 実寸 **22.4px** で、マウスで狙う的の下限とされる 24px を割っていた。
 *
 * **大きくするのは ▶ だけ。** 4つ全部を大きくすると横に入らない
 * ——一番狭い枠（`data-size="4"` の 155px）では、今でも 28×4＋隙間で
 * 内側 141px をほぼ使い切っている。実測でも 155px の枠では
 * ▶ が 28.8px まで自分で縮んで収まり、他の口は 28px のままだった。
 *
 * ここが見張るのは**4つの性質**で、どれも外すと実害が出る:
 *
 *   1. **▶ はこの列で一番大きい**（外すと元の 22.4px へ戻る）
 *   2. **▶ だけが縮める**（外すと狭い枠で他の口を枠の外へ押し出す）
 *   3. **広げた的は上下だけ**（横へ広げると隣の口——🗑 を含む——を食う）
 *   4. **広げた的の基準が ▶ 自身にある**（無いと押せる範囲が別の場所に出る）
 *
 * **数字を直に見張らない。** 「28 であること」ではなく
 * 「**共有の大きさより大きいこと**」を見る——共有側を変えた日に
 * この検査が黙って的外れにならないため。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');

/**
 * 選択子ちょうど1つぶんの宣言を、`{名前: 値}` で返す。
 *
 * **正規表現へ組み立てない。** 選択子には `.` `[` `"` `:` が混じるので、
 * 逃がし損ねると**別の規則を掴んだまま緑になる**。素の文字列で探し、
 * **行頭から**合わせる（`.unbake-act-replay` で探すと
 * `.unbake-tile-actions .unbake-act-replay` まで掴む）。
 *
 * @param {string} selector
 * @returns {Record<string, string>}
 */
function rule(selector) {
    // 前が改行であることを、改行そのものを書いて要求する（逃がし文字を使わない）。
    const head = `
${selector} {`;
    const at = css.indexOf(head);
    assert.notEqual(at, -1, `規則が見つからない（改名を見逃している）: ${selector}`);
    assert.equal(css.indexOf(head, at + 1), -1,
        `同じ選択子が2度書かれている（どちらを見張っているのか決まらない）: ${selector}`);
    const open = at + head.length;
    const close = css.indexOf('}', open);
    assert.ok(close > open, `規則が閉じていない: ${selector}`);
    /*
     * **注記を先に落とす。** この面の CSS は理由を長く書いてあるので、
     * 落とさずに `;` で割ると**注記と次の宣言が1つに繋がり**、名前が
     * 汚れて弾かれる——**見張っているつもりの宣言が丸ごと読めなくなる**
     * （実際そうなって、6件中4件が「無い」と言って落ちた）。
     */
    let body = css.slice(open, close);
    for (;;) {
        const from = body.indexOf('/*');
        if (from === -1) break;
        const to = body.indexOf('*/', from);
        if (to === -1) break;
        body = body.slice(0, from) + body.slice(to + 2);
    }
    const out = {};
    for (const piece of body.split(';')) {
        const colon = piece.indexOf(':');
        if (colon === -1) continue;
        const name = piece.slice(0, colon).trim();
        if (!name || name.includes(' ')) continue;
        out[name] = piece.slice(colon + 1).trim();
    }
    return out;
}

/** `28px` のような値を数で返す。無ければ null。 */
function px(decls, prop) {
    const raw = decls[prop];
    if (raw === undefined) return null;
    const num = Number.parseFloat(raw);
    return Number.isFinite(num) ? num : null;
}

const SHARED = rule('.unbake-tile-actions .unbake-act');
const REPLAY = rule('.unbake-tile-actions .unbake-act.unbake-act-replay');
const HIT = rule('.unbake-tile-actions .unbake-act-replay::after');
const BASE = rule('.unbake-act-replay');

test('タイルの ▶ は、並びの共有の大きさより大きい', () => {
    const shared = px(SHARED, 'inline-size');
    const mine = px(REPLAY, 'inline-size');
    assert.ok(shared, '共有の横幅が読めない（この検査が空振りしている）');
    assert.ok(mine, '▶ に横幅が無い（共有の 28px のままになる）');
    assert.ok(mine > shared,
        `▶ が他の口と同じ大きさ（${mine}px ≦ ${shared}px）。狙いにくさが戻る`);
    const mineH = px(REPLAY, 'block-size');
    const sharedH = px(SHARED, 'block-size');
    assert.ok(mineH > sharedH, `▶ の高さが増えていない（${mineH}px ≦ ${sharedH}px）`);
});

test('狭い枠では ▶ が自分で縮む（他の口を押し出さない）', () => {
    // 実測: 枠 170px → ▶ 43.6px ／ 155px → 28.8px ／ 140px → 28px。
    // どの幅でも、並びの最後の口はタイルの中に収まっていた。
    const flex = REPLAY.flex || '';
    assert.ok(/^0\s+1(\s|$)/.test(flex),
        `▶ が縮めない（flex: ${flex}）。狭い枠で列が溢れ、☆ や 🗑 が枠の外へ出る`);
    assert.equal(px(REPLAY, 'min-inline-size'), px(SHARED, 'inline-size'),
        '縮んだときの下限が共有の大きさと違う（潰れるか、溢れるかのどちらか）');
});

test('縮むのは ▶ だけ（他の口は 28px を割らない）', () => {
    const flex = SHARED.flex || '';
    assert.ok(/^0\s+0(\s|$)/.test(flex),
        `他の口も縮む（flex: ${flex}）。▶ を広げたぶんが全員から少しずつ削られる`);
});

test('広げた的は上下だけで、隣の口を食わない', () => {
    // **横は 0 を要求する。** 実測では ▶ の右 6px の位置は ⇱ が取っていた
    // ——ここを負にすると、その 6px が ▶ へ移る（左は選ぶ口）。
    assert.equal(HIT['inset-inline'], '0',
        `的を横へ広げている（inset-inline: ${HIT['inset-inline']}）。隣の口の面積を奪う`);
    const top = px(HIT, 'inset-block-start');
    const bottom = px(HIT, 'inset-block-end');
    assert.ok(top < 0 && bottom < 0,
        `上下へ広げていない（${top} / ${bottom}）。的が見た目のままで、指摘が直らない`);
});

test('広げた的の基準が ▶ 自身にある', () => {
    // `position: relative` が無いと `::after` は**もっと外側の器**を基準に置かれ、
    // 押せる範囲がボタンと無関係な場所に出る（何も見えないので気づけない）。
    assert.equal(BASE.position, 'relative',
        '▶ が位置の基準になっていない。広げた的がボタンから外れる');
});

test('表の行の ▶ も広げてある', () => {
    // タイルと同じ「印1文字ぶん」の的だったので、同じ指摘がそのまま出ていた。
    // 実測: 27px 前後 → 41.6px。
    const pad = px(BASE, 'padding-inline');
    assert.ok(pad !== null && pad >= 12,
        `表の行の ▶ が広がっていない（padding-inline: ${pad}px）`);
});
