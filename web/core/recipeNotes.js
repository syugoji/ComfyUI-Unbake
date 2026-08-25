/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * ComfyUI-Unbake の一部。**この行の意味**——著作権の所在を明示してある限り、
 * 後から別のライセンスを足せる。表示が無いまま配ると、それが言いづらくなる。
 */
// メモの項目式パース。
//
// メモは自由記述のままでよいが、`ポーズ: 立ち絵` のように `項目名: 値` で
// 書いた行を**構造として拾える**ようにする。こうしておくと
// 「ポーズがあるレシピだけ」「トリガーが standing のものだけ」で絞れる。
//
// **既存の自由記述を壊さない。** パースできない行はそのまま自由記述として
// 残す。書式を強制すると、今あるメモが全部「不正」になってしまう。

// 全角コロンも受ける。日本語入力では全角のまま書かれることが多い。
const FIELD_LINE = /^\s*([^:：\r\n]{1,40})[:：]\s*(.*)$/;

/**
 * メモ本文を `{fields, freeText}` に分ける。
 *
 * @returns {{fields: Array<{key: string, value: string}>, freeText: string}}
 */
export function parseNotes(text) {
    const source = typeof text === 'string' ? text : '';
    const fields = [];
    const free = [];

    for (const rawLine of source.split(/\r?\n/)) {
        const match = rawLine.match(FIELD_LINE);
        if (!match) {
            free.push(rawLine);
            continue;
        }
        const key = match[1].trim();
        const value = match[2].trim();
        if (!key) {
            free.push(rawLine);
            continue;
        }
        fields.push({ key, value });
    }

    return { fields, freeText: free.join('\n').trim() };
}

/** `{fields, freeText}` をメモ本文へ戻す（往復できること）。 */
export function formatNotes(fields, freeText = '') {
    const lines = (Array.isArray(fields) ? fields : [])
        .filter(field => field && typeof field.key === 'string' && field.key.trim())
        .map(field => `${field.key.trim()}: ${String(field.value ?? '').trim()}`);

    const tail = String(freeText || '').trim();
    if (tail) lines.push(tail);
    return lines.join('\n');
}

/** 指定した項目名の値を返す（同名が複数あれば最初の1つ）。 */
export function getNoteField(text, key) {
    if (!key) return null;
    const wanted = String(key).trim().toLowerCase();
    const found = parseNotes(text).fields.find(
        field => field.key.toLowerCase() === wanted
    );
    return found ? found.value : null;
}

/**
 * レシピ群から項目名を集める。**出現数の多い順**。
 *
 * 絞り込みの選択肢に使う。使われていない項目名を並べても選べないので、
 * 実際に書かれているものだけを出す。
 */
export function collectNoteFields(recipes) {
    const counts = new Map();
    const values = new Map();

    for (const recipe of Array.isArray(recipes) ? recipes : []) {
        const parsed = parseNotes(recipe?.notes);
        const seenInThisRecipe = new Set();
        for (const field of parsed.fields) {
            const key = field.key;
            const lower = key.toLowerCase();
            // 同じレシピ内で同名が複数あっても1件として数える
            if (!seenInThisRecipe.has(lower)) {
                counts.set(key, (counts.get(key) || 0) + 1);
                seenInThisRecipe.add(lower);
            }
            if (field.value) {
                if (!values.has(key)) values.set(key, new Set());
                values.get(key).add(field.value);
            }
        }
    }

    return [...counts.entries()]
        .map(([key, count]) => ({
            key,
            count,
            values: [...(values.get(key) || [])].sort((a, b) => a.localeCompare(b)),
        }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/**
 * 絞り込み条件に合うか。
 *
 * - `value` を省くと「その項目を持っているか」で絞る
 * - `value` があれば**部分一致**（大小無視）。完全一致にすると
 *   「standing, looking at viewer」のような複数値が拾えない
 */
export function matchesNoteFilter(text, { key, value } = {}) {
    if (!key) return true;

    const wanted = String(key).trim().toLowerCase();
    const fields = parseNotes(text).fields.filter(
        field => field.key.toLowerCase() === wanted
    );
    if (fields.length === 0) return false;

    const needle = String(value ?? '').trim().toLowerCase();
    if (!needle) return true;

    return fields.some(field => field.value.toLowerCase().includes(needle));
}

/** 絞り込み中のカードに出す短いバッジ文言。 */
export function describeNoteField(text, key) {
    const value = getNoteField(text, key);
    if (value === null) return '';
    return value ? `${key}: ${value}` : key;
}
