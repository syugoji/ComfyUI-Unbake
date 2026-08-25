/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 詳細から出す計画（2026-08-22 利用者の指示で「振る」から移した）。
 *
 * ここで固定するのは**間違えると投入の直前で落ちる**ところ:
 *
 *  1. 元の seed が必ず1枚目（後から「あの1枚」を言える）
 *  2. seed は非負の安全整数（`expandSweepTemplate` がそこで投げる）
 *  3. 軸は2つ以上・重複なし・基準1つ（同じ絵を別条件として使い回さない）
 *  4. 候補が1つだけの置き換え口を**黙って捨てない**
 *  5. 枚数の上限を越えたら、押す前に理由を出す
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    MAX_CELLS, MAX_SEEDS, buildDetailRunPlan, parseChoices, parseNumberList,
    placeholdersIn, seedSeries,
} from '../web/core/detailRunPlan.js';
import { applySweepCell, expandSweepTemplate } from '../web/core/recipeSweep.js';
import { setLocale } from '../web/i18n/index.js';

test('元の seed が必ず1枚目になる', () => {
    assert.deepEqual(seedSeries(100, 3), [100, 101, 102]);
    assert.deepEqual(seedSeries(100, 1), [100]);
    // 枚数を書き損ねても1枚は出す（0枚の計画を作らない）。
    assert.deepEqual(seedSeries(100, 0), [100]);
    assert.deepEqual(seedSeries(100, -5), [100]);
});

test('seed は非負の安全整数のまま伸びる', () => {
    // **上限に近いときは下へ伸ばす。** はみ出すと投入の直前で落ちる。
    const near = seedSeries(Number.MAX_SAFE_INTEGER, 3);
    assert.equal(near.length, 3);
    assert.ok(near.every(value => Number.isSafeInteger(value) && value >= 0), near.join(','));
    assert.equal(near[0], Number.MAX_SAFE_INTEGER - 1, '元の seed を先頭に置いていない');
    // 0 から下へは伸ばせないので、上へ折り返す。
    assert.deepEqual(seedSeries(0, 3), [0, 1, 2]);
    // seed が読めないときは 0 から（負を作らない）。
    assert.deepEqual(seedSeries(null, 2), [0, 1]);
    assert.deepEqual(seedSeries('abc', 2), [0, 1]);
    assert.equal(seedSeries(5, 999).length, MAX_SEEDS, '枚数の上限を越えている');
});

test('候補は1行1つで、空行を数えない', () => {
    assert.deepEqual(parseChoices('a\n b \n\n c\n'), ['a', 'b', 'c']);
    assert.deepEqual(parseChoices(''), []);
    assert.deepEqual(parseChoices(null), []);
});

test('置き換え口は出た順のまま、同じものを2度出さない', () => {
    assert.deepEqual(placeholdersIn('a {x} b {y} c {x}'), ['{x}', '{y}']);
    assert.deepEqual(placeholdersIn('none here'), []);
});

test('置き換えが無ければ seed だけの計画になる', () => {
    setLocale('en');
    const { template, cellCount } = buildDetailRunPlan({ seed: 7, count: 3 });
    assert.equal(template.mode, 'seeds_only');
    assert.deepEqual(template.axes, [], 'seeds_only に軸を持たせている');
    assert.equal(cellCount, 3);
    // **既にある展開器がそのまま食える形であること。**
    assert.equal(expandSweepTemplate({ ...template, recipeId: 'r' }).length, 3);
});

test('候補が2つ以上ある置き換え口だけが軸になる', () => {
    setLocale('en');
    const { template, cellCount, substitutions } = buildDetailRunPlan({
        seed: 7, count: 2,
        placeholders: [
            { token: '{style}', text: 'watercolor\noil' },
            // **1つだけは軸にできない**（軸は2つ以上要る）。捨てずに置換で返す。
            { token: '{mood}', text: 'calm' },
            // 空は何もしない（元の `{...}` がそのまま残る）。
            { token: '{empty}', text: '  \n ' },
        ],
    });
    assert.equal(template.mode, 'single_axis_seeds');
    assert.equal(template.axes.length, 1);
    assert.equal(template.axes[0].token, '{style}');
    assert.deepEqual(template.axes[0].values.map(v => v.value), ['watercolor', 'oil']);
    assert.deepEqual(template.axes[0].values.map(v => v.baseline), [true, false],
        '基準が1つ目になっていない');
    assert.equal(cellCount, 4, '2候補 × 2枚 になっていない');
    assert.deepEqual(substitutions, [{ token: '{mood}', value: 'calm' }],
        '軸にできない候補を黙って捨てている');
});

test('同じ候補を2度書いても、軸は1度しか持たない', () => {
    setLocale('en');
    // **重複を通すと展開器が投げる。** 「3点あるように見えて実は2点」の軸は、
    // セル数だけ増えて同じ絵を使い回す。
    const { template } = buildDetailRunPlan({
        seed: 1, count: 1, placeholders: [{ token: '{x}', text: 'a\nb\na' }],
    });
    assert.deepEqual(template.axes[0].values.map(v => v.value), ['a', 'b']);
    assert.doesNotThrow(() => expandSweepTemplate({ ...template, recipeId: 'r' }));
});

test('置き換え口が2つ以上なら直積になる', () => {
    setLocale('en');
    const { template, cellCount } = buildDetailRunPlan({
        seed: 1, count: 1,
        placeholders: [
            { token: '{a}', text: '1\n2' },
            { token: '{b}', text: 'x\ny\nz' },
        ],
    });
    assert.equal(template.mode, 'cartesian_seeds');
    assert.equal(cellCount, 6);
    assert.equal(expandSweepTemplate({ ...template, recipeId: 'r' }).length, 6);
});

test('`{...}` の形をしていない口は軸にしない', () => {
    setLocale('en');
    // 展開器は token の形を見て投げる。**その手前で落とす。**
    const { template, substitutions } = buildDetailRunPlan({
        seed: 1, count: 1, placeholders: [{ token: 'style', text: 'a\nb' }],
    });
    assert.deepEqual(template.axes, []);
    assert.deepEqual(substitutions, []);
});

// --- ステップ / CFG の軸（2026-08-22 に「振る」から移した）--------------------

test('数の候補は読点・カンマ・空白で切る', () => {
    assert.deepEqual(parseNumberList('20, 30 40'), [20, 30, 40]);
    assert.deepEqual(parseNumberList('20、30'), [20, 30]);
    // **数へ直せない片は落とす。** `Number('')` は 0 なので、そのまま通すと
    // 「20, 」と打った瞬間に 0 ステップの絵が1枚混ざる。
    assert.deepEqual(parseNumberList('20, '), [20]);
    assert.deepEqual(parseNumberList('20, abc, 30'), [20, 30]);
    // 同じ値を2度書いても1度だけ（展開器は重複で投げる）。
    assert.deepEqual(parseNumberList('20, 20, 30'), [20, 30]);
    assert.deepEqual(parseNumberList(''), []);
});

test('数の欄に2つ以上書くと、その項目の軸になる', () => {
    setLocale('en');
    const { template, cellCount } = buildDetailRunPlan({
        seed: 1, count: 1, parameters: [{ key: 'steps', text: '20, 30, 40' }],
    });
    assert.equal(template.mode, 'single_axis_seeds');
    assert.equal(template.axes[0].kind, 'generation_parameter');
    assert.equal(template.axes[0].parameter, 'steps');
    assert.deepEqual(template.axes[0].values.map(v => v.value), [20, 30, 40]);
    assert.deepEqual(template.axes[0].values.map(v => v.baseline), [true, false, false]);
    assert.equal(cellCount, 3);
    assert.equal(expandSweepTemplate({ ...template, recipeId: 'r' }).length, 3);
});

test('数の欄が1つなら軸にしない（ただの書き換え）', () => {
    setLocale('en');
    const { template } = buildDetailRunPlan({
        seed: 1, count: 1, parameters: [{ key: 'steps', text: '30' }],
    });
    assert.deepEqual(template.axes, [], '1つなのに軸を立てている');
    assert.equal(template.mode, 'seeds_only');
});

// --- LoRA の差し替え軸 -------------------------------------------------------

test('差し替え先を2つ以上選ぶと、LoRA の軸になる', () => {
    setLocale('en');
    const { template, cellCount } = buildDetailRunPlan({
        seed: 1, count: 1,
        loraSwaps: [{ target: '910595', values: ['a.safetensors', 'b.safetensors'] }],
    });
    assert.equal(template.axes[0].kind, 'lora_swap');
    // **`target` は身元。** 並び順で持つと、記録によって順が違うので
    // 静かに別の LoRA へ当たる。
    assert.equal(template.axes[0].target, '910595');
    assert.deepEqual(template.axes[0].values.map(v => v.value), ['a.safetensors', 'b.safetensors']);
    assert.equal(cellCount, 2);
});

test('差し替え先が1つなら軸にしない', () => {
    setLocale('en');
    const { template } = buildDetailRunPlan({
        seed: 1, count: 1, loraSwaps: [{ target: '1', values: ['a.safetensors'] }],
    });
    assert.deepEqual(template.axes, []);
});

test('身元の無い差し替えは作らない（別の LoRA へ当たる）', () => {
    setLocale('en');
    const { template } = buildDetailRunPlan({
        seed: 1, count: 1, loraSwaps: [{ target: '', values: ['a', 'b'] }],
    });
    assert.deepEqual(template.axes, []);
});

test('数の軸と置き換えを混ぜると直積になる', () => {
    setLocale('en');
    const { template, cellCount } = buildDetailRunPlan({
        seed: 1, count: 2,
        parameters: [{ key: 'cfg_scale', text: '4, 7' }],
        placeholders: [{ token: '{x}', text: 'a\nb\nc' }],
    });
    assert.equal(template.mode, 'cartesian_seeds');
    assert.equal(cellCount, 12, '2 × 3 × 2枚 になっていない');
    assert.equal(expandSweepTemplate({ ...template, recipeId: 'r' }).length, 12);
});

test('上限を越える計画は、押す前に理由を出して作らない', () => {
    setLocale('en');
    assert.throws(() => buildDetailRunPlan({
        seed: 1, count: MAX_SEEDS,
        placeholders: [{ token: '{a}', text: '1\n2\n3\n4' }],
    }), /32|limit/, '上限を越えたのに計画を作っている');
    // ちょうど上限なら通る。
    assert.doesNotThrow(() => buildDetailRunPlan({
        seed: 1, count: 3, placeholders: [{ token: '{a}', text: '1\n2\n3\n4\n5\n6\n7\n8' }],
    }));
    assert.equal(MAX_CELLS, 24);
});

// --- 枚数と刻み（2026-08-22「20, 30, 40 と書くのは面倒」）---------------------

test('枚数を指すと、今の値から刻んで並ぶ', () => {
    setLocale('en');
    const { template, cellCount } = buildDetailRunPlan({
        seed: 1, count: 1, parameters: [{ key: 'steps', text: '20', count: 3, spread: 5 }],
    });
    assert.deepEqual(template.axes[0].values.map(v => v.value), [20, 25, 30]);
    // **今の値が1つ目**＝比べる基準が手元に残る。
    assert.equal(template.axes[0].values[0].baseline, true);
    assert.equal(cellCount, 3);
});

test('手で複数書いたら、そちらが勝つ', () => {
    setLocale('en');
    // **書いた値を勝手に置き換えない。**
    const { template } = buildDetailRunPlan({
        seed: 1, count: 1, parameters: [{ key: 'steps', text: '12, 34', count: 5, spread: 5 }],
    });
    assert.deepEqual(template.axes[0].values.map(v => v.value), [12, 34]);
});

test('枚数が1なら軸にしない', () => {
    setLocale('en');
    const { template } = buildDetailRunPlan({
        seed: 1, count: 1, parameters: [{ key: 'steps', text: '20', count: 1, spread: 5 }],
    });
    assert.deepEqual(template.axes, []);
});

test('刻んで負になる分は作らない（0 ステップの絵を混ぜない）', () => {
    setLocale('en');
    const { template } = buildDetailRunPlan({
        seed: 1, count: 1, parameters: [{ key: 'cfg_scale', text: '1', count: 4, spread: -1 }],
    });
    // 1 → 0 まで。−1 以降は作らない。
    assert.deepEqual(template.axes[0].values.map(v => v.value), [1, 0]);
});

test('小数の刻みで端数を持ち込まない', () => {
    setLocale('en');
    const { template } = buildDetailRunPlan({
        seed: 1, count: 1, parameters: [{ key: 'cfg_scale', text: '4.3', count: 3, spread: 0.1 }],
    });
    // **`4.300000000000001` を作らない**（軸の値がそのまま名札になる）。
    assert.deepEqual(template.axes[0].values.map(v => v.value), [4.3, 4.4, 4.5]);
});

// --- 「振る」から移した残りの2軸（2026-08-22）--------------------------------

test('土台のモデルを2つ以上選ぶと、その軸になる', () => {
    setLocale('en');
    const { template, cellCount } = buildDetailRunPlan({
        seed: 1, count: 1, checkpointSwaps: ['a.safetensors', 'b.safetensors'],
    });
    assert.equal(template.axes[0].kind, 'checkpoint');
    // **`target` は取らない**（記録の checkpoint は1つなので指す先が決まる）。
    assert.equal(template.axes[0].target, undefined);
    assert.deepEqual(template.axes[0].values.map(v => v.value), ['a.safetensors', 'b.safetensors']);
    assert.equal(cellCount, 2);
    assert.equal(expandSweepTemplate({ ...template, recipeId: 'r' }).length, 2);
});

test('土台が1つなら軸にしない', () => {
    setLocale('en');
    const { template } = buildDetailRunPlan({ seed: 1, count: 1, checkpointSwaps: ['a.safetensors'] });
    assert.deepEqual(template.axes, []);
});

test('語を2つ以上足すと、末尾へ足す軸になる', () => {
    setLocale('en');
    const { template, cellCount } = buildDetailRunPlan({
        seed: 1, count: 1, appendWords: 'masterpiece\nsketch',
    });
    assert.equal(template.axes[0].kind, 'prompt_append');
    assert.deepEqual(template.axes[0].values.map(v => v.value), ['masterpiece', 'sketch']);
    assert.equal(cellCount, 2);
});

test('語が1つなら軸にしない（置換と違い、そのままでは足さない）', () => {
    setLocale('en');
    const { template } = buildDetailRunPlan({ seed: 1, count: 1, appendWords: 'masterpiece' });
    assert.deepEqual(template.axes, []);
});

test('土台を差し替えたら `localPath` も書く（`file_name` だけでは効かない）', () => {
    setLocale('en');
    // **組み立ては `inLibrary ? localPath : null` を先に見る**ので
    //（`recipeWorkflowBuilder.getResourceFilename`）、引き直し済みの記録では
    // 古い `localPath` が勝ち、**セル数だけ増えて同じ絵が出る**。
    const { template } = buildDetailRunPlan({
        seed: 1, count: 1, checkpointSwaps: ['a.safetensors', 'b.safetensors'],
    });
    const recipe = {
        checkpoint: { file_name: 'old.safetensors', localPath: 'dir/old.safetensors', inLibrary: true },
        loras: [],
        gen_params: { prompt: 'x', seed: 1 },
    };
    const cells = expandSweepTemplate({ ...template, recipeId: 'r' });
    const swapped = cells.map(cell => applySweepCell(recipe, template, cell).checkpoint);
    assert.deepEqual(swapped.map(c => c.localPath), ['a.safetensors', 'b.safetensors'],
        'localPath が古いまま');
    assert.deepEqual(swapped.map(c => c.file_name), ['a.safetensors', 'b.safetensors']);
    assert.deepEqual(swapped.map(c => c.inLibrary), [true, true]);
});

// --- 記録が持つ ComfyUI のグラフ（2026-08-22 利用者の報告）------------------

test('`generation_metadata.comfy` のグラフも読む（動画の記録はこの形で来る）', async () => {
    const { buildRecipeWorkflow } = await import('../web/core/recipeWorkflowBuilder.js');
    // Wan の i2v。**チェックポイントは持っていない**——持っているのはグラフの方。
    const graph = {
        1: { class_type: 'UNETLoader', inputs: { unet_name: 'wan.safetensors', weight_dtype: 'default' } },
        2: { class_type: 'SaveAnimatedWEBP', inputs: { filename_prefix: 'Wan', fps: 16, images: ['1', 0] } },
    };
    const objectInfo = {
        UNETLoader: { input: { required: { unet_name: [['wan.safetensors']], weight_dtype: [['default']] } } },
        // **`output_node` を書く。** 本物の `/object_info` は書いてくる。
        // 書かないと「使えない出口」と見なされ、`SaveImage` が足される
        // ——**検査の不備であって、製品の不具合ではない**（一度そう読み違えた）。
        SaveAnimatedWEBP: {
            output_node: true,
            input: { required: { filename_prefix: ['STRING'], fps: ['FLOAT'], images: ['IMAGE'] } },
        },
        SaveImage: {
            output_node: true,
            input: { required: { filename_prefix: ['STRING'], images: ['IMAGE'] } },
        },
    };
    const recipe = {
        id: 'v', gen_params: { prompt: 'x', seed: 1 },
        generation_metadata: { comfy: { prompt: graph } },
    };
    // **ここを見ないと「チェックポイント情報がありません」と言ってしまう**
    // ——実物にはノードの揃ったグラフが在るのに、である。
    const built = buildRecipeWorkflow(recipe, { objectInfo });
    const nodes = built.prompt || built.workflow || built;
    assert.ok(Object.keys(nodes).length >= 2, 'グラフを読めていない');
    assert.ok(Object.values(nodes).some(n => n?.class_type === 'SaveAnimatedWEBP'),
        '動画の出口が落ちている');
});

test('こちらが書いた記録の `prompt` もグラフとして読む', async () => {
    const { buildRecipeWorkflow } = await import('../web/core/recipeWorkflowBuilder.js');
    // **上流のレシピは `comfy_prompt`、こちらの記録は `prompt`。** ComfyUI の
    // 出力を落とし込むと PNG の `prompt` チャンクがそのままこの名前で残る。
    // 見ていなかったので、**ノードの揃ったグラフと checkpoint と LoRA 5本を
    // 持つ記録が「再現不可・チェックポイント情報がありません」と出ていた**
    // （2026-08-23 利用者の指摘・実データ `ComfyUI_00444_`）。
    const graph = {
        1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'wai.safetensors' } },
        2: { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI', images: ['1', 0] } },
    };
    const objectInfo = {
        CheckpointLoaderSimple: { input: { required: { ckpt_name: [['wai.safetensors']] } } },
        SaveImage: {
            output_node: true,
            input: { required: { filename_prefix: ['STRING'], images: ['IMAGE'] } },
        },
    };
    const built = buildRecipeWorkflow(
        { id: 'own', gen_params: { prompt: 'x', seed: 1 }, prompt: graph }, { objectInfo });
    const nodes = built.prompt || built.workflow || built;
    assert.ok(Object.values(nodes).some(n => n?.class_type === 'CheckpointLoaderSimple'),
        '記録が持つグラフを読めていない');
});

test('本文のプロンプトをグラフと取り違えない', async () => {
    const { buildRecipeWorkflow } = await import('../web/core/recipeWorkflowBuilder.js');
    // `prompt` は上流では**本文**のこともある。**グラフとして通すと壊れる**ので、
    // 「値が全部 `class_type` を持つ」ときだけグラフと認めること。
    assert.throws(
        () => buildRecipeWorkflow(
            { id: 'text', gen_params: { prompt: 'x', seed: 1 }, prompt: 'masterpiece, best quality' },
            { objectInfo: {} }),
        /checkpoint|チェックポイント/,
        '本文をグラフとして読んでいる');
    // オブジェクトでも、ノードの形をしていなければ通さない。
    assert.throws(
        () => buildRecipeWorkflow(
            { id: 'obj', gen_params: { prompt: 'x', seed: 1 }, prompt: { a: 1, b: 2 } },
            { objectInfo: {} }),
        /checkpoint|チェックポイント/,
        'ノードでない dict をグラフとして読んでいる');
});

test('グラフもチェックポイントも無ければ、理由を言って断る', async () => {
    const { buildRecipeWorkflow } = await import('../web/core/recipeWorkflowBuilder.js');
    // **黙って空のグラフを作らない。** 実データで6/120件がこの形だった。
    assert.throws(
        () => buildRecipeWorkflow({ id: 'n', gen_params: { prompt: 'x', seed: 1 } }, { objectInfo: {} }),
        /checkpoint|チェックポイント/,
    );
});
