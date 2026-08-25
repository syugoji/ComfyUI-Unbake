/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * **フォークの外で同じグラフが出ることを実測する。**
 *
 * 切り出しは「動くコードを別の置き場へ移した」だけのはずだが、それは主張であって
 * 観測ではない。ここは実レシピを両方の実装へ通し、**組み上がったグラフを深く比較**する。
 *
 * 比較に `JSON.stringify(x, keys)` を使わないこと。第2引数は並び順ではなく
 * **allowlist** なので、指紋のつもりで渡すと中身が丸ごと落ちて「同一」に見える。
 * ここでは鍵を再帰的に並べ替えた正準形を作ってから比べる。
 *
 *   node tests/fork_parity_scan.mjs --fork <フォークの static/js/utils> --recipes <レシピの置き場>
 *
 * 終了コード: 0=全件一致 / 1=不一致あり・実行不能
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function argOf(name, fallback = null) {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** 鍵を再帰的に並べ替えた正準形。**配列の順序は保つ**（グラフの接続は順序が意味を持つ）。 */
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value).sort().map(key => [key, canonical(value[key])]),
        );
    }
    return value;
}

const forkDir = argOf('--fork');
const recipesDir = argOf('--recipes');
if (!forkDir || !recipesDir) {
    console.error('使い方: node tests/fork_parity_scan.mjs --fork <static/js/utils> --recipes <レシピの置き場>');
    process.exit(1);
}

const forkModule = pathToFileURL(path.join(forkDir, 'recipeWorkflowBuilder.js')).href;
const hereModule = new URL('../web/core/recipeWorkflowBuilder.js', import.meta.url).href;

const fork = await import(forkModule);
const here = await import(hereModule);

const files = fs.readdirSync(recipesDir).filter(name => name.endsWith('.recipe.json'));
if (files.length === 0) {
    console.error(`レシピが0件です: ${recipesDir}`);
    process.exit(1);
}

let compared = 0;
let same = 0;
const differing = [];
const errors = [];

for (const name of files) {
    let recipe;
    try {
        recipe = JSON.parse(fs.readFileSync(path.join(recipesDir, name), 'utf8'));
    } catch (error) {
        errors.push([name, `読めない: ${error.message}`]);
        continue;
    }
    let a;
    let b;
    try {
        a = fork.buildRecipeWorkflow(recipe);
    } catch (error) {
        a = { threw: String(error?.message || error) };
    }
    try {
        b = here.buildRecipeWorkflow(recipe);
    } catch (error) {
        b = { threw: String(error?.message || error) };
    }
    compared += 1;
    if (JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))) same += 1;
    else differing.push(name);
}

console.log(`比較 ${compared}件 / 一致 ${same}件 / 不一致 ${differing.length}件 / 読めず ${errors.length}件`);
if (differing.length) console.log(differing.slice(0, 10).join('\n'));
if (errors.length) console.log(errors.slice(0, 5).map(e => e.join(': ')).join('\n'));

// **検出器が発火することを示す。** 0件は「同一」とも「比較していない」とも読める。
const control = { checkpoint: { file_name: 'a.safetensors' }, gen_params: { prompt: 'x', seed: 1 } };
const mutated = { checkpoint: { file_name: 'a.safetensors' }, gen_params: { prompt: 'x', seed: 2 } };
const fires = JSON.stringify(canonical(here.buildRecipeWorkflow(control)))
    !== JSON.stringify(canonical(here.buildRecipeWorkflow(mutated)));
console.log(`対照（seed だけ変えた入力）で差を検出: ${fires ? 'YES' : 'NO'}`);

process.exit(differing.length === 0 && errors.length === 0 && fires ? 0 : 1);
