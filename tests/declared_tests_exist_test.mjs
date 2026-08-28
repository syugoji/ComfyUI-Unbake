/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **宣言を、宣言のまま置かない**（`D-20260828-01` 群B）。
 *
 * このリポジトリには「唯一の場所」「同値は◯◯が固定する」という宣言が
 * あちこちに在る。**それ自体はよいことだが、宣言は検査ではない。**
 * 実測（2026-08-28）で、名指しされた検査のうち **5本が存在しなかった**:
 *
 *     tests/frontend/utils/modelFileNames.test.js
 *     tests/utils/test_model_file_names.py
 *     tests/services/test_resource_availability_service.py
 *     tests/frontend/utils/recipeMissingResources.test.js
 *     tests/test_known_model_catalog.py
 *
 * 名前が在ると**読んだ人はそこで確かめるのをやめる**ので、無い検査を
 * 名指しするのは、何も書かないより悪い。この2本は、
 *
 *   1. 名指しされた検査が**実在すること**
 *   2. 「両言語で同じ」と宣言した規則が**本当に同じであること**
 *
 * を機械で見る。1 が在れば、次に同じ形で書いた人はその場で赤くなる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEARCH_DIRS = ['web', 'unbake'];
/** 名指しを拾う形。`tests/…` から拡張子まで。 */
const NAMED = /tests\/[A-Za-z0-9_./-]+\.(?:mjs|js|py)/g;

async function* sourceFiles(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name === '__pycache__' || entry.name === 'node_modules') continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) yield* sourceFiles(path);
        else if (/\.(mjs|js|py)$/.test(entry.name)) yield path;
    }
}

const exists = async (path) => {
    try { await stat(path); return true; } catch { return false; }
};

test('名指しした検査が全部実在する', async () => {
    const missing = [];
    for (const dir of SEARCH_DIRS) {
        for await (const file of sourceFiles(join(ROOT, dir))) {
            const source = await readFile(file, 'utf8');
            for (const named of new Set(source.match(NAMED) || [])) {
                if (!(await exists(join(ROOT, named)))) {
                    missing.push(`${relative(ROOT, file)} → ${named}`);
                }
            }
        }
    }
    assert.deepEqual(missing, [],
        `存在しない検査を名指ししている（読んだ人はそこで確かめるのをやめる）:\n  ${missing.join('\n  ')}`);
});

test('拡張子の並びが JavaScript と Python で同じ', async () => {
    /*
     * `modelFileNames.js` の冒頭がこの同値を宣言している。**宣言した以上、
     * 機械で見る。** 片側だけ足すと、`ae.sft` が導入済みの `ae.safetensors` と
     * 照合できずに投入ごと拒否される——**実際に起きた壊れ方**である。
     */
    const listOf = (text, name) => {
        const block = new RegExp(`${name}[^=]*=\\s*(?:Object\\.freeze\\()?\\(?\\[?([^\\])]*)`)
            .exec(text)?.[1] || '';
        return [...block.matchAll(/['"]([a-z0-9]+)['"]/g)].map(match => match[1]);
    };
    const js = await readFile(join(ROOT, 'web/core/modelFileNames.js'), 'utf8');
    const py = await readFile(join(ROOT, 'unbake/utils/model_file_names.py'), 'utf8');

    for (const name of ['MODEL_FILE_EXTENSIONS', 'COMFYUI_SUPPORTED_PT_EXTENSIONS']) {
        const fromJs = listOf(js, name);
        const fromPy = listOf(py, name);
        assert.ok(fromJs.length >= 8, `${name} を JS 側から読めていない: ${fromJs}`);
        // **順序も見る。** `pt2` を `pt` の後ろへ置くと `model.pt2` が割れる。
        assert.deepEqual(fromJs, fromPy,
            `${name} が両言語で食い違っている（片側だけ足した）`);
    }

    // 抜けていた3つは、**抜けたことが実害になった**ので名指しで固定する。
    for (const extension of ['pt2', 'pkl', 'onnx', 'sft']) {
        assert.ok(listOf(js, 'MODEL_FILE_EXTENSIONS').includes(extension),
            `${extension} が落ちている`);
    }
});

test('「積めない種別」の集合が JavaScript と Python で同じ', async () => {
    /*
     * `resource_availability_service.py` がこの同値を宣言している。
     * **片側だけ足すと「手段を奪う側」へ倒れる**——落とせるはずの素材が
     * 「積めない」に分類され、再現できるレシピが再現不可になる。
     * （こちらも長らく存在しない検査を名指ししていた。）
     */
    const setOf = (text) => [...text.matchAll(/['"]([a-z ]+)['"]/g)].map(match => match[1]).sort();
    const js = await readFile(join(ROOT, 'web/core/recipeMissingModels.js'), 'utf8');
    const py = await readFile(join(ROOT, 'unbake/services/recipes/resource_availability_service.py'), 'utf8');
    const fromJs = setOf(/NON_LOADABLE_FILE_TYPES = new Set\(\[([^\]]*)\]/.exec(js)?.[1] || '');
    const fromPy = setOf(/NON_LOADABLE_FILE_TYPES = frozenset\(\{([^}]*)\}/.exec(py)?.[1] || '');
    assert.ok(fromJs.length > 0, `JS 側を読めていない: ${fromJs}`);
    assert.deepEqual(fromJs, fromPy, '積めない種別が両言語で食い違っている');
});
