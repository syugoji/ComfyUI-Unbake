/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **絞り込みも、面が2つあると相手の分を巻き戻していた**（`I-20260830-32`）。
 *
 * ★の名簿（`I-20260830-11`）と**同じ形の穴**。除外の理由は「面の中の絞り込み帯が
 * 持ち、押した時点で効く」だったが、それは**押した面についてしか言っていない**。
 * `persistFilters()` は4つを**まとめて**送るので、実測（2026-08-31）で:
 *
 *   1. サイドバーで ★ の絞り込みを入れる → サーバは `favorites_only: true`
 *   2. 全画面はその報せを受けないので、古い `false` を持ったまま
 *   3. 全画面で**別の**チップを1つ押す → 4つまとめて送るので
 *      **`favorites_only: false` が上書きされ、1 の操作が消える**
 *
 * 押した本人の画面では正常に見え、エラーも記録も出ない。
 *
 * ## なぜ既存の検査が素通りしたか
 *
 * 面を2つ起こす対が無く、`APPLY_EXEMPT` に理由つきで除外されていた
 * ——**理由の文が、もう一方の面について何も言っていない**ことは機械には見えない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createUnbakePanel } from '../web/panel/panel.js';
import { fakeDocument } from './fake_dom.mjs';

const RECORDS = [
    { id: 'a', libraryId: 'a', title: 'A', verdict: 'reproducible' },
    { id: 'b', libraryId: 'b', title: 'B', verdict: 'approximate' },
];

/** 面を2つ起こし、**本番の `settingsIo.write` と同じ形**で控えへ繋ぐ。 */
function twoPanels() {
    const server = {};
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
            display: { listView: 'table', ...server },
            settingsIo: { write },
        });
        panel.setRecords(RECORDS);
        panels.push(panel);
        return panel;
    };
    return { server, mount, panels };
}

/** 絞り込みのチップ。**押すのは口であって、内側の関数ではない。** */
const chipOf = (panel, cls) => {
    const found = panel.root.allByClass(cls).find(n => String(n.className).includes(cls));
    if (!found) throw new Error(`チップが見つからない: ${cls}`);
    return found;
};

test('前提: ★の絞り込みを押すとサーバへ届く', async () => {
    const { server, mount } = twoPanels();
    const one = mount();
    await chipOf(one, 'unbake-chip-favorite').dispatch('click', {});
    assert.equal(server.favorites_only, true,
        `押しても届いていない: ${JSON.stringify(server)}`);
});

test('後から開いた面にも、絞り込みが載る', async () => {
    const { mount } = twoPanels();
    const one = mount();
    await chipOf(one, 'unbake-chip-favorite').dispatch('click', {});
    const two = mount();
    assert.equal(chipOf(two, 'unbake-chip-favorite').getAttribute('data-on'), 'true',
        '2面目が古い絞り込みを持っている');
});

test('2面目が別の絞り込みを触っても、1面目の分を巻き戻さない', async () => {
    const { server, mount, panels } = twoPanels();
    const one = mount();
    const two = mount();

    await chipOf(one, 'unbake-chip-favorite').dispatch('click', {});
    assert.equal(server.favorites_only, true, '前提: 1面目の操作が届いている');

    // **別のチップ**を2面目で押す（4つまとめて送られる経路）。
    const other = panels[1].root.allByClass('unbake-chip')
        .filter(n => String(n.className).includes('unbake-chip'))
        .find(n => !String(n.className).includes('unbake-chip-favorite'));
    assert.ok(other, '前提: 別のチップが在る');
    await other.dispatch('click', {});

    assert.equal(server.favorites_only, true,
        `2面目の操作が1面目の絞り込みを巻き戻している: ${JSON.stringify(server)}`);
});

test('[対照] 触った当の絞り込みは、ちゃんと変わる', async () => {
    // 巻き戻さないことだけを見ると、「何も書かない」実装でも緑になる。
    const { server, mount } = twoPanels();
    const one = mount();
    await chipOf(one, 'unbake-chip-favorite').dispatch('click', {});
    assert.equal(server.favorites_only, true);
    await chipOf(one, 'unbake-chip-favorite').dispatch('click', {});
    assert.equal(server.favorites_only, false, '押し直しても戻らない（書けていない）');
});

test('[対照] 面が1つでも、絞り込みは効く', async () => {
    const { server, mount } = twoPanels();
    const one = mount();
    await chipOf(one, 'unbake-chip-favorite').dispatch('click', {});
    assert.equal(server.favorites_only, true);
    assert.equal(chipOf(one, 'unbake-chip-favorite').getAttribute('data-on'), 'true',
        '押した面の見た目が変わっていない');
});
