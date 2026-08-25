/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 工程1 — **足りないのは束ではなく軸だった。**（裁定②・2026-08-20）
 *
 * 「実行リスト」の正体は
 * 「レコードの一部を固定し、キャラ／checkpoint／LoRA を変数にした画像群」で、
 * これは記録の束ではなく**軸の宣言（実験の型）**である。ここで固定するのは3つ:
 *
 *  1. **`lora_swap` 軸**（＝キャラを変数にする）が在り、契約検査を通ること
 *  2. **導入済みから選ぶ**雛形が `/object_info` を渡したときだけ出ること
 *  3. **型は記録から独立**していて、別の記録へ当てられること。
 *     当たらなかった軸を**黙って落とさない**こと
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    applyExperimentType, experimentTypeFromTemplate,
    readExperimentTypes, removeExperimentType, resolveAxisFor, saveExperimentType,
} from '../web/core/experimentTypes.js';
import { buildBuiltinSweepTemplates, installedModelOptions } from '../web/core/sweepAxes.js';
import { applySweepCell, assertOnlySweepInputsChanged } from '../web/core/recipeSweep.js';
import { installEnvironment, resetEnvironment } from '../web/core/environment.js';
import { setLocale } from '../web/i18n/index.js';

/** 揮発の入れ物（`.recipe.json` へは書かない・`localStorage` も掴まない）。 */
function useMemoryStorage() {
    const map = new Map();
    installEnvironment({
        // 引数を受ける形で書く（installEnvironment が引数の数を見て拒む）。
        request: async (input) => { throw new Error('no network in this test: ' + input); },
        storage: {
            getItem: (key) => (map.has(key) ? map.get(key) : null),
            setItem: (key, value) => { map.set(key, String(value)); },
            removeItem: (key) => { map.delete(key); },
        },
    });
    return map;
}

const recordWithLora = (overrides = {}) => ({
    id: 'rec-a',
    checkpoint: { file_name: 'base.safetensors' },
    loras: [
        { file_name: 'charA.safetensors', name: 'charA', modelVersionId: 111, strength: 0.8 },
        { file_name: 'styleB.safetensors', name: 'styleB', modelVersionId: 222, strength: 0.6 },
    ],
    gen_params: { prompt: 'a girl, __STYLE__', seed: 7, cfg_scale: 7, steps: 20 },
    ...overrides,
});

// --- 1. lora_swap 軸 -------------------------------------------------------

test('lora_swap は LoRA を差し替え、効き目は引き継ぎ身元は引き継がない', () => {
    setLocale('en');
    const recipe = recordWithLora();
    const template = {
        id: 't', name: 'swap', mode: 'cartesian', seeds: [],
        axes: [{
            id: 'swap', kind: 'lora_swap', label: 'character', target: '111',
            values: [
                { label: 'base', value: 'charA.safetensors', baseline: true },
                { label: 'other', value: 'charC.safetensors', baseline: false },
            ],
        }],
    };
    const cell = { id: 'c1', selections: { swap: { value: 'charC.safetensors' } }, seed: null };
    const varied = applySweepCell(recipe, template, cell);

    assert.equal(varied.loras[0].file_name, 'charC.safetensors');
    // 効き目は持ち越す（差し替えても同じ強さで比べたい）。
    assert.equal(varied.loras[0].strength, 0.8);
    // **身元は持ち越さない。** 別の物を元の版として記録したことになる。
    assert.equal(varied.loras[0].modelVersionId, undefined);
    // 他の LoRA は触らない。
    assert.equal(varied.loras[1].file_name, 'styleB.safetensors');
    // 元の記録は書き換えない。
    assert.equal(recipe.loras[0].file_name, 'charA.safetensors');
});

test('lora_swap は manifest の要求からも、居なくなった LoRA を外す', () => {
    setLocale('en');
    const recipe = recordWithLora({
        replay_manifest: {
            required_resources: [
                { kind: 'lora', resource: { file_name: 'charA.safetensors', modelVersionId: 111 } },
                { kind: 'lora', resource: { file_name: 'styleB.safetensors', modelVersionId: 222 } },
                { kind: 'checkpoint', resource: { file_name: 'base.safetensors' } },
            ],
        },
    });
    const template = {
        id: 't', name: 'swap', mode: 'cartesian', seeds: [],
        axes: [{
            id: 'swap', kind: 'lora_swap', target: '111', label: 'character',
            values: [
                { label: 'base', value: 'charA.safetensors', baseline: true },
                { label: 'other', value: 'charC.safetensors', baseline: false },
            ],
        }],
    };
    const varied = applySweepCell(recipe, template, {
        id: 'c1', selections: { swap: { value: 'charC.safetensors' } }, seed: null,
    });
    const required = varied.replay_manifest.required_resources;
    // **要求と実際の鎖が食い違ったまま「厳密再現」を名乗らない。**
    assert.equal(required.filter(item => item.resource.modelVersionId === 111).length, 0);
    assert.equal(required.filter(item => item.resource.modelVersionId === 222).length, 1);
    assert.equal(required.filter(item => item.kind === 'checkpoint').length, 1);
    // 元の記録は書き換えない。
    assert.equal(recipe.replay_manifest.required_resources.length, 3);
});

test('表示だけの欄（_meta）は契約検査で数えない——が、ノードの増減は数える', () => {
    setLocale('en');
    const template = {
        id: 't', name: 'swap', mode: 'cartesian', seeds: [],
        axes: [{ id: 'swap', kind: 'lora_swap', target: '0', label: 'c', values: [] }],
    };
    const baseline = {
        9: { class_type: 'LoraLoader', inputs: { lora_name: 'a.safetensors' }, _meta: { title: 'Load LoRA a' } },
    };

    // 差し替えで題も別名も変わる。**ComfyUI はこれをエラー文言にしか使わない**
    // （実測: `execution.py` の `validate_prompt`）。
    const renamed = {
        9: { class_type: 'LoraLoader', inputs: { lora_name: 'b.safetensors' }, _meta: { title: 'Load LoRA b' } },
    };
    assert.doesNotThrow(() => assertOnlySweepInputsChanged(baseline, renamed, template));

    // **ノードが消えたら弾く。** 差し替え先が未導入で鎖から落ちた場合がこれ。
    const dropped = {};
    assert.throws(() => assertOnlySweepInputsChanged(baseline, dropped, template),
        /unintended graph inputs/);
});

// --- 2. 導入済みから選ぶ雛形 ------------------------------------------------

test('導入済みの一覧を、2通りの形のどちらからでも読める', () => {
    // 実測（2026-08-14）: 素の配列と `['COMBO', {options}]` の両方が在る。
    // 片方だけ見ると、その環境でだけ0件になる。
    const plain = { LoraLoader: { input: { required: { lora_name: [['a.safetensors', 'b.safetensors']] } } } };
    const combo = { LoraLoader: { input: { required: { lora_name: ['COMBO', { options: ['a.safetensors'] }] } } } };
    assert.deepEqual(installedModelOptions(plain, 'LoraLoader', 'lora_name'), ['a.safetensors', 'b.safetensors']);
    assert.deepEqual(installedModelOptions(combo, 'LoraLoader', 'lora_name'), ['a.safetensors']);
    assert.deepEqual(installedModelOptions({}, 'LoraLoader', 'lora_name'), []);
});

test('差し替えの雛形は /object_info を渡したときだけ出る', () => {
    setLocale('en');
    const record = recordWithLora();
    const withoutInfo = buildBuiltinSweepTemplates(record).map(item => item.id);
    assert.ok(!withoutInfo.includes('builtin-checkpoint-swap'),
        '導入済みが判らないのに checkpoint 差し替えを出している（無い物へ差し替えさせる）');
    assert.ok(!withoutInfo.some(id => id.startsWith('builtin-lora-swap')));

    const objectInfo = {
        CheckpointLoaderSimple: { input: { required: { ckpt_name: [[
            'base.safetensors', 'other1.safetensors', 'other2.safetensors',
        ]] } } },
        LoraLoader: { input: { required: { lora_name: [[
            'charA.safetensors', 'charC.safetensors', 'charD.safetensors',
        ]] } } },
    };
    const withInfo = buildBuiltinSweepTemplates(record, { objectInfo });
    const ids = withInfo.map(item => item.id);
    assert.ok(ids.includes('builtin-checkpoint-swap'), 'checkpoint 差し替えの雛形が出ていない');
    // **記録が指す LoRA の本数ぶん出る**（2026-08-20 に先頭1本だけから変えた）。
    // 元は「同じ系統の候補が手元に在るとき」だけ出していたので、2本目以降を
    // 差し替える道が画面に無かった。候補は画面側で絵から選ぶ。
    assert.ok(ids.includes('builtin-lora-swap-1'), 'LoRA 差し替えの雛形が出ていない');

    const swap = withInfo.find(item => item.id === 'builtin-lora-swap-1');
    assert.equal(swap.axes[0].kind, 'lora_swap');
    // 基準は必ず**今の値**（比較の土台が動かない）。
    assert.equal(swap.axes[0].values.find(v => v.baseline).value, 'charA.safetensors');
    // 候補に今の値は入れない（同じグラフを2回組むと片方が「既に出ている」に化ける）。
    assert.equal(swap.axes[0].values.filter(v => v.value === 'charA.safetensors').length, 1);
});

test('同じ系統から候補を採る（系統をまたぐと絵が壊れる）', () => {
    setLocale('en');
    const record = recordWithLora({ checkpoint: { file_name: 'Illustrious\\anime\\base.safetensors' } });
    const objectInfo = {
        CheckpointLoaderSimple: { input: { required: { ckpt_name: [[
            'Illustrious\\anime\\base.safetensors',
            'Illustrious\\anime\\sibling1.safetensors',
            'Illustrious\\anime\\sibling2.safetensors',
            'Flux\\photo\\stranger.safetensors',
        ]] } } },
        LoraLoader: { input: { required: { lora_name: [['charA.safetensors']] } } },
    };
    const template = buildBuiltinSweepTemplates(record, { objectInfo })
        .find(item => item.id === 'builtin-checkpoint-swap');
    const picked = template.axes[0].values.filter(v => !v.baseline).map(v => v.value);
    assert.deepEqual(picked, [
        'Illustrious\\anime\\sibling1.safetensors',
        'Illustrious\\anime\\sibling2.safetensors',
    ], '系統をまたいだ候補を並べている');
});

// --- 3. 実験の型 -----------------------------------------------------------

test('型は記録を持たない（別の記録へ当てられる形で保存される）', () => {
    useMemoryStorage();
    const type = experimentTypeFromTemplate({
        id: 'builtin-cfg-steps', name: 'CFG × Steps', mode: 'cartesian', seeds: [],
        recipeId: 'rec-a',
        axes: [
            { id: 'cfg', kind: 'generation_parameter', parameter: 'cfg_scale', values: [], recipeId: 'rec-a' },
        ],
    });
    assert.ok(!Object.hasOwn(type, 'recipeId'), '型が作ったときの記録を抱えている');
    assert.ok(!Object.hasOwn(type.axes[0], 'recipeId'), '軸が作ったときの記録を抱えている');
    resetEnvironment();
});

test('保存した型を読み書きできる（同じ id は置き換える）', () => {
    useMemoryStorage();
    assert.deepEqual(readExperimentTypes(), []);
    saveExperimentType({ id: 't1', name: 'One', mode: 'cartesian', axes: [{ id: 'a', kind: 'checkpoint', values: [] }] });
    saveExperimentType({ id: 't2', name: 'Two', mode: 'cartesian', axes: [{ id: 'a', kind: 'checkpoint', values: [] }] });
    assert.equal(readExperimentTypes().length, 2);
    saveExperimentType({ id: 't1', name: 'One (edited)', mode: 'cartesian', axes: [{ id: 'a', kind: 'checkpoint', values: [] }] });
    const list = readExperimentTypes();
    assert.equal(list.length, 2, '同じ id が2つに増えている');
    assert.equal(list.find(item => item.id === 't1').name, 'One (edited)');
    removeExperimentType('t1');
    assert.deepEqual(readExperimentTypes().map(item => item.id), ['t2']);
    resetEnvironment();
});

test('当たらない軸を黙って落とさない', () => {
    useMemoryStorage();
    const type = {
        id: 't', name: 'mixed', mode: 'cartesian', seeds: [],
        axes: [
            { id: 'ck', kind: 'checkpoint', values: [] },
            { id: 'ph', kind: 'prompt_placeholder', token: '__NOT_HERE__', values: [] },
            { id: 'ls', kind: 'lora_strength', target: '999', values: [] },
        ],
    };
    const target = recordWithLora({ id: 'rec-b', gen_params: { prompt: 'no token here' } });
    const result = applyExperimentType(type, target);

    assert.equal(result.applied.length, 2, '当たる軸の数が合わない');
    // プロンプトに置き換え語が無い軸は落ちる。**落ちたことが返る。**
    assert.deepEqual(result.dropped, [{ axisId: 'ph', reason: 'token-not-in-prompt' }]);
    // 別の記録の LoRA を指していた軸は、**寄せたことを言ってから**寄せる。
    assert.deepEqual(result.rebound, [{ axisId: 'ls', from: '999', to: '111' }]);
    assert.equal(result.template.recipeId, 'rec-b');
    resetEnvironment();
});

test('当たる軸が1本も無ければ雛形を作らない（0軸で黙って始めない）', () => {
    useMemoryStorage();
    const type = {
        id: 't', name: 'lora only', mode: 'cartesian', seeds: [],
        axes: [{ id: 'ls', kind: 'lora_strength', target: '1', values: [] }],
    };
    const noLora = { id: 'rec-c', loras: [], gen_params: { prompt: 'x' } };
    const result = applyExperimentType(type, noLora);
    assert.equal(result.template, null, '0軸の雛形を返している（seed だけの Sweep が黙って始まる）');
    assert.deepEqual(result.dropped, [{ axisId: 'ls', reason: 'record-has-no-lora' }]);
    resetEnvironment();
});

test('知らない種類の軸を、当たったことにしない', () => {
    const result = resolveAxisFor(recordWithLora(), { id: 'x', kind: 'not-a-real-kind' });
    assert.deepEqual(result, { ok: false, reason: 'unsupported-axis-kind', axisId: 'x' });
});
