/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 束で回す。**投げる前に落とし、出していない分だけを並べ、まとめて回す。**
 *
 * ---
 *
 * **① 門は投入の直前に置く。**（手順12）
 *
 * 1件ずつなら、投げ損ねても「1件失敗した」で済む。束にすると同じ投げ損が
 * **「N分待ってからまとめて失敗」**に化けるので、束にする前に門が要る。
 * 判定の表（`verdictTable.js`）を読んで、`blocked` を投げない。
 *
 * **判定を作り直さない。** 4人の消費者（チップ・並び替え・門・集計）が
 * 同じ表を読むと決めてあるので、ここは読むだけ。門が独自に判定すると、
 * 「一覧では再現可なのに投げると弾かれる」が起きる。
 *
 * ---
 *
 * **② 待ち行列の単位は「記録」ではなく「まだ出していない条件」。**（手順13）
 *
 * 記録を単位にすると、既に出ている絵がある記録も丸ごと回し直すことになる。
 * 単位を条件にすれば、**足りない分だけ**が並ぶ。
 * 「出ている」の判断は**刻印だけ**を使う——指紋は推定で、
 * **推定で回し直しを止めると「出したはずの絵が無い」が起きる。**
 *
 * ---
 *
 * **③ 並べ替えは絞り込みの後。**（手順14）
 *
 * checkpoint 順に並べるとモデルのロード回数が減る。**だが効果は
 * 絞り込みと足し算ではなく掛け算になる**——先に減った集合を並べ替えるので、
 * 「絞り込みで N 回減り、並べ替えで M 回減った」と足すと二重に数える。
 * 実測はこのファイルの検査（`batch_queue_real_data_test.mjs`）が持つ。
 */

/** 投げてよい判定。**`pending` は投げない**（まだ組んでいない＝可否が判っていない）。 */
const READY_VERDICTS = new Set(['reproducible', 'approximate']);

/**
 * 投入してよい記録だけを通す門。
 *
 * @param {object[]} records 一覧が持っている記録（判定が写っていること）
 * @returns {{ready: object[], blocked: object[], pending: object[]}}
 *   **落としたものを捨てない。** 件数と理由が読めないと、
 *   「N件のはずが M件しか回らなかった」の原因が判らない。
 */
export function gateForSubmission(records) {
    const ready = [];
    const blocked = [];
    const pending = [];
    for (const record of records || []) {
        const verdict = String(record?.verdict ?? 'pending');
        if (READY_VERDICTS.has(verdict)) ready.push(record);
        else if (verdict === 'pending') pending.push(record);
        else blocked.push(record);
    }
    return { ready, blocked, pending };
}

/**
 * 記録がまだ出していない条件を数える。
 *
 * @param {object} record
 * @param {(recordId: string) => string[]} stampedSignatures 出ている条件の署名
 *   **刻印由来のものだけ**を渡すこと（推定を渡すと、出ていない絵を出た扱いにする）
 * @param {string[]} wantedSignatures 回したい条件の署名
 */
export function pendingConditions(record, wantedSignatures, stampedSignatures) {
    const done = new Set(stampedSignatures?.(String(record?.libraryId ?? record?.id ?? '')) || []);
    return (wantedSignatures || []).filter(signature => !done.has(signature));
}

/** 記録の checkpoint。**空は空のまま**（不明を1つのモデル名に潰さない）。 */
export function checkpointOf(record) {
    const checkpoint = record?.checkpoint;
    if (typeof checkpoint === 'string') return checkpoint.trim();
    return String(checkpoint?.file_name || checkpoint?.name || '').trim();
}

/**
 * 同じ checkpoint を続けて回すように並べ替える。
 *
 * **同じモデルの中の順序は変えない。** 変えると、利用者が一覧で作った並びが
 * 理由なく崩れる。ここがやるのは「まとめる」だけ。
 */
export function orderByCheckpoint(records) {
    const groups = new Map();
    for (const record of records || []) {
        const key = checkpointOf(record);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(record);
    }
    // **不明（空）は最後。** 先頭に置くと、判っている分の連続が切れる。
    const keys = [...groups.keys()].sort((a, b) => {
        if (!a) return 1;
        if (!b) return -1;
        return a < b ? -1 : a > b ? 1 : 0;
    });
    return keys.flatMap(key => groups.get(key));
}

/**
 * この並びで checkpoint を何回ロードするか。
 *
 * **「モデルが何種類あるか」ではない。** 連続していれば1回で済むので、
 * 数えるのは**切り替わった回数**——同じモデルが飛び飛びに現れると、
 * 種類の数より多くなる（それが並べ替えで減る分）。
 */
export function checkpointLoadCount(records) {
    let count = 0;
    let previous = null;
    for (const record of records || []) {
        const key = checkpointOf(record);
        if (key !== previous) {
            count += 1;
            previous = key;
        }
    }
    return count;
}

/**
 * 束を組む。**落としたものと、飛ばしたものを必ず返す。**
 *
 * @returns {{items: object[], skipped: object, loads: object}}
 *   `skipped` は門で落とした内訳、`loads` は並べ替えの前後のロード回数。
 *   **2つの効果を足し算しないため**、順に測った値をそのまま返す。
 */
export function buildBatch(records, {
    stampedSignatures = null,
    wantedSignaturesOf = null,
    reorder = true,
} = {}) {
    const { ready, blocked, pending } = gateForSubmission(records);

    // 「まだ出していない条件」を持つ記録だけを残す。
    let remaining = ready;
    let alreadyDone = 0;
    if (typeof stampedSignatures === 'function' && typeof wantedSignaturesOf === 'function') {
        remaining = [];
        for (const record of ready) {
            const missing = pendingConditions(record, wantedSignaturesOf(record), stampedSignatures);
            if (missing.length === 0) { alreadyDone += 1; continue; }
            remaining.push({ ...record, pendingSignatures: missing });
        }
    }

    // **測る順序が意味を持つ。** 絞り込んだ後の集合で並べ替えの効果を測る
    // ——絞り込み前の値と足すと、同じ削減を二重に数える。
    const beforeAll = checkpointLoadCount(records || []);
    const afterGate = checkpointLoadCount(remaining);
    const items = reorder ? orderByCheckpoint(remaining) : remaining;
    const afterOrder = checkpointLoadCount(items);

    return {
        items,
        skipped: {
            blocked: blocked.length,
            pending: pending.length,
            alreadyDone,
        },
        loads: {
            // 何もしなかったときのロード回数
            all: beforeAll,
            // 門と「出していない条件」で絞った後
            filtered: afterGate,
            // さらに並べ替えた後（**これが最終**）
            ordered: afterOrder,
        },
    };
}
