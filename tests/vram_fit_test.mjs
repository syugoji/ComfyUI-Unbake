/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **VRAM に収まらないモデルを、投げる前に言う**（2026-08-26 実機の報告）。
 *
 * 「`civitai_139164303` で生成すると動作が極端に遅くなり、生成が始まりません
 * でした」。実測するとグラフは正しかった——組み立て 11ms、`object_info` と
 * 突き合わせて候補外の入力は0件。壊れていたのは**大きさの方**:
 *
 *     krea2Turbo_v10.safetensors  13.1 GB
 *     RTX 3080 Ti                 12.0 GB
 *
 * 入らないので ComfyUI は主記憶へ追い出しながら回し、機械ごと重くなる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelFilesIn, modelTooBigForVram, sizeOf } from '../web/core/vramFit.js';

/** 実物（`civitai_139164303` を組んだ結果）から採った形。 */
const PROMPT = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: 'Krea 2\\base model\\krea2Turbo_v10.safetensors' } },
    8: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_4b_bf16.safetensors', type: 'krea2' } },
    9: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
    10: { class_type: 'LoraLoader', inputs: {
        lora_name: 'Krea 2\\style\\Krea_2_zidiusArt_Melancholy_v2.safetensors',
        model: ['1', 0], clip: ['8', 0], strength_model: 1 } },
    5: { class_type: 'KSampler', inputs: { model: ['10', 0], seed: 1 } },
};

const VRAM = 12884377600;  // 実測: RTX 3080 Ti

function sizes() {
    return {
        diffusion_models: { 'Krea 2/base model/krea2Turbo_v10.safetensors': 13100000000 },
        text_encoders: { 'qwen3vl_4b_bf16.safetensors': 8000000000 },
        vae: { 'qwen_image_vae.safetensors': 250000000 },
        loras: { 'Krea 2\\style\\Krea_2_zidiusArt_Melancholy_v2.safetensors': 200000000 },
    };
}

test('グラフが読むモデルを、置き場つきで拾う', () => {
    const found = modelFilesIn(PROMPT);
    assert.deepEqual(found.map(f => f.folder).sort(),
        ['diffusion_models', 'loras', 'text_encoders', 'vae']);
    // **繋いだ線は名前ではない。** `['1', 0]` を拾うと存在しないモデルを探す。
    assert.ok(!found.some(f => Array.isArray(f.name)));
});

test('入れ子に置いたモデルも当たる（区切りを揃える）', () => {
    // ComfyUI は `Krea 2\\base model\\…` と返し、一覧は `/` で返ることがある。
    // **揃えないと、入れ子に置いたモデルは1本も当たらない。**
    assert.equal(
        sizeOf(sizes(), 'diffusion_models', 'Krea 2\\base model\\krea2Turbo_v10.safetensors'),
        13100000000);
});

test('収まらない一番大きい1本を言う', () => {
    const got = modelTooBigForVram(PROMPT, { sizes: sizes(), vramTotal: VRAM });
    assert.ok(got, '入らないのに黙っている');
    assert.match(got.name, /krea2Turbo_v10/);
    assert.equal(got.bytes, 13100000000);
    assert.equal(got.vramTotal, VRAM);
});

test('合計では見ない（入れ替わるので、入るものまで警告しない）', () => {
    // テキストエンコーダ 8GB + 拡散 5GB は合計 13GB だが、ComfyUI は
    // **同時には常駐させない**。合計で見ると入るものを「入らない」と言う。
    const small = sizes();
    small.diffusion_models['Krea 2/base model/krea2Turbo_v10.safetensors'] = 5000000000;
    assert.equal(modelTooBigForVram(PROMPT, { sizes: small, vramTotal: VRAM }), null);
});

test('測れていないときは黙る', () => {
    // **0 と比べると全部が「入らない」になる。**
    assert.equal(modelTooBigForVram(PROMPT, { sizes: sizes(), vramTotal: 0 }), null);
    assert.equal(modelTooBigForVram(PROMPT, { sizes: null, vramTotal: VRAM }), null);
    assert.equal(modelTooBigForVram(PROMPT, {}), null);
});

test('大きさが判らないモデルは、勝手に大きいと決めない', () => {
    // 一覧に無い＝**測れていない**。0 として黙る（推測で警告しない）。
    assert.equal(modelTooBigForVram(PROMPT, { sizes: { vae: {} }, vramTotal: VRAM }), null);
});

// --- 消す面を、消さない問いに使い回さない（2026-08-26 実機）-----------------

import { createConfirmView } from '../web/panel/confirmView.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale, t } from '../web/i18n/index.js';

setLocale('ja');

function openView(options) {
    const doc = fakeDocument();
    return createConfirmView({ documentRef: doc, title: '問い', onConfirm: async () => ({ ok: true }), ...options });
}

test('消さない問いでは、消す用の言い回しを出さない', () => {
    /*
     * 再現の前に聞く2つ（分割復号・VRAM に載らない）は この面を借りていたが、
     * 中身は消す用のままで、**何も消さないのに**「これは取り消せません」
     * 「0 個のファイル・合計 —」「消す」と出ていた。
     */
    const view = openView({ destructive: false, confirmLabel: t('replay.runAnyway'), warnings: ['重い'] });
    const text = view.root.text;
    assert.doesNotMatch(text, /取り消せません/, '消さないのに「取り消せない」と言っている');
    assert.doesNotMatch(text, /個のファイル/, '数える物が無いのに件数を出している');
    assert.doesNotMatch(text, /二度と表示しない/, '消す前の確認の設定を、別の問いで切らせている');
    assert.doesNotMatch(text, /消す/, '進む口が「消す」になっている');
    assert.match(text, /このまま回す/, '進む口の名前が問いに合っていない');
    assert.match(text, /やめる/, 'やめる口が無い');
});

test('消す面は今までどおり', () => {
    // **全部を消さない面にしない。** 消す前の断りは残す。
    const view = openView({ files: [{ name: 'a.png', bytes: 100 }] });
    const text = view.root.text;
    assert.match(text, /取り消せません/);
    assert.match(text, /1 個のファイル/);
    assert.match(text, /二度と表示しない/);
    assert.match(text, /消す/);
});
