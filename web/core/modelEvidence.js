/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **そのモデルが「元の1枚と同じもの」だと言える根拠の強さ。**
 *
 * 再現の判定（`verdict`）は「組めるか」を見る。こちらは別の問いで、
 * **組んだものが同じ材料でできているか**を見る。両方とも緑でありうるし、
 * **判定が「再現性 高」でも材料が別物**ということが起こる。
 *
 * ## 根拠は3段階ある
 *
 * | `evidence` | 何で当てたか | 強さ |
 * |---|---|---|
 * | `hash`      | SHA256 の一致 | **バイト同一**。これ以上は無い |
 * | `versionId` | Civitai の版ID | その版そのもの。ファイルは1つに決まる |
 * | `name`      | **ファイル名だけ** | **同名の別物を掴みうる** |
 *
 * ## なぜ `name` を目立たせるか
 *
 * Civitai の `meta` は形が3つあり、**ComfyUI で作られた絵は
 * `additionalResources` / `models` に「名前と強度」しか置かない**
 * （版IDも hash も無い。実測 2026-08-25）。拾わなければ再現不可になるので拾うが、
 * 拾った以上は**名前でしか照合していない**という事実が残る。
 *
 * そして名前の衝突は理屈の上の話ではない——**利用者の環境に、同名の LoRA が
 * 2箇所に在るものが8件あった**（`models/loras` 直下への複製・実測 2026-08-24）。
 * こういう時、道具は黙って片方を選ぶ。**選んだこと自体が見えないのが害**で、
 * 出てきた絵が違っても「モデルは合っているはず」と読んでしまう。
 *
 * **だから印は「間違っている」ではなく「確かめようがない」と言う。**
 * 実際に別物かどうかはここでは判らないし、判ったふりをしない。
 */

/** 強い順。**この順序が意味を持つ**ので、並べ替えるときは根拠ごと考えること。 */
export const EVIDENCE_RANK = Object.freeze({ hash: 3, versionId: 2, modelId: 1, name: 0 });

/** 1件ぶんの根拠を読む。**書かれていなければ推測しない。** */
export function evidenceOf(resource) {
    if (!resource || typeof resource !== 'object') return null;
    // 解決器が後から付けた根拠を優先する（実際に引き当てたのはそちら）。
    const resolved = resource.resolvedBy;
    if (typeof resolved === 'string' && resolved in EVIDENCE_RANK) return resolved;
    const declared = resource.evidence;
    if (typeof declared === 'string' && declared in EVIDENCE_RANK) return declared;
    // **無印を `name` に落とさない。** 古い記録は印を持たないので、
    // 落とすと「全部あやしい」になって印の意味が消える。
    return null;
}

/**
 * レコード（またはレシピ）の中で、**名前でしか照合できていないモデル**を集める。
 *
 * @returns {{names: string[], total: number}}
 *   `names` は表示用。`total` は根拠が読めたモデルの総数（分母）。
 */
export function nameOnlyModels(recipe) {
    const names = [];
    let total = 0;
    const visit = (resource) => {
        const evidence = evidenceOf(resource);
        if (evidence === null) return;
        total += 1;
        if (evidence === 'name') {
            const label = String(resource.file_name || resource.name || '').trim();
            if (label) names.push(label);
        }
    };
    visit(recipe?.checkpoint);
    for (const lora of (Array.isArray(recipe?.loras) ? recipe.loras : [])) visit(lora);
    for (const embed of (Array.isArray(recipe?.embeddings) ? recipe.embeddings : [])) visit(embed);
    return { names, total };
}

/**
 * 印を出すべきか。**1件でも名前だけなら出す。**
 *
 * 「何件中何件」で薄めない——**1本違えば絵は変わる**ので、割合の問題ではない。
 */
export function needsEvidenceWarning(recipe) {
    return nameOnlyModels(recipe).names.length > 0;
}
