/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **足す節の番号を決め打ちにしない**（2026-08-31・監査 I-20260831-03）。
 *
 * `insertAdetailerStages` は `let nextId = 700;`、`applyRecordedNoiseSource` は
 * `let nextId = 800;` と決め打ちで採番し、**既存の鍵と衝突していないか一度も
 * 確かめていなかった**。同ファイルの他の採番はすべて `nextNodeId(prompt)`
 * （max+1）を通しているので、**ここだけが例外**だった。
 *
 * ComfyUI のノードIDは単調増加で再利用されないので、少し使い込んだ
 * ワークフローでは700台・800台は普通に存在する——**実測: 手元の出力411枚のうち
 * 47枚（11.4%）が700番台のIDを持ち、最大IDは900番台まで在った。**
 *
 * 衝突すると `prompt[id] = {...}` が**既存の節を丸ごと差し替える**。
 * 実測では `700: CheckpointLoaderSimple` が `UltralyticsDetectorProvider` に、
 * `701: 正のプロンプト` が `FaceDetailer` に化け、`KSampler.model` は
 * `["700",0]` を指したままなので MODEL の口へ BBOX_DETECTOR が流れる。
 * ComfyUI は Return type mismatch で投入ごと拒むが、**警告は1行も出ない**
 * ——画面には「ADetailer の段を復元しました」と成功だけが出る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildRecipeWorkflow } from '../web/core/recipeWorkflowBuilder.js';
import { toRecipeShape } from '../web/core/recordShape.js';
import { setLocale } from '../web/i18n/index.js';

const STOCK = Object.fromEntries([
    'CheckpointLoaderSimple', 'CLIPTextEncode', 'EmptyLatentImage',
    'KSampler', 'VAEDecode', 'SaveImage', 'LoraLoader', 'FaceDetailer',
].map(type => [type, { input: { required: {} } }]));
STOCK.UltralyticsDetectorProvider = {
    input: { required: { model_name: [['bbox/face_yolov8n.pt', 'bbox/hand_yolov8s.pt']] } },
};

/** ノードIDを `base` から並べた埋め込みグラフ。 */
function graphAt(base) {
    const id = n => String(base + n);
    return {
        [id(0)]: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'wai.safetensors' } },
        [id(1)]: { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece', clip: [id(0), 1] } },
        [id(2)]: { class_type: 'CLIPTextEncode', inputs: { text: 'lowres', clip: [id(0), 1] } },
        [id(3)]: { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1216, batch_size: 1 } },
        [id(4)]: { class_type: 'KSampler', inputs: {
            model: [id(0), 0], positive: [id(1), 0], negative: [id(2), 0], latent_image: [id(3), 0],
            seed: 1, steps: 14, cfg: 4, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 1 } },
        [id(5)]: { class_type: 'VAEDecode', inputs: { samples: [id(4), 0], vae: [id(0), 2] } },
        [id(6)]: { class_type: 'SaveImage', inputs: { images: [id(5), 0] } },
    };
}

const A1111 = [
    'masterpiece',
    'Negative prompt: lowres',
    'Steps: 14, Sampler: DPM++ 2M, CFG scale: 4, Seed: 1, Size: 832x1216',
    'ADetailer model: face_yolov8n.pt, ADetailer confidence: 0.3, ADetailer denoising strength: 0.4',
].join('\n');

function build(base) {
    setLocale('en');
    const recipe = toRecipeShape({
        id: 'r', title: 'r', checkpoint: 'wai.safetensors', loras: [],
        seed: 1, steps: 14, cfg: 4, sampler: 'dpmpp_2m', scheduler: 'karras',
        width: 832, height: 1216, positive: 'masterpiece', negative: 'lowres',
        comfy_prompt: graphAt(base),
    });
    recipe.a1111_parameters = A1111;
    return buildRecipeWorkflow(recipe, { objectInfo: STOCK, embeddings: [] });
}

/** 埋め込みグラフが元から持っていた節が、全部残っているか。 */
function survivors(built, base) {
    const kinds = {};
    for (const [id, node] of Object.entries(built.prompt)) {
        kinds[id] = String(node.class_type);
    }
    return {
        checkpoint: kinds[String(base + 0)],
        positive: kinds[String(base + 1)],
        negative: kinds[String(base + 2)],
    };
}

test('700番台のグラフへ ADetailer を足しても、既存の節を潰さない', () => {
    const built = build(700);
    const kept = survivors(built, 700);
    assert.equal(kept.checkpoint, 'CheckpointLoaderSimple',
        `既存の節が差し替わった: 700 が ${kept.checkpoint} になっている`);
    assert.equal(kept.positive, 'CLIPTextEncode',
        `正のプロンプトが差し替わった: 701 が ${kept.positive} になっている`);

    // **段そのものは足されていること**（衝突を避けるために足すのをやめた、では困る）。
    const added = Object.values(built.prompt).map(node => String(node.class_type));
    assert.ok(added.includes('FaceDetailer'), 'ADetailer の段が足されていない');
    assert.ok(added.includes('UltralyticsDetectorProvider'), '検出器が足されていない');
});

test('KSampler の model が、モデルを出す節を指したままである', () => {
    const built = build(700);
    const sampler = Object.values(built.prompt).find(node => node.class_type === 'KSampler');
    const target = built.prompt[String(sampler.inputs.model?.[0])];
    assert.ok(target, 'KSampler.model が存在しない節を指している');
    assert.match(String(target.class_type), /Checkpoint|Lora|ModelSampling|Unet/,
        `MODEL の口へ ${target.class_type} が繋がっている（ComfyUI は投入ごと拒む）`);
});

test('対照: 100番台なら元から正しく足せていた', () => {
    const built = build(100);
    const kept = survivors(built, 100);
    assert.equal(kept.checkpoint, 'CheckpointLoaderSimple');
    assert.equal(kept.positive, 'CLIPTextEncode');
    assert.ok(Object.values(built.prompt).map(n => String(n.class_type)).includes('FaceDetailer'));
});

test('900番台でも潰さない（決め打ちを別の数へ動かしただけ、ではない）', () => {
    // **実測で最大IDは900番台まで在った。** 700 を 1000 に変えるような直し方だと、
    // ここで同じことが起きる。
    const built = build(900);
    const kept = survivors(built, 900);
    assert.equal(kept.checkpoint, 'CheckpointLoaderSimple',
        `900番台で潰している: ${kept.checkpoint}`);
    assert.equal(kept.positive, 'CLIPTextEncode');
});
