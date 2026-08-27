/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **照合の根拠を `name` から `hash` へ上げる。**
 *
 * `civitaiModelLookup` はファイル名の完全一致で版を1つに決め、その版の SHA256 を
 * `lookupSha256` として持ち帰る。手元の索引（`bySha10`）にその hash が在れば、
 * **そのファイルがバイト同一だと確かめられる**——名前が同じかどうかとは無関係に。
 *
 * これが要るのは、名前の衝突が机上の話ではないから。利用者の環境には
 * **同名の LoRA が2箇所に在るものが8件**あった（`D-20260824-01` §5）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOne, resolveRecipeModels } from '../web/core/modelResolver.js';
import { evidenceOf, needsEvidenceWarning } from '../web/core/modelEvidence.js';

const INDEX = {
    kinds: {
        loras: { bySha10: { '3c1868387a': 'correct/the_real_one.safetensors' }, byVersionId: {}, byModelId: {} },
        checkpoints: { bySha10: {}, byVersionId: {}, byModelId: {} },
        diffusion_models: { bySha10: {}, byVersionId: {}, byModelId: {} },
    },
};

test('SHA256 が一致すれば、名前が同じでも hash で当てる', () => {
    // **同名の別ファイルが手元に在る状況。** 名前で引くと wrong を掴むが、
    // hash はそれを飛び越えて correct を指す。
    const resource = {
        file_name: 'wrong/the_real_one.safetensors',
        lookupSha256: '3C1868387A3A1FF504BB',   // 大文字でも通ること
    };
    const hit = resolveOne(resource, INDEX.kinds.loras, ['wrong/the_real_one.safetensors']);
    assert.equal(hit.resolved, true, '名前一致の近道へ落ちて hash を見ていない');
    assert.equal(hit.by, 'hash');
    assert.equal(hit.name, 'correct/the_real_one.safetensors');
});

test('手元にその hash が無ければ、従来どおりに振る舞う', () => {
    const resource = { file_name: 'x.safetensors', lookupSha256: 'ffffffffff' };
    const hit = resolveOne(resource, INDEX.kinds.loras, ['x.safetensors']);
    assert.equal(hit.resolved, false, '無い hash で当てたことにしている');
    assert.equal(hit.by, null);
});

test('`lookupSha256` を持たない資源の扱いを変えない', () => {
    const resource = { file_name: 'x.safetensors' };
    const hit = resolveOne(resource, INDEX.kinds.loras, ['x.safetensors']);
    assert.equal(hit.resolved, false);
    assert.equal(hit.by, null);
});

test('根拠が上がると、印が消える', () => {
    // **これが利用者から見える変化。** 「名前だけで照合」が出なくなる。
    const recipe = {
        checkpoint: null,
        loras: [{ file_name: 'the_real_one.safetensors', evidence: 'name', lookupSha256: '3c1868387a' }],
    };
    assert.equal(needsEvidenceWarning(recipe), true, '直す前から印が出ていない');
    const { recipe: out, resolved } = resolveRecipeModels(recipe, INDEX, { loras: [] });
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].by, 'hash');
    assert.equal(evidenceOf(out.loras[0]), 'hash', '根拠が上がっていない');
    assert.equal(needsEvidenceWarning(out), false, '根拠が上がったのに印が残っている');
});

test('確かめられなかったものの印は残す', () => {
    // **一部が上がっても、残りは残る。** 1本違えば絵は変わる。
    const recipe = {
        checkpoint: null,
        loras: [
            { file_name: 'the_real_one.safetensors', evidence: 'name', lookupSha256: '3c1868387a' },
            { file_name: 'unverified.safetensors', evidence: 'name' },
        ],
    };
    const { recipe: out } = resolveRecipeModels(recipe, INDEX, { loras: [] });
    assert.equal(evidenceOf(out.loras[0]), 'hash');
    assert.equal(evidenceOf(out.loras[1]), 'name');
    assert.equal(needsEvidenceWarning(out), true, '確かめていないものまで印が消えている');
});
