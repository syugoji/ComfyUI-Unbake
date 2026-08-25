/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * **本文の複製を探す。** ファイル名が上流に無いことは「新規である」証拠であって、
 * 「本文を写していない」ことの証明ではない。上流の全ファイルを**連続6行のブロック**へ
 * 割って索引し、こちらの各ファイルが1ブロックでも当たるかを見る。
 *
 * **必ず対照を置くこと。** 0件は「複製が無い」とも「検出器が壊れている」とも読める。
 * `web/core/genParamsMapper.js` は上流のファイルそのものなので、これが当たらなければ
 * 検出器が死んでいる——その場合は 0件を成果として報告しない。
 *
 *   node tests/upstream_copy_scan.mjs --upstream <上流チェックアウト>
 *
 * この検査が覆う範囲: **正規化後の連続6行の一致まで。**
 * 短い定型や、書き換えられた複製は検出しない。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BLOCK = 6;
const SOURCE_EXTENSIONS = ['.js', '.mjs', '.py'];

function argOf(name, fallback = null) {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function filesUnder(dir, exts) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '__pycache__' || entry.name === '.git') continue;
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...filesUnder(p, exts));
        else if (exts.some(x => entry.name.endsWith(x))) out.push(p);
    }
    return out;
}

/**
 * 空白を潰し、行コメントとブロックコメントを落とす。
 * **散文の一致で誤検出しない**ため——説明文は書き手が同じなら似るのが当然で、
 * 著作権の話は構文の一致で見る。
 */
export function effectiveLines(text) {
    const withoutBlocks = text
        .replace(/\/\*[\s\S]*?\*\//g, '\n')
        .replace(/"""[\s\S]*?"""/g, '\n')
        .replace(/'''[\s\S]*?'''/g, '\n');
    return withoutBlocks
        .split(/\r?\n/)
        .map(line => line.replace(/(^|\s)(\/\/|#).*$/, '$1'))
        .map(line => line.replace(/\s+/g, ' ').trim())
        .filter(line => line.length > 0);
}

export function blocksOf(lines, size = BLOCK) {
    const out = [];
    for (let i = 0; i + size <= lines.length; i += 1) out.push(lines.slice(i, i + size).join('\n'));
    return out;
}

/**
 * **著作物性の無い定型**。ここだけは一致しても複製として数えない。
 *
 * 実際に1件出た（2026-08-20）——`raindrop_sync_service.py` の
 * `import asyncio / json / logging / os / sys / time` が、上流のテストスクリプトの
 * 同じ並びと当たっていた。標準ライブラリ名をアルファベット順に並べただけの6行は、
 * 誰が書いても同じになるので表現ではない。
 *
 * **許容はここまで。** 判定は「ブロックの全行が標準ライブラリの import 文である」
 * ことに限り、1行でも実装が混ざれば複製として数える。
 * 許容した件数は別枠で必ず表示する——黙って引くと 0件が意味を失う。
 */
const NEWLINE = String.fromCharCode(10);

const STDLIB_IMPORT_LINE = new RegExp(
    '^(?:from __future__ import [A-Za-z_, ]+'
    + '|import (?:asyncio|base64|collections|contextlib|copy|csv|dataclasses|datetime'
    + '|enum|functools|glob|hashlib|inspect|io|itertools|json|logging|math|os|pathlib'
    + '|random|re|shutil|subprocess|sys|tempfile|time|traceback|types|typing|uuid|zipfile))$',
);

function isBoilerplateBlock(block) {
    const lines = block.split(NEWLINE);
    return lines.length > 0 && lines.every(line => STDLIB_IMPORT_LINE.test(line));
}

const upstreamDir = argOf('--upstream');
if (!upstreamDir) {
    console.error('使い方: node tests/upstream_copy_scan.mjs --upstream <上流チェックアウト>');
    console.error('  取得例: gh api repos/willmiao/ComfyUI-Lora-Manager/tarball/v1.1.9 > upstream.tar.gz');
    process.exit(2);
}
if (!fs.existsSync(upstreamDir)) {
    console.error(`上流チェックアウトが見つかりません: ${upstreamDir}`);
    process.exit(2);
}

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- 上流を索引する ------------------------------------------------------
const index = new Map();
const allUpstreamFiles = filesUnder(upstreamDir, SOURCE_EXTENSIONS);

/**
 * **自分の配布物を上流として索引しない。**
 *
 * 実測（2026-08-20）でこれを踏んだ——検証のため ComfyUI の `custom_nodes/` へ
 * 本パッケージを入れたまま、その親ツリーを `--upstream` に渡した。
 * すると**本人の27ファイルのうち24件が「上流と一致」**になった。**自分自身との一致**である。
 * 検出器は生きたまま（対照は211ブロック）、結論だけが正反対になる形なので、
 * 数字を見ても異常に見えない。
 *
 * **名前ではなく値で外す。** ディレクトリ名は `ComfyUI-Unbake-main` などに化けるが、
 * 著作権表示は化けない。対照 `genParamsMapper.js` は上流のファイルで
 * この表示を持たないので、**除外しても対照は索引に残る**（＝検出器は生きたまま）。
 */
const OWN_MARK = 'Copyright (C) 2026 syugoji';
const excluded = [];
const upstreamFiles = [];
for (const file of allUpstreamFiles) {
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes(OWN_MARK)) { excluded.push(path.relative(upstreamDir, file)); continue; }
    upstreamFiles.push([file, text]);
}
for (const [file, text] of upstreamFiles) {
    for (const block of blocksOf(effectiveLines(text))) {
        if (!index.has(block)) index.set(block, path.relative(upstreamDir, file));
    }
}
console.log(`上流を索引: ${upstreamFiles.length}ファイル / ${index.size}ブロック（連続${BLOCK}行・正規化後）`);
// **黙って外さない。** 除外した件数が0でないなら、走査対象に自分の配布物が混ざっている。
if (excluded.length > 0) {
    console.log(`索引から外した自分の配布物: ${excluded.length}ファイル（著作権表示で判定）`);
    console.log(`  例: ${excluded.slice(0, 3).join(' / ')}`);
}
if (index.size < 10_000) {
    console.error('索引が小さすぎます。走査対象が違う可能性があります。');
    process.exit(1);
}

// --- こちらを当てる ------------------------------------------------------
const targets = [
    ...filesUnder(path.join(here, 'web'), ['.js', '.mjs']),
    ...filesUnder(path.join(here, 'unbake'), ['.py']),
];

const rows = [];
for (const file of targets) {
    const lines = effectiveLines(fs.readFileSync(file, 'utf8'));
    const blocks = blocksOf(lines);
    const matched = blocks.filter(block => index.has(block));
    const boilerplate = matched.filter(isBoilerplateBlock);
    const hits = matched.filter(block => !isBoilerplateBlock(block));
    rows.push({
        file: path.relative(here, file).split(path.sep).join('/'),
        lines: lines.length,
        hits: hits.length,
        boilerplate: boilerplate.length,
        example: hits.length ? index.get(hits[0]) : null,
    });
}

rows.sort((a, b) => b.hits - a.hits || a.file.localeCompare(b.file));
for (const row of rows) {
    console.log(
        `${String(row.hits).padStart(5)}  ${String(row.lines).padStart(5)}行  ${row.file}`
        + `${row.boilerplate ? `  （定型 ${row.boilerplate}）` : ''}`
        + `${row.example ? `  ← ${row.example}` : ''}`,
    );
}

// --- 判定 -----------------------------------------------------------------
const CONTROL = 'web/core/genParamsMapper.js';
const control = rows.find(row => row.file === CONTROL);
const mine = rows.filter(row => row.file !== CONTROL);
const offenders = mine.filter(row => row.hits > 0);

console.log('---');
if (!control) {
    console.error(`対照 ${CONTROL} が対象に含まれていません。走査が壊れています。`);
    process.exit(1);
}
console.log(`対照 ${CONTROL}: ${control.hits}ブロック一致 → 検出器は ${control.hits > 0 ? '生きている' : '**死んでいる**'}`);
const boilerplateTotal = mine.reduce((sum, row) => sum + row.boilerplate, 0);
console.log(`本人のファイル ${mine.length}件のうち、一致したもの ${offenders.length}件`);
console.log(`うち著作物性の無い定型として除外したブロック: ${boilerplateTotal}件（標準ライブラリの import 並び）`);

if (control.hits === 0) {
    console.error('対照が当たらないので、0件を「複製なし」と読んではいけない。');
    process.exit(1);
}
process.exit(offenders.length === 0 ? 0 : 1);
