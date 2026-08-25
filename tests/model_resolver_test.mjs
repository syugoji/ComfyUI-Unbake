/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 名前で引けないモデルを hash と Civitai の id で引き直す（2026-08-22）。
 *
 * **これが無いと、手元に在るモデルを「未導入」と言う。** 実測で、人間の判定シートが
 * 「再現できた」と記録している2件が「再現不可」と出ていた。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installedNamesFrom, resolveOne, resolveRecipeModels } from '../web/core/modelResolver.js';

const INDEX = {
    kinds: {
        checkpoints: {
            bySha10: { '4286171e4b': 'prefectiousXLNSFW_v10' },
            byVersionId: { 665047: 'realDream_sdxlPony9', 1111838: 'prefectiousXLNSFW_v10' },
            byModelId: { 153568: 'realDream_sdxlPony9' },
        },
        loras: { bySha10: {}, byVersionId: {}, byModelId: {} },
    },
};

test('Civitai の内部名で引けないときに hash で引き直す', () => {
    // 実データ `43323642`。`file_name` は Civitai の内部名で、手元の名前と違う。
    const found = resolveOne(
        { file_name: 'prefectious_nsfw.fp16', hash: '4286171e4b', id: 1111838 },
        INDEX.kinds.checkpoints, ['someOther.safetensors'],
    );
    assert.equal(found.resolved, true, '手元に在るのに引けていない');
    assert.equal(found.name, 'prefectiousXLNSFW_v10');
    assert.equal(found.by, 'hash', 'hash より弱い根拠で当てている');
});

test('名前も hash も空なら、版 id で引き直す', () => {
    // 実データ `21490268`。`isDeleted: true` の殻で、手掛かりは id だけ。
    const found = resolveOne(
        { file_name: '', hash: '', id: '665047', modelId: '153568', isDeleted: true },
        INDEX.kinds.checkpoints, [],
    );
    assert.equal(found.resolved, true);
    assert.equal(found.name, 'realDream_sdxlPony9');
    assert.equal(found.by, 'versionId', 'model id（版が違えば絵も違う）で当てている');
});

test('名前でそのまま引けるものへは触らない', () => {
    // **記録の名前が正しいのに索引で上書きすると、同名の別ファイルへ静かに移る。**
    const found = resolveOne(
        { file_name: 'prefectiousXLNSFW_v10.safetensors', hash: '4286171e4b' },
        INDEX.kinds.checkpoints, ['Illustrious\\anime\\prefectiousXLNSFW_v10.safetensors'],
    );
    assert.equal(found.resolved, false, '名前で引けているのに索引を当てている');
});

test('当てられなければ何も変えない（黙って別のモデルにしない）', () => {
    const found = resolveOne({ file_name: 'nothing_like_this', hash: 'ffffffffff' },
        INDEX.kinds.checkpoints, []);
    assert.equal(found.resolved, false);
    assert.equal(found.name, null);
});

test('引き直した結果は `localPath` と `inLibrary` に入れ、元の名前は残す', () => {
    // **組み立て側は `inLibrary ? localPath` を最優先で見る。** そこへ入れることで、
    // 下流に新しい分岐を作らずに済む。`file_name` を消すと記録の中身が辿れなくなる。
    const { recipe, resolved } = resolveRecipeModels(
        { checkpoint: { file_name: 'prefectious_nsfw.fp16', hash: '4286171e4b' }, loras: [] },
        INDEX, { checkpoints: [], loras: [] },
    );
    assert.equal(recipe.checkpoint.localPath, 'prefectiousXLNSFW_v10');
    assert.equal(recipe.checkpoint.inLibrary, true);
    assert.equal(recipe.checkpoint.file_name, 'prefectious_nsfw.fp16', '記録の名前を消している');
    assert.equal(recipe.checkpoint.resolvedBy, 'hash', 'どの根拠で当てたかを残していない');
    assert.deepEqual(resolved, [{
        kind: 'checkpoints', from: 'prefectious_nsfw.fp16', to: 'prefectiousXLNSFW_v10', by: 'hash',
    }]);
});

test('索引が空でも落とさない（LoRA Manager を入れていない環境）', () => {
    // **索引を置いているのは LoRA Manager。** 入れていなければ空になるが、
    // そこで壊れてはいけない——今までどおり名前だけで解決する。
    const recipe = { checkpoint: { file_name: 'x', hash: 'aaaaaaaaaa' }, loras: [] };
    for (const empty of [null, undefined, {}, { kinds: {} }]) {
        const out = resolveRecipeModels(recipe, empty, {});
        assert.deepEqual(out.resolved, []);
        assert.equal(out.recipe, recipe, '当てていないのに写しを作っている');
    }
});

test('元の記録を書き換えない（写しを返す）', () => {
    const recipe = { checkpoint: { file_name: 'prefectious_nsfw.fp16', hash: '4286171e4b' }, loras: [] };
    const before = JSON.stringify(recipe);
    resolveRecipeModels(recipe, INDEX, {});
    assert.equal(JSON.stringify(recipe), before, '呼び手の記録を書き換えている');
});

// --- Flux 系は `models/checkpoints` に入らない（2026-08-22 実データで踏んだ）---
//
// 手元では `unet/Flux.1 D/base model/flux_dev.safetensors` に在り、組み立ても
// `UNETLoader` で読む。にもかかわらず導入済みの一覧も索引も `checkpoints` しか
// 見ていなかったので、**在るのに「未導入モデル」と出て 再現不可 になっていた**。

test('checkpoint は `diffusion_models` の索引からも引く', () => {
    // 実データ `civitai_32271527`。記録の hash は手元の `flux_dev.safetensors` と同じ。
    const index = {
        kinds: {
            checkpoints: { bySha10: {}, byVersionId: {}, byModelId: {} },
            diffusion_models: {
                bySha10: { '2eda627c8a': 'Flux.1 D\\base model\\flux_dev.safetensors' },
                byVersionId: { 691639: 'Flux.1 D\\base model\\flux_dev.safetensors' },
                byModelId: {},
            },
            loras: { bySha10: {}, byVersionId: {}, byModelId: {} },
        },
    };
    const { recipe, resolved } = resolveRecipeModels(
        { checkpoint: { file_name: 'marduk191sFlux1_flux1Dev8x8', hash: '2eda627c8aee140edc77e28ed8dd3c662928ae60f0f960f36824f8862dcbb713' }, loras: [] },
        index, { checkpoints: ['someOther.safetensors'], loras: [] },
    );
    assert.equal(recipe.checkpoint.inLibrary, true, '手元に在るのに未導入のまま');
    assert.equal(recipe.checkpoint.localPath, 'Flux.1 D\\base model\\flux_dev.safetensors');
    assert.equal(resolved[0].kind, 'diffusion_models', 'どの置き場で当てたかを言えていない');
});

test('`checkpoints` に在れば、そちらを先に採る', () => {
    // **両方に同じ名前が居ることは在りうる。** 先に見るのは `checkpoints`。
    const index = {
        kinds: {
            checkpoints: { bySha10: { aaaaaaaaaa: 'in_checkpoints' }, byVersionId: {}, byModelId: {} },
            diffusion_models: { bySha10: { aaaaaaaaaa: 'in_unet' }, byVersionId: {}, byModelId: {} },
            loras: { bySha10: {}, byVersionId: {}, byModelId: {} },
        },
    };
    const { recipe, resolved } = resolveRecipeModels(
        { checkpoint: { file_name: 'x', hash: 'aaaaaaaaaa' }, loras: [] }, index, {},
    );
    assert.equal(recipe.checkpoint.localPath, 'in_checkpoints');
    assert.equal(resolved[0].kind, 'checkpoints');
});

test('導入済みの checkpoint に `UNETLoader` の分も入る', () => {
    // **ここを落とすと、名前でそのまま引けるモデルまで「未導入」になる。**
    const names = installedNamesFrom({
        CheckpointLoaderSimple: { input: { required: { ckpt_name: [['a.safetensors']] } } },
        UNETLoader: { input: { required: { unet_name: [['Flux.1 D\\base model\\flux_dev.safetensors', 'a.safetensors']] } } },
        LoraLoader: { input: { required: { lora_name: [['l.safetensors']] } } },
    });
    assert.deepEqual(names.checkpoints,
        ['a.safetensors', 'Flux.1 D\\base model\\flux_dev.safetensors'],
        'unet 側を拾っていないか、重複を潰していない');
    assert.deepEqual(names.loras, ['l.safetensors']);
});

test('導入済みの一覧は `/object_info` から取る（推測で組み立てない）', () => {
    const names = installedNamesFrom({
        CheckpointLoaderSimple: { input: { required: { ckpt_name: [['a.safetensors', 'b.safetensors']] } } },
        LoraLoader: { input: { required: { lora_name: [['sub\\c.safetensors']] } } },
    });
    assert.deepEqual(names.checkpoints, ['a.safetensors', 'b.safetensors']);
    assert.deepEqual(names.loras, ['sub\\c.safetensors']);
    // 形が違っても落ちない（`/object_info` の形は本体の版で変わる）。
    assert.deepEqual(installedNamesFrom(null), { checkpoints: [], loras: [] });
    assert.deepEqual(installedNamesFrom({}), { checkpoints: [], loras: [] });
});
