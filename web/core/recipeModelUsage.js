/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 「このモデルは、ほかに何件の記録が要求しているか」を数える。
 *
 * **補助モデル（テキストエンコーダ・VAE・拡大器）は記録の素材一覧に載っていない。**
 * 構成から逆算されて初めて名前が出るので、素材一覧を舐めるだけでは数えられない。
 * だからここは**記録を1件ずつ実際に組んで**、組み上がったグラフの入力欄から数える。
 *
 * Unbake でこれが要るのは**不足を埋める順番**のため。「入っていないモデル」が
 * 20個あるとき、どれから落とせば再現できる記録が一番増えるかは、共有件数でしか
 * 決まらない。上流では「消してよいか」を決める道具だったが、その用途は
 * モデルの整理＝**この製品がやらないこと**なので、既定の選択も削除の示唆も持たない。
 *
 * **数えられなかった件を0扱いにしない。** 組めなかった記録を黙って除くと共有件数が
 * 過小に出て、「ほかは誰も使っていない」という**測っていない断定**が静かに混ざる。
 * 件数と一緒に返して、呼び手が「N件は数えられていない」と言えるようにする。
 *
 * 上流の同名モジュールはフォークの `/api/lm/recipes` を自分で叩いて全件を集めていた。
 * ここは**記録の配列を受け取るだけ**にしてある（core は外へ出ない）。
 */

import { buildRecipeWorkflow } from './recipeWorkflowBuilder.js';

/** 組み上がったグラフで「モデルのファイル名」が入る入力欄。 */
const MODEL_FIELDS = new Set([
    'ckpt_name', 'lora_name', 'unet_name', 'vae_name', 'model_name',
    'clip_name', 'clip_name1', 'clip_name2', 'clip_name3', 'clip_name4', 'control_net_name',
]);

/** 区切りと大小を無視した照合鍵。ComfyUI 側と記録側で表記が揺れるため。 */
export function usageKey(value) {
    return String(value || '').replaceAll('\\', '/').toLowerCase();
}

/** 組み上がったグラフが要求しているモデル名（正規化前の表記のまま）。 */
export function modelNamesInBuilt(built) {
    const names = new Map();
    for (const node of Object.values(built?.prompt || {})) {
        for (const [field, value] of Object.entries(node?.inputs || {})) {
            if (!MODEL_FIELDS.has(field) || typeof value !== 'string' || !value) continue;
            const key = usageKey(value);
            if (!names.has(key)) names.set(key, { name: value, field });
        }
    }
    return names;
}

/**
 * モデル名 → それを要求する記録（id と題名）の索引を作る。
 *
 * @param {Array<object>} records 記録の配列（呼び手が集める）
 * @param {object} options `buildRecipeWorkflow` へそのまま渡す判定材料
 * @returns {{usage: Map<string, Array<{id: string, title: string}>>,
 *            failures: Array<{id: string, title: string, why: string}>,
 *            scanned: number, counted: number}}
 */
export function buildModelUsageIndex(records, {
    objectInfo, knownModelCatalog = null, embeddings = null, build = buildRecipeWorkflow,
} = {}) {
    const usage = new Map();
    const failures = [];
    let counted = 0;
    for (const record of Array.isArray(records) ? records : []) {
        if (!record || typeof record !== 'object') continue;
        let built;
        try {
            built = build(record, { objectInfo, knownModelCatalog, embeddings });
        } catch (error) {
            failures.push({
                id: String(record.id ?? record.recipe_id ?? ''),
                title: String(record.title || record.id || ''),
                why: String(error?.message || error).slice(0, 200),
            });
            continue;
        }
        counted += 1;
        for (const key of modelNamesInBuilt(built).keys()) {
            if (!usage.has(key)) usage.set(key, []);
            usage.get(key).push({
                id: String(record.id ?? record.recipe_id ?? ''),
                title: String(record.title || record.id || ''),
            });
        }
    }
    return { usage, failures, scanned: Array.isArray(records) ? records.length : 0, counted };
}

/** 索引に載っている、その名前を要求する記録（自分を除く）。 */
export function otherUsers(index, name, currentRecordId) {
    const current = currentRecordId === undefined || currentRecordId === null
        ? null
        : String(currentRecordId);
    return (index?.usage?.get(usageKey(name)) || []).filter(item => item.id !== current);
}

/**
 * 対象の記録が要求するモデルを、**ほかで何件が要求しているか**つきで並べる。
 *
 * 並びは共有件数の少ない順。`sharedWithOthers` は「ほかにも要る」という事実だけで、
 * **どうすべきかは含まない**——上流にあった「既定で選ぶ」は削除UIの都合だった。
 */
export function summarizeRecordModels(built, index, currentRecordId) {
    const rows = [];
    for (const { name, field } of modelNamesInBuilt(built).values()) {
        const users = otherUsers(index, name, currentRecordId);
        rows.push({
            name,
            field,
            others: users.length,
            otherTitles: users.map(item => item.title),
            sharedWithOthers: users.length > 0,
        });
    }
    return rows.sort((a, b) => a.others - b.others || a.name.localeCompare(b.name));
}

/**
 * 不足しているモデルを、**落としたときに解ける記録の件数**が多い順に並べる。
 *
 * これが Unbake でこの索引を持つ理由。不足20件を上から順に落とすのと、
 * 共有件数の多い順に落とすのとでは、**同じ手間で再現できる件数が変わる**。
 *
 * @param {Array<string|{name: string}>} missingNames 不足しているモデル名
 * @param {object} index `buildModelUsageIndex` の返り値
 * @returns {Array<{name: string, unlocks: number, records: Array<{id: string, title: string}>}>}
 */
export function rankMissingByUnlock(missingNames, index) {
    const rows = [];
    const seen = new Set();
    for (const entry of Array.isArray(missingNames) ? missingNames : []) {
        const name = typeof entry === 'string' ? entry : String(entry?.name || '');
        if (!name) continue;
        const key = usageKey(name);
        if (seen.has(key)) continue;
        seen.add(key);
        const records = index?.usage?.get(key) || [];
        rows.push({ name, unlocks: records.length, records: [...records] });
    }
    return rows.sort((a, b) => b.unlocks - a.unlocks || a.name.localeCompare(b.name));
}

/**
 * **不足から索引を作る**（買い足しの相談用・2026-08-26）。
 *
 * `buildModelUsageIndex` はグラフを組み直して「そのモデルを**使う**記録」を
 * 数える。正しいが高い——実測で記録 352件の組み直しに約7秒かかり、
 * 押すたびに払える値段ではない。
 *
 * 買い足しの相談で知りたいのは「そのモデルを使う記録」ではなく
 * **「そのモデルが足りなくて止まっている記録」**で、判定が既に `missing` として
 * 持っている。**組み直さずに同じ形の索引が作れる。**
 *
 * 返す形は `buildModelUsageIndex` と同じなので、`rankMissingByUnlock` が
 * そのまま使える。**数えている母集団が違う**ことだけは呼び手が知っていること
 * ——こちらは「待っている記録」で、あちらは「使っている記録」。
 *
 * @param {Array<object>} records `missing` を持つ記録（判定済み）
 * @returns {{usage: Map<string, Array<{id: string, title: string}>>}}
 */
export function buildMissingUsageIndex(records) {
    const usage = new Map();
    for (const record of Array.isArray(records) ? records : []) {
        const missing = record?.missing;
        if (!missing) continue;
        const who = {
            id: String(record.libraryId ?? record.id ?? ''),
            title: String(record.title || record.id || ''),
        };
        const items = [...(missing.models || []), ...(missing.resources || [])];
        // **同じ記録を1つのモデルに2回数えない。**（本体と資源の両方に出ることがある）
        const seen = new Set();
        for (const item of items) {
            const name = String(item?.name || '').trim();
            if (!name) continue;
            const key = usageKey(name);
            if (seen.has(key)) continue;
            seen.add(key);
            if (!usage.has(key)) usage.set(key, []);
            usage.get(key).push(who);
        }
    }
    return { usage };
}
