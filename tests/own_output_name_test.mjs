/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **こちらが投げる回は、こちらの名前で保存する**（2026-08-26 実機）。
 *
 * 「作者が決めた行き先を上書きしない」は**人が開いて回すグラフ**の話。
 * Unbake が自分で投げた回まで作者の行き先へ落とすと、**出した絵を自分で
 * 見つけられない**。
 *
 * 実機の `civitai_139981506` は `filename_prefix: "Anima/2026-08-17/hshi"` を
 * 持っていて、再現した絵はそこへ落ちていた。記録に紐づかないので
 * `/unbake/outputs?id=139981506` は **0件**を返し、「絵は出ませんでした。
 * ComfyUI の履歴にも、出力フォルダにも見つかりません」と言い続けていた
 * ——**絵は在ったのに。**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecipeWorkflow } from '../web/core/recipeWorkflowBuilder.js';

/** 作者が行き先を決めている記録（実物 `civitai_139981506` の形）。 */
function recipeWithOwnPrefix() {
    return {
        id: 'civitai_139981506',
        title: 'civitai_139981506',
        base_model: 'Anima',
        checkpoint: { file_name: 'anima_aestheticV11.safetensors' },
        loras: [],
        gen_params: { prompt: 'a', negative_prompt: '', seed: 1, steps: 20,
                      cfg_scale: 5, sampler: 'euler', size: '512x512' },
        prompt: {
            1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'c.safetensors' } },
            2: { class_type: 'CLIPTextEncode', inputs: { text: 'a', clip: ['1', 1] } },
            3: { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
            4: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
            5: { class_type: 'KSampler', inputs: { seed: 1, steps: 20, cfg: 5,
                 sampler_name: 'euler', scheduler: 'normal', denoise: 1,
                 model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0] } },
            6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
            7: { class_type: 'SaveImage',
                 inputs: { filename_prefix: 'Anima/2026-08-17/hshi', images: ['6', 0] } },
        },
    };
}

const OBJECT_INFO = {
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [['c.safetensors']] } } },
    CLIPTextEncode: {}, EmptyLatentImage: {}, KSampler: {}, VAEDecode: {},
    SaveImage: { output_node: true },
};

const prefixOf = (built) => Object.values(built?.prompt || {})
    .find(node => node?.class_type === 'SaveImage')?.inputs?.filename_prefix;

test('人が開くぶんは、作者の行き先を変えない', () => {
    const built = buildRecipeWorkflow(recipeWithOwnPrefix(), {
        objectInfo: OBJECT_INFO, embeddings: [],
    });
    assert.equal(prefixOf(built), 'Anima/2026-08-17/hshi',
        '作者が決めた行き先を勝手に変えている');
});

test('こちらが投げるぶんは、こちらの名前にする', () => {
    // **これが無いと、出した絵を自分で見つけられない。**
    const built = buildRecipeWorkflow(recipeWithOwnPrefix(), {
        objectInfo: OBJECT_INFO, embeddings: [], ownOutputs: true,
    });
    const prefix = prefixOf(built);
    assert.ok(String(prefix).includes('139981506'),
        `記録に紐づく名前になっていない: ${prefix}`);
    assert.notEqual(prefix, 'Anima/2026-08-17/hshi');
});

test('掃引が投げるグラフは、こちらの名前で保存される', async () => {
    // **配線まで見る。** 口が在っても、投げる側が頼まなければ意味が無い。
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../web/core/recipeSweep.js', import.meta.url), 'utf8');
    const at = source.indexOf('buildRecipeWorkflow(variedRecipe, {');
    assert.ok(at >= 0, '投げるグラフの組み立てが見つからない');
    assert.ok(source.slice(at, at + 400).includes('ownOutputs: true'),
        '投げる側が名前の付け替えを頼んでいない');
});
