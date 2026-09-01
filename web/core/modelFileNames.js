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
 * `tests/declared_tests_exist_test.mjs` が**両言語のファイルを読んで固定する**。
 *
 * （2026-08-28: ここは長い間、**存在しない検査を2本名指ししていた**。
 * 名前が在ると読んだ人はそこで確かめるのをやめるので、無い検査を指すのは
 * 何も書かないより悪い。同じ検査が、名指しの実在も機械で見ている。）
 *
 * ここで扱うのは**名前の正規化**であって、中身が本当にそのモデルかの検査ではない。
 * 後者は `unbake/utils/model_file_validation.py`（先頭バイトの契約）で、
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
    'safetensors', 'sft', 'ckpt', 'pt2', 'pt', 'pth', 'bin', 'pkl', 'onnx', 'gguf',
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
 * 名前の末尾に括弧で埋め込まれた **SHA-10** を取り出す（2026-08-29 実機で確定）。
 *
 * 実機で観測した形（記録 `civitai_128383826` の土台）:
 *
 *     Illustrious/aMixIllustrious_aMix(B199B92EE9).safetensors
 *
 * 手元にはこれが `aMixIllustrious_aMix.safetensors` として入っており、
 * 導入済み索引の `checkpoints.bySha10` には `"b199b92ee9"` の項が在った
 * ——**括弧の中身は、その索引が持っているハッシュそのもの**である。
 *
 * **括弧を外した名前で当てにいかない。** それは推測で、同じ名前の別の版を
 * 掴み得る。ハッシュなら索引に当たった時点で**バイト同一だと確かめられる**。
 *
 * @returns {string|null} 小文字10桁。読めなければ `null`。
 */
export function hashFromModelName(value) {
    const stem = modelStem(value);
    const found = /\(([0-9a-f]{10})\)$/i.exec(stem);
    return found ? found[1].toLowerCase() : null;
}

/**
 * 別名照合用のキー。綴りの揺れ（`R-ESRGAN 4x+ Anime6B` 対
 * `RealESRGAN_x4plus_anime_6B.pth`）を越えるため、英数字だけを残す。
 */
/**
 * 索引を引くための鍵。**フォルダと本体の拡張子を落として小文字にする。**
 *
 * `unbake/utils/model_file_names.py` の `model_lookup_key` と同じ規則
 * （`I-20260831-69`）。ここは長く `web/panel/modelsView.js` の `stemOf` と
 * `models.py` / `model_index.py` に手で書かれており、**落とす拡張子の一覧が
 * それぞれ違って**いたので境界で鍵が食い違った。
 *
 * **最後の `.` から後ろを落とさない**——拡張子の付いていない名前が版番号の
 * ところで切れる（実データの `ink-style_A3.1_XL` → `ink-style_a3`）。
 */
export function modelLookupKey(value) {
    return modelStem(value).trim().toLowerCase();
}

export function compactModelName(value) {
    return modelStem(value).replace(/[^a-z0-9]+/gi, '').toLowerCase();
}
