/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A1111 のテキストに書いてある**版 ID を、本当のファイル名と SHA256 へ**
 * 置き換える（2026-08-23 利用者の問い「civitai の Generation data を参考に
 * 再現できないのか」から）。
 *
 * **プロンプトの表記は手元のファイル名ではない。** 実測（利用者の画像1件・
 * 版4件を Civitai の公開 API で照合）:
 *
 *     <lora:ZodaPlus:1>  →  zodaplus_v1_anima.safetensors
 *
 * 名前で探すと**在るのに見つからない**。版 ID なら一意に決まり、SHA256 まで
 * 付いてくるので、**名前を変えて置いてあっても索引から引ける**（索引が
 * hash と版 ID で引く形になっているのはこのため）。
 *
 * **効き目はプロンプト側を採る。** 資源にも `weight` が入っているが、
 * 実際に掛かったのはプロンプトに書かれた値である。
 */

/** 比べるための形。**拡張子と区切りを落として小文字にする。** */
export function normalizeName(value) {
    return String(value ?? '')
        .replace(/\.(safetensors|ckpt|pt|pth|bin)$/i, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

/**
 * プロンプトの表記と、解決したファイル名が**同じものを指しているか**。
 *
 * **完全一致だけでは足りない。** 実測の `ZodaPlus` → `zodaplus_v1_anima` は
 * 一致しないが同じものである。片方がもう片方を含んでいれば同じと見る。
 *
 * **短い語では含みで判定しない。** `v1` や `add` のような語は無関係な名前へ
 * 当たる。3文字以下は完全一致だけを認める。
 */
export function looksLikeSameModel(tagName, filename) {
    const tag = normalizeName(tagName);
    const file = normalizeName(filename);
    if (!tag || !file) return false;
    if (tag === file) return true;
    if (tag.length <= 3 || file.length <= 3) return false;
    return file.includes(tag) || tag.includes(file);
}

/**
 * 解決した結果をレシピへ写す。**引数は変えない。**
 *
 * @param {object} recipe   `recipeFromA1111()` の戻り
 * @param {object[]} resolved `[{versionId, filename, kind, sha256}]`
 * @returns {{recipe: object, replaced: number, added: number, unresolved: number}}
 */
export function applyResolvedResources(recipe, resolved) {
    if (!recipe || typeof recipe !== 'object') {
        return { recipe, replaced: 0, added: 0, unresolved: 0 };
    }
    const list = (Array.isArray(resolved) ? resolved : []).filter(item => item?.ok !== false);
    const byVersion = new Map();
    for (const item of list) {
        const id = Number(item?.versionId ?? item?.modelVersionId);
        if (Number.isFinite(id) && item?.filename) byVersion.set(id, item);
    }
    const resources = Array.isArray(recipe.civitai_resources) ? recipe.civitai_resources : [];
    const next = { ...recipe };
    let replaced = 0;
    let added = 0;

    // --- checkpoint（対応は一意）------------------------------------------
    const checkpointId = Number(recipe.checkpoint?.modelVersionId);
    const checkpointHit = byVersion.get(checkpointId);
    if (checkpointHit) {
        next.checkpoint = {
            ...recipe.checkpoint,
            file_name: checkpointHit.filename,
            hash: checkpointHit.sha256 || recipe.checkpoint?.hash || null,
        };
        replaced += 1;
    }

    // --- LoRA ---------------------------------------------------------------
    // 解決できた LoRA の資源だけを候補にする（checkpoint は上で使った）。
    const candidates = resources
        .filter(item => item.kind && item.kind !== 'checkpoint')
        .map(item => ({ resource: item, hit: byVersion.get(Number(item.modelVersionId)) }))
        .filter(item => item.hit);

    const used = new Set();
    const loras = (Array.isArray(recipe.loras) ? recipe.loras : []).map(lora => {
        const found = candidates.find(item => !used.has(item)
            && looksLikeSameModel(lora.file_name, item.hit.filename));
        if (!found) return lora;
        used.add(found);
        replaced += 1;
        return {
            ...lora,
            file_name: found.hit.filename,
            // **効き目はプロンプト側。** 実際に掛かったのはそちらである。
            hash: found.hit.sha256 || lora.hash || null,
            modelVersionId: found.resource.modelVersionId ?? null,
            modelName: found.resource.modelName ?? null,
        };
    });

    // **プロンプトに書かれていない資源も足す。** Civitai の側で自動的に
    // 掛かるものがあり、落とすと出る絵が変わる。効き目は資源が持っている。
    for (const item of candidates) {
        if (used.has(item)) continue;
        added += 1;
        loras.push({
            file_name: item.hit.filename,
            weight: item.resource.weight ?? 1,
            strength: item.resource.weight ?? 1,
            hash: item.hit.sha256 || null,
            modelVersionId: item.resource.modelVersionId ?? null,
            modelName: item.resource.modelName ?? null,
        });
    }
    next.loras = loras;

    return {
        recipe: next,
        replaced,
        added,
        // **引けなかった数を返す。** 黙って落とすと「全部そろった」と読まれる。
        unresolved: resources.filter(item => Number.isFinite(Number(item.modelVersionId))
            && !byVersion.has(Number(item.modelVersionId))).length,
    };
}
