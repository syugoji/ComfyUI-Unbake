/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 自前の展開器（`web/core/inflate.js`）を **zlib と突き合わせて**測る。
 *
 * 自分で書いた展開器を「たぶん合っている」で置くと、**壊れた文字列を
 * 正しい記録として保存する**という一番戻しにくい失敗になる。
 * だから「例外が出ない」ではなく、**zlib が畳んだ物を戻して原本と一致するか**で見る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { inflate } from '../web/core/inflate.js';
import { readPngText } from '../web/core/pngText.js';

/** 種を固定した疑似乱数（**毎回同じ標本**でないと、落ちた回だけ再現できない）。 */
function pseudoRandomBytes(length, seed = 12345) {
    let state = seed;
    const out = Buffer.alloc(length);
    for (let i = 0; i < length; i += 1) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        out[i] = (state >> 16) & 0xff;
    }
    return out;
}

/** 圧縮の3つの道（無圧縮・固定ハフマン・動的ハフマン）へ確実に入る材料。 */
function samples() {
    const cases = [
        Buffer.alloc(0),
        Buffer.from('a'),
        Buffer.from('{"a":1}'),
        // 同じ字の繰り返し＝長距離の参照が出る。
        Buffer.from('x'.repeat(70000)),
        // 乱数＝畳めないので**無圧縮ブロック**になりやすい。
        pseudoRandomBytes(65536),
        Buffer.from(JSON.stringify({
            nodes: Array.from({ length: 3000 }, (_, i) => ({ i, class_type: 'KSampler' })),
        })),
    ];
    for (let i = 0; i < 24; i += 1) {
        cases.push(Buffer.concat([
            pseudoRandomBytes(200 + i * 37, 7 + i),
            Buffer.from('ちいさな日本語 '.repeat(1 + i)),
        ]));
    }
    return cases;
}

test('zlib が畳んだ物を、原本どおりに戻せる', () => {
    const mismatches = [];
    let checked = 0;
    for (const level of [0, 1, 6, 9]) {
        for (const original of samples()) {
            for (const packed of [
                zlib.deflateSync(original, { level }),
                zlib.deflateRawSync(original, { level }),
            ]) {
                checked += 1;
                try {
                    const got = Buffer.from(inflate(new Uint8Array(packed)));
                    if (Buffer.compare(got, original) !== 0) {
                        mismatches.push(`中身が違う（${original.length}バイト / level ${level}）`);
                    }
                } catch (error) {
                    mismatches.push(`例外（${original.length}バイト / level ${level}）: ${error.message}`);
                }
            }
        }
    }
    // 検査が空振りしていないこと。**空集合に対する全称は必ず真。**
    assert.ok(checked >= 200, `照合が ${checked} 件しか走っていない`);
    assert.deepEqual(mismatches, [], '自前の展開器が zlib と食い違っている');
});

test('壊れた入力は、黙って部分的な結果を返さない', () => {
    const packed = zlib.deflateSync(Buffer.from('x'.repeat(5000)));
    // 途中で切る。**途中まで返す**と、切れた記録が正しい記録として保存される。
    assert.throws(() => inflate(new Uint8Array(packed.subarray(0, 12))));
});

// --- PNG のチャンク -------------------------------------------------------

const crcTable = (() => {
    const table = [];
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function pngChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    let c = 0xffffffff;
    for (const byte of body) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE((c ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, sum]);
}

/** `zTXt` と圧縮 `iTXt` を持つ PNG を組む。 */
function pngWith(promptText, workflowText) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(4, 0);
    ihdr.writeUInt32BE(4, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    // zTXt: 鍵 \0 方式 圧縮本文
    const ztxt = Buffer.concat([
        Buffer.from('prompt', 'latin1'), Buffer.from([0, 0]),
        zlib.deflateSync(Buffer.from(promptText, 'utf8')),
    ]);
    // iTXt(圧縮あり): 鍵 \0 flag 方式 言語\0 訳語\0 圧縮本文
    const itxt = Buffer.concat([
        Buffer.from('workflow', 'latin1'), Buffer.from([0, 1, 0, 0, 0]),
        zlib.deflateSync(Buffer.from(workflowText, 'utf8')),
    ]);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('zTXt', ztxt),
        pngChunk('iTXt', itxt),
        pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(4 * (1 + 4 * 3)))),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

test('圧縮されたチャンクを読める（未対応として捨てない）', () => {
    // 元は `zTXt` と圧縮 `iTXt` を `unsupported` へ入れていた。
    // **「メタが無い」とは混ぜていなかった**ので静かには壊れないが、
    // 読める物を読まないままではあった（2026-08-24 に改造版と突き合わせて追加）。
    const promptText = JSON.stringify({ 3: { class_type: 'KSampler', inputs: { seed: 42 } } });
    const workflowText = JSON.stringify({ nodes: [] });
    const read = readPngText(new Uint8Array(pngWith(promptText, workflowText)));
    assert.equal(read.ok, true, read.reason || '');
    assert.equal(read.text.prompt, promptText, 'zTXt を読めていない');
    assert.equal(read.text.workflow, workflowText, '圧縮 iTXt を読めていない');
    assert.deepEqual(read.unsupported, [], '読めたのに未対応へ入れている');
});

test('展開できないチャンクは、未対応として残す（黙って消さない）', () => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(4, 0);
    ihdr.writeUInt32BE(4, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const broken = Buffer.concat([
        Buffer.from('prompt', 'latin1'), Buffer.from([0, 0]),
        Buffer.from([0x78, 0x9c, 0x01, 0x02, 0x03]),   // zlib の頭だけ本物
    ]);
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('zTXt', broken),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
    const read = readPngText(new Uint8Array(png));
    assert.deepEqual(read.unsupported, ['prompt'], '壊れたチャンクを黙って消している');
    assert.equal(read.text.prompt, undefined, '壊れた中身を読めたことにしている');
});
