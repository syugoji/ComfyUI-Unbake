/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **複数語のスケジューラ接尾辞を切り出せること**（2026-08-31・監査 I-20260831-16）。
 *
 * `parseCombinedSamplerName` は `lastIndexOf('_')` と `lastIndexOf(' ')` で
 * **1回しか切らない**ので、`SCHEDULER_SUFFIXES` に並ぶ複数語の4つ
 * （`sgm_uniform` / `ddim_uniform` / `linear_quadratic` / `kl_optimal`）は
 * 候補が常に `uniform` / `quadratic` / `optimal` になり、**絶対に一致しない**。
 * 表の冒頭は「longest-match-first parsing のため長さ降順に並べた」と書いているが、
 * **その最長一致は実装されていなかった**——表の半分だけが死んでいた。
 *
 * 落ちた値は後段の緩い判定に拾われ、**存在しないサンプラー名としてそのまま返る**。
 * `er_sde_sgm_uniform` は ComfyUI の SAMPLERS に無い（`er_sde` がサンプラーで
 * `sgm_uniform` がスケジューラ）ので、KSampler の COMBO へ書くと弾かれるか
 * 無効値のまま残る。しかも scheduler 側は null なので**ノードの既定値が据え置かれ、
 * 記録に書いてあるスケジューラが黙って別物になる**。
 *
 * 露出は自分のレシピ343件中2件（`er_sde_sgm_uniform`）。ComfyUI 出力3,691枚の
 * `sampler_name` には0件。少ないが、**外し方が「黙って別の絵になる」側**である。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveSamplerScheduler } from '../web/core/genParamsMapper.js';

test('下線でつないだ複数語の接尾辞を切り出す', () => {
    assert.deepEqual(resolveSamplerScheduler('er_sde_sgm_uniform'),
        { sampler: 'er_sde', scheduler: 'sgm_uniform' });
    assert.deepEqual(resolveSamplerScheduler('dpmpp_2m_sgm_uniform'),
        { sampler: 'dpmpp_2m', scheduler: 'sgm_uniform' });
    assert.deepEqual(resolveSamplerScheduler('euler_kl_optimal'),
        { sampler: 'euler', scheduler: 'kl_optimal' });
    assert.deepEqual(resolveSamplerScheduler('dpmpp_2m_linear_quadratic'),
        { sampler: 'dpmpp_2m', scheduler: 'linear_quadratic' });
    assert.deepEqual(resolveSamplerScheduler('euler_ddim_uniform'),
        { sampler: 'euler', scheduler: 'ddim_uniform' });
});

test('対照: 1語の接尾辞は元から通っていた（壊していない）', () => {
    assert.deepEqual(resolveSamplerScheduler('er_sde_beta'),
        { sampler: 'er_sde', scheduler: 'beta' });
    assert.deepEqual(resolveSamplerScheduler('dpmpp_2m_karras'),
        { sampler: 'dpmpp_2m', scheduler: 'karras' });
    assert.deepEqual(resolveSamplerScheduler('euler_normal'),
        { sampler: 'euler', scheduler: 'normal' });
});

test('対照: 接尾辞を持たない名前は、そのままサンプラーとして返る', () => {
    assert.deepEqual(resolveSamplerScheduler('euler_ancestral'),
        { sampler: 'euler_ancestral', scheduler: null });
    assert.deepEqual(resolveSamplerScheduler('dpmpp_3m_sde'),
        { sampler: 'dpmpp_3m_sde', scheduler: null });
});

test('接尾辞そのものと同じ名前のサンプラーを、切り落とさない', () => {
    // **`euler` の後ろに何も無い**。最長一致を入れたせいで空のサンプラーを
    // 作らないこと（`_beta` だけ、のような入力で崩れないか）。
    const solo = resolveSamplerScheduler('beta');
    assert.equal(solo.sampler !== '', true, `サンプラーが空になっている: ${JSON.stringify(solo)}`);
});
