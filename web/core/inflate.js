/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * DEFLATE（RFC 1951）と zlib 包み（RFC 1950）の展開。**同期・依存なし。**
 *
 * PNG の `zTXt` と圧縮 `iTXt` は zlib で包まれている。ブラウザの
 * `DecompressionStream` は**非同期**なので、これを使うと
 * `readPngText` から上の呼び出し側まで全部 async に変わる
 * ——**読むだけの純関数を非同期にする代償**が大きいので、ここで自前に持つ。
 *
 * **正しさは zlib と突き合わせて測る**（`tests/inflate_test.mjs`）。
 * 自分で書いた展開器を「たぶん合っている」で置くと、
 * **壊れた文字列を正しい記録として保存する**という一番戻しにくい失敗になる。
 */

/** 長さの符号（257..285）の基準値と追加ビット数。 */
const LENGTH_BASE = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
    35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
    3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
/** 距離の符号（0..29）。 */
const DIST_BASE = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
    257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
    7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
/** 符号長の並び順（RFC 1951 3.2.7）。 */
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

class Bits {
    constructor(bytes) {
        this.bytes = bytes;
        this.at = 0;
        this.bit = 0;
    }

    read(count) {
        let value = 0;
        for (let i = 0; i < count; i += 1) {
            if (this.at >= this.bytes.length) throw new Error('inflate: input ended mid-stream');
            value |= ((this.bytes[this.at] >> this.bit) & 1) << i;
            this.bit += 1;
            if (this.bit === 8) { this.bit = 0; this.at += 1; }
        }
        return value;
    }

    align() {
        if (this.bit) { this.bit = 0; this.at += 1; }
    }
}

/**
 * 符号長の一覧から、復号用の表を作る（正準ハフマン）。
 *
 * 返すのは `{ counts, symbols }` で、**符号は短い順に並ぶ**という性質だけで
 * 読める形にしてある（表を作らずに1ビットずつ辿る）。
 */
function buildHuffman(lengths) {
    const maxBits = 15;
    const counts = new Array(maxBits + 1).fill(0);
    for (const length of lengths) if (length) counts[length] += 1;

    const offsets = new Array(maxBits + 2).fill(0);
    for (let bits = 1; bits <= maxBits; bits += 1) offsets[bits + 1] = offsets[bits] + counts[bits];

    const symbols = new Array(lengths.length).fill(0);
    for (let symbol = 0; symbol < lengths.length; symbol += 1) {
        const length = lengths[symbol];
        if (length) { symbols[offsets[length]] = symbol; offsets[length] += 1; }
    }
    return { counts, symbols };
}

/** 1つの符号を読む。 */
function decodeSymbol(bits, table) {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let length = 1; length <= 15; length += 1) {
        code |= bits.read(1);
        const count = table.counts[length];
        if (code - first < count) return table.symbols[index + (code - first)];
        index += count;
        first = (first + count) << 1;
        code <<= 1;
    }
    throw new Error('inflate: symbol is not in the table');
}

const FIXED_LITERAL = (() => {
    const lengths = new Array(288);
    for (let i = 0; i < 144; i += 1) lengths[i] = 8;
    for (let i = 144; i < 256; i += 1) lengths[i] = 9;
    for (let i = 256; i < 280; i += 1) lengths[i] = 7;
    for (let i = 280; i < 288; i += 1) lengths[i] = 8;
    return buildHuffman(lengths);
})();
const FIXED_DISTANCE = buildHuffman(new Array(30).fill(5));

/** 動的ハフマンの表を読む。 */
function readDynamicTables(bits) {
    const literalCount = bits.read(5) + 257;
    const distanceCount = bits.read(5) + 1;
    const codeCount = bits.read(4) + 4;

    const codeLengths = new Array(19).fill(0);
    for (let i = 0; i < codeCount; i += 1) codeLengths[CODE_LENGTH_ORDER[i]] = bits.read(3);
    const codeTable = buildHuffman(codeLengths);

    const lengths = [];
    while (lengths.length < literalCount + distanceCount) {
        const symbol = decodeSymbol(bits, codeTable);
        if (symbol < 16) { lengths.push(symbol); continue; }
        if (symbol === 16) {
            const previous = lengths[lengths.length - 1];
            if (previous === undefined) throw new Error('inflate: repeat with no preceding length');
            const repeat = 3 + bits.read(2);
            for (let i = 0; i < repeat; i += 1) lengths.push(previous);
            continue;
        }
        const repeat = symbol === 17 ? 3 + bits.read(3) : 11 + bits.read(7);
        for (let i = 0; i < repeat; i += 1) lengths.push(0);
    }
    return {
        literal: buildHuffman(lengths.slice(0, literalCount)),
        distance: buildHuffman(lengths.slice(literalCount, literalCount + distanceCount)),
    };
}

/**
 * 生の DEFLATE を展開する。
 *
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export function inflateRaw(bytes) {
    const bits = new Bits(bytes);
    let out = new Uint8Array(Math.max(1024, bytes.length * 4));
    let size = 0;
    const push = (byte) => {
        if (size === out.length) {
            const grown = new Uint8Array(out.length * 2);
            grown.set(out);
            out = grown;
        }
        out[size] = byte;
        size += 1;
    };

    for (;;) {
        const last = bits.read(1);
        const type = bits.read(2);
        if (type === 0) {
            bits.align();
            if (bits.at + 4 > bits.bytes.length) throw new Error('inflate: stored block length is unreadable');
            const length = bits.bytes[bits.at] | (bits.bytes[bits.at + 1] << 8);
            bits.at += 4;   // 長さと、その1の補数
            for (let i = 0; i < length; i += 1) {
                if (bits.at >= bits.bytes.length) throw new Error('inflate: stored block is short');
                push(bits.bytes[bits.at]);
                bits.at += 1;
            }
        } else if (type === 1 || type === 2) {
            const tables = type === 1
                ? { literal: FIXED_LITERAL, distance: FIXED_DISTANCE }
                : readDynamicTables(bits);
            for (;;) {
                const symbol = decodeSymbol(bits, tables.literal);
                if (symbol === 256) break;
                if (symbol < 256) { push(symbol); continue; }
                const index = symbol - 257;
                if (index >= LENGTH_BASE.length) throw new Error('inflate: length symbol out of range');
                const length = LENGTH_BASE[index] + bits.read(LENGTH_EXTRA[index]);
                const distanceSymbol = decodeSymbol(bits, tables.distance);
                if (distanceSymbol >= DIST_BASE.length) throw new Error('inflate: distance symbol out of range');
                const distance = DIST_BASE[distanceSymbol] + bits.read(DIST_EXTRA[distanceSymbol]);
                if (distance > size) throw new Error('inflate: back-reference points outside the output');
                for (let i = 0; i < length; i += 1) push(out[size - distance]);
            }
        } else {
            throw new Error('inflate: reserved block type');
        }
        if (last) break;
    }
    return out.subarray(0, size);
}

/**
 * zlib 包み（RFC 1950）を外して展開する。
 *
 * **検査値は確かめない。** 壊れていれば展開の途中で必ず落ちるし、
 * ここで Adler-32 を回すと**読めるものまで捨てる**方向に倒れる。
 */
export function inflate(bytes) {
    if (!bytes || bytes.length < 2) throw new Error('inflate: too short');
    const method = bytes[0] & 0x0f;
    const check = ((bytes[0] << 8) | bytes[1]) % 31;
    // zlib なら方式8・検査値が31で割り切れる。そうでなければ生の DEFLATE とみなす。
    if (method === 8 && check === 0) {
        const preset = (bytes[1] >> 5) & 1;
        return inflateRaw(bytes.subarray(preset ? 6 : 2));
    }
    return inflateRaw(bytes);
}
