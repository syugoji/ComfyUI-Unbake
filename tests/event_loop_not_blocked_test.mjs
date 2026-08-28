/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **重い処理を ComfyUI 本体のイベントループの上で走らせない**（`D-20260828-01` 群D）。
 *
 * `aiohttp` のハンドラは本体と同じループで走る。同期の重い処理をその上で回すと、
 * **その間すべての HTTP が返らない**——`/prompt` も進捗の WebSocket もキュー表示も
 * 止まる。利用者からは「ComfyUI が固まった」に見えるので、原因が拡張だと分からない。
 *
 * 実測（4,851枚の出力）:
 *   `/unbake/outputs`（記録指定なし） → `scan_outputs` で **約45秒**
 *   `/unbake/records` 初回          → `model_index.build()` で **5〜6秒**
 *
 * `routes.py` は既に7箇所で `asyncio.to_thread` を使っている。**重い口だけが
 * 素通しだった**ので、ここで機械に見張らせる——同じ形の再発を止めるのが目的で、
 * 個別の2箇所を直すことではない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * **同期で重いと分かっている呼び出し。** ディスクを歩く・索引を組む・
 * 何千件の `stat` を取るもの。ここに足したものは `to_thread` 越しでしか呼べない。
 */
const HEAVY = ['list_records', 'scan_outputs', 'record_outputs'];

const handlersOf = (source) => {
    // `@routes.<method>(...)` の直後の `async def` から、次の装飾子までを1つの塊とする。
    const blocks = [];
    const lines = source.split('\n');
    let current = null;
    for (const line of lines) {
        if (/^\s*@routes\.(get|post|delete|put)\(/.test(line)) {
            if (current) blocks.push(current);
            current = { head: line.trim(), body: [] };
            continue;
        }
        if (current) current.body.push(line);
    }
    if (current) blocks.push(current);
    return blocks;
};

test('重い呼び出しは、口の中から直に呼ばれていない', async () => {
    const source = await readFile(join(ROOT, 'unbake/routes.py'), 'utf8');
    const offenders = [];
    for (const block of handlersOf(source)) {
        const body = block.body.join('\n');
        for (const name of HEAVY) {
            // `to_thread(name, ...)` は関数を**渡している**だけなので直呼びではない。
            const direct = new RegExp(`(?<!to_thread\\(\\s*)\\b${name}\\s*\\(`);
            const viaThread = new RegExp(`to_thread\\(\\s*${name}\\b`);
            if (direct.test(body) && !viaThread.test(body)) {
                offenders.push(`${block.head} → ${name}(...)`);
            }
        }
    }
    assert.deepEqual(offenders, [],
        `本体のループの上で重い処理を走らせている:\n  ${offenders.join('\n  ')}`);
});

test('出力の数え直しは、既定では走らない', async () => {
    /*
     * 数え直しは出力フォルダ全体を歩いて全ファイルの更新時刻を取る
     *（実測 4,851枚で初回 2,891ms・差分でも 187ms）。既定で走ると
     * **再現を押すたび・Sweep を始めるたび**にその代金を払う。
     */
    const source = await readFile(join(ROOT, 'unbake/routes.py'), 'utf8');
    assert.ok(/refresh=request\.query\.get\("refresh"\)\s*==\s*"1"/.test(source),
        '既定で数え直している（`!= "0"` は「付けなければ真」）');

    // 頼む側は明示する。**既定を変えただけで呼び手を直さないと、
    // 出たばかりの絵が見つからなくなる**（数え直さないので索引に無い）。
    const host = await readFile(join(ROOT, 'web/host/comfyHost.js'), 'utf8');
    assert.ok(/listRecordOutputs\(recordId,\s*\{\s*refresh\s*=\s*false/.test(host),
        '口が `refresh` を受け取らない');
    const app = await readFile(join(ROOT, 'web/unbake.js'), 'utf8');
    const asked = [...app.matchAll(/listRecordOutputs\([^)]*refresh:\s*true/g)].length;
    assert.equal(asked, 2,
        `明示的に数え直す呼び手が 2 でない: ${asked}（再現の直後と Sweep の開始時）`);
});
