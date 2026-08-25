/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 手元に残す値の置き場。**core は `localStorage` を直接触らない。**
 *
 * 上流にも同じ役目のモジュールがあるが、**開かずに書き直した**——写した瞬間に
 * 「著作権が単独で自分にある」という切り出しの根拠が消える。必要な面は呼び出し側
 * 2本から判っていた（鍵と既定値で読む／鍵と値で書く）ので、それだけを組んである。
 *
 * 設計上の違いを2つ置いた。
 *
 * 1. **入れ物は環境から受け取る。** `environment.js` に据えられていなければ
 *    プロセス内の Map へ倒す。テストが `localStorage` の有無に左右されなくなる。
 * 2. **書き込みは真偽値を返す。** 容量超過は例外で来るが、握り潰すと
 *    「保存した」と見えたまま次回消えている。呼び手が気づけるように返す。
 */

import { environmentStorageOrNull } from './environment.js';

const memory = new Map();

/** 環境に入れ物が無いときの受け皿。**プロセスが終われば消える。** */
const memoryStorage = {
    getItem(key) {
        return memory.has(key) ? memory.get(key) : null;
    },
    setItem(key, value) {
        memory.set(key, String(value));
    },
    removeItem(key) {
        memory.delete(key);
    },
};

/** 今使う入れ物。**環境優先・無ければ揮発。** */
export function storageBackend() {
    return environmentStorageOrNull() ?? memoryStorage;
}

/** 環境が据えられていない＝この保存はセッション限りである、を呼び手へ知らせる。 */
export function storageIsVolatile() {
    return environmentStorageOrNull() === null;
}

/** 揮発の入れ物を空にする（テストの後始末用）。 */
export function resetMemoryStorage() {
    memory.clear();
}

/**
 * JSON として読む。読めない値は**捨てて既定へ倒す**。
 *
 * 壊れた JSON をそのまま投げると、画面が丸ごと開かなくなる。ここが持っているのは
 * 設定と作業用の控えだけで、**記録そのものではない**ので、落として続ける方が安全。
 */
export function readStored(key, fallback = null) {
    let raw;
    try {
        raw = storageBackend().getItem(String(key));
    } catch {
        return fallback;
    }
    if (raw === null || raw === undefined || raw === '') return fallback;
    try {
        const value = JSON.parse(raw);
        return value === undefined ? fallback : value;
    } catch {
        return fallback;
    }
}

/**
 * JSON として書く。**書けたかどうかを返す。**
 *
 * @returns {boolean} 書けたら true
 */
export function writeStored(key, value) {
    let encoded;
    try {
        encoded = JSON.stringify(value);
    } catch {
        return false;
    }
    if (encoded === undefined) return false;
    try {
        storageBackend().setItem(String(key), encoded);
        return true;
    } catch {
        return false;
    }
}

/** 鍵を消す。**書けたかどうかを返す。** */
export function removeStored(key) {
    try {
        storageBackend().removeItem(String(key));
        return true;
    } catch {
        return false;
    }
}
