/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **1枚で見るときの基準側は、必ず絵を描ける箱にする**
 * （2026-08-31・監査 I-20260831-28）。
 *
 * `openCompare()` は `record.previewUrl` が無いと基準側を `<img>` ではなく
 * `<div data-state="none">·</div>` にする。これは**一覧の空欄と同じ正規の状態**で、
 * `list.preview.none` という文言まで用意されている。
 *
 * ところが `single: true` の経路（詳細の升目の拡大・「出た絵」タブ）は
 * `show()` で**基準側を差し替える**ので、差し替え先が `div` になり
 * `setAttribute('src', …)` が**何も描かない**。
 *
 * 実測: `previewUrl` を持たない記録の詳細を開き「出た絵」から2枚目を押すと、
 * 返るのは `{tag:'DIV', src:'/api/view?…', state:'none', text:'·'}`
 * ——**属性は正しく入っているのに絵が出ない**。字幕（`2 / 2 …`）だけ出るので、
 * 押した人には「出た絵が壊れている／消えている」に見える。
 *
 * `single` を渡さない経路は右側の `<img>` を使うので無傷——**同じ関数の中で
 * 片方だけ壊れている**形だった。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createUnbakePanel } from '../web/panel/panel.js';
import { fakeDocument } from './fake_dom.mjs';
import { resetMemoryStorage } from '../web/core/storage.js';
import { setLocale } from '../web/i18n/index.js';

const settle = () => new Promise(resolve => setTimeout(resolve, 10));

const OUTPUTS = [
    { filename: 'out_1.png', subfolder: '', url: '/api/view?filename=out_1.png', differenceLabel: 'one' },
    { filename: 'out_2.png', subfolder: '', url: '/api/view?filename=out_2.png', differenceLabel: 'two' },
];

/**
 * 詳細を開いて「出た絵」から1枚押す。
 *
 * **`openCompare` は外へ出ていない**ので、`single: true` を渡す実際の経路
 * （詳細の「出た絵」タブ）から到達する。人形の中だけで通る近道を作らない。
 */
async function openEnlarged(record) {
    setLocale('en');
    resetMemoryStorage();
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc,
        display: { listView: 'table' },
        loadRecord: async () => ({ id: record.id, gen_params: { seed: 1 } }),
        loadVariants: async () => ({ outputs: OUTPUTS }),
    });
    panel.setRecords([record]);
    await panel.openDetail(record, { tab: 'variants' });
    for (let i = 0; i < 10; i += 1) await settle();

    const thumbs = panel.root.findAll(node =>
        String(node.className || '').includes('unbake-variant-thumb')
        || String(node.className || '').includes('unbake-variant-image'));
    assert.ok(thumbs.length > 0,
        `出た絵の升目が出ていない（前提が崩れている）: ${thumbs.length}`);
    await thumbs[0].dispatch('click', {});
    await settle();
    return panel;
}

/** 拡大の面の、基準側の箱。 */
function baseBox(panel) {
    const shell = panel.root.find(node => String(node.className || '') === 'unbake-compare');
    if (!shell) return null;
    const walk = (node, out = []) => {
        out.push(node);
        for (const child of node.children || []) walk(child, out);
        return out;
    };
    return walk(shell).find(node =>
        String(node.className || '').includes('unbake-compare-image')) || null;
}

test('見本の絵を持たない記録でも、拡大した絵が描ける箱に入る', async () => {
    const panel = await openEnlarged({ id: 'r', title: 'R', libraryId: 'r' });   // previewUrl 無し
    const box = baseBox(panel);
    assert.ok(box, '拡大の面が出ていない');
    assert.equal(box.tagName, 'IMG',
        `絵を描けない箱に src を書いている: ${box.tagName}（属性は入るが何も映らない）`);
    assert.match(String(box.getAttribute('src') || ''), /out_1\.png/, '基準側に絵が入っていない');
});

test('対照: 見本の絵を持つ記録は今までどおり', async () => {
    const panel = await openEnlarged({
        id: 'r', title: 'R', libraryId: 'r', previewUrl: '/api/view?filename=prev.png',
    });
    const box = baseBox(panel);
    assert.equal(box?.tagName, 'IMG');
    assert.match(String(box.getAttribute('src') || ''), /out_1\.png/);
});
