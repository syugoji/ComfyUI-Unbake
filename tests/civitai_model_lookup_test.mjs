/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * ファイル名から Civitai の版を引く。**当たらなければ何も返さない。**
 *
 * ここで守りたいのは精度ではなく**沈黙**である。1つに決まらないときに
 * 「たぶんこれ」を返すと、道具は黙って違うモデルで再現し、
 * 出てきた絵が違っても利用者は理由に辿り着けない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    baseName, searchTermsFor, collectExactMatches, decideMatch, findVersionByFileName,
} from '../web/core/civitaiModelLookup.js';

const fileEntry = (name, sha = 'AABB') => ({ name, hashes: { SHA256: sha }, sizeKB: 1 });
const payload = (models) => ({ items: models });

test('フォルダ付きの名前でも、ファイル名だけで見る', () => {
    assert.equal(baseName(String.raw`Illustrious\anime\748cmSDXL.safetensors`), '748cmSDXL.safetensors');
    assert.equal(baseName('a/b/c.safetensors'), 'c.safetensors');
});

test('検索語は短くしながら何通りか作る', () => {
    // **実測に基づく**（2026-08-25）: 長く連結した語は0件で、
    // 小文字→大文字の境目で切った先頭語なら当たる。
    const terms = searchTermsFor('hassakuXLIllustrious_v13StyleA.safetensors');
    assert.ok(terms.includes('hassaku'), '先頭語まで短くしていない');
    assert.equal(terms[0], 'hassakuXLIllustrious v13StyleA', '素直な語幹を先に試していない');
    assert.ok(searchTermsFor('748cmSDXL.safetensors').includes('748cm'));
    // **2文字以下は捨てる。** 短すぎる語は母集団が広すぎて意味が無い。
    assert.deepEqual(searchTermsFor('ab.safetensors'), []);
});

test('採るのはファイル名が完全一致したものだけ', () => {
    const found = collectExactMatches(payload([
        { id: 1, name: 'M', modelVersions: [
            { id: 10, name: 'v1', files: [fileEntry('wanted.safetensors', 'ABC')] },
            { id: 11, name: 'v2', files: [fileEntry('wanted_v2.safetensors')] },   // 部分一致は採らない
        ] },
    ]), 'wanted.safetensors');
    assert.equal(found.length, 1);
    assert.equal(found[0].versionId, 10);
    assert.equal(found[0].sha256, 'abc', 'SHA256 を小文字で揃えていない');
});

test('大文字小文字とフォルダの違いは無視する', () => {
    const found = collectExactMatches(payload([
        { id: 1, modelVersions: [{ id: 10, files: [fileEntry('Wanted.SafeTensors')] }] },
    ]), String.raw`some\folder\wanted.safetensors`);
    assert.equal(found.length, 1);
});

test('**2つ以上あったら選ばない**（これが要）', () => {
    // 同名のファイルを持つ別のモデルは実在しうる。**どちらかを選ばない。**
    const two = decideMatch([
        { versionId: 10, modelId: 1 }, { versionId: 20, modelId: 2 },
    ]);
    assert.equal(two.match, null, '曖昧なのに1つ選んでいる');
    assert.equal(two.reason, 'ambiguous');
    assert.equal(two.candidates, 2);
});

test('同じ版が重複して返っても1件と数える', () => {
    // 検索が同じモデルを複数回返すことがある。**それは曖昧ではない。**
    const dup = decideMatch([{ versionId: 10 }, { versionId: 10 }, { versionId: 10 }]);
    assert.equal(dup.reason, 'unique');
    assert.equal(dup.match.versionId, 10);
});

test('1件も無ければ none（「たぶんこれ」を返さない）', () => {
    assert.equal(decideMatch([]).reason, 'none');
});

test('検索には nsfw=true を必ず付ける', async () => {
    // **無いと成人向けのモデルが静かに消える。** 実測: `query=hassaku` で
    // `Hassaku XL (Illustrious)`（nsfw: true）が1件も返らない。
    // **200 のまま空になる**ので、付け忘れると「Civitai に無い」と誤読する。
    const seen = [];
    const request = async (url) => {
        seen.push(url);
        return { ok: true, status: 200, json: async () => payload([]) };
    };
    await findVersionByFileName('anything_here.safetensors', { request });
    assert.ok(seen.length > 0, '一度も問い合わせていない');
    for (const url of seen) {
        assert.match(url, /[?&]nsfw=true(&|$)/, 'nsfw=true が付いていない: ' + url);
    }
});

test('短い語で当たるまで順に試し、当たったら止める', async () => {
    const seen = [];
    const request = async (url) => {
        seen.push(decodeURIComponent(new URL(url).searchParams.get('query')));
        // 3つ目の語（先頭語）でだけ当てる。
        const hit = seen.length >= 3;
        return {
            ok: true, status: 200,
            json: async () => payload(hit
                ? [{ id: 1, name: 'M', modelVersions: [{ id: 99, files: [fileEntry('hassakuXLIllustrious_v13StyleA.safetensors')] }] }]
                : []),
        };
    };
    const r = await findVersionByFileName('hassakuXLIllustrious_v13StyleA.safetensors', { request });
    assert.equal(r.reason, 'unique');
    assert.equal(r.match.versionId, 99);
    assert.deepEqual(seen, ['hassakuXLIllustrious v13StyleA', 'hassakuXLIllustrious', 'hassaku']);
});

test('曖昧だったら、短い語で引き直して1件に減らさない', async () => {
    // **減ったのは「絞れた」のではなく「別の母集団を見た」だけ。**
    let calls = 0;
    const request = async () => {
        calls += 1;
        return {
            ok: true, status: 200,
            json: async () => payload([
                { id: 1, modelVersions: [{ id: 10, files: [fileEntry('hassakuXLIllustrious_v13StyleA.safetensors')] }] },
                { id: 2, modelVersions: [{ id: 20, files: [fileEntry('hassakuXLIllustrious_v13StyleA.safetensors')] }] },
            ]),
        };
    };
    // **検索語が3つ作られる名前を使う。** 1つしか作られない名前だと、
    // 引き直しをやめても呼び出しは1回のままで、**検査が素通りする**
    // （変異検査で実際に素通りした）。
    const name = 'hassakuXLIllustrious_v13StyleA.safetensors';
    assert.equal(searchTermsFor(name).length, 3, '前提が崩れている（梯子を通らない入力）');
    const r = await findVersionByFileName(name, { request });
    assert.equal(r.reason, 'ambiguous');
    assert.equal(calls, 1, '曖昧なのに引き直している');
});

test('通信の失敗を「無い」と混ぜない', async () => {
    const request = async () => { throw new Error('boom'); };
    const r = await findVersionByFileName('a_bC.safetensors', { request });
    assert.match(r.reason, /^network:/);
    assert.equal(r.match, null);
});
