/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * ComfyUI-Unbake の一部。**この行の意味**——著作権の所在を明示してある限り、
 * 後から別のライセンスを足せる。表示が無いまま配ると、それが言いづらくなる。
 */
import { environmentRequestOrNull } from './environment.js';
// このレシピから生成した出力画像を引く。
//
// 紐付けの根拠は画像側の PNG チャンクにあり（py/utils/recipe_pnginfo.py）、
// サーバ側が出力フォルダを走査して索引にしている。ここはその結果を
// 画面で使える形に整えるだけ。

/**
 * サーバから返る1件を ComfyUI の /view で開ける URL にする。
 *
 * `thumbnail: true` を渡すと ComfyUI 側で JPEG へ変換させる。96px の升目に
 * 1.5MB の PNG を流し込むのは、転送よりデコードとメモリが重い
 * （実測: 1.55 MiB → 0.16 MiB、枚数ぶん効く）。拡大表示は元のまま使う。
 */
export function buildOutputViewUrl(entry, { thumbnail = false } = {}) {
    if (!entry?.filename) return '';

    const params = new URLSearchParams();
    params.set('filename', entry.filename);
    params.set('type', 'output');
    if (entry.subfolder) {
        params.set('subfolder', entry.subfolder);
    }
    const query = params.toString();
    // preview は値の中に ; を含むので URLSearchParams へ入れずに直接繋ぐ
    // （エンコードされると ComfyUI 側が解釈しない）。
    return thumbnail ? `/view?${query}&preview=jpeg;75` : `/view?${query}`;
}

/** 表示用に整える。壊れた項目は落とす。 */
export function normalizeOutputs(outputs) {
    if (!Array.isArray(outputs)) return [];

    return outputs
        .filter(entry => entry && typeof entry.filename === 'string' && entry.filename)
        .map(entry => ({
            filename: entry.filename,
            subfolder: entry.subfolder || '',
            modified: Number(entry.modified) || 0,
            size: Number(entry.size) || 0,
            sweep: entry.sweep && typeof entry.sweep === 'object' ? entry.sweep : null,
            url: buildOutputViewUrl(entry),
            thumbnailUrl: buildOutputViewUrl(entry, { thumbnail: true }),
        }));
}

/**
 * レシピに紐付く出力画像を取得する。
 *
 * 失敗しても投げない。**この節が取れないことでレシピ詳細そのものが
 * 開けなくなってはいけない**ので、空配列とエラー文を返して呼び出し側に委ねる。
 *
 * @returns {Promise<{outputs: Array, total: number, error: string}>}
 */
export async function fetchRecipeOutputs(recipeId, deps = {}) {
    const { fetchImpl = null, refresh = true } = deps;
    const request = fetchImpl || environmentRequestOrNull();

    if (!recipeId) {
        return { outputs: [], total: 0, error: '' };
    }

    const query = refresh ? '' : '?refresh=false';
    try {
        const response = await request(
            `/api/lm/recipe/${encodeURIComponent(recipeId)}/outputs${query}`
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.success) {
            return {
                outputs: [],
                total: 0,
                error: data.error || `HTTP ${response.status}`,
            };
        }

        const outputs = normalizeOutputs(data.outputs);
        return { outputs, total: outputs.length, error: '' };
    } catch (error) {
        return { outputs: [], total: 0, error: error?.message || String(error) };
    }
}
