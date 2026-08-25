/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 記録1件ごとの上書き（LoRA の強度と、モデルの差し替え）。
 *
 * 記録の `strength` は**元画像に付いていた値**なので書き換えない。手で振った値は
 * 別レイヤに持ち、組み立てる直前にだけ重ねる。こうすると「元に戻す」はレイヤを
 * 消すだけで済み、**記録は常に無傷で残る**——ここが Unbake の前提そのもので、
 * 記録を直接書き換える実装にすると、比較の基準点が回を追うごとに動いてしまう。
 *
 * 鍵は `modelVersionId` を優先する。ファイル名は改名や版の差し替えで動くが、
 * `modelVersionId` は記録が指している版そのものを指す。
 */

import { readStored, writeStored } from './storage.js';

const STORAGE_KEY = 'unbake.lora_strength_overrides';

/**
 * 差し替えの置き場。**強度とは別の鍵にする。**
 *
 * 同じ入れ物へ混ぜると、片方の形を変えたときにもう片方の既存データが
 * 読めなくなる（利用者の手元には既に強度の上書きが入っている）。
 */
const MODEL_STORAGE_KEY = 'unbake.model_overrides';

/** checkpoint は1記録に1つなので、鍵は固定でよい。 */
const CHECKPOINT_KEY = 'checkpoint';

function loraKey(lora, index) {
    const versionId = lora?.modelVersionId ?? lora?.id;
    if (Number.isFinite(Number(versionId)) && Number(versionId) > 0) {
        return `v${versionId}`;
    }
    const name = String(lora?.file_name || '').trim();
    return name ? `f${name.toLowerCase()}` : `i${index}`;
}

function readAll() {
    const stored = readStored(STORAGE_KEY, {});
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}

/** この記録に上書きがあるか。 */
export function hasLoraOverrides(recordId) {
    const entry = readAll()[String(recordId)];
    return Boolean(entry && typeof entry === 'object' && Object.keys(entry).length > 0);
}

/** 記録の上書き一覧（loraKey → strength）。無ければ空オブジェクト。 */
export function getLoraOverrides(recordId) {
    const entry = readAll()[String(recordId)];
    return entry && typeof entry === 'object' ? { ...entry } : {};
}

/** 1本ぶんの上書き。未設定なら null。 */
export function getLoraOverride(recordId, lora, index) {
    const value = getLoraOverrides(recordId)[loraKey(lora, index)];
    return Number.isFinite(Number(value)) ? Number(value) : null;
}

/**
 * 上書きを保存する。`strength` に null を渡すとその1本だけ消える。
 *
 * @returns {boolean} 保存できたら true（**容量超過を黙って飲まない**）
 */
export function setLoraOverride(recordId, lora, index, strength) {
    const all = readAll();
    const id = String(recordId);
    const entry = { ...(all[id] || {}) };
    const key = loraKey(lora, index);
    if (strength === null || !Number.isFinite(Number(strength))) {
        delete entry[key];
    } else {
        entry[key] = Number(strength);
    }
    if (Object.keys(entry).length === 0) {
        delete all[id];
    } else {
        all[id] = entry;
    }
    return writeStored(STORAGE_KEY, all);
}

/** 記録の上書きを全部消す（＝記録どおりへ戻す）。 */
export function clearLoraOverrides(recordId) {
    const all = readAll();
    delete all[String(recordId)];
    return writeStored(STORAGE_KEY, all);
}

/**
 * 組み立て直前の記録へ上書きを重ねる。**元のオブジェクトは変更しない。**
 *
 * 値は `strength_model` / `strength_clip` に入れる（`recipeWorkflowBuilder` の
 * `getLoraStrengths` が最優先で読むフィールド）。あわせて `user_override` を立て、
 * 記録の無い強度の自動抑制（`capUnrecordedLoraStrengths`）の対象から外す——
 * **手で指した値は「既定で埋めた値」ではない**ので、勝手に縮めない。
 */
export function applyLoraOverrides(record) {
    if (!record || !Array.isArray(record.loras) || record.loras.length === 0) return record;
    const overrides = getLoraOverrides(record.id);
    if (Object.keys(overrides).length === 0) return record;

    let touched = false;
    const loras = record.loras.map((lora, index) => {
        const value = overrides[loraKey(lora, index)];
        if (!Number.isFinite(Number(value))) return lora;
        touched = true;
        return {
            ...lora,
            strength_model: Number(value),
            strength_clip: Number(value),
            user_override: true,
        };
    });
    return touched ? { ...record, loras } : record;
}


// --- モデルの差し替え -------------------------------------------------------
//
// **「振る」で軸を宣言する形をやめ、モデルの行で直に選ぶ**（利用者の指示・
// 2026-08-22）。選べるのは**手元に在るものだけ**——無い物へ差し替えると、
// 組み立てがその LoRA を鎖から外すか、ComfyUI が投入を拒む。

function readAllModels() {
    const stored = readStored(MODEL_STORAGE_KEY, {});
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}

/** この記録の差し替え一覧（鍵 → 相対名）。無ければ空オブジェクト。 */
export function getModelOverrides(recordId) {
    const entry = readAllModels()[String(recordId)];
    return entry && typeof entry === 'object' ? { ...entry } : {};
}

/**
 * 1つぶんの差し替え。未設定なら null。
 *
 * `lora` に null を渡すと checkpoint を指す（1記録に1つしか無い）。
 */
export function getModelOverride(recordId, lora, index) {
    const key = lora ? loraKey(lora, index) : CHECKPOINT_KEY;
    const value = getModelOverrides(recordId)[key];
    return typeof value === 'string' && value ? value : null;
}

/**
 * 差し替えを保存する。`name` に null を渡すとその1つだけ消える（＝記録どおり）。
 *
 * @returns {boolean} 保存できたら true（**容量超過を黙って飲まない**）
 */
export function setModelOverride(recordId, lora, index, name) {
    const all = readAllModels();
    const id = String(recordId);
    const entry = { ...(all[id] || {}) };
    const key = lora ? loraKey(lora, index) : CHECKPOINT_KEY;
    const text = typeof name === 'string' ? name.trim() : '';
    if (!text) delete entry[key];
    else entry[key] = text;
    if (Object.keys(entry).length === 0) delete all[id];
    else all[id] = entry;
    return writeStored(MODEL_STORAGE_KEY, all);
}

/** この記録の差し替えを全部消す（＝記録どおりへ戻す）。 */
export function clearModelOverrides(recordId) {
    const all = readAllModels();
    delete all[String(recordId)];
    return writeStored(MODEL_STORAGE_KEY, all);
}

/**
 * 差し替えを1つぶん重ねた資源を作る。**元のオブジェクトは変更しない。**
 *
 * `file_name` だけ差し替えても効かない。組み立ては
 * `inLibrary ? localPath : null` → `file_name` の順で名前を採るので
 * （`recipeWorkflowBuilder.getResourceFilename`）、**`localPath` が古いままだと
 * そちらが勝って、選んだのと違うモデルで回る**——画面は変わったのに絵が
 * 変わらない、という一番わかりにくい形になる。
 */
function swapped(resource, name) {
    const base = (resource && typeof resource === 'object')
        ? resource
        : { name: typeof resource === 'string' ? resource : '' };
    return {
        ...base,
        file_name: name,
        localPath: name,
        // 手元に在るものからしか選ばせていないので、必ず手元に在る。
        inLibrary: true,
        user_swapped: true,
    };
}

/**
 * 組み立て直前の記録へ差し替えを重ねる。**元のオブジェクトは変更しない。**
 */
export function applyModelOverrides(record) {
    if (!record) return record;
    const overrides = getModelOverrides(record.id);
    if (Object.keys(overrides).length === 0) return record;

    let touched = false;
    let checkpoint = record.checkpoint;
    if (overrides[CHECKPOINT_KEY]) {
        checkpoint = swapped(checkpoint, overrides[CHECKPOINT_KEY]);
        touched = true;
    }

    let loras = record.loras;
    if (Array.isArray(loras)) {
        loras = loras.map((lora, index) => {
            const name = overrides[loraKey(lora, index)];
            if (!name) return lora;
            touched = true;
            return swapped(lora, name);
        });
    }
    return touched ? { ...record, checkpoint, loras } : record;
}

/**
 * 強度と差し替えをまとめて重ねる。**呼び手はこれ1つを呼べばよい。**
 *
 * 順番は差し替えが先。強度は鍵（版 ID かファイル名）で引くので、
 * **差し替えでファイル名が変わった後に引くと当たらなくなる**。
 */
export function applyRecordOverrides(record) {
    return applyModelOverrides(applyLoraOverrides(record));
}

/** この記録に何か手が入っているか（強度・差し替えのどちらでも）。 */
export function hasAnyOverride(recordId) {
    return hasLoraOverrides(recordId) || Object.keys(getModelOverrides(recordId)).length > 0;
}

/** この記録の手入れを全部消す。 */
export function clearAllOverrides(recordId) {
    const a = clearLoraOverrides(recordId);
    const b = clearModelOverrides(recordId);
    return a && b;
}
