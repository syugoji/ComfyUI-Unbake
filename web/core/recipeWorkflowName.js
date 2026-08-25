/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * ComfyUI-Unbake の一部。**この行の意味**——著作権の所在を明示してある限り、
 * 後から別のライセンスを足せる。表示が無いまま配ると、それが言いづらくなる。
 */
/**
 * 出す画像のファイル名の頭を決める。
 *
 * ---
 *
 * **`recipe` を出さない。**（2026-08-20 ユーザー指示・決定④の続き）
 *
 * `recipe` は上流（LoRA Manager）の語で、外向きの語彙には使わない。
 * Civitai から来たものは **`civitai_<画像ID>`** で意味が足りる。
 *
 * **実物では二重に付いていた。** 呼び手が `` `Recipe_${recipe.title}` `` と
 * 前置し、その `title` が既に `Civitai_Recipe_47986787` だったため、
 * 出力は `Recipe_Civitai_Recipe_47986787_00045_.png` になっていた
 * ——実測（2026-08-20・出力4,275枚）で **2,387枚**がこの形。
 * だから前置は呼び手から取り上げ、**名前を作るのはここ1箇所**にする。
 *
 * ---
 *
 * **ファイル名を判定の根拠にしない。** ここが作るのは人が読むための頭で、
 * どの記録から出たかは**印と指紋**で決める（`outputAttribution.js`）。
 * 名前を変えても帰属は壊れない——壊れるなら、それは名前に依存している側の誤り。
 *
 * **既に在るファイルの名前は変えない。** 2,410枚が古い名前で残るが、
 * 帰属は名前を見ていないので、混ざっても困らない。
 */

/** ファイル名に使ってよい字だけにする。 */
function sanitizeWorkflowName(value) {
    return String(value || '')
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

/**
 * 題や識別子から Civitai の画像 ID を拾う。
 *
 * 既存の記録の題は `Civitai_Recipe_<id>` の形で入っている（実測346件中340件）。
 * **その題からも ID を拾って `civitai_<id>` へ直す**——直さないと、
 * 古い記録から出す絵にだけ `recipe` が残り続ける。
 */
function civitaiIdOf(recipe) {
    const title = String(recipe?.title || recipe?.name || '');
    const fromTitle = title.match(/civitai[\s_-]*(?:recipe[\s_-]*)?(\d+)/i);
    if (fromTitle) return fromTitle[1];
    const direct = [
        recipe?.civitai_image_id,
        recipe?.civitaiImageId,
        recipe?.image_id,
        recipe?.imageId,
    ].find(value => /^\d+$/.test(String(value ?? '')));
    if (direct) return String(direct);
    // 出典 URL からも拾う（`.red` と `.com` の両方）。
    const source = String(recipe?.source_path || recipe?.sourcePath || '');
    const fromUrl = source.match(/civitai\.(?:com|red)\/images\/(\d+)/i);
    return fromUrl ? fromUrl[1] : null;
}

/**
 * 出力ファイル名の頭。**`recipe` という語は1文字も入らない。**
 *
 * @param {object} recipe 記録（書庫の要約でも、本体でもよい）
 * @returns {string} 例: `civitai_47986787` / `my_own_title` / `record_ab12cd`
 */
export function createRecipeWorkflowName(recipe) {
    const civitaiId = civitaiIdOf(recipe);
    if (civitaiId) return `civitai_${civitaiId}`;

    // Civitai 由来でない題は、そのまま使う。ただし**前置が二重にならないよう**、
    // 頭に付いている `Recipe_` / `Record_` は落とす。
    const title = sanitizeWorkflowName(recipe?.title || recipe?.name || '')
        .replace(/^(?:recipe|record)_+/i, '');
    if (title) return title;

    const identifier = sanitizeWorkflowName(recipe?.id || recipe?.recipe_id);
    // **落とすところが無ければ `record_`。** 外向きの語は Generation Record。
    return identifier ? `record_${identifier}` : 'record_workflow';
}
