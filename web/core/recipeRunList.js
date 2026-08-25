/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 実行リスト——**順番に回したい記録を名前付きで束ねる**入れ物と、その純粋な操作。
 *
 * 束は複数持てる。1本しか持てないと、別の狙いで回すたびに組み直すことになり、
 * その組み直しの手間がそのまま損失になる。
 *
 * **旧い形（ただの配列）をそのまま受ける。** 入れ物の形を変えた版が、前の版で
 * 作った束を黙って捨てると、失うのは配列ではなく**並べ直した順番**である。
 *
 * 保存は `storage.js` 経由。ここが `localStorage` を直接見ないので、テストと
 * 埋め込み用途では揮発の入れ物へ落ちる。
 */

import { readStored, writeStored } from './storage.js';
import { t } from '../i18n/index.js';

export const RUN_LIST_STORAGE_KEY = 'unbake.run_lists';

/**
 * checkpoint の名前を、来た形に関係なく取り出す。
 * **見つからないときだけ空文字**（形が違うだけの記録を捨てない）。
 *
 * @param {object|string|null|undefined} checkpoint
 * @returns {string}
 */
export function checkpointNameOf(checkpoint) {
    if (typeof checkpoint === 'string') return checkpoint.trim();
    if (checkpoint && typeof checkpoint === 'object') {
        return String(checkpoint.file_name || checkpoint.name || '').trim();
    }
    return '';
}

/**
 * 既定の束の名前。**定数ではなく関数**——モジュールの読み込み時に決めてしまうと、
 * 宿主の言語設定を読む前の文言で固定される。
 */
export function defaultListName() {
    return t('core.runList.defaultName');
}

/** 記録1件を束に入る形へ落とす。id が無いものは入れない。 */
export function normalizeRunListEntry(record) {
    if (!record || typeof record !== 'object') return null;
    const id = record.id || record.recipe_id;
    if (!id) return null;
    // **checkpoint は2つの形で来る。** レシピの本体はオブジェクト
    // （`{file_name, name, ...}`）だが、**一覧が渡してくる記録では文字列**である
    // ——書庫の要約 `_summarize()` が名前へ潰して返すからで、束に入るのはたいてい
    // そちら側の記録になる。
    //
    // 元はオブジェクトしか見ておらず、文字列は問答無用で空文字になっていた。
    // 実測（2026-08-20・実データ346件）で**一覧経由なら331件が空文字**になる
    // ——束の中身がすべて名前無しで並ぶので、checkpoint 順に並べることも
    // 見分けることもできない。**空文字は「無い」に見えて、実際は「捨てた」だった。**
    return {
        id: String(id),
        title: String(record.title || id),
        checkpointName: checkpointNameOf(record.checkpoint),
    };
}

/**
 * 記録を束へ足す。**既に入っているものは足さず、足せた件数と飛ばした件数を返す。**
 * 「12件放り込んだのに3件しか増えなかった」を呼び手が説明できるようにするため。
 */
export function addRunListEntries(entries, records) {
    const next = Array.isArray(entries) ? [...entries] : [];
    const known = new Set(next.map(entry => entry.id));
    let added = 0;
    let skipped = 0;
    for (const record of Array.isArray(records) ? records : []) {
        const entry = normalizeRunListEntry(record);
        if (!entry || known.has(entry.id)) {
            skipped += 1;
            continue;
        }
        known.add(entry.id);
        next.push(entry);
        added += 1;
    }
    return { entries: next, added, skipped };
}

export function removeRunListEntry(entries, id) {
    return (Array.isArray(entries) ? entries : []).filter(entry => entry.id !== id);
}

export function moveRunListEntry(entries, id, offset) {
    const next = Array.isArray(entries) ? [...entries] : [];
    const index = next.findIndex(entry => entry.id === id);
    if (index < 0) return next;
    const target = index + offset;
    if (target < 0 || target >= next.length) return next;
    const [entry] = next.splice(index, 1);
    next.splice(target, 0, entry);
    return next;
}

// -- 複数の束 ---------------------------------------------------------

/**
 * 束の識別子。`crypto.randomUUID` があれば使う。
 * **テストが差し替えられるように**引数で受け取れる形にしてある。
 */
export function makeListId(makeId = null) {
    if (typeof makeId === 'function') return String(makeId());
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
    const values = new Uint32Array(4);
    globalThis.crypto?.getRandomValues?.(values);
    return `list-${[...values].map(value => value.toString(16).padStart(8, '0')).join('')}`;
}

function sanitizeEntries(value) {
    return (Array.isArray(value) ? value : []).filter(
        entry => entry && typeof entry === 'object' && entry.id
    );
}

function makeList(name, entries = [], makeId = null) {
    return {
        id: makeListId(makeId),
        name: String(name || defaultListName()),
        entries: sanitizeEntries(entries),
    };
}

/**
 * 保存値を `{activeId, lists}` へ揃える。**壊れていても空を返さない**——
 * 束が1つも無い状態を返すと、呼び手は「入れ物が無い」ので追加すらできなくなる。
 */
export function normalizeRunListState(stored, { makeId = null } = {}) {
    // 旧い形: entries の配列
    if (Array.isArray(stored)) {
        const list = makeList(defaultListName(), stored, makeId);
        return { activeId: list.id, lists: [list] };
    }

    if (!stored || typeof stored !== 'object') {
        const list = makeList(defaultListName(), [], makeId);
        return { activeId: list.id, lists: [list] };
    }

    const lists = (Array.isArray(stored.lists) ? stored.lists : [])
        .filter(list => list && typeof list === 'object')
        .map(list => ({
            id: String(list.id || makeListId(makeId)),
            name: String(list.name || defaultListName()),
            entries: sanitizeEntries(list.entries),
        }));

    if (lists.length === 0) {
        const list = makeList(defaultListName(), [], makeId);
        return { activeId: list.id, lists: [list] };
    }

    const activeId = lists.some(list => list.id === stored.activeId)
        ? String(stored.activeId)
        : lists[0].id;

    return { activeId, lists };
}

export function loadRunListState(options = {}) {
    return normalizeRunListState(readStored(RUN_LIST_STORAGE_KEY, null), options);
}

/** @returns {boolean} 保存できたら true */
export function saveRunListState(state, options = {}) {
    return writeStored(RUN_LIST_STORAGE_KEY, normalizeRunListState(state, options));
}

export function getActiveList(state, options = {}) {
    const normalized = normalizeRunListState(state, options);
    return normalized.lists.find(list => list.id === normalized.activeId) || normalized.lists[0];
}

export function createList(state, name, options = {}) {
    const normalized = normalizeRunListState(state, options);
    const list = makeList(name, [], options.makeId ?? null);
    return { activeId: list.id, lists: [...normalized.lists, list] };
}

export function renameList(state, listId, name, options = {}) {
    const normalized = normalizeRunListState(state, options);
    const trimmed = String(name || '').trim();
    if (!trimmed) return normalized;
    return {
        ...normalized,
        lists: normalized.lists.map(list =>
            list.id === listId ? { ...list, name: trimmed } : list
        ),
    };
}

/** 束を消す。**最後の1本は消さない**（消すと入れ物が無くなる）。 */
export function deleteList(state, listId, options = {}) {
    const normalized = normalizeRunListState(state, options);
    if (normalized.lists.length <= 1) return normalized;

    const lists = normalized.lists.filter(list => list.id !== listId);
    if (lists.length === normalized.lists.length) return normalized;

    const activeId = normalized.activeId === listId ? lists[0].id : normalized.activeId;
    return { activeId, lists };
}

export function setActiveList(state, listId, options = {}) {
    const normalized = normalizeRunListState(state, options);
    if (!normalized.lists.some(list => list.id === listId)) return normalized;
    return { ...normalized, activeId: listId };
}

/** 今の束の中身を差し替える。 */
export function replaceActiveEntries(state, entries, options = {}) {
    const normalized = normalizeRunListState(state, options);
    return {
        ...normalized,
        lists: normalized.lists.map(list =>
            list.id === normalized.activeId
                ? { ...list, entries: sanitizeEntries(entries) }
                : list
        ),
    };
}

/** 今の束の中身だけを読む・書く近道。 */
export function loadRunList(options = {}) {
    return getActiveList(loadRunListState(options), options).entries;
}

export function saveRunList(entries, options = {}) {
    return saveRunListState(replaceActiveEntries(loadRunListState(options), entries, options), options);
}
