/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **拡散モデルは、本体だけでは動かない。**
 *
 * Civitai は Flux / Qwen-Image / HiDream / Chroma / Z-Image / Krea 2 / Anima に
 * ついて拡散モデルしか配らない。テキストエンコーダと VAE は別に要るのに、
 * **落とし終わってから初めて足りないと判る**——実測で Krea 2 は 12GB と
 * 表示され、実際には +8.3GB 必要だった。
 *
 * 目録も取得も以前から在ったのに、`modelCompanions.js` の口は**フォークの
 * `/api/lm/…` を向いたまま**で、画面から一度も届いていなかった
 *（2026-08-26 の到達性の棚卸しで判明）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    fetchCompanionStatus, downloadCompanions, resetCompanionCache, formatBytes,
} from '../web/core/modelCompanions.js';

const SOURCE = readFileSync(new URL('../web/core/modelCompanions.js', import.meta.url), 'utf8');

test('口がこちらのサーバを向いている（フォークの /api/lm/ ではない）', () => {
    // **単体で入る拡張である。** 向こうの口を叩くと、LoRA Manager も入って
    // いる環境でだけ動くかもしれないもの＝動かないのと同じ、になる。
    const endpoints = [...SOURCE.matchAll(/^const \w+_ENDPOINT = '([^']+)'/gm)].map(m => m[1]);
    assert.deepEqual(endpoints,
        ['/unbake/model-companions', '/unbake/download-model-companions'],
        `口が向いている先が違う: ${endpoints.join(' / ')}`);
});

test('足りない伴走の件数と大きさを読む', async () => {
    resetCompanionCache();
    const fetchImpl = async () => ({
        ok: true,
        json: async () => ({
            ok: true,
            companions: [
                { key: 'a', filename: 'te.safetensors', bytes: 3_000_000_000, installed: false },
                { key: 'b', filename: 'vae.safetensors', bytes: 250_000_000, installed: true },
            ],
            missingCount: 1, missingBytes: 3_000_000_000, missingUnknown: 0,
        }),
    });
    const status = await fetchCompanionStatus('Anima', { fetchImpl });
    assert.equal(status.missingCount, 1);
    assert.equal(status.missingBytes, 3_000_000_000);
});

test('大きさの判らない伴走を「0」に混ぜない', async () => {
    // **混ぜると「0 MB」と出て、実際には何GBも引くことになる。**
    resetCompanionCache();
    const fetchImpl = async () => ({
        ok: true,
        json: async () => ({
            ok: true, companions: [{ key: 'a', bytes: null, installed: false }],
            missingCount: 1, missingBytes: 0, missingUnknown: 1,
        }),
    });
    const status = await fetchCompanionStatus('Krea 2', { fetchImpl });
    assert.equal(status.missingUnknown, 1, '判らない件数を落としている');
});

test('こちらの応答の形（ok / camelCase）で読む', async () => {
    // フォークは `success` と `missing_count` を返す。**繋ぎ替えたのに
    // 読む形を直し忘れると、常に null が返って「伴走は要らない」に見える。**
    resetCompanionCache();
    const forkShape = async () => ({
        ok: true,
        json: async () => ({ success: true, companions: [{ installed: false }], missing_count: 1 }),
    });
    assert.equal(await fetchCompanionStatus('Anima', { fetchImpl: forkShape }), null,
        'フォークの形をそのまま受けている');
});

test('落とせなかったものを黙って飲まない', async () => {
    const fetchImpl = async () => ({
        ok: true,
        json: async () => ({
            ok: false,
            companions: [
                { key: 'a', filename: 'te.safetensors', ok: true },
                { key: 'b', filename: 'vae.safetensors', ok: false, error: '404' },
            ],
        }),
    });
    const rows = await downloadCompanions('Anima', { fetchImpl });
    assert.equal(rows.length, 2);
    assert.equal(rows.filter(row => !row.ok).length, 1, '失敗を落としている');
});

test('大きさの言い方', () => {
    assert.equal(formatBytes(0), '0 MB');
    assert.equal(formatBytes(3_221_225_472), '3.0 GB');
    assert.equal(formatBytes(250_000_000), '238 MB');
});
