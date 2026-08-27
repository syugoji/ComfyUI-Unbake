/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **`modelId` で別の版へ差し替えない**（2026-08-26 実機で踏んだ）。
 *
 * `modelId` はモデル**ページ**の id で、そこには何本も版がぶら下がる。実機では
 * `anima_aestheticV11`（要る版）を、同じページの `anima_baseV10`（手元に在る
 * 別の版）へ差し替えていた——**別の重みなので別の絵が出る。**
 *
 * 害は二重だった。差し替えた記録は「手元に在る」ことになるので、**正しい版を
 * 落とす候補から外れる**。実機で候補は 16件あったのに 6件しか出ず、
 * チェックポイントは1件も出なかった。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRecipeModels } from '../web/core/modelResolver.js';

/** 実測（2026-08-26）を縮めた索引。 */
const INDEX = {
    kinds: {
        checkpoints: { byModelId: {}, bySha10: {}, byVersionId: {} },
        diffusion_models: {
            // 同じページ（2458426）に、手元の版がぶら下がっている。
            byModelId: { 2458426: 'Anima\anime\anima_baseV10.safetensors' },
            byVersionId: { 3126580: 'Anima\anime\anima_baseV10.safetensors' },
            bySha10: { abcdef0123: 'Anima\anime\anima_baseV10.safetensors' },
        },
        loras: { byModelId: {}, bySha10: {}, byVersionId: {} },
    },
};

const recipeWith = (checkpoint) => ({ checkpoint, loras: [] });

test('同じページの別の版へ差し替えない', () => {
    const { recipe, resolved } = resolveRecipeModels(
        recipeWith({ file_name: 'anima_aestheticV11.safetensors', modelId: 2458426, modelVersionId: 3126581 }),
        INDEX, { checkpoints: [] },
    );
    // **在ることにしない。** 在るのは別の版であって、これではない。
    assert.notEqual(recipe.checkpoint.inLibrary, true, '別の版を「手元に在る」と言っている');
    assert.equal(recipe.checkpoint.localPath, undefined, '別の版のパスを当てている');
    assert.equal(recipe.checkpoint.file_name, 'anima_aestheticV11.safetensors', '要る版の名前が消えている');
    assert.deepEqual(resolved, [], '差し替えたことにしている');
    // **手掛かりも足さない。** 出す所が無い値を増やさない。
    assert.equal('sameModelLocalPath' in recipe.checkpoint, false,
        '出す所の無い値を足している');
});

test('版IDが一致すれば差し替える（同じ版なので同じ絵）', () => {
    const { recipe, resolved } = resolveRecipeModels(
        recipeWith({ file_name: 'なにか.safetensors', modelVersionId: 3126580 }),
        INDEX, { checkpoints: [] },
    );
    assert.equal(recipe.checkpoint.inLibrary, true, '版が一致するのに当てていない');
    assert.equal(resolved[0]?.by, 'versionId');
});

test('hash が一致すれば差し替える（同じファイル）', () => {
    const { recipe } = resolveRecipeModels(
        recipeWith({ file_name: 'x.safetensors', hash: 'ABCDEF0123456789' }),
        INDEX, { checkpoints: [] },
    );
    assert.equal(recipe.checkpoint.inLibrary, true, 'hash が一致するのに当てていない');
    assert.equal(recipe.checkpoint.resolvedBy, 'hash');
});

test('差し替えないので、落とす候補として残る', async () => {
    // **これが実機で起きていたこと。** 差し替えると候補から消える。
    const { classifyMissing } = await import('../web/core/recipeMissingModels.js');
    const missing = {
        models: [{
            name: 'anima_aestheticV11.safetensors', resourceType: 'checkpoint',
            modelId: 2458426, versionId: 3126581, isDeleted: false,
        }],
        resources: [],
    };
    const classified = classifyMissing(missing, null);
    assert.equal(classified.civitai.length, 1, '落とせる候補から外れている');
    assert.equal(classified.civitai[0].versionId, 3126581);
});
