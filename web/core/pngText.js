/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * PNG のテキストチャンクを読む。**純関数・依存なし。**
 *
 * ComfyUI は生成したワークフローを PNG の `tEXt` チャンクへ書き込む。
 * だから**自分の出力を落とし戻したときは、再構成が要らない**——読むだけでよい。
 * これが「捕捉」経路の入口である。
 *
 * **実測（2026-08-20・出力3,084枚から124枚を等間隔抽出）で、鍵の出方はこうだった:**
 *
 *   `prompt` のみ ................................. 76件（61%）
 *   `prompt` ＋ `lora_manager_recipe` ............. 25件（20%）
 *   `prompt` ＋ `workflow` ........................ 22件（18%）
 *   `prompt` ＋ 刻印 ＋ `lora_manager_sweep` ...... 1件
 *
 * **`prompt` は全件にある。** `workflow`（画面のグラフ）は18%しかないので、
 * `workflow` を主経路にすると**8割が黙って落ちる**。
 *
 * **覆う範囲**: 非圧縮の `tEXt` と `iTXt`。**`zTXt` と圧縮 iTXt は読めない**ので、
 * 見つけたら `unsupported` へ入れて返す——**黙って飛ばすと「メタが無い画像」に見える。**
 * （上記の標本では両方とも0件だった。）
 */

import { inflate } from './inflate.js';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function asBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw new TypeError('readPngText: pass an ArrayBuffer or a Uint8Array');
}

function isPng(bytes) {
    if (bytes.length < 8) return false;
    return SIGNATURE.every((b, i) => bytes[i] === b);
}

const latin1 = (bytes, from, to) => {
    let out = '';
    for (let i = from; i < to; i += 1) out += String.fromCharCode(bytes[i]);
    return out;
};

const utf8 = (() => {
    const decoder = new TextDecoder('utf-8');
    return (bytes, from, to) => decoder.decode(bytes.subarray(from, to));
})();

/**
 * PNG のテキストチャンクを読む。
 *
 * @param {ArrayBuffer|Uint8Array} input PNG のバイト列
 * @returns {{ ok: boolean, text: Record<string,string>, unsupported: string[], reason: string|null }}
 *   `text` は鍵→値。`unsupported` は**読めなかった圧縮チャンクの鍵**。
 */
/**
 * zlib で包まれた本文を展開して文字にする。**展開できなければ `null`。**
 *
 * 展開できなかったことを**「メタが無い」と混ぜない**ために、
 * 呼ぶ側は `null` を `unsupported` へ入れる（今までと同じ扱い）。
 */
function expand(bytes) {
    try {
        return utf8(inflate(bytes), 0, undefined);
    } catch {
        return null;
    }
}

export function readPngText(input) {
    const bytes = asBytes(input);
    if (!isPng(bytes)) {
        return { ok: false, text: {}, unsupported: [], reason: 'not-png' };
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const text = {};
    const unsupported = [];
    let offset = 8;

    while (offset + 8 <= bytes.length) {
        const length = view.getUint32(offset);
        const type = latin1(bytes, offset + 4, offset + 8);
        const dataFrom = offset + 8;
        const dataTo = dataFrom + length;
        // **長さが壊れていたら止める。** 進み続けると、でたらめな位置を鍵として拾う。
        if (dataTo + 4 > bytes.length) {
            return { ok: false, text, unsupported, reason: 'truncated' };
        }

        if (type === 'tEXt') {
            const nul = bytes.indexOf(0, dataFrom);
            if (nul >= 0 && nul < dataTo) {
                text[latin1(bytes, dataFrom, nul)] = utf8(bytes, nul + 1, dataTo);
            }
        } else if (type === 'iTXt') {
            const nul = bytes.indexOf(0, dataFrom);
            if (nul >= 0 && nul < dataTo) {
                const key = latin1(bytes, dataFrom, nul);
                const compressionFlag = bytes[nul + 1];
                if (compressionFlag === 1) {
                    // 圧縮あり: flag, method, language\u0000, translated\u0000, 圧縮された本文
                    let p = nul + 3;
                    const lang = bytes.indexOf(0, p);
                    p = (lang >= 0 && lang < dataTo) ? lang + 1 : p;
                    const translated = bytes.indexOf(0, p);
                    p = (translated >= 0 && translated < dataTo) ? translated + 1 : p;
                    const expanded = expand(bytes.subarray(p, dataTo));
                    if (expanded === null) unsupported.push(key);
                    else text[key] = expanded;
                } else {
                    // 圧縮なし: flag, method, language\0, translated\0, text
                    let p = nul + 3;
                    const lang = bytes.indexOf(0, p);
                    p = (lang >= 0 && lang < dataTo) ? lang + 1 : p;
                    const translated = bytes.indexOf(0, p);
                    p = (translated >= 0 && translated < dataTo) ? translated + 1 : p;
                    text[key] = utf8(bytes, p, dataTo);
                }
            }
        } else if (type === 'zTXt') {
            const nul = bytes.indexOf(0, dataFrom);
            if (nul >= 0 && nul < dataTo) {
                const key = latin1(bytes, dataFrom, nul);
                // 鍵\u0000, 圧縮方式1バイト, 圧縮された本文
                const expanded = expand(bytes.subarray(nul + 2, dataTo));
                if (expanded === null) unsupported.push(key);
                else text[key] = expanded;
            }
        }

        if (type === 'IEND') break;
        offset = dataTo + 4;
    }

    return { ok: true, text, unsupported, reason: null };
}

/**
 * **JSON の値位置に裸で置かれた `NaN` / `Infinity`。**
 *
 * Python の `json` はこれらを**書けるし読み戻せる**が、`JSON.parse` は拒否する。
 * 実測（2026-08-20・出力3,084枚）で1枚がこれに当たり、`prompt` チャンクが
 * 3,328文字きちんと在るのに解けず、**グラフが目の前にあるのに「メタが無い」扱い**で
 * `blocked` へ落ちていた。落ち方が「解析できない」ではなく「無かったことになる」なので、
 * 件数を見ても異常に見えない。
 *
 * 文字列の中の `"NaN"` を壊さないよう、**値の位置に裸で現れたものだけ**を置き換える
 * （直前が `"` なら当たらない）。
 */
const BARE_NON_JSON_NUMBER = /(?<=[:,[\s])-?(?:NaN|Infinity)(?=\s*[,}\]])/g;

/**
 * 値が JSON なら解いて返す。解けなければ null（**例外にしない**——1枚で全部止めない）。
 *
 * @returns {{ value: any, repaired: boolean }} `repaired` は
 *   `NaN`/`Infinity` を `null` へ置き換えて初めて解けたことを表す。
 *   **黙って直さない**——置き換えた値は元の値ではない。
 */
export function parseJsonLoose(value) {
    if (typeof value !== 'string' || !value.trim()) return { value: null, repaired: false };
    try {
        return { value: JSON.parse(value), repaired: false };
    } catch {
        // ここまで来たら形が違う可能性もあるので、置き換えても解けなければ諦める。
    }
    const patched = value.replace(BARE_NON_JSON_NUMBER, 'null');
    if (patched === value) return { value: null, repaired: false };
    try {
        return { value: JSON.parse(patched), repaired: true };
    } catch {
        return { value: null, repaired: false };
    }
}

/** 解けた値だけが要るときの糖衣。 */
export function parseJsonValue(value) {
    return parseJsonLoose(value).value;
}
