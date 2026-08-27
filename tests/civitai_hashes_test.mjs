/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * `meta.hashes` の読み取り。**この鍵を一度も見ていなかった。**
 *
 * 実測（2026-08-25・人気画像200枚）: `meta` を持つ117枚のうち **23枚が `hashes` を持ち**、
 * **15枚が LoRA の項目**を持つ。うち3枚は **LoRA の名前が `hashes` にしか無い**
 * （`civitaiResources` は版IDだけを持ち、名前を持たない）。
 *
 * 得られるものは2つで、**大きいのは後者**:
 *   ① 名前——読まないと名無しの LoRA が残る
 *   ② hash——**照合の根拠が `name` から `hash` へ上がる**（同名の別物を掴む余地が消える）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readHashes, recipeFromCivitaiMeta } from '../web/core/civitaiClient.js';
import { evidenceOf } from '../web/core/modelEvidence.js';

/** 実測の形（image 140173431）。 */
const REAL = {
    Model: 'krea2TurboOfficialComfy_krea2TurboFp8',
    'Model hash': 'EB4DD8C612',
    hashes: {
        model: 'EB4DD8C612',
        'LORA:Krea2_TextFusion_Refusal_Reduction': '84EC722DDA',
    },
    civitaiResources: [{ type: 'lora', weight: 1, modelVersionId: 3125118 }],
    resources: [{ hash: 'EB4DD8C612', name: 'krea2TurboOfficialComfy_krea2TurboFp8', type: 'model' }],
    baseModel: 'Krea 2',
};

test('`model` と `LORA:` を読み分ける', () => {
    const out = readHashes(REAL);
    assert.equal(out.checkpoint, 'EB4DD8C612');
    assert.deepEqual(out.loras, [{ name: 'Krea2_TextFusion_Refusal_Reduction', hash: '84EC722DDA' }]);
});

test('接頭辞は `LORA:` だけではない', () => {
    const out = readHashes({ hashes: {
        'EMBED:bad_hands': 'AA', 'TI:easynegative': 'BB', 'LyCORIS:style': 'CC',
        'unknown-prefix-no-colon': 'DD',
    } });
    assert.deepEqual(out.embeddings.map(e => e.name), ['bad_hands', 'easynegative']);
    assert.deepEqual(out.loras.map(l => l.name), ['style']);
});

test('空の値を「在る」と数えない', () => {
    const out = readHashes({ hashes: { model: '', 'LORA:x': '  ' } });
    assert.equal(out.checkpoint, null);
    assert.deepEqual(out.loras, []);
});

test('hashes が無くても落ちない', () => {
    for (const meta of [null, {}, { hashes: 'nope' }, { hashes: [] }]) {
        const out = readHashes(meta);
        assert.deepEqual(out, { checkpoint: null, loras: [], embeddings: [] });
    }
});

test('版IDしか無かった LoRA に、名前と hash が付く', () => {
    // **これが実データで起きていたこと。** 直す前は `file_name: null` だった。
    const recipe = recipeFromCivitaiMeta({ id: 1 }, REAL, new Map());
    assert.equal(recipe.loras.length, 1);
    assert.equal(recipe.loras[0].file_name, 'Krea2_TextFusion_Refusal_Reduction',
        '名前が付いていない（hashes を読めていない）');
    assert.equal(recipe.loras[0].hash, '84EC722DDA');
    assert.equal(recipe.loras[0].modelVersionId, 3125118, '版IDを捨てている');
    // **根拠が上がる。** 名前照合の危うさが消える。
    assert.equal(evidenceOf(recipe.loras[0]), 'hash');
    assert.equal(evidenceOf(recipe.checkpoint), 'hash');
});

test('強い根拠を、弱い側で塗り替えない', () => {
    // 既に hash を持っているものへ、別の hash を上書きしない。
    const meta = {
        resources: [{ name: 'a.safetensors', hash: 'ORIGINAL', type: 'lora' }],
        hashes: { 'LORA:a': 'DIFFERENT' },
    };
    const recipe = recipeFromCivitaiMeta({ id: 1 }, meta, new Map());
    assert.equal(recipe.loras[0].hash, 'ORIGINAL', '先に在った hash を上書きしている');
});

test('フォルダと拡張子の違いで別物と数えない', () => {
    const meta = {
        additionalResources: [{ name: 'Illustrious/anime/x.safetensors', type: 'lora', strength: 0.5 }],
        hashes: { 'LORA:x': 'ABC' },
    };
    const recipe = recipeFromCivitaiMeta({ id: 1 }, meta, new Map());
    assert.equal(recipe.loras.length, 1, '同じ LoRA を2件に増やしている');
    assert.equal(recipe.loras[0].hash, 'ABC');
    assert.equal(recipe.loras[0].strength, 0.5, '強度を落としている');
});

test('画面が既に持っていた欄へ、値を入れる', () => {
    // `recipeReferenceInfo.js` に表示ラベルが在るのに、抽出側が空だった
    // ——**表示側だけ移して抽出側を移していない**状態。
    const meta = {
        VAE: 'sdxl_vae.safetensors',
        'Hires upscale': 2, 'Hires steps': 10, 'Hires upscaler': 'Latent',
        'Hires resize': '1024x1536', 'Hires CFG Scale': 4,
        Model: 'x', baseModel: 'Illustrious',
    };
    const g = recipeFromCivitaiMeta({ id: 1 }, meta, new Map()).gen_params;
    assert.equal(g.vae, 'sdxl_vae.safetensors');
    assert.equal(g.hires_upscale, 2);
    assert.equal(g.hires_steps, 10);
    assert.equal(g.hires_upscaler, 'Latent');
    assert.equal(g.hires_resize, '1024x1536');
    assert.equal(g.hires_cfg_scale, 4);
    assert.equal(recipeFromCivitaiMeta({ id: 1 }, meta, new Map()).base_model, 'Illustrious');
});

test('名前を持つ LoRA が hash を得たら、根拠も上がる', () => {
    // **変異検査で見つけた穴。** 直前の検査は「名前が無い LoRA に名前と hash が付く」
    // 経路しか通っておらず、**既に名前を持つものへ hash を足す**経路が素通りしていた
    // （`found.evidence` を `name` へ変えても赤くならなかった）。
    const meta = {
        additionalResources: [{ name: 'styleA.safetensors', type: 'lora', strength: 0.8 }],
        hashes: { 'LORA:styleA': 'DEADBEEF' },
    };
    const lora = recipeFromCivitaiMeta({ id: 1 }, meta, new Map()).loras[0];
    assert.equal(lora.file_name, 'styleA.safetensors');
    assert.equal(lora.hash, 'DEADBEEF', 'hash を足していない');
    assert.equal(evidenceOf(lora), 'hash',
        '名前で拾ったものが hash を得たのに、根拠が name のまま');
});
