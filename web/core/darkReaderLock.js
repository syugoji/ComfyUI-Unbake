/**
 * Dark Reader に「このページは自前で暗い」と伝える。
 *
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * ## なぜ要るのか（実測 2026-08-24）
 *
 * 利用者の環境で**面の色が指定と違って返っていた**。
 *
 *   後ろ布  指定 `rgba(8, 5, 3, 0.18)` → 返り値 `rgb(74, 81, 83)`（**不透明のグレー**）
 *   箱      指定 `#212124`             → 返り値 `rgb(30, 32, 33)`
 *
 * **指定していない色が返る＝ページの外から書き換えられている。**
 * 犯人は拡張機能 Dark Reader だった。半透明の重ねを不透明へ潰すので、
 * **重ねた面が「背景が単色」に見える**。
 *
 * **CSS では直せない。** どんな色を書いても同じ変換を受ける
 * （実測で `oklch` も `rgba` も両方読めていて、結果だけが別の色だった）。
 *
 * ## 何をするのか
 *
 * Dark Reader は `<meta name="darkreader-lock">` を見つけると**自分を無効にする**
 * （公式の仕組み。静的にも動的にも置ける）。ComfyUI は元から暗いので、
 * 上から暗くし直す意味は薄く、**壊す側の害のほうが大きい。**
 *
 * ## ⚠️ ページ全体に効く
 *
 * **これは Unbake の面だけの話にできない。** meta は文書に1つで、
 * 効く範囲は ComfyUI 全体になる。だから**切れるようにしてある**
 * （設定の `disable_dark_reader`。既定は有効）。
 * 明るいテーマの ComfyUI を Dark Reader で暗くして使っている人は、ここを切る。
 *
 * **足したことは黙らない。** 呼び手はログへ1行出すこと——
 * 宿主の見え方を変える操作を、気づかれないまま行わない。
 */

/** 目印。**Dark Reader が見るのはこの名前だけ**（値は見ない）。 */
export const LOCK_META_NAME = 'darkreader-lock';

/**
 * 錠を掛ける。**既に在れば何もしない**（重ねて足すと文書が汚れる）。
 *
 * @param {Document} [documentRef]
 * @returns {'added' | 'already' | 'unavailable'}
 *   `unavailable` は `head` が無いとき——**例外にしない**。
 *   拡張の登録はここで止まってよい話ではない。
 */
export function lockDarkReader(documentRef = globalThis.document) {
    const doc = documentRef;
    if (!doc?.head || typeof doc.createElement !== 'function') return 'unavailable';
    const existing = doc.querySelector?.(`meta[name="${LOCK_META_NAME}"]`);
    if (existing) return 'already';
    const meta = doc.createElement('meta');
    meta.setAttribute('name', LOCK_META_NAME);
    doc.head.append(meta);
    return 'added';
}

/**
 * 錠を外す。**設定で切ったときに効く**——次の再読み込みを待たせない。
 *
 * @returns {'removed' | 'absent' | 'unavailable'}
 */
export function unlockDarkReader(documentRef = globalThis.document) {
    const doc = documentRef;
    if (!doc?.querySelector) return 'unavailable';
    const existing = doc.querySelector(`meta[name="${LOCK_META_NAME}"]`);
    if (!existing) return 'absent';
    existing.remove?.();
    return 'removed';
}

/** 設定の値から、掛けるか外すかを決めて実行する。 */
export function applyDarkReaderLock(enabled, documentRef = globalThis.document) {
    return enabled === false
        ? unlockDarkReader(documentRef)
        : lockDarkReader(documentRef);
}
