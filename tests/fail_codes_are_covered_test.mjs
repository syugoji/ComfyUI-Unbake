/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **サーバが返す印を、画面が1つ残らず知っていること**（`I-20260831-70`・2026-09-01）。
 *
 * `FAIL_CODES[code] || FAIL_CODES.unknown` は**落ちても赤くならない**——
 * 印を足しても画面は動き続け、ただ「理由が判りません（英語の原文）」と出る。
 * **知っている理由を「判りません」と言い、しかも訳していない文字が混ざる。**
 *
 * 実際にそうなっていた: `routes.py` の `busy`（同時に落とせる数の上限。打つ手は
 * 「待つ」）が一覧に無く、`too many downloads at once` がそのまま `{detail}` に
 * 出ていた。**これは「一覧に手で書いた」型の欠陥**で、このパッケージでは
 * `I-20260831-34`（落とせるのに消せない）・`I-20260831-75`（落とせるが消せない）と
 * 同じ形である——**片側だけ足して、もう片側が取り残される。**
 *
 * ここは3つを突き合わせる:
 *   1. `download.py` の `DownloadError` docstring が書いている印の一覧
 *   2. `DownloadError(..., "印")` と `routes.py` の `"code": "印"` の実引数
 *   3. `panel.js` の `FAIL_CODES` と `en.js` の鍵
 *
 * **除外は注記が持つ。** 「失敗ではない」と書かれた印（`already` / `canceled`）は
 * 画面の失敗欄に出ないので対象外——**この検査に除外一覧を書かない**
 * （書くと、除外一覧のほうが腐って誰も気づかない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const read = name => readFile(join(ROOT, name), 'utf8');

/** `DownloadError` の docstring が並べている印と、その説明。 */
function documentedCodes(python) {
    const start = python.indexOf('class DownloadError');
    assert.ok(start >= 0, 'DownloadError が見つからない');
    const body = python.slice(start, python.indexOf('def __init__', start));
    const found = new Map();
    for (const line of body.split('\n')) {
        const hit = /^\s*``([a-z_]+)``\s*…\s*(.*)$/.exec(line);
        if (hit) found.set(hit[1], hit[2]);
    }
    return found;
}

/** 実際に投げられている／返されている印。**注記は数えない。** */
function raisedCodes(sources) {
    const codes = new Set();
    for (const text of sources) {
        const code = text
            .replace(/"""[\s\S]*?"""/g, ' ')
            .replace(/^\s*#.*$/gm, ' ');
        for (const hit of code.matchAll(/DownloadError\([^)]*,\s*"([a-z_]+)"/g)) {
            codes.add(hit[1]);
        }
        for (const hit of code.matchAll(/"code":\s*"([a-z_]+)"/g)) {
            codes.add(hit[1]);
        }
    }
    return codes;
}

test('投げている印は、全部 docstring に書いてある', async () => {
    const download = await read('unbake/download.py');
    const documented = documentedCodes(download);
    const raised = raisedCodes([download]);
    const undocumented = [...raised].filter(code => !documented.has(code));
    assert.deepEqual(undocumented, [],
        `download.py が投げるのに docstring に無い印: ${undocumented.join(', ')}`);
    assert.ok(documented.size >= 8, `一覧が痩せている（${documented.size}）`);
});

test('画面が知らない印が無い（失敗ではない印を除く）', async () => {
    const [download, routes, panel, en] = await Promise.all([
        read('unbake/download.py'), read('unbake/routes.py'),
        read('web/panel/panel.js'), read('web/i18n/locales/en.js'),
    ]);

    const documented = documentedCodes(download);
    // **除外は注記が決める。** `already` / `canceled` は「失敗ではない」と
    // 書いてあるので失敗欄に出ない。ここに名前を書かない。
    const failures = new Set(
        [...documented].filter(([, why]) => !why.includes('失敗ではない')).map(([code]) => code));
    assert.ok(failures.size >= 6, `失敗の印が少なすぎる（${failures.size}）`);

    // `routes.py` は download.py を通さずに直接返す印を持つ（`busy` / `downloading` /
    // `unexpected`）。**同じ応答の形で画面の同じ所へ出る**ので、一緒に数える。
    for (const code of raisedCodes([routes])) failures.add(code);

    const mapBody = /const FAIL_CODES\s*=\s*\{([\s\S]*?)\n\};/.exec(panel)?.[1] || '';
    assert.ok(mapBody, 'FAIL_CODES を拾えていない');
    const mapped = new Map(
        [...mapBody.replace(/^\s*\/\/.*$/gm, ' ')
            .matchAll(/(?:^|\s)([a-z_]+)\s*:\s*'([^']+)'/gm)].map(hit => [hit[1], hit[2]]));

    const missing = [...failures].filter(code => !mapped.has(code));
    assert.deepEqual(missing, [],
        '画面が知らない印がある。**`unknown` へ黙って落ちる**ので、'
        + '知っている理由を「判りません」と言い、サーバの英語が {detail} に出る:\n  '
        + missing.join('\n  '));

    // 対応づけた鍵が**実在**すること。綴り違いは `[download.fail.busy]` と
    // 出るだけで、これも赤くならない。
    const absent = [...mapped.values()].filter(key => !en.includes(`"${key}"`));
    assert.deepEqual([...new Set(absent)], [],
        `en.js に無い鍵へ対応づけている: ${absent.join(', ')}`);
});

test('並び順が印を取りこぼさない', async () => {
    const panel = await read('web/panel/panel.js');
    const mapBody = /const FAIL_CODES\s*=\s*\{([\s\S]*?)\n\};/.exec(panel)?.[1] || '';
    const mapped = [...mapBody.replace(/^\s*\/\/.*$/gm, ' ')
        .matchAll(/(?:^|\s)([a-z_]+)\s*:/gm)].map(hit => hit[1]);
    const orderBody = /const FAIL_ORDER\s*=\s*\[([\s\S]*?)\];/.exec(panel)?.[1] || '';
    assert.ok(orderBody, 'FAIL_ORDER を拾えていない');
    const order = [...orderBody.matchAll(/'([a-z_]+)'/g)].map(hit => hit[1]);

    // **`FAIL_ORDER` は絞り込みの並びを決める**（`panel.js` の `findIndex`）。
    // 載っていない印は `-1` になり、**並びの先頭より前**に置かれる。
    // `downloading` は失敗ではないので除く——`FAIL_CODES` には在るが失敗欄に出ない。
    const expected = mapped.filter(code => code !== 'downloading' && code !== 'unexpected');
    const missing = expected.filter(code => !order.includes(code));
    assert.deepEqual(missing, [],
        `FAIL_ORDER に無い印: ${missing.join(', ')}（findIndex が -1 を返す）`);
});
