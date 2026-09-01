/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **名前の茎の取り方を1本に揃える**（2026-08-31・監査 I-20260831-31）。
 *
 * `installedHas` は `.replace(/\.[^.]+$/, '')` で**末尾のドット区間を無条件に**
 * 落としていた。`modelFileNames.js` は「拡張子を落とす規則は唯一ここ」と宣言し、
 * `MODEL_EXTENSION_PATTERN`（**既知の拡張子だけ**を落とす）を持っているのに、
 * ここだけ別の規則で切っていた。
 *
 * 記録側が拡張子を持たない名前（A1111 の `Model:`、レシピの `file_name`）で、
 * かつ**語幹にドットを含む**と剥がしすぎて索引側と一致しない。
 *
 * 実測: レシピ343件の LoRA 1,023本のうち **102本（10%）** が
 * `GENESIS_MK0.4` / `cross bikini_noobai_V1.0` / `feet_anime_il_v2.5` /
 * `illustriousXL_stabilizer_v1.7` のように**拡張子でない末尾ドット**を持つ。
 *
 * 版番号は名前の一部であって拡張子ではない。同じ罠は `stemOf`（`modelsView.js`）
 * のコメントも名指ししている——「最後の `.` から後ろを落とさない。
 * 拡張子の付いていない名前が版番号のところで切れる」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveOne } from '../web/core/modelResolver.js';
import { modelStem } from '../web/core/modelFileNames.js';

/*
 * `installedHas` は外へ出ていないので、`resolveOne` の**分岐が変わる場面**で測る。
 *
 * `resolveOne` は「1. 名前でそのまま引けるなら索引を当てない」を持つ。
 * つまり**索引に別名の候補を置いておけば**、名前で当たったかどうかが
 * 返り値に出る——当たれば `resolved:false`（触らない）、外せば版IDで
 * 引き直して `resolved:true` になる。
 *
 * **この形にしないと測れなかった。** 最初は索引を空で渡していたので、
 * 当たっても外しても `resolved:false` で同じ返りになり、**変異を入れても
 * 緑のまま**だった（実際に踏んだ）。
 */
function resolveWithIndex(name, installed) {
    return resolveOne(
        { file_name: name, modelVersionId: 42 },
        { byVersionId: { 42: 'SOMETHING_ELSE.safetensors' }, byModelId: {}, bySha10: {}, byName: {} },
        installed,
    );
}

test('版番号のドットを拡張子として剥がさない', () => {
    // 手元に「そのままの名前」が在るので、**索引を当てずに済む**はず。
    const out = resolveWithIndex('GENESIS_MK0.4', ['GENESIS_MK0.4.safetensors']);
    assert.equal(out.resolved, false,
        `手元に在る名前なのに索引で引き直している: ${JSON.stringify(out)}`);
});

test('対照: 手元に無ければ、今までどおり索引で引き直す', () => {
    const out = resolveWithIndex('GENESIS_MK0.4', ['SOMETHING_ELSE.safetensors']);
    assert.equal(out.resolved, true, '引き直しの経路まで塞いでいる');
    assert.equal(out.name, 'SOMETHING_ELSE.safetensors');
});

test('対照: 普通の名前は今までどおり当たる', () => {
    const out = resolveWithIndex('plain', ['plain.safetensors']);
    assert.equal(out.resolved, false);
});

test('唯一の規則（modelStem）と同じ切り方になっている', () => {
    // **規則が2つ在ることそのもの**を留める。片方だけ直しても気づけるように。
    for (const name of [
        'GENESIS_MK0.4', 'cross bikini_noobai_V1.0', 'feet_anime_il_v2.5',
        'illustriousXL_stabilizer_v1.7', 'plain_name',
    ]) {
        assert.equal(modelStem(name), name.split('/').pop(),
            `唯一の規則が版番号を落としている: ${name} → ${modelStem(name)}`);
    }
});

test('対照: 本物の拡張子は今までどおり落ちる', () => {
    assert.equal(modelStem('a.safetensors'), 'a');
    assert.equal(modelStem('dir/b.ckpt'), 'b');
    assert.equal(modelStem('c.pt'), 'c');
});
