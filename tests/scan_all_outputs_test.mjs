/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **走査の周回**（`I-20260830-14`）。
 *
 * サーバは要求した幅ぶんのファイルを開くが、**読めなかった PNG は落として返す**。
 * 呼び手が「返った件数」で進めると、落ちた枚数だけ次ページが手前から始まり
 * **同じ絵を二度数える**（一覧に同じ画像が並び、枚数も水増しされる）。
 * さらに 0件を「終わり」と読むと、**1ページ全滅で残り全部を切り捨てる**。
 *
 * ここは `unbake.js` の閉じた中に在って**外から検査できなかった**ので、
 * 切り出した。見本は「短いページ」「全滅ページ」を必ず作る——作れない見本では
 * この2つの壊れ方を1つも観測できない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanAllOutputs } from '../web/core/scanAllOutputs.js';

/**
 * 偽の走査口。`unreadable` に挙げた添字のファイルは**返さない**（読めなかった分）。
 * サーバと同じく `nextOffset` は**消費した幅**で返す。
 */
function fakeScan(total, { unreadable = new Set(), omitNextOffset = false } = {}) {
    const calls = [];
    const all = Array.from({ length: total }, (_, i) => ({ filename: `f${i}.png`, subfolder: '' }));
    const scan = async ({ offset, limit }) => {
        calls.push({ offset, limit });
        const window = all.slice(offset, offset + limit);
        const rows = window.filter((_, i) => !unreadable.has(offset + i));
        return {
            reachable: true, total, offset,
            ...(omitNextOffset ? {} : { nextOffset: offset + window.length }),
            outputs: rows,
        };
    };
    return { scan, calls };
}

const names = (r) => r.outputs.map(o => o.filename);

test('読める分だけの素直な走査（前提）', async () => {
    const { scan, calls } = fakeScan(12);
    const got = await scanAllOutputs(scan, { limit: 5 });
    assert.equal(got.outputs.length, 12);
    assert.equal(new Set(names(got)).size, 12, '重複が出ている');
    assert.deepEqual(calls.map(c => c.offset), [0, 5, 10]);
});

test('読めない絵が混ざっても、同じ絵を二度数えない', async () => {
    // 1ページ目（0..4）のうち 2件が読めない。**返るのは3件**。
    const { scan, calls } = fakeScan(12, { unreadable: new Set([1, 3]) });
    const got = await scanAllOutputs(scan, { limit: 5 });
    assert.deepEqual(calls.map(c => c.offset), [0, 5, 10],
        `ページ送りが手前へ戻っている: ${JSON.stringify(calls.map(c => c.offset))}`);
    assert.equal(new Set(names(got)).size, got.outputs.length, '同じ絵を二度数えている');
    assert.equal(got.outputs.length, 10, '読めた枚数が合わない');
});

test('1ページが全滅しても、残りを切り捨てない', async () => {
    // 2ページ目（5..9）が丸ごと読めない。
    const { scan } = fakeScan(12, { unreadable: new Set([5, 6, 7, 8, 9]) });
    const got = await scanAllOutputs(scan, { limit: 5 });
    assert.equal(got.outputs.length, 7, `残りを切り捨てている: ${got.outputs.length}件`);
    assert.ok(names(got).includes('f11.png'), '最後のページまで届いていない');
});

test('[対照] 進まなくなったら止まる（無限に回さない）', async () => {
    const scan = async ({ offset }) => ({ reachable: true, total: 100, offset, nextOffset: offset, outputs: [] });
    const got = await scanAllOutputs(scan, { limit: 5 });
    assert.equal(got.stoppedBy, 'no-progress');
    assert.ok(got.pages < 5, `回りすぎている: ${got.pages}ページ`);
});

test('[対照] 届かなければ、そう言う（0件と混ぜない）', async () => {
    const got = await scanAllOutputs(async () => ({ reachable: false }), { limit: 5 });
    assert.equal(got.reachable, false);
    assert.equal(got.stoppedBy, 'unreachable');
    assert.deepEqual(got.outputs, []);
});

test('周回の上限で必ず止まる', async () => {
    const scan = async ({ offset }) => ({
        reachable: true, total: 1e9, offset, nextOffset: offset + 1,
        outputs: [{ filename: `x${offset}.png`, subfolder: '' }],
    });
    const got = await scanAllOutputs(scan, { limit: 1, maxPages: 4 });
    assert.equal(got.pages, 4);
    assert.equal(got.stoppedBy, 'max-pages');
});

test('nextOffset を返さないサーバでも止まる（従来の進め方へ落ちる）', async () => {
    const { scan } = fakeScan(7, { omitNextOffset: true });
    const got = await scanAllOutputs(scan, { limit: 3 });
    assert.equal(got.outputs.length, 7);
});

test('サーバが消費した幅を返している（読む側と書く側の対）', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    const source = fs.readFileSync(path.join(root, 'unbake/outputs.py'), 'utf8');
    assert.match(source, /"nextOffset":\s*start \+ len\(window\)/,
        'サーバが消費した幅を返していない（読む側だけ直しても重なりは消えない）');
});
