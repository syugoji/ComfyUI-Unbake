/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 落とし込んだファイルの絵を、記録の隣へ残す（2026-08-23 利用者の指示）。
 *
 * **サーバは手が届かない。** 取りに行けるのは `http(s)` の URL だけで、
 * ブラウザが抱えているバイト列には届かない——だから一覧で絵が出るのは
 * civitai 由来の記録だけ、という状態だった。
 *
 * ここで固定するのは、渡す側で壊れうるところ:
 *
 *  1. 大きい画像で**呼び出しの上限**に当たって落ちない
 *  2. 上限を越えたら**添えないが記録は残す**（黙って落とさない）
 *  3. 記録の JSON へ**焼き込まない**（数MBの文字列が入って読むたびに解かれる）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_PREVIEW_BYTES, recordSaveBody, toDataUrl } from '../web/unbake.js';

const PNG_HEAD = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

test('バイト列を data: へ直す', () => {
    const url = toDataUrl(new Uint8Array([...PNG_HEAD, 1, 2, 3, 4]));
    assert.match(url, /^data:image\/png;base64,/);
    // 直したものを戻すと元のバイト列。
    const back = Buffer.from(url.split('base64,')[1], 'base64');
    assert.deepEqual([...back.subarray(0, 8)], PNG_HEAD);
});

test('大きい画像でも落ちない（引数を全部積まない）', () => {
    // **`String.fromCharCode(...bytes)` は数MBで呼び出しの上限を越える。**
    // 塊で回していないと、ここが `RangeError` で落ちる。
    const big = new Uint8Array(3 * 1024 * 1024);
    big.set(PNG_HEAD);
    const url = toDataUrl(big);
    assert.match(url, /^data:image\/png;base64,/);
    assert.equal(Buffer.from(url.split('base64,')[1], 'base64').length, big.length);
});

test('上限を越えたら添えない（`null` を返す）', () => {
    const tooBig = { length: MAX_PREVIEW_BYTES + 1, subarray: () => new Uint8Array(0) };
    assert.equal(toDataUrl(tooBig), null);
    assert.equal(toDataUrl(new Uint8Array(0)), null, '空でも data: を作っている');
    assert.equal(toDataUrl(null), null);
});

test('絵を記録の JSON へ焼き込まない', () => {
    // **数MBの文字列が記録に入る。** 読むたびに丸ごと解かれるし、
    // 記録の上限（`MAX_RECORD_BYTES`）にも当たる。
    const data = toDataUrl(new Uint8Array([...PNG_HEAD, 9]));
    const body = recordSaveBody({
        id: 'x', title: 'X', checkpoint: 'a.safetensors',
        previewData: data, previewUrl: data,
    });
    assert.equal('previewData' in body, false, '絵を記録へ焼き込んでいる');
    assert.equal('previewUrl' in body, false);
    assert.equal(body.checkpoint, 'a.safetensors', '本体まで落としている');
});

test('本体を別に持つ記録でも焼き込まない', () => {
    const data = toDataUrl(new Uint8Array([...PNG_HEAD, 9]));
    const body = recordSaveBody({
        id: 'x', previewData: data,
        recipe: { id: 'x', checkpoint: { file_name: 'a.safetensors' } },
    });
    assert.equal('previewData' in body, false);
    assert.equal(body.checkpoint.file_name, 'a.safetensors');
});
