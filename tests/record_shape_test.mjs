/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 記録の形を、レシピの形へ揃える（2026-08-24 利用者の報告）。
 *
 * **同じ食い違いを3回踏んだ。** グラフの鍵（`prompt` と `comfy_prompt`）、
 * 保存の本体（`recipe` を持たない記録）、そして今回の条件（直下と `gen_params`）。
 * 下流は全部レシピの形を読むので、記録の形がそのまま流れると
 * **値が在るのに画面が空になる**——`ComfyUI_00444_` の詳細でプロンプトも
 * seed も出なかったのがこれ（記録は両方持っていた）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { looksLikeRecordShape, toRecipeShape } from '../web/core/recordShape.js';
import { buildRecipeWorkflow } from '../web/core/recipeWorkflowBuilder.js';
import { setLocale } from '../web/i18n/index.js';

/** `ComfyUI_00444_` と同じ形（実データから写した）。 */
const RECORD = {
    id: 'ComfyUI_00444_.png',
    title: 'ComfyUI_00444_',
    checkpoint: 'Illustrious/anime/wai.safetensors',
    loras: [{ name: 'CADENZA.safetensors', strength: 0.5 }],
    seed: 173502072326292,
    steps: 14,
    cfg: 4,
    sampler: 'dpmpp_2m',
    scheduler: 'karras',
    width: 832,
    height: 1216,
    positive: 'masterpiece, anime girl',
    negative: 'lowres',
};

test('条件が直下に在る記録を、そうと見分ける', () => {
    assert.equal(looksLikeRecordShape(RECORD), true);
    // 既にレシピの形なら、触る相手ではない。
    assert.equal(looksLikeRecordShape({ gen_params: { prompt: 'x' } }), false);
    assert.equal(looksLikeRecordShape(null), false);
    assert.equal(looksLikeRecordShape({ id: 'x', title: 'y' }), false);
});

test('直下の条件を gen_params へ写す', () => {
    const out = toRecipeShape(RECORD);
    assert.equal(out.gen_params.prompt, 'masterpiece, anime girl');
    assert.equal(out.gen_params.negative_prompt, 'lowres');
    assert.equal(out.gen_params.seed, 173502072326292);
    assert.equal(out.gen_params.steps, 14);
    // **名前が違うだけ**（記録は `cfg`、レシピは `cfg_scale`）。
    assert.equal(out.gen_params.cfg_scale, 4);
    assert.equal(out.gen_params.sampler, 'dpmpp_2m');
    assert.equal(out.gen_params.size, '832x1216');
});

test('記録の負が空でも、保存されているグラフの文字を潰さない', () => {
    // **同じ種・同じ設定なのに絵が変わっていた**（2026-08-24 実機 `ComfyUI_00444_`）。
    // 記録の負が空だったのは「本当に空」ではなく**抽出できていなかった**だけで、
    // グラフには本物が残っていた。空で上書きすると、**手元にある正解を捨てる。**
    setLocale('en');
    const graph = {
        '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'wai.safetensors' } },
        '2': { class_type: 'CLIPTextEncode', inputs: { text: 'lowres, worst quality', clip: ['1', 1] } },
        '3': { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, anime girl', clip: ['1', 1] } },
        '4': { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1216, batch_size: 1 } },
        '5': { class_type: 'KSampler', inputs: {
            seed: 173502072326292, steps: 14, cfg: 4, sampler_name: 'dpmpp_2m', scheduler: 'karras',
            denoise: 1, model: ['1', 0], positive: ['3', 0], negative: ['2', 0], latent_image: ['4', 0] } },
        '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
        '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'ComfyUI' } },
    };
    // **形を揃える所を通さずに渡す**（レシピの形で負が空、という入口）。
    // 揃える側は下の検査でグラフから埋めるので、ここは**組み立て器そのもの**を見る。
    const stale = {
        ...toRecipeShape({ ...RECORD, prompt: graph }),
        gen_params: { ...toRecipeShape({ ...RECORD, prompt: graph }).gen_params, negative_prompt: '' },
    };
    const built = buildRecipeWorkflow(stale, { objectInfo: null, embeddings: [] });
    const texts = Object.values(built.prompt)
        .filter(node => node.class_type === 'CLIPTextEncode')
        .map(node => node.inputs.text);
    assert.ok(texts.includes('lowres, worst quality'),
        `負の文字が空で潰されている: ${JSON.stringify(texts)}`);
    // **黙って残さない。** 何を使ったのかは言う。
    assert.ok((built.warnings || []).some(text => /negative/i.test(String(text))),
        `残したことを言っていない: ${JSON.stringify(built.warnings)}`);
});

test('記録が負を持っていなくても、抱えているグラフから埋める', () => {
    // 古い記録は**全件が空**（要約器が抜いていなかった）。取り込み直さなくても、
    // 記録の中に残っているグラフから埋まること（2026-08-24 実機 `ComfyUI_00444_`）。
    const graph = {
        '1': { class_type: 'CLIPTextEncode', inputs: { text: 'lowres, worst quality' } },
        '2': { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, anime girl' } },
        '3': { class_type: 'KSampler', inputs: {
            seed: 7, steps: 14, cfg: 4, positive: ['2', 0], negative: ['1', 0] } },
    };
    const out = toRecipeShape({ ...RECORD, prompt: graph, negative: '' });
    assert.equal(out.gen_params.negative_prompt, 'lowres, worst quality',
        'グラフから埋めていない（画面は「無かった」と言い、再現もそう振る舞う）');
    // **記録が持っている方が強い。** グラフで上書きしない。
    const kept = toRecipeShape({ ...RECORD, prompt: graph, negative: 'my own negative' });
    assert.equal(kept.gen_params.negative_prompt, 'my own negative', '記録の値をグラフで潰している');
});

test('記録に負が在れば、そちらで上書きする', () => {
    setLocale('en');
    const graph = {
        '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'wai.safetensors' } },
        '2': { class_type: 'CLIPTextEncode', inputs: { text: 'old negative', clip: ['1', 1] } },
        '3': { class_type: 'CLIPTextEncode', inputs: { text: 'old positive', clip: ['1', 1] } },
        '4': { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1216, batch_size: 1 } },
        '5': { class_type: 'KSampler', inputs: {
            seed: 1, steps: 14, cfg: 4, sampler_name: 'dpmpp_2m', scheduler: 'karras',
            denoise: 1, model: ['1', 0], positive: ['3', 0], negative: ['2', 0], latent_image: ['4', 0] } },
        '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
        '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'ComfyUI' } },
    };
    const fresh = toRecipeShape({ ...RECORD, prompt: graph, negative: 'lowres' });
    const built = buildRecipeWorkflow(fresh, { objectInfo: null, embeddings: [] });
    const texts = Object.values(built.prompt)
        .filter(node => node.class_type === 'CLIPTextEncode')
        .map(node => node.inputs.text);
    assert.ok(texts.includes('lowres'), `記録の負が効いていない: ${JSON.stringify(texts)}`);
    assert.ok(!texts.includes('old negative'), '古い文字が残っている');
});

test('文字列の checkpoint を資源の形にする', () => {
    // 組み立ては `file_name` を見るので、裸の文字列は「無い」になる。
    const out = toRecipeShape(RECORD);
    assert.deepEqual(out.checkpoint, { file_name: 'Illustrious/anime/wai.safetensors' });
    assert.equal(out.loras[0].file_name, 'CADENZA.safetensors');
    assert.equal(out.loras[0].weight, 0.5);
});

test('既にレシピの形なら、作り直さない', () => {
    // **作り直すと、上流が持っている項目が落ちる。**
    const recipe = {
        checkpoint: { file_name: 'a.safetensors', modelVersionId: 5 },
        loras: [{ file_name: 'b.safetensors', weight: 0.8, modelVersionId: 6 }],
        gen_params: { prompt: 'p', clip_skip: 2, denoising_strength: 0.5, seed: 1 },
    };
    const out = toRecipeShape(recipe);
    assert.deepEqual(out.gen_params, recipe.gen_params, 'gen_params を作り直している');
    assert.deepEqual(out.checkpoint, recipe.checkpoint, 'checkpoint を作り直している');
    assert.deepEqual(out.loras, recipe.loras, 'LoRA を作り直している');
});

test('元の記録を書き換えない', () => {
    const before = JSON.stringify(RECORD);
    toRecipeShape(RECORD);
    assert.equal(JSON.stringify(RECORD), before, '引数を書き換えている');
});

test('揃えた後は、プロンプトを変えて組める', () => {
    setLocale('en');
    const objectInfo = {
        CheckpointLoaderSimple: { input: { required: { ckpt_name: [['Illustrious/anime/wai.safetensors']] } } },
        LoraLoader: { input: { required: { model: ['MODEL'], clip: ['CLIP'],
            lora_name: [['CADENZA.safetensors']], strength_model: ['FLOAT'], strength_clip: ['FLOAT'] } } },
        CLIPTextEncode: { input: { required: { text: ['STRING'], clip: ['CLIP'] } } },
        KSampler: { input: { required: {} } },
        EmptyLatentImage: { input: { required: {} } },
        VAEDecode: { input: { required: {} } },
        SaveImage: { input: { required: {} }, output_node: true },
    };
    const shaped = toRecipeShape(RECORD);
    const edited = { ...shaped, gen_params: { ...shaped.gen_params, prompt: 'a new prompt' } };
    assert.doesNotThrow(() => buildRecipeWorkflow(edited, { objectInfo, embeddings: [] }));

    // **揃えないと組めない**（この検査が何を守っているかを固定する）。
    assert.throws(
        () => buildRecipeWorkflow({ ...RECORD, gen_params: { prompt: 'a new prompt' } },
            { objectInfo, embeddings: [] }),
        /checkpoint|チェックポイント/);
});

// --- 大きすぎる再現を縮める（2026-08-25 利用者の指示）-----------------------

/** 2段構成（拡大 → 描き直し → 分割復号）の最小のグラフ。 */
function twoPassGraph() {
    return {
        '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a.safetensors' } },
        '2': { class_type: 'CLIPTextEncode', inputs: { text: 'neg', clip: ['1', 1] } },
        '3': { class_type: 'CLIPTextEncode', inputs: { text: 'pos', clip: ['1', 1] } },
        '4': { class_type: 'EmptyLatentImage', inputs: { width: 1280, height: 1856, batch_size: 1 } },
        '5': { class_type: 'KSampler', inputs: {
            seed: 1, steps: 20, cfg: 4, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
            model: ['1', 0], positive: ['3', 0], negative: ['2', 0], latent_image: ['4', 0] } },
        '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
        '10': { class_type: 'ImageScale', inputs: {
            width: 2560, height: 3712, upscale_method: 'lanczos', crop: 'disabled', image: ['6', 0] } },
        '11': { class_type: 'VAEEncode', inputs: { pixels: ['10', 0], vae: ['1', 2] } },
        '12': { class_type: 'KSampler', inputs: {
            seed: 1, steps: 20, cfg: 4, sampler_name: 'euler', scheduler: 'normal', denoise: 0.35,
            model: ['1', 0], positive: ['3', 0], negative: ['2', 0], latent_image: ['11', 0] } },
        '13': { class_type: 'VAEDecodeTiled', inputs: {
            samples: ['12', 0], vae: ['1', 2], tile_size: 512, overlap: 64,
            temporal_size: 64, temporal_overlap: 8 } },
        '14': { class_type: 'SaveImage', inputs: { images: ['13', 0], filename_prefix: 'x' } },
    };
}

const decodesOf = (prompt) => Object.values(prompt)
    .filter(node => String(node.class_type).startsWith('VAEDecode'))
    .map(node => node.class_type);
const biggestOf = (prompt) => Object.values(prompt)
    .filter(node => Number(node.inputs?.width) > 0)
    .map(node => [node.inputs.width, node.inputs.height])
    .sort((a, b) => (b[0] * b[1]) - (a[0] * a[1]))[0];

test('上限を入れると、縮めて分割せずに復号する', () => {
    // **記録どおりの寸法では復号できない機械が在り、そこでは絵が1枚も出ない**
    // （2026-08-25 実機 `civitai_87384188`: 2560x3712 で復号の段から進まなくなった）。
    setLocale('en');
    const recipe = toRecipeShape({ ...RECORD, prompt: twoPassGraph() });
    const built = buildRecipeWorkflow(recipe, { objectInfo: null, embeddings: [], maxReplayPixels: 4_500_000 });

    assert.ok(!decodesOf(built.prompt).includes('VAEDecodeTiled'),
        `分割復号が残っている: ${decodesOf(built.prompt).join(',')}`);
    const [width, height] = biggestOf(built.prompt);
    assert.ok(width * height <= 4_500_000, `縮めていない: ${width}x${height}`);
    // **比率は保つ。** 変えると別の絵になる。
    const before = 2560 / 3712;
    assert.ok(Math.abs((width / height) - before) < 0.02, `比率が変わっている: ${width}x${height}`);
    // **8の倍数へ落とす。** 潜在は 1/8 なので、半端だと段の途中で丸められる。
    assert.equal(width % 8, 0, '幅が8の倍数でない');
    assert.equal(height % 8, 0, '高さが8の倍数でない');
    // **黙って縮めない。**
    assert.ok((built.warnings || []).some(text => /reduced to|縮めました/.test(String(text))),
        `縮めたことを言っていない: ${JSON.stringify(built.warnings)}`);
});

test('上限が 0 なら、記録どおりのまま（分割復号を残す）', () => {
    setLocale('en');
    const recipe = toRecipeShape({ ...RECORD, prompt: twoPassGraph() });
    const built = buildRecipeWorkflow(recipe, { objectInfo: null, embeddings: [], maxReplayPixels: 0 });
    assert.ok(decodesOf(built.prompt).includes('VAEDecodeTiled'),
        '上限が無いのに縮めている（記録どおりを選べなくなる）');
    const [width, height] = biggestOf(built.prompt);
    assert.equal(width, 2560, '記録どおりでない');
    assert.equal(height, 3712, '記録どおりでない');
});

test('元からタイル分割の記録には、「切り替えました」と言わない', () => {
    // **やっていないことを言わない**（2026-08-25 実機 `civitai_137676446`:
    // 記録そのものが `VAEDecodeTiled`（tile_size 224）で、こちらは触っていない）。
    setLocale('en');
    const graph = twoPassGraph();
    const built = buildRecipeWorkflow(
        toRecipeShape({ ...RECORD, prompt: graph }),
        { objectInfo: null, embeddings: [], maxReplayPixels: 0 }
    );
    const said = (built.warnings || []).join(' / ');
    assert.ok(/already decodes in tiles/.test(said),
        `元からその形だと言っていない: ${JSON.stringify(built.warnings)}`);
    assert.ok(!/decoding is switched to tiles/.test(said),
        `切り替えたと言っている: ${JSON.stringify(built.warnings)}`);
});

test('こちらが切り替えたときは、そう言う', () => {
    // グラフを持たない記録から標準構成で組む道。**大きすぎるので分割へ切り替える**
    // ——この時だけ「切り替えました」と言ってよい。
    //
    // 埋め込みグラフを持つ記録では、この道は通らない（実測: 素の `VAEDecode` の
    // まま 2560x3712 でも切り替えない）。**言い分けが要るのはここだけ。**
    setLocale('en');
    const built = buildRecipeWorkflow(
        toRecipeShape({ ...RECORD, width: 2560, height: 3712 }),
        { objectInfo: null, embeddings: [], maxReplayPixels: 0 }
    );
    const said = (built.warnings || []).join(' / ');
    // **空振りさせない。** 切り替わっていなければ、この検査は何も見ていない。
    assert.ok(decodesOf(built.prompt).includes('VAEDecodeTiled'),
        `切り替えが起きていない＝この検査は空振り: ${decodesOf(built.prompt).join(',')}`);
    assert.ok(/decoding is switched to tiles/.test(said),
        `切り替えたのに言っていない: ${JSON.stringify(built.warnings)}`);
    assert.ok(!/already decodes in tiles/.test(said),
        `切り替えたのに「元から」と言っている: ${JSON.stringify(built.warnings)}`);
});

// --- 1つの節が何本も運ぶ形（2026-08-25 実機 `civitai_137676446`）------------

/** LoRA Manager の運搬ノードを持つ最小のグラフ。 */
function carrierGraph() {
    return {
        '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a.safetensors' } },
        '10': { class_type: 'Lora Loader (LoraManager)', inputs: {
            model: ['1', 0], clip: ['1', 1],
            text: '<lora:alpha:0.25> <lora:beta:0.50>',
            loras: { __value__: [
                { name: 'alpha', strength: 0.25 },
                { name: 'beta', strength: 0.5 },
            ] },
        } },
        '2': { class_type: 'CLIPTextEncode', inputs: { text: 'neg', clip: ['10', 1] } },
        '3': { class_type: 'CLIPTextEncode', inputs: { text: 'pos', clip: ['10', 1] } },
        '4': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
        '5': { class_type: 'KSampler', inputs: {
            seed: 1, steps: 20, cfg: 4, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
            model: ['10', 0], positive: ['3', 0], negative: ['2', 0], latent_image: ['4', 0] } },
        '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
        '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'x' } },
    };
}

/**
 * 埋め込みグラフを**そのまま使わせる**ための最小の宿主。
 *
 * **空だと足りない。** 節が1つでも「導入されていない」と読まれると、
 * 埋め込みを捨てて標準構成へ組み直すので、運搬ノードの話にならない
 * （2026-08-25 に実際に踏んだ——両方が同じ結果になり、検査が意味を失った）。
 */
const STOCK = Object.fromEntries([
    'CheckpointLoaderSimple', 'CLIPTextEncode', 'EmptyLatentImage',
    'KSampler', 'VAEDecode', 'SaveImage', 'LoraLoader',
].map(type => [type, { input: { required: {} } }]));

/** 運搬ノードが**導入されている**ことにする（在るならそのまま使う道）。 */
const WITH_CARRIER = { ...STOCK, 'Lora Loader (LoraManager)': { input: { required: {} } } };

const loraNodes = (prompt) => Object.values(prompt)
    .filter(node => /lora/i.test(String(node.class_type || ''))).length;

test('1つの節が運んでいる LoRA を、もう一度足さない', () => {
    // **元は1節で8本なのに、組んだ後は9節になっていた**（＝全部が二重掛け）。
    // 運搬ノードは `lora_name` を持たず `text` と `loras.__value__` に名前を入れる。
    // `lora_name` だけを見ていたので一致せず、足し直していた。
    setLocale('en');
    const recipe = toRecipeShape({
        ...RECORD,
        comfy_prompt: carrierGraph(),
        loras: [
            { name: 'alpha.safetensors', strength: 0.25 },
            { name: 'beta.safetensors', strength: 0.5 },
        ],
    });
    const built = buildRecipeWorkflow(recipe, { objectInfo: WITH_CARRIER, embeddings: [] });
    assert.equal(loraNodes(built.prompt), 1,
        `運ばれている分を足し直している（${loraNodes(built.prompt)}節）`);
    // **触らない。** 強さを書き換える口が無いので、当て直すこともできない。
    const carrier = Object.values(built.prompt).find(n => /LoraManager/.test(String(n.class_type)));
    assert.ok(carrier, '運搬ノードごと消している');
    assert.equal(carrier.inputs.text, '<lora:alpha:0.25> <lora:beta:0.50>', '運搬の中身を書き換えている');
});

test('運んでいない LoRA は、今までどおり足す', () => {
    // **足さない方へ倒しすぎない。** 運搬ノードが在っても、そこに無い LoRA は要る。
    setLocale('en');
    const recipe = toRecipeShape({
        ...RECORD,
        comfy_prompt: carrierGraph(),
        loras: [
            { name: 'alpha.safetensors', strength: 0.25 },
            { name: 'gamma.safetensors', strength: 0.8 },
        ],
    });
    const built = buildRecipeWorkflow(recipe, { objectInfo: WITH_CARRIER, embeddings: [] });
    assert.equal(loraNodes(built.prompt), 2, `運んでいない分を足していない（${loraNodes(built.prompt)}節）`);
    const added = Object.values(built.prompt).find(n => n.inputs?.lora_name);
    assert.match(String(added?.inputs?.lora_name || ''), /gamma/, '足したのが別の LoRA');
});

test('運搬の書き方が片方だけでも読む（text のみ / loras のみ）', () => {
    // **どちらか片方だけを読まない。** 片方が空の書き手が在ると、
    // 「運んでいない」と読んで**同じ LoRA をもう一度足す**ことになる。
    setLocale('en');
    const only = (inputs) => {
        const graph = carrierGraph();
        graph['10'].inputs = { model: ['1', 0], clip: ['1', 1], ...inputs };
        return graph;
    };
    const loras = [{ name: 'alpha.safetensors', strength: 0.25 }];

    // `text` にしか無い書き手。
    const byText = buildRecipeWorkflow(
        toRecipeShape({ ...RECORD, comfy_prompt: only({ text: '<lora:alpha:0.25>' }), loras }),
        { objectInfo: WITH_CARRIER, embeddings: [] }
    );
    assert.equal(loraNodes(byText.prompt), 1, 'text だけの書き手で足し直している');

    // `loras` にしか無い書き手。
    const byList = buildRecipeWorkflow(
        toRecipeShape({ ...RECORD, comfy_prompt: only({ loras: { __value__: [{ name: 'alpha', strength: 0.25 }] } }), loras }),
        { objectInfo: WITH_CARRIER, embeddings: [] }
    );
    assert.equal(loraNodes(byList.prompt), 1, 'loras だけの書き手で足し直している');
});

test('運搬ノードが無い環境では、標準の連なりへ開く', () => {
    // **そのままでは、その環境で1枚も出せない**（2026-08-25 利用者の指示）。
    // LoRA は重みを順に当てる操作なので、**同じ順・同じ強さなら
    // 1節でまとめても連ねても結果は同じ**——絵は変わらない。
    setLocale('en');
    const recipe = toRecipeShape({
        ...RECORD,
        comfy_prompt: carrierGraph(),
        loras: [
            { name: 'alpha.safetensors', strength: 0.25 },
            { name: 'beta.safetensors', strength: 0.5 },
        ],
    });
    // **導入されていない**ことにする。
    const built = buildRecipeWorkflow(recipe, { objectInfo: STOCK, embeddings: [] });
    const chain = Object.values(built.prompt).filter(node => node.class_type === 'LoraLoader');
    assert.equal(chain.length, 2, `連なりが ${chain.length} 節（2本のはず）`);
    // 運搬ノードは残さない（その環境では動かない）。
    assert.ok(!Object.values(built.prompt).some(n => /LoraManager/.test(String(n.class_type))),
        '動かない節を残している');

    // **順番と強さが同じこと。** ここが崩れると絵が変わる。
    // 名前は実ファイル名へ解決されるので、**頭の一致で見る**。
    const names = chain.map(node => String(node.inputs.lora_name));
    assert.ok(names[0].startsWith('alpha'), `1本目が違う: ${names.join(',')}`);
    assert.ok(names[1].startsWith('beta'), `2本目が違う: ${names.join(',')}`);
    assert.equal(chain[0].inputs.strength_model, 0.25);
    assert.equal(chain[0].inputs.strength_clip, 0.25);
    assert.equal(chain[1].inputs.strength_model, 0.5);

    // **繋ぎ替えができていること。** 末尾が使われていないと、当たらない。
    const last = Object.entries(built.prompt).find(([, n]) => n === chain[1])[0];
    const sampler = Object.values(built.prompt).find(n => n.class_type === 'KSampler');
    assert.equal(String(sampler.inputs.model[0]), last, '末尾へ繋ぎ替えていない');
    // **CLIP は口1（clip 側）へ。** 口0（model 側）へ繋ぐと文字の解釈が壊れるが、
    // 絵は出てしまうので気づけない。
    for (const node of Object.values(built.prompt).filter(n => n.class_type === 'CLIPTextEncode')) {
        assert.equal(String(node.inputs.clip[0]), last, 'CLIP を末尾へ繋ぎ替えていない');
        assert.equal(node.inputs.clip[1], 1, 'CLIP を model 側の口へ繋いでいる');
    }

    // **黙って開かない。**
    assert.ok((built.warnings || []).some(text => /standard loaders|標準の/.test(String(text))),
        `開いたことを言っていない: ${JSON.stringify(built.warnings)}`);
});

test('1本も持っていない運搬ノードは、素通しにして外す', () => {
    // **0本でも運搬ノードは運搬ノード**（2026-08-25 実機 `civitai_128202934`）。
    // 元は「1本以上持っていること」を条件にしていたので、**空の運搬ノードだけが
    // 残ってグラフ全体が組み直しになる**——1本以上なら開くのに、0本だと丸ごと
    // 捨てる、という筋の通らない差になっていた。
    setLocale('en');
    const graph = carrierGraph();
    graph['10'].inputs.loras = { __value__: [] };
    graph['10'].inputs.text = '';
    const built = buildRecipeWorkflow(
        toRecipeShape({ ...RECORD, comfy_prompt: graph, loras: [] }),
        { objectInfo: STOCK, embeddings: [] }
    );
    // **埋め込みのまま**であること（組み直されていない＝構図が変わらない）。
    assert.equal(built.source, 'embedded', `組み直されている: ${built.source}`);
    assert.ok(!Object.values(built.prompt).some(n => /LoraManager/.test(String(n.class_type))),
        '動かない節を残している');
    // **LoRA を足さない。** 持っていないのだから、当てる物は無い。
    assert.equal(Object.values(built.prompt).filter(n => n.class_type === 'LoraLoader').length, 0,
        '持っていない LoRA を当てている');
    // 素通し＝元の繋ぎ先へ直結する。
    const sampler = Object.values(built.prompt).find(n => n.class_type === 'KSampler');
    assert.equal(String(sampler.inputs.model[0]), '1', `model を繋ぎ替えていない: ${JSON.stringify(sampler.inputs.model)}`);
    for (const node of Object.values(built.prompt).filter(n => n.class_type === 'CLIPTextEncode')) {
        assert.equal(String(node.inputs.clip[0]), '1', 'clip を繋ぎ替えていない');
        assert.equal(node.inputs.clip[1], 1, 'clip を model 側の口へ繋いでいる');
    }
    // **「開きました」とは言わない**（節は1つも増えていない）。
    const said = (built.warnings || []).join(' / ');
    assert.ok(/passed straight through/.test(said), `素通しにしたと言っていない: ${said}`);
    assert.ok(!/rebuilt as a chain/.test(said), `増えていないのに「開いた」と言っている: ${said}`);
});

test('LoRA の名簿を持たない節は、素通しにしない（絵が変わる）', () => {
    // **ここを緩めると、手元に無い節を片端から素通しにする。** 見た目には
    // 「組めるようになった」に見えるが、**その節が絵へ効いていた分が黙って消える**
    // ——組み直し（構図が変わる）より悪い、気づけない壊れ方になる。
    setLocale('en');
    const graph = carrierGraph();
    graph['10'] = {
        class_type: 'Some Model Patcher',
        inputs: { model: ['1', 0], clip: ['1', 1], strength: 0.8 },
    };
    const built = buildRecipeWorkflow(
        toRecipeShape({ ...RECORD, comfy_prompt: graph, loras: [] }),
        { objectInfo: STOCK, embeddings: [] }
    );
    const said = (built.warnings || []).join(' / ');
    assert.ok(!/passed straight through/.test(said), `名簿を持たない節を素通しにしている: ${said}`);
    // **判らないものは、判らないままにする**（標準構成へ組み直す道が残る）。
    assert.equal(built.source, 'standard', `素通しにして通してしまっている: ${built.source}`);
});

test('model と clip を受けない節は、素通しにしない', () => {
    // 名簿を持っていても、**繋ぎ替える先が無ければ運搬ノードではない。**
    setLocale('en');
    const graph = carrierGraph();
    graph['10'] = {
        class_type: 'Lora Name List (LoraManager)',
        inputs: { loras: { __value__: [{ name: 'alpha', strength: 1 }] }, text: '' },
    };
    const built = buildRecipeWorkflow(
        toRecipeShape({ ...RECORD, comfy_prompt: graph, loras: [] }),
        { objectInfo: STOCK, embeddings: [] }
    );
    const said = (built.warnings || []).join(' / ');
    assert.ok(!/passed straight through|rebuilt as a chain/.test(said),
        `繋ぎ替え先が無いのに触っている: ${said}`);
    assert.equal(built.source, 'standard', `触ってはいけない節を触っている: ${built.source}`);
});

test('開いた分の強さを、記録側の数字で上書きしない', () => {
    // 開いた後の節は**標準の LoraLoader に見える**ので、この後の
    // 「記録の LoRA を当てる」処理が掴んで強さを書き換えられる
    // ——運搬ノードが在る環境と**別の絵**になる。
    setLocale('en');
    const graph = carrierGraph();
    graph['10'].inputs.loras = { __value__: [{ name: 'alpha', strength: 0.25, active: true }] };
    delete graph['10'].inputs.text;
    const built = buildRecipeWorkflow(
        toRecipeShape({
            ...RECORD,
            comfy_prompt: graph,
            // 記録側は 1.0 と言っている（運搬ノードの中は 0.25）。
            loras: [{ name: 'alpha.safetensors', strength: 1 }],
        }),
        { objectInfo: STOCK, embeddings: [] }
    );
    const chain = Object.values(built.prompt).filter(node => node.class_type === 'LoraLoader');
    assert.equal(chain.length, 1, `本数が違う: ${chain.length}`);
    assert.equal(chain[0].inputs.strength_model, 0.25, '記録側の数字で上書きしている');
    assert.equal(chain[0].inputs.strength_clip, 0.25, '記録側の数字で上書きしている');
    // 名前だけは実ファイル名へ直す（拡張子が無いと選べない）。
    assert.equal(chain[0].inputs.lora_name, 'alpha.safetensors', '名前を直していない');
});

test('切ってある LoRA は当てない', () => {
    // **当てると絵が変わる。**
    setLocale('en');
    const graph = carrierGraph();
    graph['10'].inputs.loras = { __value__: [
        { name: 'alpha', strength: 0.25, active: true },
        { name: 'beta', strength: 0.5, active: false },
    ] };
    delete graph['10'].inputs.text;
    // **レシピが言っているのは alpha だけ。** beta は運搬の中で切ってある。
    const built = buildRecipeWorkflow(
        toRecipeShape({ ...RECORD, comfy_prompt: graph, loras: [{ name: 'alpha.safetensors', strength: 0.25 }] }),
        { objectInfo: STOCK, embeddings: [] }
    );
    const names = Object.values(built.prompt)
        .filter(node => node.class_type === 'LoraLoader')
        .map(node => String(node.inputs.lora_name));
    assert.equal(names.length, 1, `本数が違う: ${names.join(',')}`);
    assert.ok(names[0].startsWith('alpha'), `切ってある分を当てている: ${names.join(',')}`);
});
