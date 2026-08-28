/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * ComfyUI-Unbake の一部。**この行の意味**——著作権の所在を明示してある限り、
 * 後から別のライセンスを足せる。表示が無いまま配ると、それが言いづらくなる。
 */
/**
 * 「出た絵」の手元の索引を、**触った1枚だけ**書き換える。
 *
 * 索引は開いたときに1度だけ組む（実測で初回の走査は 24往復・1,334ms）。
 * 1枚出しただけで全部組み直すのは、**待たせるためだけの往復**になる。
 *
 * ## ここを切り出した理由（2026-08-29）
 *
 * 元は `unbake.js` の閉じた中に在り、**外から呼べないので検査できなかった**。
 * そして実際に、そこに欠陥が1つ埋まっていた:
 *
 *     同じ名前の絵が来たら「もう在る」として**捨てていた**。
 *
 * **ComfyUI は消して空いた番号を再利用する。** `_00006_` を消して作り直すと、
 * 新しい絵も `_00006_` になる。つまり**同じ名前は同じ絵を意味しない**。
 * 捨てると古い項目（古い mtime・古い大きさ）が索引に残り続け、
 * 「出た絵」の一覧は**前の絵の URL を出し続ける**
 * ——利用者の報告「再度生成した後に表示が前の画像だったり」がこれ。
 *
 * 名前で同じかを見るのは正しい（**同じ場所の絵は1つ**）。間違っていたのは、
 * 同じだと分かったときに**古い方を残した**ことである。
 */

/** 索引の中で1枚を指す鍵。**置き場と名前**で決まる（同じ場所の絵は1つ）。 */
export function outputKey(entry) {
    return `${entry?.subfolder || ''}/${entry?.filename || ''}`;
}

/**
 * 出た絵を索引へ入れる。**同じ場所の絵は、新しい方で置き換える。**
 *
 * @param {Map<string, Array>} index 記録id → その記録の絵
 * @param {string} recordId
 * @param {Array} outputs 今出た分
 * @returns {boolean} 索引を書き換えたか
 */
export function noteOutputs(index, recordId, outputs) {
    const id = String(recordId ?? '');
    if (!id || !index || !Array.isArray(outputs) || !outputs.length) return false;

    /** 同じ投入の中に同じ場所が2回来たら**後勝ち**（新しい方が真）。 */
    const incoming = new Map();
    for (const output of outputs) {
        if (!output?.filename) continue;
        incoming.set(outputKey(output), output);
    }
    if (!incoming.size) return false;

    const current = index.get(id) || [];
    let replaced = false;
    // **並びは動かさない。** 差し替えは同じ位置で行う——一覧は新しい順に
    // 並べてあるので、置き換えのたびに順番が跳ねると読む側が追えなくなる。
    const kept = current.map(item => {
        const key = outputKey(item);
        if (!incoming.has(key)) return item;
        const fresh = incoming.get(key);
        incoming.delete(key);
        replaced = true;
        return fresh;
    });
    const added = [...incoming.values()];
    if (!added.length && !replaced) return false;
    // **新しいものを先頭へ。** 一覧は新しい順で並べている。
    index.set(id, added.length ? [...added, ...kept] : kept);
    return true;
}

/**
 * 消した絵を索引から落とす。**どの記録に属していても落とす**（同じ絵は1つ）。
 *
 * @returns {boolean} 索引を書き換えたか
 */
export function forgetOutput(index, { filename, subfolder = '' } = {}) {
    if (!index || !filename) return false;
    const key = outputKey({ filename, subfolder });
    let changed = false;
    for (const [id, list] of index) {
        const left = (list || []).filter(item => outputKey(item) !== key);
        if (left.length !== (list || []).length) {
            index.set(id, left);
            changed = true;
        }
    }
    return changed;
}
