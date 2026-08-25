/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **本物の Civitai へ問い合わせて確かめる。**
 *
 * 単体の検査はダブルを相手にするので、**API の形が変わったことは分からない**。
 * ここは実際に叩く——ただし**外へ通信するので、明示した時だけ走る**。
 *
 *     UNBAKE_CIVITAI_LIVE=1 UNBAKE_RECIPES_DIR=… node --test tests/civitai_live_test.mjs
 *
 * **落とすのはこの検査では一度もしない。** 読むだけ。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fetchCivitaiImage, fetchModelVersion, primaryFileOf, recipeFromCivitaiMeta } from '../web/core/civitaiClient.js';
import { installEnvironment, resetEnvironment } from '../web/core/environment.js';
import { setLocale } from '../web/i18n/index.js';

const live = process.env.UNBAKE_CIVITAI_LIVE === '1';
const recipesDir = process.env.UNBAKE_RECIPES_DIR;

/** 記録の出典から画像 ID を集める。 */
function imageIds(limit) {
    if (!recipesDir || !fs.existsSync(recipesDir)) return [];
    const ids = [];
    for (const name of fs.readdirSync(recipesDir).filter(n => n.endsWith('.recipe.json'))) {
        let data;
        try { data = JSON.parse(fs.readFileSync(path.join(recipesDir, name), 'utf8')); } catch { continue; }
        const match = String(data.source_path || '').match(/\/images\/(\d+)/);
        if (match) ids.push(match[1]);
        if (ids.length >= limit) break;
    }
    return ids;
}

const pause = (ms) => new Promise(resolve => { setTimeout(resolve, ms); });

test('本物の API から、実データの画像の生成情報が取れる', async (t) => {
    if (!live) { t.skip('UNBAKE_CIVITAI_LIVE=1 のときだけ走る（外へ通信する）'); return; }
    const ids = imageIds(12);
    if (ids.length < 5) { t.skip('レシピの置き場から画像 ID を集められない'); return; }
    setLocale('en');
    installEnvironment({ request: (url, init) => fetch(url, init), storage: null });

    let found = 0;
    let withMeta = 0;
    let withComfy = 0;
    let withResources = 0;
    for (const id of ids) {
        const result = await fetchCivitaiImage(id);
        if (!result.ok) continue;
        found += 1;
        if (result.meta && Object.keys(result.meta).length) withMeta += 1;
        if (result.meta?.comfy) withComfy += 1;
        if ((result.meta?.civitaiResources || result.meta?.resources || []).length) withResources += 1;
        await pause(250);
    }
    resetEnvironment();

    console.log(`引いた ${ids.length}件 ／ 取れた ${found} ／ meta あり ${withMeta}`
        + ` ／ ComfyUI のグラフあり ${withComfy} ／ 素材の一覧あり ${withResources}`);

    assert.ok(found >= ids.length - 2, `取れた件数が少なすぎる（${found}/${ids.length}）`);
    // **`withMeta=true` が効いていること。** 落とすと meta が全部 null になる。
    assert.equal(withMeta, found, 'meta が返っていない（withMeta=true が落ちている疑い）');
    // **グラフを前提にしない。** 実測で `comfy` を持つのは1割未満だった。
    assert.ok(withComfy < found, 'グラフ前提の実装で足りるように見えている（実測と食い違う）');
});

test('版を引くと、落とすのに要るもの（名前・大きさ・hash・URL）が揃う', async (t) => {
    if (!live) { t.skip('UNBAKE_CIVITAI_LIVE=1 のときだけ走る（外へ通信する）'); return; }
    setLocale('en');
    installEnvironment({ request: (url, init) => fetch(url, init), storage: null });
    // EasyNegative（約24KB）。**小さいものを選ぶ**——確かめるだけなので。
    const result = await fetchModelVersion('9208');
    resetEnvironment();

    assert.equal(result.ok, true, result.reason);
    const file = primaryFileOf(result.version);
    assert.ok(file, '落とすファイルが選べていない');
    assert.ok(file.name.endsWith('.safetensors'), `想定外の形式: ${file.name}`);
    assert.ok(Number(file.sizeKB) > 0, '大きさが返っていない');
    assert.ok(file.hashes?.SHA256, 'SHA256 が返っていない（照合できない）');
    assert.match(file.downloadUrl, /^https:\/\/civitai\.(com|red)\//, `想定外の行き先: ${file.downloadUrl}`);
});

test('実データの画像から、書庫と同じ形の記録が組める', async (t) => {
    if (!live) { t.skip('UNBAKE_CIVITAI_LIVE=1 のときだけ走る（外へ通信する）'); return; }
    const ids = imageIds(8);
    if (ids.length < 3) { t.skip('レシピの置き場から画像 ID を集められない'); return; }
    setLocale('en');
    installEnvironment({ request: (url, init) => fetch(url, init), storage: null });

    let shaped = 0;
    let withCheckpoint = 0;
    for (const id of ids) {
        const result = await fetchCivitaiImage(id);
        if (!result.ok) continue;
        const versionIds = [...new Set((result.meta?.civitaiResources || [])
            .map(resource => resource?.modelVersionId).filter(value => value != null))];
        const versions = new Map();
        for (const versionId of versionIds.slice(0, 4)) {
            const found = await fetchModelVersion(versionId);
            if (found.ok) versions.set(String(versionId), found.version);
            await pause(150);
        }
        const recipe = recipeFromCivitaiMeta(result.item, result.meta, versions);
        if (recipe.gen_params.seed !== null || recipe.gen_params.prompt) shaped += 1;
        if (recipe.checkpoint?.file_name) withCheckpoint += 1;
        await pause(250);
    }
    resetEnvironment();

    console.log(`記録の形になった ${shaped}/${ids.length} ／ checkpoint の名前まで解けた ${withCheckpoint}`);
    assert.ok(shaped >= Math.ceil(ids.length * 0.6),
        `記録の形にできた割合が低すぎる（${shaped}/${ids.length}）`);
});
