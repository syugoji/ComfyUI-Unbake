/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **負の強度の LoRA を、画面から振れること**（2026-08-31・監査 I-20260831-07）。
 *
 * `web/core/sweepAxes.js` は範囲を `[-2, 2]` にしていて、その直前に
 * 「**範囲を `[0, 2]` にしない。** 負の強度は誤りではなく、明るさや年齢の
 * slider LoRA は負で使うことが正しい使い方である（実データ346件に実在）。
 * 0 で切ると、その種類の LoRA を振る実験そのものができなくなる」と書いてある。
 * ところが**画面側の `NUMBER_RANGES` だけが `min: 0`** だった。
 *
 * 実データでの露出は自分の出力411枚中2枚（0.5%）。少ないが、
 * **その2枚では実験そのものが作れない**。
 *
 * **この不具合は、人形を直すまで原理的に赤くできなかった。**
 * `tests/fake_dom.mjs` の `value` は range の `min`/`max` で丸めていなかったので、
 * 偽DOM上では `-0.7` が素通りし、実機で `0` に潰れる差が見えなかった
 * （`I-20260831-17` で人形を直した）。だからここは属性そのものを見るだけでなく、
 * **値を入れて丸められないこと**まで測る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSweepView } from '../web/panel/sweepView.js';
import { buildBuiltinSweepTemplates } from '../web/core/sweepAxes.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale } from '../web/i18n/index.js';

const OBJECT_INFO = {
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [['base.safetensors']] } } },
    LoraLoader: { input: { required: { lora_name: [['brightness_slider.safetensors']] } } },
};

/** 明るさの slider LoRA を**負の強度**で使っている記録。 */
const negativeRecipe = () => ({
    id: 'rec-neg',
    checkpoint: { file_name: 'base.safetensors', modelVersionId: 1 },
    gen_params: { prompt: 'a cat', seed: 1, steps: 20, cfg_scale: 4, sampler: 'euler' },
    loras: [{ file_name: 'brightness_slider.safetensors', name: 'Brightness', modelVersionId: 111, strength: -0.7 }],
});

function mountSweep(recipe) {
    const doc = fakeDocument();
    return createSweepView({
        documentRef: doc,
        record: { id: recipe.id, recipe, displayName: 'rec-neg' },
        runner: { objectInfo: OBJECT_INFO },
    });
}

/**
 * 強度の雛形を選んでスライダーを出す。
 * **選ぶまで出ない**ので、面を起こしただけでは触り口に届かない。
 */
function strengthSliders(view) {
    const select = view.root.byClass('unbake-sweep-template');
    const option = [...select.children]
        .find(node => String(node.getAttribute('value')).includes('lora-'));
    assert.ok(option, `強度の雛形が選択肢に無い: ${[...select.children].map(n => n.getAttribute('value'))}`);
    select.value = option.getAttribute('value');
    select.dispatch('change', {});
    return view.root.allByClass('unbake-sweep-slider')
        .filter(node => node.getAttribute('type') === 'range');
}

test('中核の軸は、負の基準からでも振れる値を出す', () => {
    setLocale('en');
    const templates = buildBuiltinSweepTemplates(negativeRecipe(), { objectInfo: OBJECT_INFO });
    const axis = templates
        .flatMap(template => template.axes || [])
        .find(item => item.kind === 'lora_strength');
    assert.ok(axis, '強度の軸が作られていない（前提が崩れている）');

    const values = (axis.values || []).map(item => Number(item?.value ?? item));
    assert.ok(values.some(value => value < 0),
        `負の基準なのに、振る値が全部 0 以上になっている: ${JSON.stringify(values)}`);
});

test('画面の強度スライダーが、負の値を丸めない', () => {
    setLocale('en');
    const view = mountSweep(negativeRecipe());
    const sliders = strengthSliders(view);
    assert.ok(sliders.length > 0, '強度のスライダーが1本も出ていない（前提が崩れている）');

    for (const slider of sliders) {
        assert.ok(Number(slider.getAttribute('min')) <= -2,
            `下限が中核より狭い: min=${slider.getAttribute('min')}`
            + '（sweepAxes.js は -2 まで振ると宣言している）');
        // **属性だけでなく、実際に入れて確かめる。** 人形が range を丸めるように
        // なったので、下限が 0 のままならここで潰れる。
        slider.value = '-0.7';
        assert.equal(Number(slider.value), -0.7,
            `負の値が丸められている（画面から入れられない）: ${slider.value}`);
    }
});

test('対照: 範囲の外はやはり丸める（宣言を無効にしたのではない）', () => {
    setLocale('en');
    const view = mountSweep(negativeRecipe());
    const slider = strengthSliders(view)[0];
    slider.value = '9';
    assert.equal(Number(slider.value), 2, '上限を外している＝範囲そのものを無効にした');
});
