/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **再現した絵が改造 LoRA Manager のものと違う**（2026-08-27 実機・`civitai_77742180`）。
 *
 * 両方の PNG から埋め込みグラフを取り出して突き合わせたら、**差は LoRA の本数だけ**
 * だった——LoRA Manager は4本、Unbake は1本。checkpoint・寸法・seed・steps・cfg・
 * sampler・scheduler・denoise・CLIP Skip は完全に一致していた。
 *
 * ---
 *
 * **原因は2つ重なっていた。**
 *
 * **①「タグに無い＝使っていない」が成り立たない形がある。**
 * Civitai の生成画面はインラインタグを**一部の LoRA にしか書かない**。この記録は
 * `<lora:tove-nikke-richy-v1_ixl:1>` の1本だけだが、同じ A1111 メタデータの
 * `Civitai resources:` には**4本が版ID付きで並んでいる**（0.45 / 0.9 / 0.7 / 1）。
 * レシピの台帳も同じ4本で、**版IDが完全一致**していた。
 * それでもタグを唯一の権威として扱っていたので、**3本が黙って落ちた。**
 *
 * **②その `Civitai resources` を、そもそも読めていなかった。**
 * `normalizeResources()` が種別と版IDを `urn:air:…` からしか取らず、
 * Civitai が実際に書く素の形（`{"type":"lora","modelVersionId":…}`）を
 * **全部 `null` に潰していた**。潰れると `kind === 'lora'` の絞り込みは常に0件で、
 * ①を直す材料そのものが手に入らない。
 *
 * **どちらか片方だけ直しても直らない。** だから検査も2つ並べる。
 *
 * ---
 *
 * **③ おまけで見つかった `smZ_steps`。** 突き合わせに残ったもう1点。
 * LoRA Manager は歩数（30）を渡し、こちらは渡していなかったので既定 **1** が
 * 当たっていた。効くのは**プロンプト編集構文**（`[昼:夜:10]`）で、1 のままだと
 * **切り替えが起きない**。この記録は編集構文を持たないので絵は変わらなかったが、
 * **持つ記録では変わる**——「今回は害が出ていない」を「直さなくてよい」と読まない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeResources, parseA1111Parameters } from '../web/core/a1111Parameters.js';
import { buildRecipeWorkflow } from '../web/core/recipeWorkflowBuilder.js';
import { setLocale } from '../web/i18n/index.js';

setLocale('ja');

/** 実データ（`Civitai_Recipe_77742180`）と同じ形の `Civitai resources:`。 */
const RESOURCES = JSON.stringify([
    { type: 'checkpoint', modelVersionId: 1761560, modelName: 'WAI-NSFW-illustrious-SDXL', modelVersionName: 'v14.0' },
    { type: 'lora', weight: 0.45, modelVersionId: 1056404, modelName: '748cm', modelVersionName: 'v1.0' },
    { type: 'lora', weight: 0.9, modelVersionId: 1135769, modelName: 'Kawaii tech', modelVersionName: 'ILXL' },
    { type: 'lora', weight: 0.7, modelVersionId: 1373674, modelName: "Velvet's Mythic", modelVersionName: 'illustrious' },
    { type: 'lora', weight: 1, modelVersionId: 1809862, modelName: 'Tove (NIKKE)', modelVersionName: 'tove-nikke-richy-v1_ixl' },
]);

const PROMPT = 'a girl, <lora:tove-nikke-richy-v1_ixl:1>, blue eyes';

const A1111 = [
    PROMPT,
    'Negative prompt: bad hands',
    `Steps: 30, Sampler: DDIM, CFG scale: 3.5, Seed: 2057504659, Size: 832x1216,`
        + ` Clip skip: 2, Civitai resources: ${RESOURCES}, Civitai metadata: {}`,
].join('\n');

const RECORD = () => ({
    id: 'rec-77742180',
    title: 'Civitai_Recipe_77742180',
    a1111_parameters: A1111,
    checkpoint: { file_name: 'waiIllustriousSDXL_v140', modelVersionId: 1761560 },
    loras: [
        { file_name: '748cmSDXL', strength: 0.45, modelVersionId: 1056404 },
        { file_name: 'NV_KawaiiTech_WM_IL_SH', strength: 0.9, modelVersionId: 1135769 },
        { file_name: 'ILLMythP0rtr4itStyle', strength: 0.7, modelVersionId: 1373674 },
        { file_name: 'tove-nikke-richy-v1_ixl', strength: 1, modelVersionId: 1809862 },
    ],
    gen_params: {
        prompt: PROMPT, negative_prompt: 'bad hands', seed: 2057504659,
        steps: 30, cfg_scale: 3.5, sampler: 'DDIM', size: '832x1216', clip_skip: 2,
    },
});

const lorasIn = (built) => Object.values(built?.prompt || {})
    .filter(node => node?.class_type === 'LoraLoader')
    .map(node => ({
        name: String(node.inputs.lora_name),
        model: node.inputs.strength_model,
        clip: node.inputs.strength_clip,
    }));

// --- ② 資源欄を読めること（①の材料）------------------------------------------

test('`Civitai resources` は air が無くても種別と版IDが読める', () => {
    const parsed = parseA1111Parameters(A1111);
    assert.equal(parsed.ok, true);
    const flat = normalizeResources(parsed.resources);
    const loras = flat.filter(item => item.kind === 'lora');
    assert.equal(loras.length, 4,
        'air が無い素の形で種別が読めていない（kind が全部 null に潰れている）');
    assert.deepEqual(loras.map(item => item.modelVersionId),
        [1056404, 1135769, 1373674, 1809862], '版IDが読めていない');
    assert.deepEqual(loras.map(item => item.weight), [0.45, 0.9, 0.7, 1]);
    // checkpoint も同じ経路で読める（版IDが要る側が他にも居る）。
    assert.equal(flat.find(item => item.kind === 'checkpoint')?.modelVersionId, 1761560);
});

test('air が在るときは今までどおり air を優先する', () => {
    const flat = normalizeResources([
        { air: 'urn:air:sdxl:lora:civitai:111@222', type: 'checkpoint', modelVersionId: 999 },
    ]);
    assert.equal(flat[0].kind, 'lora', 'air より素の欄を優先している');
    assert.equal(flat[0].modelVersionId, 222);
    assert.equal(flat[0].modelId, 111);
});

// --- ① タグに無くても、A1111 が名指しした LoRA は積む -------------------------

test('プロンプトのタグが1本でも、資源欄が名指しした4本を積む', () => {
    const built = buildRecipeWorkflow(RECORD(), {});
    const loras = lorasIn(built);
    assert.equal(loras.length, 4,
        `台帳4本のうち ${loras.length} 本しか積んでいない（タグに無い分を落としている）`);
    assert.deepEqual(loras.map(item => item.model), [0.45, 0.9, 0.7, 1],
        '強度が資源欄の申告と食い違う');
    // **タグが指す1本の重みはタグが決める**（そこは今までどおり）。
    assert.equal(loras[3].model, 1);
});

test('資源欄がLoRAを1つも名指ししていなければ、今までどおりタグで絞る', () => {
    // **この規則を広げすぎない。** 資源欄が無いレシピでタグを無視すると、
    // 「この画像では使っていない」を読み取る唯一の手掛かりが消える。
    const record = RECORD();
    record.a1111_parameters = [
        PROMPT, 'Negative prompt: bad hands',
        'Steps: 30, Sampler: DDIM, CFG scale: 3.5, Seed: 1, Size: 832x1216, Clip skip: 2',
    ].join('\n');
    const built = buildRecipeWorkflow(record, {});
    assert.equal(lorasIn(built).length, 1,
        '資源欄が無いのに台帳を丸ごと積んでいる（タグで絞る規則が死んでいる）');
});

test('落とすときは、落としたと言う', () => {
    const record = RECORD();
    record.a1111_parameters = [
        PROMPT, 'Negative prompt: bad hands',
        'Steps: 30, Sampler: DDIM, CFG scale: 3.5, Seed: 1, Size: 832x1216, Clip skip: 2',
    ].join('\n');
    const built = buildRecipeWorkflow(record, {});
    const said = (built.warnings || []).some(text => /LoRA/.test(text) && /3/.test(text));
    assert.ok(said,
        `3本落としたのに黙っている: ${JSON.stringify(built.warnings || [])}`);
});

// --- ③ smZ_steps --------------------------------------------------------------

test('smZ には歩数を渡す（既定の 1 のままにしない）', () => {
    const built = buildRecipeWorkflow(RECORD(), {
        objectInfo: { 'smZ CLIPTextEncode': { input: { required: {} } } },
    });
    const smz = Object.values(built.prompt).filter(node => node?.class_type === 'smZ CLIPTextEncode');
    assert.ok(smz.length > 0, 'smZ に差し替わっていない（この検査が空振りしている）');
    for (const node of smz) {
        assert.equal(node.inputs.smZ_steps, 30,
            'プロンプト編集構文の切り替え位置が、既定 1 で割られる');
    }
});

// --- 記録が持つ生成グラフの LoRA 強度（2026-08-27 実機・`civitai_128383826`）------
//
// 「生成画像が改造 LoRA Manager から変化しています」。突き合わせると**実行経路は
// 完全に同一**で、違ったのは**LoRA の強度だけ**だった:
//
//     ノード26 rimixO                    グラフ 0.4 → **1.0 に書き換え**
//     ノード30 Dramatic Lighting Slider  グラフ 3.0 → **1.0 に書き換え**
//
// 一覧の `loras` はどちらも `strength: 1` を持っている。**要約はグラフから作った
// 写しにすぎず、桁が落ちていた**。3.0 で当てた絵を 1.0 で出せば別の絵になる。

const EMBEDDED = () => ({
    id: 'rec-embedded',
    checkpoint: { file_name: 'base' },
    loras: [{ file_name: 'slider', strength: 1 }, { file_name: 'rimix', strength: 1 }],
    gen_params: { prompt: 'a girl', negative_prompt: '', seed: 1, steps: 40, cfg_scale: 0.7, sampler: 'Euler', size: '768x1152' },
    comfy_prompt: {
        1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'base.safetensors' } },
        26: { class_type: 'LoraLoader', inputs: { lora_name: 'rimix.safetensors', strength_model: 0.4, strength_clip: 0.4, model: ['1', 0], clip: ['1', 1] } },
        30: { class_type: 'LoraLoader', inputs: { lora_name: 'slider.safetensors', strength_model: 3, strength_clip: 3, model: ['26', 0], clip: ['26', 1] } },
        6: { class_type: 'CLIPTextEncode', inputs: { text: 'a girl', clip: ['30', 1] } },
        7: { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['30', 1] } },
        24: { class_type: 'EmptyLatentImage', inputs: { width: 768, height: 1152, batch_size: 1 } },
        3: { class_type: 'KSampler', inputs: { seed: 1, steps: 40, cfg: 0.7, sampler_name: 'euler', scheduler: 'karras', denoise: 1, model: ['30', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['24', 0] } },
        8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['1', 2] } },
        9: { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI', images: ['8', 0] } },
    },
});

const strengthsOf = (built) => Object.values(built.prompt)
    .filter(n => n.class_type === 'LoraLoader')
    .map(n => [String(n.inputs.lora_name).replace(/\.safetensors$/, ''), n.inputs.strength_model])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));

test('記録が持つ生成グラフの LoRA 強度を、一覧の値で上書きしない', () => {
    const built = buildRecipeWorkflow(EMBEDDED(), {});
    assert.deepEqual(strengthsOf(built), [['rimix', 0.4], ['slider', 3]],
        '要約の 1.0 でグラフの値を潰している（絵が別物になる）');
});

test('上書きしなかったことを黙らない', () => {
    const built = buildRecipeWorkflow(EMBEDDED(), {});
    const said = (built.warnings || []).some(text => /グラフ/.test(text) && /LoRA/.test(text));
    assert.ok(said, `どちらを採ったか言っていない: ${JSON.stringify(built.warnings || [])}`);
});

test('組み直した記録では、今までどおり一覧の値を当てる', () => {
    // **守りを広げすぎない。** グラフを持たない記録では一覧が唯一の出典なので、
    // ここまで守ると LoRA が全部 1.0 のまま出ることになる。
    const record = EMBEDDED();
    delete record.comfy_prompt;
    record.loras = [{ file_name: 'rimix', strength: 0.6 }];
    const built = buildRecipeWorkflow(record, {});
    assert.deepEqual(strengthsOf(built), [['rimix', 0.6]],
        'グラフが無いのに一覧の値を無視している');
});
