/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **名前に括弧で埋め込まれたハッシュを、照合に使う**（2026-08-29 実機で確定）。
 *
 * ## 症状
 *
 * 利用者の報告: 「`civitai_128383826` …レコードを削除してから入れ直したのですが
 * **再現不可に分類されます**」。
 *
 * ## 実機で取った証拠（2026-08-29・ポータブル版の稼働中インスタンス）
 *
 * 記録が要求していた土台:
 *
 *     Illustrious/aMixIllustrious_aMix(B199B92EE9).safetensors
 *
 * 導入済み（`/object_info` の `CheckpointLoaderSimple.ckpt_name`）:
 *
 *     Illustrious\anime\aMixIllustrious_aMix.safetensors
 *
 * そして導入済み索引（`/unbake/model-index`）の `checkpoints.bySha10` には:
 *
 *     "b199b92ee9": "aMixIllustrious_aMix"
 *
 * **括弧の中身は、その索引が持っている SHA-10 そのものだった。**
 * つまり照合に使える鍵を両側が持っていたのに、`resolveOne()` は
 * 装飾つきの名前をそのまま突き合わせて外し、「未導入モデル」と言っていた。
 *
 * 判定器の出力（実機・この記録）:
 *
 *     verdict: 'blocked' / blocker: 'unobtainable'
 *     reasons: ['未導入モデル: aMixIllustrious_aMix(B199B92EE9).safetensors']
 *
 * LoRA 2本は素の名前で一致していたので、**外していたのは土台1本だけ**だった。
 *
 * ## なぜ「名前から括弧を外して照合する」ではないのか
 *
 * 外した名前で当てるのは**推測**である（同じ名前の別の版を掴み得る）。
 * 括弧の中身はハッシュなので、**索引に当たれば同一ファイルだと確かめられる**
 * ——当たらなければ何も言わない。この検査はその区別も見る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hashFromModelName } from '../web/core/modelFileNames.js';
import { resolveOne } from '../web/core/modelResolver.js';

/** 実機で観測した形（`bySha10` の鍵は小文字）。 */
const INDEX = {
    bySha10: { b199b92ee9: 'Illustrious\\anime\\aMixIllustrious_aMix' },
    byVersionId: {},
    byModelId: {},
};
const INSTALLED = [
    'Illustrious\\anime\\aMixIllustrious_aMix.safetensors',
    'Illustrious\\anime\\amanatsuIllustrious_v11.safetensors',
];

// --- 名前からハッシュを取り出す ---------------------------------------------

test('括弧つきの10桁16進を、ハッシュとして取り出す', () => {
    assert.equal(
        hashFromModelName('Illustrious/aMixIllustrious_aMix(B199B92EE9).safetensors'),
        'b199b92ee9',
        '実機で観測した形を読めていない',
    );
    assert.equal(hashFromModelName('aMixIllustrious_aMix(b199b92ee9).ckpt'), 'b199b92ee9');
    assert.equal(hashFromModelName('aMixIllustrious_aMix(B199B92EE9)'), 'b199b92ee9',
        '拡張子が無い記録（A1111 由来）で読めていない');
});

test('ハッシュでないものを、ハッシュだと言わない', () => {
    // **対照。** 何でも拾う実装だと、下の照合が別のモデルを掴む。
    for (const name of [
        'aMixIllustrious_aMix.safetensors',        // 括弧が無い
        'model(v2).safetensors',                   // 16進でない
        'model(B199B92EE).safetensors',            // 9桁
        'model(B199B92EE9A).safetensors',          // 11桁
        'model(B199B92EE9)extra.safetensors',      // 末尾でない
        'model(B199B92EE9) v2.safetensors',        // 末尾でない
        '',
        null,
    ]) {
        assert.equal(hashFromModelName(name), null, `拾ってはいけない: ${String(name)}`);
    }
});

// --- 照合 -------------------------------------------------------------------

test('名前で引けない土台を、名前の中のハッシュで引き当てる', () => {
    const got = resolveOne(
        { file_name: 'Illustrious/aMixIllustrious_aMix(B199B92EE9).safetensors', evidence: 'name' },
        INDEX, INSTALLED,
    );
    assert.deepEqual(
        got,
        { resolved: true, name: 'Illustrious\\anime\\aMixIllustrious_aMix', by: 'hash' },
        '実機で再現不可になっていた土台を、今も引き当てられていない',
    );
});

test('索引に当たらないハッシュでは、何も言わない', () => {
    // **推測しない。** 括弧を外した名前で当てにいくと、別の版を掴み得る。
    const got = resolveOne(
        { file_name: 'aMixIllustrious_aMix(0000000000).safetensors' },
        INDEX, INSTALLED,
    );
    assert.deepEqual(got, { resolved: false, name: null, by: null },
        '当たっていないのに引き当てたと言っている');
});

test('素の名前で引けるものは、今までどおり触らない', () => {
    // **対照。** ハッシュの道を先に置くと、ここが壊れる。
    const got = resolveOne(
        { file_name: 'Illustrious/aMixIllustrious_aMix.safetensors' },
        INDEX, INSTALLED,
    );
    assert.deepEqual(got, { resolved: false, name: null, by: null },
        '手元に在る名前を引き直している');
});

test('記録が持つ hash の方が在れば、そちらが先に効く', () => {
    // 名前の中のハッシュは**最後の手段**。明示された hash を上書きしない。
    const got = resolveOne(
        { file_name: 'whatever(b199b92ee9).safetensors', hash: 'b199b92ee9' },
        INDEX, INSTALLED,
    );
    assert.equal(got.by, 'hash');
    assert.equal(got.name, 'Illustrious\\anime\\aMixIllustrious_aMix');
});

test('版 id が在れば、名前の中のハッシュより先に見る', () => {
    const index = { ...INDEX, byVersionId: { 1915059: 'other_model' } };
    const got = resolveOne(
        { file_name: 'aMixIllustrious_aMix(b199b92ee9).safetensors', modelVersionId: 1915059 },
        index, INSTALLED,
    );
    // **ハッシュはバイト同一の証拠**なので、版 id より強い。
    assert.equal(got.by, 'hash', '弱い根拠（版 id）が強い根拠（ハッシュ）を追い越した');
});
