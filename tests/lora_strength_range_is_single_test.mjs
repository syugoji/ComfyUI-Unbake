/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * **LoRA 強度の範囲は1つ**（2026-09-01・走査15周目）。
 *
 * 負の強度は誤りではない——明るさや年齢の slider LoRA は**負で使うのが正しい**
 * （実データ346件に実在）。中核はそう宣言していて、`I-20260831-07` が
 * `sweepView.js` の下限を 0 から -2 へ直している。
 *
 * **ところが強度を触る口はもう1つあった。** `modelsView.js` のつまみは
 * `min: '0'` のままで、直っていたのは片方だけだった。実ブラウザで測った害:
 *
 *   min=0  / 記録 -0.50 → `input.value` は **"0"**（つまみが記録を表せない）
 *   min=-2 / 記録 -0.50 → `input.value` は "-0.5"
 *
 * `<input type=range>` は範囲外の値を黙って丸めるので、**つまみは 0・字は
 * 「-0.50」**という食い違った行が開き、`↺`（記録どおりへ戻す）も同じ代入なので
 * **一度触ると負へは二度と戻せない**。
 *
 * **綴りは留めない。** 見るのは関係——「中核が振る値を、どの口も表せること」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LORA_STRENGTH_RANGE, buildBuiltinSweepTemplates } from '../web/core/sweepAxes.js';
import { createModelsView } from '../web/panel/modelsView.js';
import { createSweepView } from '../web/panel/sweepView.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale } from '../web/i18n/index.js';

/** 負の強度を持つ記録（明るさ slider LoRA の使い方）。 */
const NEGATIVE = -0.5;

const recipeWith = (strength) => ({
    id: 'rec-1', title: 'T',
    checkpoint: { file_name: 'base.safetensors' },
    comfy_prompt: { 1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'base.safetensors' } } },
    gen_params: { prompt: 'a', seed: 12, steps: 20, cfg_scale: 7, sampler: 'euler' },
    loras: [{ file_name: 'bright.safetensors', name: 'Bright', modelVersionId: 111, strength }],
});

const IO = {
    plan: async () => ({ ok: true, state: 'one', bytes: 1, files: ['x'], usage: { count: 1 } }),
    usage: async () => ({ ok: true, count: 1 }),
    remove: async () => ({ ok: true }),
};

function mountModels(strength) {
    const doc = fakeDocument();
    const view = createModelsView({
        documentRef: doc,
        record: { id: 'rec-1', recipe: recipeWith(strength) },
        recipe: recipeWith(strength),
        io: IO,
        onDelete: () => {},
        onLoraStrength: () => {},
        loraStrengthOf: () => null,
    });
    return { view, slider: view.root.byClass('unbake-models-strength') };
}

// --- 前提: 中核は本当に負の値を出す（検出器が生きているか）------------------

test('中核は負の強度を候補に出す（この検査が空回りしていない印）', () => {
    setLocale('en');
    const templates = buildBuiltinSweepTemplates(recipeWith(NEGATIVE), { objectInfo: {} });
    const axis = templates.flatMap(item => item.axes || [])
        .find(item => item.kind === 'lora_strength');
    assert.ok(axis, '強度の軸が1本も出ていない（前提が崩れている）');
    const values = axis.values.map(value => Number(value.value));
    assert.ok(values.some(value => value < 0),
        `負の候補が出ていない: ${JSON.stringify(values)} — 以降の検査が空回りする`);
    assert.ok(LORA_STRENGTH_RANGE.minimum < 0, '中核の宣言そのものが負でない');
});

// --- 本体: どの口も、中核が振る範囲を覆う ------------------------------------

test('モデルの行のつまみは、中核が振る範囲を覆う', () => {
    setLocale('en');
    const { slider } = mountModels(0.8);
    assert.ok(slider, '強度のつまみが無い（前提が崩れている）');
    const min = Number(slider.getAttribute('min'));
    const max = Number(slider.getAttribute('max'));
    assert.ok(min <= LORA_STRENGTH_RANGE.minimum,
        `つまみの下限 ${min} が中核の ${LORA_STRENGTH_RANGE.minimum} を覆っていない`
        + ' — 実ブラウザは範囲外の値を黙って丸めるので、記録どおりに開けない');
    assert.ok(max >= LORA_STRENGTH_RANGE.maximum,
        `つまみの上限 ${max} が中核の ${LORA_STRENGTH_RANGE.maximum} を覆っていない`);
});

test('記録が負の強度でも、その値をつまみで表せる', () => {
    setLocale('en');
    const { view, slider } = mountModels(NEGATIVE);
    const min = Number(slider.getAttribute('min'));
    assert.ok(min <= NEGATIVE,
        `記録 ${NEGATIVE} が下限 ${min} の外に在る`
        + ' — 実ブラウザではここで value が 0 へ丸められ、字だけが -0.50 のまま残る');
    // 字の側は記録どおりに出ている（食い違うのはつまみだけ、を示す対照）。
    const readout = view.root.byClass('unbake-models-strength-value');
    assert.equal(readout.textContent, NEGATIVE.toFixed(2), '記録の値が字にも出ていない');
});

test('Sweep のつまみも同じ範囲を使う（口が2つに割れていない）', () => {
    setLocale('en');
    const doc = fakeDocument();
    const view = createSweepView({
        documentRef: doc,
        record: { id: 'rec-1', recipe: recipeWith(NEGATIVE), displayName: 'x' },
        runner: { objectInfo: {} },
    });
    const select = view.root.byClass('unbake-sweep-template');
    const strength = [...select.children].find(o => /^LoRA strength \(/.test(o.textContent || ''));
    assert.ok(strength, '強度の雛形が出ていない（前提が崩れている）');
    select.value = strength.getAttribute('value');
    select.dispatch('change');
    const slider = view.root.byClass('unbake-sweep-slider');
    assert.equal(Number(slider.getAttribute('min')), LORA_STRENGTH_RANGE.minimum,
        'Sweep のつまみが中核と別の下限を持っている');
    assert.equal(Number(slider.getAttribute('max')), LORA_STRENGTH_RANGE.maximum,
        'Sweep のつまみが中核と別の上限を持っている');
    view.destroy();
});

test('対照: 正の強度は今までどおり開く', () => {
    setLocale('en');
    const { view, slider } = mountModels(0.8);
    assert.equal(Number(slider.value), 0.8, '記録の値がつまみに入っていない');
    assert.equal(view.root.byClass('unbake-models-strength-value').textContent, '0.80');
});
