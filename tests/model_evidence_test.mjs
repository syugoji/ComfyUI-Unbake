/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **「組めるか」と「同じ材料か」は別の問い。**
 *
 * 2026-08-25 に利用者が実機で見つけた2つの症状——Generation data の Resources を
 * 取り込めない／落とせば済むものまで「再現不可」——は**同じ原因**だった。
 * `civitaiClient` が読む meta の鍵が5つしかなく、ComfyUI 形の絵が置く
 * `additionalResources` / `models` / `vaes` を1つも見ていなかった。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recipeFromCivitaiMeta } from '../web/core/civitaiClient.js';
import { evidenceOf, nameOnlyModels, needsEvidenceWarning } from '../web/core/modelEvidence.js';

/** 実際に Civitai が返した形（実測 2026-08-25・image 140604738）を縮めたもの。 */
const COMFY_SHAPE = {
    Model: 'hassakuXLIllustrious_v13StyleA.safetensors',
    models: ['hassakuXLIllustrious_v13StyleA.safetensors'],
    additionalResources: [
        { name: 'USNR STYLE_XL_lokr.safetensors', type: 'lora', strength: 0.45 },
        // **Windows のパス区切りをそのまま持つ**（Civitai が返す実際の形）。
        // `String.raw` で書く——素の文字列だと `\7` が8進エスケープとして解釈されて
        // ファイルごと構文エラーになる（実際にそうなった）。
        { name: String.raw`Illustrious\anime\748cmSDXL.safetensors`, type: 'lora', strength: 0.55 },
        { name: String.raw`Illustrious\realistic\Ah_yes.safetensors`, type: 'lora', strength: 0.75 },
    ],
    prompt: 'a', seed: 1, steps: 24, cfgScale: 4.5, sampler: 'euler_ancestral',
};

/** 版IDが付く形（実測・image 140173431）。 */
const A1111_SHAPE = {
    Model: 'krea2TurboOfficialComfy_krea2TurboFp8',
    'Model hash': 'EB4DD8C612',
    civitaiResources: [{ type: 'lora', weight: 1, modelVersionId: 3125118 }],
    resources: [{ hash: 'EB4DD8C612', name: 'krea2TurboOfficialComfy_krea2TurboFp8', type: 'model' }],
    prompt: 'b', seed: 2, steps: 8,
};

test('ComfyUI 形の meta から LoRA を取りこぼさない', () => {
    // **これが利用者の報告そのもの。** 直す前は 0件だった。
    const recipe = recipeFromCivitaiMeta({ id: 1 }, COMFY_SHAPE, new Map());
    assert.equal(recipe.loras.length, 3, 'additionalResources の LoRA を拾えていない');
    assert.ok(recipe.checkpoint, 'models から checkpoint を拾えていない');
    // 強度も落とさない——落とすと絵が変わるのに「同じ材料」に見える。
    assert.deepEqual(recipe.loras.map(l => l.strength), [0.45, 0.55, 0.75]);
});

test('根拠の強さが記録される（名前だけ / hash / 版ID）', () => {
    const comfy = recipeFromCivitaiMeta({ id: 1 }, COMFY_SHAPE, new Map());
    assert.equal(evidenceOf(comfy.checkpoint), 'name');
    assert.deepEqual(comfy.loras.map(evidenceOf), ['name', 'name', 'name']);

    const a1111 = recipeFromCivitaiMeta({ id: 2 }, A1111_SHAPE, new Map());
    assert.equal(evidenceOf(a1111.checkpoint), 'hash', 'hash が在るのに name へ落ちている');
    assert.deepEqual(a1111.loras.map(evidenceOf), ['versionId']);
});

test('印は「1件でも名前だけ」なら出る（割合で薄めない）', () => {
    // **1本違えば絵は変わる。** 「4件中1件」でも警告する。
    const mixed = { checkpoint: { file_name: 'c', evidence: 'hash' },
                    loras: [{ file_name: 'a', evidence: 'hash' },
                            { file_name: 'b', evidence: 'name' }] };
    assert.equal(needsEvidenceWarning(mixed), true);
    assert.deepEqual(nameOnlyModels(mixed).names, ['b']);
    assert.equal(nameOnlyModels(mixed).total, 3, '分母が根拠のある件数になっていない');
});

test('印の無い古い記録を「あやしい」に落とさない', () => {
    // **無印は「名前だけ」ではない。** 落とすと全部が警告になり、印の意味が消える。
    const legacy = { checkpoint: { file_name: 'c' }, loras: [{ file_name: 'a' }] };
    assert.equal(evidenceOf(legacy.checkpoint), null);
    assert.equal(needsEvidenceWarning(legacy), false);
    assert.equal(nameOnlyModels(legacy).total, 0);
});

test('解決器が後から付けた根拠を優先する', () => {
    // 名前しか無かったものを hash で引き直せたなら、それは hash で当てたということ。
    const resource = { file_name: 'a', evidence: 'name', resolvedBy: 'hash' };
    assert.equal(evidenceOf(resource), 'hash');
});

test('落とし込みの出口で形が揃う（記録の形をそのまま流さない）', async () => {
    // **同じ食い違いを5回踏んだ。** 5回目がこれ（2026-08-25・`civitai_139981506`）。
    // `D-20260824-01` の実測①が「新しく記録を読む経路を足すときは、必ず
    // `toRecipeShape()` を通す」と書いていたのに、押し込み口6箇所のうち
    // 通していたのは**ライブラリから読む1本だけ**だった。
    //
    // 個々の経路ではなく**出口で1度**通すので、経路が増えても漏れない。
    const { toRecipeShape } = await import('../web/core/recordShape.js');
    // 捕捉経路が作る形（値が直下・checkpoint が文字列）。
    const captured = {
        seed: 0, steps: 30, cfg: 5, sampler: 'euler', scheduler: 'simple',
        width: 720, height: 1280, positive: '4k', negative: '',
        checkpoint: 'anima_aestheticV11.safetensors', loras: [],
    };
    const shaped = toRecipeShape(captured);
    assert.equal(shaped.gen_params.steps, 30, 'gen_params が埋まっていない');
    assert.equal(shaped.gen_params.cfg_scale, 5, '記録の `cfg` をレシピの `cfg_scale` へ移せていない');
    assert.equal(shaped.gen_params.size, '720x1280');
    assert.equal(typeof shaped.checkpoint, 'object', 'checkpoint が文字列のまま');
    // **揃えたら印も読める。** 揃える前は資源オブジェクトが無いので印が付かなかった。
    assert.equal(evidenceOf(shaped.checkpoint), 'name');
    assert.equal(needsEvidenceWarning(shaped), true);
});

test('プロンプトは meta を優先する（グラフの要約で上書きしない）', async () => {
    // **2026-08-25 利用者の報告。** グラフから要約すると、テキストのノードが
    // 複数あるときに別のノードを掴む。実測（`civitai_139981506`）では
    // 品質語だけの「4k，高清」を拾い、ページの Generation data と食い違っていた。
    //
    // 利用者が見比べる相手は Civitai のページで、そこが出しているのは `meta.prompt`。
    // **要約は推測、`meta` は投稿された値そのもの。推測より値を採る。**
    const { recordFromCivitaiImage } = await import('../web/core/civitaiClient.js');
    const { toRecipeShape } = await import('../web/core/recordShape.js');

    const graph = JSON.stringify({
        prompt: { 1: { class_type: 'CLIPTextEncode', inputs: { text: '4k, hd' } } },
    });
    const meta = { comfy: graph, prompt: 'the real prompt', negativePrompt: 'the real negative' };
    const built = recordFromCivitaiImage({ id: 1 }, meta, { url: 'x', domain: 'civitai.com' });
    assert.ok(built.ok, '捕捉できていない');
    const shaped = toRecipeShape(built.record);
    assert.equal(shaped.gen_params.prompt, 'the real prompt', 'グラフの要約が meta を上書きしている');
    assert.equal(shaped.gen_params.negative_prompt, 'the real negative');
});

test('meta にプロンプトが無ければ、要約を潰さない', async () => {
    // **空で上書きすると「プロンプトが無い」という別の嘘になる。**
    // `meta` を持たない画像では、グラフの要約が唯一の手がかり。
    const { recordFromCivitaiImage } = await import('../web/core/civitaiClient.js');
    const graph = JSON.stringify({
        prompt: { 1: { class_type: 'CLIPTextEncode', inputs: { text: 'only from graph' } } },
    });
    const built = recordFromCivitaiImage({ id: 2 }, { comfy: graph }, { url: 'x' });
    assert.ok(built.ok);
    // **`!== ''` では足りない。** 上書きが無条件になると `undefined` が入り、
    // それでも `!== ''` は通ってしまう（変異検査で素通りした）。中身を見る。
    assert.equal(typeof built.record.positive, 'string',
        'meta が空のときに positive が文字列でなくなっている（無条件に上書きしている）');
    assert.match(built.record.positive, /only from graph/,
        'meta が空のときに要約まで消えている');
});

test('取り込み直した記録の判定は、控えを捨ててから掛け直す', async () => {
    // **2026-08-25 に利用者が踏んだ。** 直す前の取り込みで `checkpoint: null`
    // として計算された行が表に残り、直したあとに取り込み直しても
    // **不足モデルが「無い」まま**だった——`run()` は `!rows.has(id)` で
    // 計算済みを飛ばすので、控えを捨てないと古い判定が使われ続ける。
    const { createVerdictTable } = await import('../web/core/verdictTable.js');

    let loaded = 0;
    const table = createVerdictTable({
        loadRecord: async () => { loaded += 1; return { checkpoint: { file_name: 'x.safetensors' } }; },
        collectInputs: async () => ({ objectInfo: { CheckpointLoaderSimple: {
            input: { required: { ckpt_name: [[]] } } } }, embeddings: [] }),
    });
    const records = [{ libraryId: 'a' }];

    await table.run(records);
    assert.equal(loaded, 1);

    // **2回目は飛ばす**（350件を開くたびに組み直さないための近道）。
    await table.run(records);
    assert.equal(loaded, 1, '控えが効いていない（毎回組み直している）');

    // **捨てれば掛け直す。** ここが無いと取り込み直しが反映されない。
    table.invalidate(['a']);
    await table.run(records);
    assert.equal(loaded, 2, '控えを捨てても掛け直していない');
});
