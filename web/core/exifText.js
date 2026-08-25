/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * JPEG / WEBP の EXIF から生成情報を読む。**純関数・依存なし。**
 *
 * PNG しか読めなかったので、**非PNGを落とすと `not-png` で即座に終わっていた**
 * ——情報を持っているのに「メタが無い絵」と同じ扱いになる。
 *
 * **実測（2026-08-24・手元のレシピ置き場）**:
 *
 *   置いてある画像 ... `.webp` **628件** / `.jpg` 1件 / `.png` **0件**
 *   無作為40件 ....... **40件すべてが EXIF UserComment を持つ**
 *   中身の内訳 ....... A1111 パラメータ **11件** / ComfyUI 系 JSON **7件**
 *                      改造版が書いた `Recipe metadata:` の刻印 22件
 *
 * つまり**標本の45%が実際の生成情報**で、PNG 専用のままでは全部取り逃がす。
 *
 * ---
 *
 * **UserComment は先頭8バイトが文字集合の名前。** `UNICODE\0` なら UTF-16 で、
 * **並び順は TIFF ヘッダの側に書いてある**（`II` = 小端 / `MM` = 大端）。
 * ただし**書き手が間違えることがある**ので、素直に読んで駄目なら逆でも試す
 * ——間違った側で読むと**例外は出ず、CJK が全部化けた文字列**が返る。
 */

/** TIFF のタグ番号。 */
const TAG_EXIF_IFD = 0x8769;
const TAG_USER_COMMENT = 0x9286;
const TAG_IMAGE_DESCRIPTION = 0x010e;

/** 型ごとの1要素あたりのバイト数（使うものだけ）。 */
const TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function asBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return null;
}

const u16 = (bytes, at, little) => (little
    ? bytes[at] | (bytes[at + 1] << 8)
    : (bytes[at] << 8) | bytes[at + 1]);

const u32 = (bytes, at, little) => ((little
    ? bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)
    : (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0);

/** その位置から始まる ASCII 文字列か。 */
function matches(bytes, at, text) {
    for (let i = 0; i < text.length; i += 1) {
        if (bytes[at + i] !== text.charCodeAt(i)) return false;
    }
    return true;
}

/**
 * TIFF ブロックの中を歩いて、欲しいタグの生バイトを集める。
 *
 * **入れ子は1段だけ辿る**（IFD0 → Exif IFD）。それより深い所に
 * 生成情報を置く書き手は実測で1件も無かった。
 */
function readTiffTags(tiff) {
    if (tiff.length < 8) return null;
    const little = matches(tiff, 0, 'II');
    if (!little && !matches(tiff, 0, 'MM')) return null;
    if (u16(tiff, 2, little) !== 42) return null;

    const found = new Map();
    const walk = (offset, depth) => {
        if (depth > 1 || offset <= 0 || offset + 2 > tiff.length) return;
        const count = u16(tiff, offset, little);
        for (let i = 0; i < count; i += 1) {
            const at = offset + 2 + i * 12;
            if (at + 12 > tiff.length) return;
            const tag = u16(tiff, at, little);
            const type = u16(tiff, at + 2, little);
            const length = u32(tiff, at + 4, little);
            const size = (TYPE_SIZES[type] || 0) * length;
            if (!size) continue;
            // 4バイトに収まる値はその場に、収まらない値は指し先に在る。
            const valueAt = size <= 4 ? at + 8 : u32(tiff, at + 8, little);
            if (tag === TAG_EXIF_IFD) {
                walk(u32(tiff, at + 8, little), depth + 1);
                continue;
            }
            if (tag !== TAG_USER_COMMENT && tag !== TAG_IMAGE_DESCRIPTION) continue;
            if (valueAt + size > tiff.length) continue;
            found.set(tag, { bytes: tiff.subarray(valueAt, valueAt + size), little });
        }
    };
    walk(u32(tiff, 4, little), 0);
    return found;
}

/** UTF-16 を並び順を指定して読む。 */
function decodeUtf16(bytes, little) {
    let out = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) {
        out += String.fromCharCode(u16(bytes, i, little));
    }
    return out;
}


/**
 * UTF-16 を**区間ごとに向きを決めて**読む。
 *
 * **1つのフィールドの中で向きが変わることがある。** 上流 LoRA Manager は
 * 本文を UTF-16BE 決め打ちで読み、化けた文字列をそのまま UTF-16BE で書き戻して
 * いた（BE読み→BE書きは可逆なので**元の LE バイト列がそのまま残る**）。
 * そこへ追記する `Recipe metadata:` は本物の ASCII なので BE で書かれる
 * ——結果として**前半 LE・後半 BE** の1本ができる。
 * 改造版の実測（2026-08-12・630枚）で **70枚が混在**していた。
 *
 * 全体を1つの向きで読む実装は、**必ずどちらかを化けさせる**。
 * ここでは2バイトずつ見て、`00 xx` を大端の証拠・`xx 00` を小端の証拠として
 * 直前の判断を引き継ぎながら読む（どちらの証拠も無い組は判断を変えない）。
 */
function decodeMixedUtf16(body, headerLittle) {
    let out = '';
    let little = headerLittle;
    for (let i = 0; i + 1 < body.length; i += 2) {
        const a = body[i];
        const b = body[i + 1];
        // 片方だけが 0 の組は、どちらの向きかを一意に決める。
        if (a === 0 && b !== 0) little = false;
        else if (b === 0 && a !== 0) little = true;
        out += String.fromCharCode(little ? (a | (b << 8)) : ((a << 8) | b));
    }
    return out;
}

/**
 * UserComment を文字へ。
 *
 * **並び順は当てにしすぎない。** ヘッダの指す側で読んで駄目なら逆でも読み、
 * **読めた割合が高い方**を採る——間違った側は例外を出さず、静かに化ける。
 */
function decodeUserComment(bytes, little) {
    if (!bytes || bytes.length <= 8) return null;
    const head = String.fromCharCode(...bytes.subarray(0, 8)).replace(/\0/g, '');
    const body = bytes.subarray(8);
    if (head.toUpperCase().startsWith('UNICODE')) {
        return decodeMixedUtf16(body, little);
    }
    // `ASCII` と、名前の無いもの。UTF-8 として読めれば読む。
    try {
        return new TextDecoder('utf-8', { fatal: false }).decode(body).replace(/\0+$/, '');
    } catch {
        return String.fromCharCode(...body).replace(/\0+$/, '');
    }
}

/** JPEG から EXIF の TIFF ブロックを取り出す。 */
function tiffFromJpeg(bytes) {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    let at = 2;
    while (at + 4 <= bytes.length) {
        if (bytes[at] !== 0xff) { at += 1; continue; }
        const marker = bytes[at + 1];
        // 画像本体に入ったら終わり。
        if (marker === 0xda || marker === 0xd9) return null;
        const length = (bytes[at + 2] << 8) | bytes[at + 3];
        if (length < 2) return null;
        if (marker === 0xe1 && matches(bytes, at + 4, 'Exif')) {
            const start = at + 4 + 6;   // `Exif\0\0`
            const end = Math.min(at + 2 + length, bytes.length);
            if (end > start) return bytes.subarray(start, end);
        }
        at += 2 + length;
    }
    return null;
}

/** WEBP（RIFF）から EXIF チャンクを取り出す。 */
function tiffFromWebp(bytes) {
    if (!matches(bytes, 0, 'RIFF') || !matches(bytes, 8, 'WEBP')) return null;
    let at = 12;
    while (at + 8 <= bytes.length) {
        const size = u32(bytes, at + 4, true);
        const start = at + 8;
        if (matches(bytes, at, 'EXIF')) {
            const end = Math.min(start + size, bytes.length);
            // 書き手によっては `Exif\0\0` が前に付く。
            const offset = matches(bytes, start, 'Exif') ? 6 : 0;
            if (end > start + offset) return bytes.subarray(start + offset, end);
        }
        // チャンクは偶数境界に整列する。
        at = start + size + (size % 2);
    }
    return null;
}

/** ComfyUI の API 形式のグラフらしいか（`class_type` を持つ節が在る）。 */
function looksLikePromptGraph(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.values(value).some(node => node && typeof node === 'object' && node.class_type);
}

/**
 * 取り出した1本の文字列を、PNG のチャンクと**同じ鍵**へ割り当てる。
 *
 * **鍵を揃えるのが要点。** 揃えておけば `buildRecordFromTextChunks` は
 * PNG から来たのか EXIF から来たのかを知らなくてよい。
 */
/**
 * 末尾に足された刻印の行を落とす。
 *
 * A1111 の書式は**最後の行が条件行**であることを前提にしている。
 * 改造版 LoRA Manager は EXIF へ書くとき、その後ろへ
 * `Recipe metadata: {...}` を1行足す——**そのままだと条件行が最後でなくなり、
 * seed も steps も cfg も1つも取れない**（2026-08-24 実測: 標本の11件すべて）。
 *
 * **落とすのは末尾側だけ。** 条件行より前に在るものは触らない。
 */
function trimTrailingStamp(text) {
    const lines = String(text).split(/\r?\n/);
    let last = lines.length - 1;
    while (last > 0 && /^\s*[A-Za-z ]+metadata:\s*[[{]/.test(lines[last])) last -= 1;
    return lines.slice(0, last + 1).join('\n');
}

export function classifyMetadataText(text) {
    // **NUL の詰め物を先に落とす。** `trim()` は空白しか落とさないので、
    // 末尾の `\u0000` が残ったまま `JSON.parse` が落ちていた
    // ——例外は握り潰していたので、**中身は在るのに「割り当て先が無い」**として
    // 静かに捨てていた（2026-08-24 実測: 標本40件中7件）。
    // **刻印の行は先に落とす。** 改造版は生成情報の後ろへ
    // `Recipe metadata: {...}` を1行足すので、**JSON も条件行も末尾が汚れる**
    // ——JSON は途中で終わって `parse` が落ち、A1111 は条件行が最後でなくなる。
    const value = trimTrailingStamp(String(text || '').replace(/\u0000+/g, '')).trim();
    if (!value) return null;
    if (value.startsWith('{') || value.startsWith('[')) {
        try {
            const parsed = JSON.parse(value);
            if (looksLikePromptGraph(parsed)) return { key: 'prompt', value };
            if (parsed && Array.isArray(parsed.nodes)) return { key: 'workflow', value };
        } catch {
            // **壊れていても、何のグラフかは形で分かる。**
            // ここで捨てると直せる物まで消える（`parseJsonLoose` が後で直す）。
            if (value.includes('"class_type"')) return { key: 'prompt', value };
            if (/"nodes"\s*:\s*\[/.test(value)) return { key: 'workflow', value };
        }
    }
    // A1111 は「Steps:」と「Sampler:」が並ぶ1枚の文字列。
    if (/(^|\n)[^\n]*Steps:\s*\d/.test(value) && /Sampler:/.test(value)) {
        return { key: 'parameters', value };
    }
    return null;
}

/**
 * JPEG / WEBP の EXIF から、PNG のチャンクと同じ形のマップを作る。
 *
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {{ ok: boolean, text: Record<string,string>, unsupported: string[], reason: string|null }}
 */
export function readExifText(input) {
    const bytes = asBytes(input);
    if (!bytes || bytes.length < 12) {
        return { ok: false, text: {}, unsupported: [], reason: 'not-exif' };
    }
    const tiff = tiffFromJpeg(bytes) || tiffFromWebp(bytes);
    if (!tiff) return { ok: false, text: {}, unsupported: [], reason: 'not-exif' };

    const tags = readTiffTags(tiff);
    if (!tags || !tags.size) return { ok: false, text: {}, unsupported: [], reason: 'no-exif-text' };

    const text = {};
    const unsupported = [];
    for (const tag of [TAG_USER_COMMENT, TAG_IMAGE_DESCRIPTION]) {
        const entry = tags.get(tag);
        if (!entry) continue;
        const decoded = tag === TAG_USER_COMMENT
            ? decodeUserComment(entry.bytes, entry.little)
            : new TextDecoder('utf-8', { fatal: false }).decode(entry.bytes).replace(/\0+$/, '');
        const classified = classifyMetadataText(decoded);
        if (!classified) {
            // **黙って捨てない。** 中身は在るのに割り当て先が無かった、を残す。
            if (decoded && decoded.trim()) unsupported.push(`exif:${tag.toString(16)}`);
            continue;
        }
        if (!(classified.key in text)) text[classified.key] = classified.value;
    }
    if (!Object.keys(text).length) {
        return { ok: false, text: {}, unsupported, reason: 'no-exif-text' };
    }
    return { ok: true, text, unsupported, reason: null };
}

/** JPEG か WEBP らしいか（署名だけを見る）。 */
export function looksLikeExifImage(input) {
    const bytes = asBytes(input);
    if (!bytes || bytes.length < 12) return false;
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return true;
    return matches(bytes, 0, 'RIFF') && matches(bytes, 8, 'WEBP');
}
