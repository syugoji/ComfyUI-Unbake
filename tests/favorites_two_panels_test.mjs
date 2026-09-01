/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **面が2つ開いていても、★の名簿が消えないこと**（`I-20260830-11`）。
 *
 * お気に入りだけが `settingsIo.write` を通らず、サーバへ直書きされていた。
 * `settingsIo.write` の後始末（共有の控えを更新し、開いている面すべてへ配る）を
 * 通らないため、こうなる:
 *
 *   1. サイドバーで a に ★ → サーバには入るが、共有の控えは古いまま
 *   2. 全画面を開く → 古い控えを読むので a は ☆、外したはずの上流の印が復活
 *   3. 全画面で b に ★ → **その面の名簿全体**が送られ、1 の変更が
 *      サーバから消える
 *
 * 押した本人の画面では正常に見え、エラーも記録も出ない。名簿は実測128件規模。
 *
 * ## なぜ既存の検査が素通りしたか
 *
 * `grep -rn favoritesIo tests/` = **0件**。`display_policy_test.mjs` の
 * `APPLY_EXEMPT` は `favoriteIds` を「押した面がその場で描き直す」を理由に
 * 除外していた——**押した面については正しいが、もう一方の面については
 * 何も言っていない**。除外を外したので、以後はあの構造検査も見張る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createUnbakePanel } from '../web/panel/panel.js';
import { fakeDocument } from './fake_dom.mjs';

const RECORDS = [
    { id: 'a', libraryId: 'a', title: 'A' },
    { id: 'b', libraryId: 'b', title: 'B' },
];

/**
 * 面を2つ起こし、**書き手を1本の控えへ繋ぐ**（本番の `settingsIo.write` と同じ形
 * ——保存したら控えを更新し、開いている面すべてへ配る）。
 */
function twoPanels() {
    const server = { favorite_ids: [], unfavorite_ids: [] };
    const panels = [];
    const write = async (patch) => {
        Object.assign(server, patch);
        for (const panel of panels) panel.applyDisplay?.(patch);
        return { settings: { ...server } };
    };
    const mount = () => {
        const doc = fakeDocument();
        const panel = createUnbakePanel(doc.createElement('div'), {
            documentRef: doc,
            display: {
                listView: 'table',
                favoriteIds: [...server.favorite_ids],
                unfavoriteIds: [...server.unfavorite_ids],
            },
            favoritesIo: { write },
        });
        panel.setRecords(RECORDS);
        panels.push(panel);
        return panel;
    };
    return { server, mount, panels };
}

/**
 * ★の釦を押す。**面の内側の関数を呼ばない**——`toggleFavorite` は外へ出ておらず、
 * `panel.toggleFavorite?.()` は optional chaining で**黙って何もしない**
 * （最初この形で書いて、検査が空振りしているのに緑に見えた）。
 */
function pressStar(panel, id) {
    const buttons = panel.root.allByClass('unbake-act-favorite');
    const target = buttons.find(node => {
        const label = String(node.getAttribute?.('aria-label') || node.title || '');
        return label.includes(id) || node.dataset?.id === id;
    }) || buttons[Number(id === 'b')];
    if (!target) throw new Error(`★の釦が見つからない (id=${id}, 候補 ${buttons.length}件)`);
    target.dispatch('click', {});
    return target;
}

test('片方で付けた★が、後から開いた面にも載る', async () => {
    const { mount, server } = twoPanels();
    const first = mount();
    pressStar(first, 'a');
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(server.favorite_ids, ['a'], '前提: サーバへ入っていること');

    const second = mount();
    assert.ok(second, '2枚目が起きていない');
    // 2枚目は**保存された名簿**を持って起きる。
    assert.deepEqual(server.favorite_ids, ['a'], '2枚目を開いただけで名簿が変わった');
});

test('後から開いた面で1つ付けても、前の面の★が消えない', async () => {
    const { mount, server } = twoPanels();
    const first = mount();
    pressStar(first, 'a');
    await new Promise(r => setTimeout(r, 0));

    const second = mount();
    pressStar(second, 'b');
    await new Promise(r => setTimeout(r, 0));

    assert.deepEqual([...server.favorite_ids].sort(), ['a', 'b'],
        `2枚目の書き込みで1枚目の★が消えた: ${JSON.stringify(server.favorite_ids)}`);
});

test('配られた名簿が、もう一方の面の★の見た目まで変える', async () => {
    const { mount } = twoPanels();
    const first = mount();
    const second = mount();
    const starBefore = second.root.allByClass('unbake-act-favorite')[0];
    assert.equal(starBefore.getAttribute('data-on'), 'false', '前提: 最初は☆');

    pressStar(first, 'a');
    await new Promise(r => setTimeout(r, 0));

    // **描き直した後の節を取り直す。** 前の節を握ったままだと、
    // 描き直しで捨てられた古い節を見て「変わっていない」と誤判定する。
    const starAfter = second.root.allByClass('unbake-act-favorite')[0];
    assert.equal(starAfter.getAttribute('data-on'), 'true',
        'もう一方の面へ配られていない（applyDisplay が名簿を見ていない）');
});

test('★の書き込みが、設定と同じ口を通る（経路そのもの）', async () => {
    /*
     * **ここだけは振る舞いでは測れない。** 経路を決めているのは `unbake.js` で、
     * 面から見ると `favoritesIo.write` という同じ1つの口に見える。検査の見本が
     * 「保存したら配る」書き手を渡してしまうと、**見本が直しの仕事を肩代わりして**
     * 経路が元のままでも緑になる（最初この形で書いた）。
     *
     * だから経路は原文で見る。`writeUnbakeSettings` を直に呼んでいたら赤くする。
     */
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    const entry = fs.readFileSync(path.join(root, 'web/unbake.js'), 'utf8');
    const line = /favoritesIo:\s*\{[^}]*\}/.exec(entry)?.[0] || '';
    assert.ok(line, 'favoritesIo が見つからない');
    assert.match(line, /settingsIo\.write/,
        '★だけが別経路で書いている（控えの更新と配り直しを通らない）');
    assert.doesNotMatch(line, /writeUnbakeSettings/,
        '★がサーバへ直書きしている');
});

test('[対照] 何も押さなければ、名簿は空のまま', async () => {
    const { mount, server } = twoPanels();
    mount();
    mount();
    assert.deepEqual(server.favorite_ids, [], '開いただけで名簿が動いた');
});
test('上流の★を打ち消した名簿も配られる', () => {
    // `unfavorite_ids` は「向こうが立てている印を、こちらで打ち消す」名簿。
    // 配らないと、もう一方の面では**外したはずの★が復活したまま**になる。
    const server = { favorite_ids: [], unfavorite_ids: [] };
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc,
        display: { listView: 'table', favoriteIds: [], unfavoriteIds: [] },
        favoritesIo: { write: async () => ({ settings: { ...server } }) },
    });
    // **上流が★を立てている記録**（`favorite: true`）。
    panel.setRecords([{ id: 'a', libraryId: 'a', title: 'A', favorite: true }]);
    assert.equal(panel.root.allByClass('unbake-act-favorite')[0].getAttribute('data-on'), 'true',
        '前提: 上流の★が出ていること');

    panel.applyDisplay({ favorite_ids: [], unfavorite_ids: ['a'] });
    assert.equal(panel.root.allByClass('unbake-act-favorite')[0].getAttribute('data-on'), 'false',
        '打ち消しの名簿が配られていない（外したはずの★が残る）');
});
