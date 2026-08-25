/**
 * 出た絵から、**詳細の欄へそのまま流し込める値**を取り出す。
 *
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * ここは「保存する側」の逆向きである。升目や詳細から出た絵を**記録にする**口は
 * 既に在る（`onCaptureSweepCell` → `ingest`）。無かったのは**戻す側**で、
 * 「この設定で出た絵が良かったので、そこから続けたい」ができなかった
 * （利用者の要望・2026-08-24。**開いている画面へ流し込む**方を選んだ）。
 *
 * **記録の形のまま渡さないこと。** この道具には形が2つあり、下流は
 * レシピの形しか読まない。同じ食い違いを既に4回踏んでいて、そのたびに
 * **値が在るのに画面が空になる**。だからここは境界であり、
 * `toRecipeShape()` を**必ず1度通してから**値を読む。5回目を作らない。
 *
 * **取り込むのは欄に在る7項目だけ。** LoRA や checkpoint は流し込まない
 * ——欄が無いので流し込んでも画面に出ず、「読み込んだのに変わらない」に見える。
 * モデルの差し替えは別の口（「使っているモデル」の面）が持っている。
 */

import { buildGenerationRecord } from './generationRecord.js';
import { toRecipeShape } from './recordShape.js';

/**
 * 生成パラメータを、記録と本体のどちらからでも同じ形で取り出す。
 *
 * **詳細の面から core へ移した**（2026-08-24）。抜き出す側と表示する側が
 * 同じ読み方をしないと、「画面には出ているのに読み込めない」が起きる。
 * `detailView` は互換のためここを再輸出している。
 */
export function paramsOf(record, recipe = null) {
    const gen = (recipe?.gen_params && typeof recipe.gen_params === 'object')
        ? recipe.gen_params
        : (record?.gen_params || {});
    return {
        prompt: gen.prompt ?? record?.positive ?? '',
        negative_prompt: gen.negative_prompt ?? '',
        seed: gen.seed ?? record?.seed ?? null,
        steps: gen.steps ?? null,
        cfg_scale: gen.cfg_scale ?? null,
        sampler: gen.sampler ?? null,
        size: gen.size ?? null,
    };
}

/**
 * 流し込んでよい項目だけを残す。
 *
 * **空を流し込まない。** `null` や空文字を欄へ書くと、**読めなかったことが
 * 「消してよい」に化ける**——プロンプトが取れなかった絵を読み込んだ瞬間に、
 * 手で書いた本文が消える。取れた項目だけを上書きする。
 *
 * `0` は落とさない（seed 0 も cfg 0 も正当な値である）。
 */
export function fillableParams(params) {
    const out = {};
    for (const [key, value] of Object.entries(params || {})) {
        if (value === null || value === undefined) continue;
        if (typeof value === 'string' && !value.trim()) continue;
        out[key] = value;
    }
    return out;
}

/**
 * 画像のバイト列から、欄へ流し込める値を取り出す。
 *
 * @param {ArrayBuffer|Uint8Array} bytes 画像
 * @param {object} [origin] どこから来たか（`buildGenerationRecord` と同じ）
 * @returns {{ ok: boolean, params: object, record: object|null, recipe: object|null, reason: string|null }}
 *   `ok` は**読めたか**であって、**流し込む物が在るか**ではない
 *   ——読めたが1項目も取れないことは普通に起きる（メタを持たない絵）。
 *   呼ぶ側は `Object.keys(params).length` を別に見ること。
 */
export function extractParamsFromBytes(bytes, origin = {}) {
    const built = buildGenerationRecord(bytes, origin);
    if (!built.ok || !built.record) {
        return { ok: false, params: {}, record: null, recipe: null, reason: built.reason || 'unreadable' };
    }
    // ★ここが境界。記録の形のまま `paramsOf` へ渡すと `gen_params` が無く、
    //   直下の `positive` しか拾えないので **seed も steps も空になる**。
    const recipe = toRecipeShape(built.record);
    return {
        ok: true,
        params: fillableParams(paramsOf(built.record, recipe)),
        record: built.record,
        recipe,
        reason: null,
    };
}
