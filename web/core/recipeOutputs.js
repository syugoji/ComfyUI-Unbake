/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * ComfyUI-Unbake の一部。**この行の意味**——著作権の所在を明示してある限り、
 * 後から別のライセンスを足せる。表示が無いまま配ると、それが言いづらくなる。
 */
import { environmentRequestOrNull } from './environment.js';
import { outputImageUrl } from './outputUrl.js';
// このレシピから生成した出力画像を引く。
//
// 紐付けの根拠は画像側の PNG チャンクにあり（unbake/utils/recipe_pnginfo.py）、
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

    // **組み立ては `outputUrl.js` の1本だけ**（2026-08-31・監査 I-20260831-21）。
    //
    // ここは今どこからも呼ばれていない（`tests/module_reachability_test.mjs` が
    // そう宣言している）が、**手で組んだままにしない**——復活させた瞬間に
    // 鮮度の印（`_ub`）の無い URL が戻り、消した絵・前の絵がそのまま出る。
    // 検出器が `/api/view?` しか見ていなかったので、ここは長く素通りしていた。
    return outputImageUrl(entry, thumbnail ? { preview: 'jpeg;75' } : {});
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

    // **口はこのパッケージのもの**（`I-20260831-63`）。以前はフォークの
    // `/api/lm/recipe/{id}/outputs` を叩いていた——**このパッケージのサーバは
    // `/unbake/` しか出していない**ので 404 になり、黙って空を返していた。
    //
    // **数え直しは頼まれたときだけ。** サーバ側の既定は「数え直さない」で、
    // 全件 `stat` は実測 4,851枚で初回 2,891ms かかる（`routes.py` の注記）。
    const query = new URLSearchParams({ id: String(recipeId) });
    if (refresh) query.set('refresh', '1');
    try {
        const response = await request(`/unbake/outputs?${query.toString()}`);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            return {
                outputs: [],
                total: 0,
                error: data.error || `HTTP ${response.status}`,
            };
        }

        const outputs = normalizeOutputs(data.outputs);
        // **サーバが数えた総数を捨てない**（`I-20260831-65`）。
        // `outputs.length` は `normalizeOutputs` が壊れた項目を落とした後の数で、
        // 「何枚在るか」ではなく「何枚描けるか」である。両方を返す。
        const total = Number.isFinite(Number(data.total)) ? Number(data.total) : outputs.length;
        return { outputs, total, error: '' };
    } catch (error) {
        return { outputs: [], total: 0, error: error?.message || String(error) };
    }
}
