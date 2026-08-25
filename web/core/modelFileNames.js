/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * ComfyUI-Unbake の一部。**この行の意味**——著作権の所在を明示してある限り、
 * 後から別のライセンスを足せる。表示が無いまま配ると、それが言いづらくなる。
 */
/**
 * モデル名から拡張子を落として比較キーを作る、**唯一の場所**。
 *
 * 2026-08-16 の棚卸しで、同じ規則が**9箇所に手書きで5通り**あった
 * （`_measurements/normalization_inventory_2026-08-16.md`）。**どれも `.sft` を欠き**、
 * `.pt2` と `.pkl` はどこにも無かった。実害も出ている——`ae.sft` と記録されたレシピが、
 * 導入済みの `ae.safetensors` が在るのに完全一致に失敗して投入ごと拒否されていた。
 *
 * **宣言は検査ではない。** `recipeMissingModels.js` の該当行には
 * 「バックエンドの `normalize_model_name` と同じ規則」と書いてあったが、
 * 実体はバックエンドとも一致していなかった。同値は
 * `tests/frontend/utils/modelFileNames.test.js` と
 * `tests/utils/test_model_file_names.py` が**両言語のファイルを読んで固定する**。
 *
 * ここで扱うのは**名前の正規化**であって、中身が本当にそのモデルかの検査ではない。
 * 後者は `py/utils/model_file_validation.py`（先頭バイトの契約）で、
 * `.onnx` のように容器の契約を持たない拡張子を含む点が違う。
 */

/**
 * ComfyUI が**モデルファイルとして受け付ける拡張子**（`folder_paths.supported_pt_extensions`
 * の実測値・ComfyUI 0.27.0）に `onnx`（一部のカスタムノードが使う）を足したもの。
 *
 * 順序に意味がある: `pt2` は `pt` より**前**に置く。後ろに置くと
 * 交替の左優先で `model.pt2` が `model.` + `2` へ割れる。
 */
export const MODEL_FILE_EXTENSIONS = Object.freeze([
    'safetensors', 'sft', 'ckpt', 'pt2', 'pt', 'pth', 'bin', 'pkl', 'onnx',
]);

/** ComfyUI 側の集合（`onnx` を除いたもの）。テストが実測値と突き合わせる。 */
export const COMFYUI_SUPPORTED_PT_EXTENSIONS = Object.freeze([
    'ckpt', 'pt', 'pt2', 'bin', 'pth', 'safetensors', 'pkl', 'sft',
]);

export const MODEL_EXTENSION_PATTERN = new RegExp(
    `\\.(?:${MODEL_FILE_EXTENSIONS.join('|')})$`, 'i');

/** パス区切りを揃えたうえでの basename。記録は `\` と `/` の両方で来る。 */
export function modelBasename(value) {
    return String(value ?? '').replaceAll('\\', '/').split('/').pop() || '';
}

/** 末尾の拡張子だけを落とす（basename 化はしない）。 */
export function stripModelExtension(value) {
    return String(value ?? '').replace(MODEL_EXTENSION_PATTERN, '');
}

/** basename にして拡張子を落とした名前。A1111 の記録は拡張子を持たない。 */
export function modelStem(value) {
    return stripModelExtension(modelBasename(value));
}

/**
 * 別名照合用のキー。綴りの揺れ（`R-ESRGAN 4x+ Anime6B` 対
 * `RealESRGAN_x4plus_anime_6B.pth`）を越えるため、英数字だけを残す。
 */
export function compactModelName(value) {
    return modelStem(value).replace(/[^a-z0-9]+/gi, '').toLowerCase();
}
