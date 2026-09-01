/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **名前を寄せる規則を、1本に保つ**（`I-20260831-69`）。
 *
 * `model_file_names.py` は自分を「**the single place**」と名乗り、
 * 2026-08-16 の棚卸しで「**9箇所に5通りの一覧**が手書きされていた」ことまで
 * 書いてある。**それでも 2026-08-31 に5つ在った**:
 *
 *     unbake/utils/model_file_names.py   （正）
 *     unbake/models.py            `_stem`      pt2 / pkl が無い・gguf が在る
 *     unbake/model_index.py       `name_key`   pt2 / pkl / onnx が無い
 *     web/panel/modelsView.js     `stemOf`     pt2 / pkl が無い
 *     unbake/download.py          `ALLOWED_SUFFIXES`（**別の規則**・下記）
 *
 * `model_index.get()` は `/unbake/model-index` で画面へ渡り、画面は正の一覧で
 * 寄せる。だから `x.gguf` は **Python が `x` で索引し、JS は `xgguf` で引く**
 * ——`model_index.py` 自身が書いている「**どちらかに寄せないと、在るのに
 * 引けない**」がそのまま起きていた。
 *
 * **これは2度目である。** フォークでは `I-20260816-02`（2026-08-16）が同じことを
 * 直し、**走査そのものを検査として残して**いた。ところが 2026-08-20 の切り出しでは
 * **集約した結果だけが移り、集約を保つ機械は来なかった**——だから同じ形が
 * 11日で5つまで戻った。**直した状態ではなく、直し続ける機械のほうを移す。**
 *
 * **宣言は検査ではない。** 一覧を1本にしただけでは、次に足す人がまた書く。
 * ここは**写しが増えたら落ちる**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

import { MODEL_FILE_EXTENSIONS, modelLookupKey } from '../web/core/modelFileNames.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 規則を持ってよい場所。**ここ以外に一覧を書かない。** */
const CANONICAL = new Set([
    'unbake/utils/model_file_names.py',
    'web/core/modelFileNames.js',
]);

/**
 * **別の規則**として一覧を持ってよい場所と、その理由。
 *
 * 「同じ規則の写し」ではなく「**別のことを決めている**」もの。
 * 増やすときは理由を書くこと——理由が「拡張子を落としたいから」なら、
 * それは写しなので上の1本を呼ぶ。
 */
const DISTINCT_RULES = new Map([
    ['unbake/download.py ALLOWED_SUFFIXES',
     '**落としてよい形式**を決める側（名前を寄せる規則ではない）。'
     + ' 正の一覧より狭いのは意図であり、注記と中身が合っているかは `I-20260831-70` で人が決める。'],
    ['unbake/utils/model_file_validation.py SAFETENSORS_EXTENSIONS',
     '**safetensors の容れ物の約束**を持つ拡張子。`model_file_names.py` の冒頭が'
     + ' 「名前の話とは別の問い」として名指ししている。'],
    ['unbake/utils/model_file_validation.py TORCH_EXTENSIONS',
     '**torch（pickle）の容れ物**の側。上と対で「中身がその形式か」を決める。'
     + ' `onnx` / `gguf` を持たないのは正しい——どちらの容れ物でもないため。'],
    ['unbake/utils/model_file_validation.py MODEL_EXTENSIONS',
     '上の2つの和。**容れ物を判定できる拡張子の全体**であって、名前を寄せる一覧ではない。'],
]);

/** 対象の綴り。3つ以上そろって並んでいたら「拡張子の一覧」と見なす。 */
const KNOWN = MODEL_FILE_EXTENSIONS;

async function* sourceFiles(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name === '__pycache__' || entry.name === 'node_modules') continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) yield* sourceFiles(path);
        else if (/\.(mjs|js|py)$/.test(entry.name)) yield path;
    }
}

/** 「拡張子を3つ以上並べた定数」を探す。 */
function listsIn(text) {
    const found = [];
    // `NAME = (...)` / `NAME = [...]` / `NAME = Object.freeze([...])` を、
    // 綴りが3つ以上そろっているときだけ拾う。
    for (const match of text.matchAll(/([A-Z_][A-Z0-9_]*)\s*(?::[^=]*)?=\s*(?:Object\.freeze\()?[([]([^)\]]*)[)\]]/g)) {
        const [, name, body] = match;
        const hit = KNOWN.filter(ext => new RegExp(`['"]\\.?${ext}['"]`).test(body));
        if (hit.length >= 3) found.push({ name, count: hit.length });
    }
    return found;
}

test('拡張子の一覧が、正の場所と宣言した例外にしか無い', async () => {
    const found = [];
    for (const dir of ['unbake', 'web']) {
        for await (const file of sourceFiles(join(ROOT, dir))) {
            const rel = relative(ROOT, file).split('\\').join('/');
            if (rel.includes('/locales/')) continue;
            const text = await readFile(file, 'utf8');
            for (const item of listsIn(text)) found.push({ rel, ...item });
        }
    }

    // **0件を合格と読まない。** 当て方が壊れると全部素通りする。
    assert.ok(found.length >= 3,
        `拡張子の一覧を数えられていない（${found.length}件）。当て方が壊れている`);

    const stray = found
        .filter(item => !CANONICAL.has(item.rel))
        .filter(item => !DISTINCT_RULES.has(`${item.rel} ${item.name}`))
        .map(item => `${item.rel} ${item.name}（綴り ${item.count}件）`);

    assert.deepEqual(stray, [],
        '拡張子の一覧が写されている。**落とすためなら `model_lookup_key` / `modelLookupKey` を呼ぶこと**。'
        + '別の規則を決めているなら DISTINCT_RULES へ理由つきで足す:\n  ' + stray.join('\n  '));
});

test('宣言した例外が実在し、理由が書いてある', async () => {
    for (const [key, why] of DISTINCT_RULES) {
        const [rel, name] = key.split(' ');
        const text = await readFile(join(ROOT, rel), 'utf8');
        assert.ok(text.includes(name), `${key}: 例外だけ残って実体が無い`);
        assert.ok(String(why).trim().length >= 20, `${key}: 理由が短すぎる`);
    }
});

test('落としてよい形式は、モデルの拡張子の中から選ばれている', async () => {
    /*
     * `ALLOWED_SUFFIXES` は**狭めてよい**が、**正の一覧の外へ出てはいけない**
     * ——出た瞬間、「モデルとして扱わないものを落とす」ことになる。
     */
    const py = await readFile(join(ROOT, 'unbake/download.py'), 'utf8');
    const body = /ALLOWED_SUFFIXES\s*=\s*\(([^)]*)\)/.exec(py)?.[1] || '';
    const allowed = [...body.matchAll(/['"]\.([a-z0-9]+)['"]/g)].map(m => m[1]);
    assert.ok(allowed.length >= 3, `ALLOWED_SUFFIXES を拾えていない: ${allowed}`);

    const outside = allowed.filter(ext => !MODEL_FILE_EXTENSIONS.includes(ext));
    assert.deepEqual(outside, [],
        `モデルの拡張子でないものを落とそうとしている: ${outside.join(', ')}`);
});

test('境界で鍵が食い違っていた綴りが、同じ鍵になる', () => {
    // `I-20260831-69` で実際に割れていた2つ。**正の一覧に在れば落ちる。**
    assert.equal(modelLookupKey('Some\\Folder\\x.gguf'), 'x');
    assert.equal(modelLookupKey('x.pt2'), 'x');
    assert.equal(modelLookupKey('x.pkl'), 'x');
    assert.equal(modelLookupKey('x.onnx'), 'x');
    // **名前の一部は落とさない**（実データの checkpoint 名）。
    assert.equal(modelLookupKey('re-mixmain.fp16'), 're-mixmain.fp16');
    assert.equal(modelLookupKey('ink-style_A3.1_XL'), 'ink-style_a3.1_xl');
    assert.equal(modelLookupKey('ink-style_A3.1_XL.safetensors'), 'ink-style_a3.1_xl');
});
