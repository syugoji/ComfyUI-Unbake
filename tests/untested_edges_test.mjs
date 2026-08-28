/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **検査ゼロだった端**（`D-20260828-01` 群C）。
 *
 * 緑が「守られている」を意味していない箇所を埋める。ここに集めたのは
 * **落ちると被害が大きいのに、参照する検査が1本も無かった**もの:
 *
 *   - `resolveComfyApp()` … ここが null を返すと**拡張が丸ごと存在しない**のと
 *     同じになる。**過去に実際に起きた事故そのもの**（`window.app` を見ていて
 *     一度も登録されなかった）。それでも検査は0本だった。
 *   - `estimateDownloadSize()` … 「これから落とす総量」の出どころ。
 *     **判らない分を 0 として足す**と、「1GB のつもりが 20GB だった」という
 *     一番困る外し方をする。モジュールの冒頭がその戒めを書いているのに、
 *     それを固定する検査が無かった。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveComfyApp } from '../web/unbake.js';
import { estimateDownloadSize, knownSizeOf, formatBytes } from '../web/core/downloadSizeEstimate.js';

// --- 宿主の見つけ方 ---------------------------------------------------------

test('宿主が居ないときは null を返す（例外にしない）', async () => {
    // 例外にすると、読み込みの途中で落ちて**登録そのものが起きない**。
    const before = globalThis.comfyAPI;
    delete globalThis.comfyAPI;
    try {
        assert.equal(await resolveComfyApp(), null);
    } finally {
        if (before !== undefined) globalThis.comfyAPI = before;
    }
});

test('`comfyAPI.app.app` に居る宿主を見つける', async () => {
    /*
     * **`window.app` を見ていて一度も登録されなかった**のが過去の事故。
     * 実体はここに居る。**名前が変わったら検査が落ちる**ようにしておく
     * ——落ちないと、次に変わったときも「起動ログは正常なのに何も無い」になる。
     */
    const before = globalThis.comfyAPI;
    const host = { registerExtension() {} };
    globalThis.comfyAPI = { app: { app: host } };
    try {
        assert.equal(await resolveComfyApp(), host, '実体の在り処を見ていない');
    } finally {
        if (before === undefined) delete globalThis.comfyAPI;
        else globalThis.comfyAPI = before;
    }
});

// --- 落とす総量の見積もり ---------------------------------------------------

test('判らない分を 0 として合計しない', async () => {
    // **過小な数字は「判らない」より悪い。** 押した後で 20GB だったと判る。
    const got = await estimateDownloadSize([
        { sizeBytes: 1024 },
        { civitai: { files: [{ primary: true, sizeKB: 2048 }] } },
        { /* 何も判らない素材 */ },
    ], { lookup: false });
    assert.equal(got.resolved, 2, '判明した件数が合わない');
    assert.equal(got.unknown, 1, '判らない件数を落としている');
    assert.equal(got.bytes, 1024 + 2048 * 1024, '合計が合わない');
});

test('問い合わせを頼まれなければ、外へ出ない', async () => {
    // `lookup:false` で呼ぶ側が居る（実測: `panel.js` の総量表示）。
    // ここが外へ出ると、**押していないのに Civitai へ346回**という形で表に出る。
    let called = 0;
    const got = await estimateDownloadSize([{ modelVersionId: 1 }], {
        lookup: false, fetchImpl: async () => { called += 1; return { ok: false }; },
    });
    assert.equal(called, 0, '頼まれていないのに問い合わせている');
    assert.equal(got.unknown, 1);
});

test('素材が持っている大きさを読む（指定ファイル → primary → 先頭）', () => {
    const files = [
        { id: 7, sizeKB: 10, hashes: { SHA256: 'AABB' } },
        { id: 8, primary: true, sizeKB: 20 },
    ];
    assert.equal(knownSizeOf({ civitai: { files }, fileParams: { fileId: 7 } }), 10 * 1024);
    assert.equal(knownSizeOf({ civitai: { files } }), 20 * 1024, 'primary を優先していない');
    assert.equal(knownSizeOf({ civitai: { files: [] } }), null, '無いのに数字を作っている');
});

test('大きさの表記は桁で単位が変わる', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(2.5 * 1024 ** 3), '2.5 GB');
    // **負や NaN で「NaN B」を出さない**（画面にそのまま出る）。
    assert.equal(formatBytes(-1), '0 B');
    assert.equal(formatBytes('x'), '0 B');
});
