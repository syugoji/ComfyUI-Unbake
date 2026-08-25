/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 工程5・6 — **URL しか来ない経路**を API から取り直す。
 *
 * ここで固定するのは、**引数を1つ落とすと `200` で空が返る**という性質への守り。
 * 実測で2回踏んだ:
 *
 *   `withMeta=true` が無い → `meta` が全部 `null`（画像30件で **0/29 → 29/29**）
 *   `nsfw=X` が無い      → 項目そのものが返らない（`items: []`）
 *
 * どちらも例外にならないので、**「この機能は無い」と誤読する。**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    API_DOMAINS, fetchCivitaiImage, fetchModelVersion, folderKindOf, imageQueryUrl,
    nsfwLevelOf, primaryFileOf, recipeFromCivitaiMeta, recordFromCivitaiImage,
    REQUIRED_QUERY, unwrapMeta,
} from '../web/core/civitaiClient.js';
import { setLocale } from '../web/i18n/index.js';

const reply = (payload, ok = true, status = 200) => async () => ({
    ok, status, json: async () => payload,
});

// --- 引数の欠落を、コードの側で起こさない -----------------------------------

test('画像を引く URL に、落とすと空が返る引数が必ず入っている', () => {
    const url = new URL(imageQueryUrl(123));
    // **`REQUIRED_QUERY` を回して確かめない。** 回すと、鍵を消したときに
    // 繰り返しが減るだけで検査は通る——**自分が真実源にしているものを
    // 自分で確かめている**ので、消したことに気づけない（変異で実際に素通りした）。
    // 名前は literal で書く。
    assert.equal(url.searchParams.get('withMeta'), 'true',
        'withMeta が無い（meta が全部 null で返り、機能が無いと誤読する）');
    assert.equal(url.searchParams.get('nsfw'), 'X',
        'nsfw=X が無い（項目そのものが返らず、見つからないと誤読する）');
    assert.equal(url.searchParams.get('imageId'), '123');
    // 定数の側も同じ2つを持っていること（片方だけ直すのを防ぐ）。
    assert.deepEqual(Object.keys(REQUIRED_QUERY).sort(), ['nsfw', 'withMeta']);
});

test('ドメインを渡すと、そちらへ問い合わせる', () => {
    // 手元の記録の出典は `.red` が326/340件。既定へ落とすと94%が別ドメインへ行く。
    assert.match(imageQueryUrl(1, 'civitai.red'), /^https:\/\/civitai\.red\//);
    assert.match(imageQueryUrl(1, 'civitai.com'), /^https:\/\/civitai\.com\//);
    // 知らないドメインは既定へ落とす（勝手なホストへ問い合わせない）。
    assert.match(imageQueryUrl(1, 'evil.example'), new RegExp(`^https://${API_DOMAINS[0]}/`));
});

// --- 二重の入れ子 -----------------------------------------------------------

test('meta の二重の入れ子を解く', () => {
    // 実測の形: `item.meta = { id, meta: { …本体… } }`
    assert.deepEqual(unwrapMeta({ meta: { id: 1, meta: { seed: 7 } } }), { seed: 7 });
    // 内側が無い形でも読める（API の形が変わって静かに空を返さないため）。
    assert.deepEqual(unwrapMeta({ meta: { seed: 7 } }), { seed: 7 });
    // `id` しか無ければ生成情報ではない。
    assert.equal(unwrapMeta({ meta: { id: 1 } }), null);
    assert.equal(unwrapMeta({}), null);
});

// --- 空を「無い」と混ぜない --------------------------------------------------

test('空の応答を「見つからない」と区別できる理由で返す', async () => {
    const empty = await fetchCivitaiImage(1, { request: reply({ items: [] }) });
    assert.equal(empty.ok, false);
    assert.equal(empty.reason, 'not-found-or-filtered',
        '空だったことと絞り込みで消えたことを、呼び手が区別できない');

    const bad = await fetchCivitaiImage('not-a-number', { request: reply({}) });
    assert.equal(bad.reason, 'bad-image-id');

    const http = await fetchCivitaiImage(1, { request: reply({}, false, 503) });
    assert.equal(http.reason, 'http-503');
});

test('取得の失敗で投げない（落とし込み1件で面が壊れない）', async () => {
    const thrown = await fetchCivitaiImage(1, {
        request: async () => { throw new Error('offline'); },
    });
    assert.equal(thrown.ok, false);
    assert.match(thrown.reason, /^network:/);
});

// --- グラフが在るときと、無いとき ---------------------------------------------

test('ComfyUI のグラフが在れば、捕捉と同じ形の記録になる', () => {
    setLocale('en');
    const graph = { 1: { class_type: 'KSampler', inputs: { seed: 5, steps: 20 } } };
    const built = recordFromCivitaiImage(
        { id: 42, nsfwLevel: 'X', modelVersionIds: [7] },
        { comfy: JSON.stringify({ prompt: graph }) },
        {},
    );
    assert.equal(built.ok, true, built.reason);
    assert.equal(built.record.id, '42');
    assert.equal(built.record.origin.kind, 'civitai');
    assert.deepEqual(built.record.prompt, graph);
    assert.equal(built.record.nsfwLevel, 16, 'X の格付けを数値へ寄せていない');
    assert.deepEqual(built.record.modelVersionIds, [7]);
});

test('グラフが無いときは、そうと分かる理由を返す', () => {
    setLocale('en');
    // **実測で `comfy` を持つのは 2/29（6.9%）** しかない。
    // ここが黙って空の記録を返すと、93%が「情報が無い」ように見える。
    const built = recordFromCivitaiImage({ id: 42 }, { seed: 5, steps: 20 }, {});
    assert.equal(built.ok, false);
    assert.match(built.reason, /42/);
    assert.doesNotMatch(built.reason, /^\[.*\]$/, '未訳の鍵がそのまま出ている');
});

// --- 平たい meta を、書庫と同じ形へ ------------------------------------------

test('A1111 形式の meta を、書庫の記録と同じ形へ落とす', () => {
    const item = { id: 99, nsfwLevel: 'Mature', baseModel: 'Illustrious' };
    const meta = {
        prompt: 'a girl', negativePrompt: 'bad hands',
        seed: 123, steps: 25, cfgScale: 5, sampler: 'DPM++ 2M Karras',
        Size: '832x1216', clipSkip: 2,
        civitaiResources: [
            { type: 'checkpoint', modelVersionId: 111 },
            { type: 'lora', modelVersionId: 222, weight: 0.8 },
            { type: 'embed', modelVersionId: 333, weight: 1 },
        ],
    };
    const versions = new Map([
        ['111', { files: [{ primary: true, name: 'base.safetensors' }] }],
        ['222', { files: [{ primary: true, name: 'char.safetensors' }] }],
    ]);
    const recipe = recipeFromCivitaiMeta(item, meta, versions);

    // **新しい形を作らない。** 書庫の記録と同じ鍵で並ぶ。
    assert.equal(recipe.checkpoint.file_name, 'base.safetensors');
    assert.equal(recipe.loras.length, 1);
    assert.equal(recipe.loras[0].file_name, 'char.safetensors');
    assert.equal(recipe.loras[0].strength, 0.8);
    // 版が引けなかった素材も**捨てない**（版IDは残る）。
    assert.equal(recipe.embeddings[0].modelVersionId, 333);
    assert.equal(recipe.embeddings[0].file_name, null);

    assert.equal(recipe.gen_params.prompt, 'a girl');
    assert.equal(recipe.gen_params.seed, 123);
    assert.equal(recipe.gen_params.size, '832x1216');
    assert.equal(recipe.preview_nsfw_level, 4);
    assert.equal(recipe.generation_source, 'civitai-api');
});

test('版IDの無い古い形（名前と hash）も拾う', () => {
    const recipe = recipeFromCivitaiMeta(
        { id: 1 },
        { resources: [{ type: 'model', name: 'Rimixoa', hash: '91CF056496' }], Model: 'Rimixoa' },
    );
    assert.equal(recipe.checkpoint.file_name, 'Rimixoa');
    assert.equal(recipe.checkpoint.hash, '91CF056496');
});

// --- ダウンロードに要るもの ---------------------------------------------------

test('落とすファイルは primary を選ぶ', () => {
    // 版には本体の他に学習の設定や画像が付く。最初の1つを取ると本体でない物を落とす。
    const version = {
        files: [
            { name: 'config.json', type: 'Config', primary: false },
            { name: 'model.safetensors', type: 'Model', primary: true },
        ],
    };
    assert.equal(primaryFileOf(version).name, 'model.safetensors');
    // `primary` が無ければ type で選ぶ。
    assert.equal(primaryFileOf({ files: [{ name: 'a.txt', type: 'Config' }, { name: 'b.safetensors', type: 'Model' }] }).name, 'b.safetensors');
    assert.equal(primaryFileOf({ files: [] }), null);
});

test('種別から置き場を決め、判らないものは判らないままにする', () => {
    assert.equal(folderKindOf({ model: { type: 'LORA' } }), 'loras');
    assert.equal(folderKindOf({ model: { type: 'Checkpoint' } }), 'checkpoints');
    assert.equal(folderKindOf({ model: { type: 'TextualInversion' } }), 'embeddings');
    // **推測で置き場を決めない。** 間違えると探しても見つからない場所へ落ちる。
    assert.equal(folderKindOf({ model: { type: 'Workflows' } }), null);
    assert.equal(folderKindOf({}), null);
});

test('版を引く口も、失敗で投げない', async () => {
    const bad = await fetchModelVersion('x', { request: reply({}) });
    assert.equal(bad.reason, 'bad-version-id');
    const ok = await fetchModelVersion(1, { request: reply({ id: 1, files: [] }) });
    assert.equal(ok.ok, true);
    assert.equal(ok.version.id, 1);
});

test('格付けは文字でも数でも読める', () => {
    assert.equal(nsfwLevelOf({ nsfwLevel: 'None' }), 1);
    assert.equal(nsfwLevelOf({ nsfwLevel: 'X' }), 16);
    assert.equal(nsfwLevelOf({ nsfwLevel: 8 }), 8);
    // **読めないものを 0（安全）へ丸めない。**
    assert.equal(nsfwLevelOf({ nsfwLevel: 'unknown-word' }), null);
    assert.equal(nsfwLevelOf({}), null);
});
