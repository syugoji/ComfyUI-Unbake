/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **条件が変わった日に効く欠陥**（再走査の 4〜7 件目・`_Planning/unbake_rescan_findings.md`）。
 *
 * どれも「今は害が出ない」——だが**害が無い理由が構造ではなく条件**だった。
 * 唯一の呼び手が `lookup: false` を渡している／叩く口が 404 を返す／
 * 別の検査が鍵集合の一致を固定している。**条件が変われば全部効く。**
 *
 * ここで留めるのは**その条件に依らない性質**である。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    estimateDownloadSize, knownSizeOf, resetDownloadSizeCache,
} from '../web/core/downloadSizeEstimate.js';
import { fetchRecipeOutputs } from '../web/core/recipeOutputs.js';
import { CATALOGS, setLocale, t } from '../web/i18n/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 応答のダブル。**呼ばれた URL を覚える**（呼ばれなかったことも確かめたい）。 */
function fakeFetch(handler) {
    const calls = [];
    const impl = async (url, init) => {
        calls.push(String(url));
        return handler(String(url), init);
    };
    return { impl, calls };
}

const jsonResponse = (body, ok = true, status = 200) => ({
    ok, status, json: async () => body,
});

// --------------------------------------------------------------------------
// I-20260831-62: Number(null) が 0 になり、問い合わせを飛ばす
// --------------------------------------------------------------------------

test('サイズが `null` の素材は「判っている」に数えない', () => {
    // `recipeMissingResources.js` は `size_bytes || null` を作る。
    assert.equal(knownSizeOf({ sizeBytes: null }), null,
        'Number(null)=0 を「判っているサイズ」として返している');
    assert.equal(knownSizeOf({ sizeBytes: undefined }), null);
});

test('サイズが `null` なら、問い合わせへ進む（飛ばさない）', async () => {
    resetDownloadSizeCache();
    const { impl, calls } = fakeFetch(() => jsonResponse({ ok: true, bytes: 4096 }));
    const out = await estimateDownloadSize(
        [{ sizeBytes: null, id: 111, type: 'lora' }],
        { fetchImpl: impl },
    );
    assert.equal(calls.length, 1, `問い合わせが飛んでいる: ${JSON.stringify(calls)}`);
    assert.deepEqual(out, { bytes: 4096, resolved: 1, unknown: 0 });
});

test('[対照] サイズが 0 と書いてあるなら、それは判っている', () => {
    // **`0` を書いた素材まで「判らない」にしない。** 直しの向きを確かめる対照。
    assert.equal(knownSizeOf({ sizeBytes: 0 }), 0);
});

// --------------------------------------------------------------------------
// I-20260831-63: フォークの `/api/lm/` を向いたままの口
// --------------------------------------------------------------------------

test('サイズの問い合わせ先が、このパッケージの口である', async () => {
    resetDownloadSizeCache();
    const { impl, calls } = fakeFetch(() => jsonResponse({ ok: true, bytes: 8192 }));
    await estimateDownloadSize([{ id: 222, type: 'checkpoint' }], { fetchImpl: impl });

    assert.equal(calls.length, 1);
    assert.match(calls[0], /^\/unbake\/civitai-version\?/,
        `フォークの口を叩いている: ${calls[0]}`);
    assert.match(calls[0], /id=222/);
    assert.match(calls[0], /kind=checkpoint/);
});

test('取れなかったとき（ok:false が 200 で返る）を、サイズとして数えない', async () => {
    resetDownloadSizeCache();
    const { impl } = fakeFetch(() => jsonResponse({ ok: false, error: 'not found' }));
    const out = await estimateDownloadSize([{ id: 333, type: 'lora' }], { fetchImpl: impl });
    assert.deepEqual(out, { bytes: 0, resolved: 0, unknown: 1 });
});

test('出た絵の問い合わせ先が、このパッケージの口である', async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse({ outputs: [], total: 0 }));
    await fetchRecipeOutputs('rec-1', { fetchImpl: impl });
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^\/unbake\/outputs\?/, `フォークの口を叩いている: ${calls[0]}`);
});

test('`web/core/` から、フォークの口を叩く経路が無い', async () => {
    /*
     * **口を1つずつ塞ぐのをやめる。** `modelCompanions.js` は 2026-08-26 に
     * 繋ぎ替えたが、同じ直しが `downloadSizeEstimate.js` と `recipeOutputs.js`
     * には届いていなかった（`I-20260831-63`）。**次に増えたら落ちる形**にする。
     *
     * 文中で `/api/lm/` に言及するのは構わない（経緯として書いてある）。
     * 落とすのは**綴りの中に組み込んで実際に叩く形**だけ。
     */
    const files = (await readdir(join(ROOT, 'web/core'))).filter(name => name.endsWith('.js'));
    assert.ok(files.length >= 20, `走査が壊れている（${files.length}件）`);

    const offenders = [];
    for (const name of files) {
        const text = await readFile(join(ROOT, 'web/core', name), 'utf8');
        for (const line of text.split(/\r?\n/)) {
            const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '');
            if (/['"`]\/api\/lm\//.test(code)) offenders.push(`${name}: ${line.trim()}`);
        }
    }
    assert.deepEqual(offenders, [],
        'フォークの口を綴りとして持っているモジュールがある:\n' + offenders.join('\n'));
});

// --------------------------------------------------------------------------
// I-20260831-65: サーバが数えた総数を捨てない
// --------------------------------------------------------------------------

test('総数はサーバの数え上げを使う（描けた枚数で置き換えない）', async () => {
    // 壊れた項目を1つ混ぜる。`normalizeOutputs` はそれを落とす。
    const { impl } = fakeFetch(() => jsonResponse({
        outputs: [{ filename: 'a.png' }, { filename: '' }],
        total: 2,
    }));
    const out = await fetchRecipeOutputs('rec-1', { fetchImpl: impl });
    assert.equal(out.outputs.length, 1, '壊れた項目を落としていない');
    assert.equal(out.total, 2, 'サーバが数えた総数を、描けた枚数で置き換えている');
});

test('[対照] 総数が来なければ、描けた枚数で埋める', async () => {
    const { impl } = fakeFetch(() => jsonResponse({ outputs: [{ filename: 'a.png' }] }));
    const out = await fetchRecipeOutputs('rec-1', { fetchImpl: impl });
    assert.equal(out.total, 1);
});

// --------------------------------------------------------------------------
// I-20260831-64: 未訳を英語へ静かに落とさない
// --------------------------------------------------------------------------

test('英語にしか無い鍵は、その言語で `[鍵]` として出る', () => {
    const code = 'test.onlyInEnglish.__probe__';
    CATALOGS.en[code] = 'English only';
    try {
        setLocale('ja');
        assert.equal(t(code), `[${code}]`,
            '未訳が英語へ静かに落ちている（訳の抜けが見えなくなる）');
        setLocale('en');
        assert.equal(t(code), 'English only', '英語では出るはず');
    } finally {
        delete CATALOGS.en[code];
        setLocale('en');
    }
});

test('[対照] 訳が在る鍵は、これまでどおりその言語で出る', () => {
    setLocale('ja');
    const japanese = t('settings.uiSkin');
    setLocale('en');
    const english = t('settings.uiSkin');
    assert.ok(japanese && !japanese.startsWith('['), `日本語が出ていない: ${japanese}`);
    assert.notEqual(japanese, english, '言語で切り替わっていない');
});
