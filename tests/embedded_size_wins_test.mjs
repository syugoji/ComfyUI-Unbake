/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **埋め込みグラフの寸法を、記録の申告で上書きしない**
 *（2026-08-28 実機 `civitai_140604778`・利用者の報告
 *  「再現性高になったのですが、生成された絵が異なります」）。
 *
 * 実測（3つとも同じ1件から）:
 *
 *     参照画像の実寸      832 x 1216   ← 現物（PNG の IHDR）
 *     埋め込みグラフ      832 x 1216   ← 実際に走った設定
 *     記録の `size`      1024 x 1024   ← Civitai の申告。**間違っている**
 *
 * ここが記録の側で上書きしていたので、**縦横比ごと変わって別の絵**が出ていた。
 * しかも材料（checkpoint・LoRA3本・smZ）は全部そろっているので、
 * **判定は「再現性・高」のまま**——一番たちの悪い壊れ方をする。
 *
 * **強さの違うものを、弱い側で上書きしない。** グラフは実際に走った設定
 * そのもので、記録の `size` は出力についての申告にすぎない。
 * この面が hash と大きさで既に決めているのと同じ順序である。
 *
 * 当初 embedded は守られていた。多段グラフを守るために条件を
 * `isMultiStageGraph` へ広げたときに、**1段の埋め込みグラフが裸になった**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildRecipeWorkflow } from '../web/core/recipeWorkflowBuilder.js';
import { setLocale, t } from '../web/i18n/index.js';

setLocale('ja');

/** 実データ（`civitai_140604778`）と同じ形。寸法の食い違いだけを残して縮めた。 */
const RECORD = (size = '1024x1024') => ({
    id: '140604778',
    title: 'civitai_140604778',
    checkpoint: { file_name: 'base.safetensors', modelVersionId: 1 },
    loras: [],
    gen_params: {
        prompt: 'a girl', negative_prompt: 'bad',
        seed: 365723129853673, steps: 24, cfg_scale: 4.5,
        sampler: 'euler_ancestral', scheduler: 'normal', size,
    },
    width: 1024,
    height: 1024,
    prompt: {
        1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'base.safetensors' } },
        2: { class_type: 'CLIPTextEncode', inputs: { text: 'a girl', clip: ['1', 1] } },
        3: { class_type: 'CLIPTextEncode', inputs: { text: 'bad', clip: ['1', 1] } },
        4: { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1216, batch_size: 1 } },
        5: { class_type: 'KSampler', inputs: {
            seed: 365723129853673, steps: 24, cfg: 4.5,
            sampler_name: 'euler_ancestral', scheduler: 'normal', denoise: 1,
            model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0],
        } },
        6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
        7: { class_type: 'SaveImage', inputs: { images: ['6', 0] } },
    },
});

const latentOf = (built) => Object.values(built.prompt)
    .find(node => node.class_type === 'EmptyLatentImage')?.inputs;

test('記録の寸法が違っても、埋め込みグラフの寸法で組む', () => {
    const built = buildRecipeWorkflow(RECORD(), {});
    const latent = latentOf(built);
    assert.ok(latent, 'latent が無い');
    assert.equal(latent.width, 832, `幅を記録の申告で上書きしている: ${latent.width}`);
    assert.equal(latent.height, 1216, `高さを記録の申告で上書きしている: ${latent.height}`);
});

test('上書きしなかったことを黙らない', () => {
    // **絵が変わる決定は必ず言う。** 黙って直すと、次に本当に記録が正しい回で
    // 「なぜグラフ側になったのか」を誰も辿れない。
    const built = buildRecipeWorkflow(RECORD(), {});
    const said = (built.warnings || []).some(text => text.includes('1024') && text.includes('832'));
    assert.ok(said, `食い違いを言っていない: ${JSON.stringify(built.warnings || [])}`);
    assert.equal(
        (built.warnings || []).some(text => text === t('core.recipeWorkflowBuilder.sizeFromGraph', {
            p1: 1024, p2: 1024, p3: 832, p4: 1216,
        })),
        true,
        '文言が i18n を通っていない',
    );
});

test('食い違っていなければ、余計なことを言わない', () => {
    // 一致する回まで警告を出すと、**本当に危ない回が埋もれる**。
    const built = buildRecipeWorkflow(RECORD('832x1216'), {});
    assert.equal(latentOf(built).width, 832);
    // **語そのもので見る。** 数字の含みで見ると、一致した回の文言
    //（832 と 1216 しか出ない）を素通しして検査が空になる。
    const same = t('core.recipeWorkflowBuilder.sizeFromGraph', {
        p1: 832, p2: 1216, p3: 832, p4: 1216,
    });
    assert.equal((built.warnings || []).includes(same), false,
        `一致しているのに食い違いを言っている: ${JSON.stringify(built.warnings || [])}`);
});

test('グラフが寸法を別ノードから受けているときは、今までどおり記録で埋める', () => {
    /*
     * **リンクは「まだ決まっていない」ではなく「別のノードが決める」。**
     * 数値で潰すとその関係が消えるので、元から触らない決まりがある。
     * ここで見るのは、**寸法を自分で持っていないグラフ**では
     * この新しい守りが働かないこと（＝今までの経路を塞いでいないこと）。
     */
    const record = RECORD();
    record.prompt[4].inputs.width = ['8', 0];
    record.prompt[4].inputs.height = ['8', 1];
    record.prompt[8] = { class_type: 'PrimitiveNode', inputs: { value: 1 } };
    const built = buildRecipeWorkflow(record, {});
    const latent = latentOf(built);
    assert.ok(Array.isArray(latent.width), 'リンクを数値で潰している');
});
