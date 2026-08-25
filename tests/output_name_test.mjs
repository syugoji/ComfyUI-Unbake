/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 出す画像のファイル名に **`recipe` を出さない**（2026-08-20 ユーザー指示）。
 *
 * `recipe` は上流（LoRA Manager）の語で、外向きの語彙には使わない（決定④）。
 * Civitai から来たものは **`civitai_<画像ID>`** で意味が足りる。
 *
 * **実物では二重に付いていた。** 呼び手が `Recipe_` を前置し、その題が既に
 * `Civitai_Recipe_47986787` だったため、出力は
 * `Recipe_Civitai_Recipe_47986787_00045_.png` になっていた
 * ——実測（2026-08-20・出力4,275枚）で **2,387枚**がこの形。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRecipeWorkflowName } from '../web/core/recipeWorkflowName.js';
import { buildRecipeWorkflow } from '../web/core/recipeWorkflowBuilder.js';
import { setLocale } from '../web/i18n/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('Civitai 由来は civitai_<画像ID> になる', () => {
    // 既存の題（`Civitai_Recipe_<id>`）からも ID を拾って直す——直さないと、
    // 古い記録から出す絵にだけ `recipe` が残り続ける。
    assert.equal(createRecipeWorkflowName({ title: 'Civitai_Recipe_47986787' }), 'civitai_47986787');
    assert.equal(createRecipeWorkflowName({ title: 'Civitai Recipe 123' }), 'civitai_123');
    assert.equal(createRecipeWorkflowName({ civitai_image_id: '999' }), 'civitai_999');
    assert.equal(createRecipeWorkflowName({ civitaiImageId: 888 }), 'civitai_888');
    // 出典 URL からも拾う（`.red` は手元の記録の326/340件）。
    assert.equal(
        createRecipeWorkflowName({ source_path: 'https://civitai.red/images/777' }),
        'civitai_777',
    );
});

test('どの入力からも recipe という語が出ない', () => {
    const inputs = [
        { title: 'Civitai_Recipe_1' },
        { title: 'Recipe_my_thing' },
        { title: 'recipe_lowercase' },
        { id: 'abc-123' },
        { recipe_id: 'def-456' },
        {},
        null,
    ];
    for (const input of inputs) {
        const name = createRecipeWorkflowName(input);
        assert.doesNotMatch(name, /recipe/i, `${JSON.stringify(input)} から ${name} が出た`);
        assert.doesNotMatch(name, /[^a-zA-Z0-9_-]/, `ファイル名に使えない字がある: ${name}`);
    }
    // 落とすところが無ければ `record_`（外向きの語は Generation Record）。
    assert.equal(createRecipeWorkflowName({}), 'record_workflow');
    assert.equal(createRecipeWorkflowName({ id: 'abc-123' }), 'record_abc-123');
});

test('前置が二重にならない', () => {
    // **これが実物で 2,387枚起きていた形。**
    assert.equal(createRecipeWorkflowName({ title: 'Recipe_Civitai_Recipe_47986787' }), 'civitai_47986787');
    assert.equal(createRecipeWorkflowName({ title: 'Recipe_my_thing' }), 'my_thing');
    assert.equal(createRecipeWorkflowName({ title: 'Record_my_thing' }), 'my_thing');
});

test('組み立て側が名前を前置しない（付けるのは1箇所だけ）', async () => {
    // 前置を呼び手に持たせると、題が既に接頭辞を持っていたときに二重になる。
    // **名前を作るのは `recipeWorkflowName.js` だけ**であることをここで固定する。
    const builder = await readFile(join(ROOT, 'web/core/recipeWorkflowBuilder.js'), 'utf8');
    const prefixes = [...builder.matchAll(/filename_prefix:\s*([^,\n}]+)/g)].map(m => m[1].trim());
    assert.ok(prefixes.length >= 4, `filename_prefix を拾えていない（${prefixes.length}）`);
    for (const value of prefixes) {
        assert.equal(value, 'createRecipeWorkflowName(recipe)',
            `名前を自前で組んでいる: ${value}`);
    }
    // 検出器が生きていること。
    assert.doesNotMatch('createRecipeWorkflowName(recipe)', /Recipe_\$\{/);
});

test('実データ346件から作った名前に recipe が1件も無い', (t) => {
    const dir = process.env.UNBAKE_RECIPES_DIR;
    if (!dir || !fs.existsSync(dir)) { t.skip('レシピの置き場が指定されていない'); return; }
    const names = fs.readdirSync(dir)
        .filter(name => name.endsWith('.recipe.json'))
        .map(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')))
        .map(createRecipeWorkflowName);
    assert.ok(names.length >= 100, `実データが少なすぎる（${names.length}件）`);

    const offenders = names.filter(name => /recipe/i.test(name));
    assert.deepEqual(offenders, [], `recipe を含む名前がある: ${offenders.slice(0, 3).join(', ')}`);

    // **大半が `civitai_<id>` になること。** 全部が落ちて `record_` になっていたら、
    // 「recipe が無い」だけ満たして意味が消えている。
    const civitai = names.filter(name => /^civitai_\d+$/.test(name)).length;
    console.log(`${names.length}件 → civitai_<id> が ${civitai}件`);
    assert.ok(civitai > names.length * 0.8,
        `civitai_<id> になった割合が低すぎる（${civitai}/${names.length}）`);
});

test('埋め込みグラフでも、既定の名前のままなら記録の名前を付ける', (t) => {
    const infoPath = process.env.UNBAKE_OBJECT_INFO;
    if (!infoPath || !fs.existsSync(infoPath)) { t.skip('/object_info の控えが指定されていない'); return; }
    setLocale('en');
    const objectInfo = JSON.parse(fs.readFileSync(infoPath, 'utf8'));

    // 埋め込みグラフは**そのまま使う**のが原則なので、作者が決めた行き先は触らない。
    // だが `ComfyUI` は「決めていない」のと同じ——そのままだと再現した絵が
    // `ComfyUI_00356_.png` として出て、**他のどの絵とも見分けが付かない**
    // （実機で確認した）。
    const base = {
        id: 'rec-1',
        title: 'Civitai_Recipe_4242',
        comfy_prompt: {
            1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'x.safetensors' } },
            2: { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI', images: [1, 0] } },
        },
        gen_params: { prompt: 'a girl', seed: 1, steps: 20, cfg_scale: 7 },
    };
    const named = buildRecipeWorkflow(base, { objectInfo, embeddings: [] });
    const prefixOf = (wf) => Object.values(wf.prompt)
        .filter(node => node?.inputs && 'filename_prefix' in node.inputs)
        .map(node => String(node.inputs.filename_prefix));
    assert.deepEqual(prefixOf(named), ['civitai_4242'], '既定のままの名前を直していない');

    // **作者が決めた行き先は触らない。**
    const custom = buildRecipeWorkflow({
        ...base,
        comfy_prompt: {
            ...base.comfy_prompt,
            2: { class_type: 'SaveImage', inputs: { filename_prefix: 'my/own/folder', images: [1, 0] } },
        },
    }, { objectInfo, embeddings: [] });
    assert.deepEqual(prefixOf(custom), ['my/own/folder'], '作者が決めた行き先を上書きしている');
});
