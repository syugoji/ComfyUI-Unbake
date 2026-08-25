/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * JPEG / WEBP の EXIF から生成情報を読む経路。
 *
 * **合成だけで固めない。** 本物の癖（`UNICODE` の並び順、末尾に足された
 * `Recipe metadata:` の行）は自分で組んだ画像には出ない。手元に実データが
 * 在るときは当てる（`UNBAKE_RECIPE_DIR`、既定は実測で使った置き場）。
 *
 * **実測 2026-08-24**（レシピ置き場・等間隔40件）:
 *
 *   `.webp` **628件** / `.jpg` 1件 / `.png` **0件**
 *   40件すべてが EXIF UserComment を持ち、**18件（45%）が実際の生成情報**
 *   （A1111 パラメータ11件 / ComfyUI のグラフ7件）。残り22件は
 *   改造版が書いた `Recipe metadata:` の刻印だけで、生成情報は入っていない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { classifyMetadataText, looksLikeExifImage, readExifText } from '../web/core/exifText.js';
import { buildGenerationRecord } from '../web/core/generationRecord.js';

const RECIPE_DIR = process.env.UNBAKE_RECIPE_DIR
    || 'D:/AI/forge/webui/models/Lora/recipes';

/** 等間隔で40件。**無作為より再現できる**（落ちた回をそのまま追える）。 */
function sampleWebp(limit = 40) {
    if (!fs.existsSync(RECIPE_DIR)) return [];
    const files = fs.readdirSync(RECIPE_DIR).filter(name => name.toLowerCase().endsWith('.webp'));
    if (!files.length) return [];
    const step = Math.max(1, Math.floor(files.length / limit));
    return files.filter((_, index) => index % step === 0).slice(0, limit)
        .map(name => path.join(RECIPE_DIR, name));
}

test('署名だけで JPEG / WEBP を見分ける', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const webp = new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    ]);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    assert.equal(looksLikeExifImage(jpeg), true);
    assert.equal(looksLikeExifImage(webp), true);
    // **PNG をこちらへ引き込まない。** 引き込むと PNG の経路が死ぬ。
    assert.equal(looksLikeExifImage(png), false);
});

test('末尾に足された刻印の行を切り離す', () => {
    // 改造版は生成情報の後ろへ `Recipe metadata: {...}` を1行足す。
    // **A1111 は最後の行が条件行**という前提なので、そのままだと
    // seed も steps も1つも取れない（実測: 標本の11件すべて）。
    const a1111 = [
        'masterpiece, 1girl',
        'Negative prompt: lowres',
        'Steps: 25, Sampler: Euler a, CFG scale: 3.5, Seed: 1672630971, Size: 832x1216',
        ' Recipe metadata: {"title": "Civitai_Recipe_1", "loras": []}',
    ].join('\n');
    const classified = classifyMetadataText(a1111);
    assert.equal(classified?.key, 'parameters');
    assert.ok(!classified.value.includes('Recipe metadata'), '刻印の行が残っている');
    assert.ok(classified.value.trimEnd().endsWith('Size: 832x1216'), '条件行が最後になっていない');

    // JSON も同じ。**後ろが汚れていると parse が落ちる。**
    const graph = JSON.stringify({ 3: { class_type: 'KSampler', inputs: { seed: 1 } } });
    const dirty = `${graph}\n Recipe metadata: {"title": "x"}`;
    const asGraph = classifyMetadataText(dirty);
    assert.equal(asGraph?.key, 'prompt');
    assert.equal(asGraph.value, graph, 'グラフの後ろに刻印が残っている');
});

test('刻印だけの文字列は、生成情報として拾わない', () => {
    // **拾うと「読めた」と言いながら中身が空**の記録ができる。
    const stamp = 'Recipe metadata: {"title": "Civitai_Recipe_13233430", "gen_params": {}}';
    assert.equal(classifyMetadataText(stamp), null);
});

test('実データの WEBP から生成情報を読む', (t) => {
    const files = sampleWebp();
    if (!files.length) { t.skip(`実データが無い（${RECIPE_DIR}）`); return; }

    const tally = { parameters: 0, prompt: 0, none: 0 };
    for (const file of files) {
        const read = readExifText(new Uint8Array(fs.readFileSync(file)));
        if (!read.ok) { tally.none += 1; continue; }
        if (read.text.parameters) tally.parameters += 1;
        else if (read.text.prompt || read.text.workflow) tally.prompt += 1;
    }
    // **検査が空振りしていないこと。**
    assert.ok(files.length >= 10, `標本が ${files.length} 件しか無い`);
    // 実測（2026-08-24）の内訳。**下振れしたら赤くする**——上振れは歓迎。
    assert.ok(tally.parameters >= 8,
        `A1111 として読めた件数が落ちている: ${JSON.stringify(tally)}`);
    assert.ok(tally.prompt >= 5,
        `グラフとして読めた件数が落ちている: ${JSON.stringify(tally)}`);
});

test('実データの WEBP から、条件まで埋まった記録を組める', (t) => {
    const files = sampleWebp();
    if (!files.length) { t.skip(`実データが無い（${RECIPE_DIR}）`); return; }

    let built = 0;
    let withSeed = 0;
    for (const file of files) {
        const record = buildGenerationRecord(
            new Uint8Array(fs.readFileSync(file)),
            { kind: 'drop', filename: path.basename(file) }
        );
        if (!record.ok) continue;
        built += 1;
        if (record.record.seed !== null && record.record.seed !== undefined) withSeed += 1;
    }
    // **「読めた」で止めない。** 記録が組めて、条件が埋まって初めて再現に使える。
    assert.ok(built >= 15, `組めた記録が ${built} 件しか無い（実測は18件）`);
    assert.ok(withSeed >= 12, `種まで取れた記録が ${withSeed} 件しか無い（実測は14件）`);
});

// --- 合成した JPEG（本物では出ない道を、ここで踏む）----------------------

/**
 * EXIF を1つ持つ最小の JPEG を組む。
 *
 * @param {object} options
 * @param {boolean} options.headerLittle TIFF ヘッダが小端だと言うか
 * @param {boolean} options.bodyLittle 本文を実際に小端で書くか（食い違わせられる）
 */
function jpegWithUserComment(text, { headerLittle = true, bodyLittle = headerLittle, flipAt = null } = {}) {
    const body = Buffer.alloc(text.length * 2);
    for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        // `flipAt` から先だけ向きを変えられる（**1本の中で混在する**形を作る）。
        const little = flipAt !== null && i >= flipAt ? !bodyLittle : bodyLittle;
        if (little) body.writeUInt16LE(code, i * 2);
        else body.writeUInt16BE(code, i * 2);
    }
    const comment = Buffer.concat([Buffer.from('UNICODE' + String.fromCharCode(0), 'latin1'), body]);

    const u16 = (value) => {
        const b = Buffer.alloc(2);
        if (headerLittle) b.writeUInt16LE(value); else b.writeUInt16BE(value);
        return b;
    };
    const u32 = (value) => {
        const b = Buffer.alloc(4);
        if (headerLittle) b.writeUInt32LE(value); else b.writeUInt32BE(value);
        return b;
    };
    // TIFF: ヘッダ8 + IFD0(1件=2+12+4) + Exif IFD(1件=2+12+4) + 本文
    const ifd0At = 8;
    const exifIfdAt = ifd0At + 2 + 12 + 4;
    const commentAt = exifIfdAt + 2 + 12 + 4;
    const tiff = Buffer.concat([
        Buffer.from(headerLittle ? 'II' : 'MM', 'latin1'), u16(42), u32(ifd0At),
        // IFD0: ExifIFD へのポインタだけ
        u16(1), u16(0x8769), u16(4), u32(1), u32(exifIfdAt), u32(0),
        // Exif IFD: UserComment（型7 = UNDEFINED）
        u16(1), u16(0x9286), u16(7), u32(comment.length), u32(commentAt), u32(0),
        comment,
    ]);
    const app1 = Buffer.concat([Buffer.from('Exif', 'latin1'), Buffer.from([0, 0]), tiff]);
    const size = Buffer.alloc(2);
    size.writeUInt16BE(app1.length + 2);
    return Buffer.concat([
        Buffer.from([0xff, 0xd8]),               // SOI
        Buffer.from([0xff, 0xe1]), size, app1,   // APP1
        Buffer.from([0xff, 0xd9]),               // EOI
    ]);
}

const A1111_TEXT = [
    'masterpiece, 1girl',
    'Negative prompt: lowres',
    'Steps: 25, Sampler: Euler a, CFG scale: 3.5, Seed: 7, Size: 832x1216',
].join(String.fromCharCode(10));

test('合成した JPEG の EXIF を読める', () => {
    // **JPEG の道は実データに1件しか無い**ので、ここで踏んでおかないと
    // 壊れても誰も気づかない。
    const read = readExifText(new Uint8Array(jpegWithUserComment(A1111_TEXT)));
    assert.equal(read.ok, true, read.reason || '');
    assert.equal(read.text.parameters, A1111_TEXT);
});

test('書き手が並び順を取り違えていても読める', () => {
    // ヘッダは小端だと言っているのに、本文は大端で書いてある形。
    // **例外は出ず、CJK に化けた文字列**が返るので、気づけない壊れ方をする。
    const read = readExifText(
        new Uint8Array(jpegWithUserComment(A1111_TEXT, { headerLittle: true, bodyLittle: false }))
    );
    assert.equal(read.ok, true, `化けた側を選んでいる: ${read.reason}`);
    assert.equal(read.text.parameters, A1111_TEXT, '並びを直せていない');
});

test('並びが合っているときは、動かさない', () => {
    // **僅差で入れ替えない。** 入れ替えると、合っている物まで壊す。
    for (const little of [true, false]) {
        const read = readExifText(new Uint8Array(jpegWithUserComment(A1111_TEXT, { headerLittle: little })));
        assert.equal(read.text.parameters, A1111_TEXT, `並び ${little ? 'II' : 'MM'} で壊している`);
    }
});

test('1本の中でバイト順が変わっていても、全部読める', () => {
    // **上流の欠陥で実在する形**（改造版の実測 2026-08-12: 630枚中70枚が混在）。
    // 前半 LE・後半 BE。全体を1つの向きで読む実装は、**必ずどちらかを化けさせる**。
    const half = Math.floor(A1111_TEXT.length / 2);
    const read = readExifText(new Uint8Array(
        jpegWithUserComment(A1111_TEXT, { headerLittle: false, bodyLittle: true, flipAt: half })
    ));
    assert.equal(read.ok, true, `混在を読めていない: ${read.reason}`);
    assert.equal(read.text.parameters, A1111_TEXT, '途中から化けている');
});
