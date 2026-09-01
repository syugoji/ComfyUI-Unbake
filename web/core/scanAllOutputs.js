/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 出力の走査を**最後まで**回す（`I-20260830-14`）。
 *
 * ## なぜ切り出したか
 *
 * 周回は `unbake.js` の閉じた中に在り、**外から呼べないので検査できなかった**。
 * そして実際に、そこに欠陥が2つ埋まっていた。
 *
 * ## 欠陥1: 読めた件数でページを送っていた
 *
 * サーバは要求した幅（`limit`）ぶんのファイルを開くが、**読めなかった PNG は
 * 落として返す**（`outputs.py` の `_read_raw` が None を返すと `continue`）。
 * 呼び手が `offset += batch.length` と進めると、落ちた枚数だけ次ページが手前から
 * 始まり、**同じ絵をもう一度数える**。一覧に同じ画像が並び、枚数も水増しされる。
 *
 * 進めるのは**消費した幅**（サーバが返す `nextOffset`）である。
 *
 * ## 欠陥2: 0件を「終わり」と読んでいた
 *
 * `batch.length === 0` で打ち切っていたが、0件は「そのページが全滅」でもある。
 * 1ページ読めないだけで**残り全部を切り捨てて**いた。
 */

/** 1回に頼む件数。サーバ側の上限がここ（`outputs.py` の `MAX_LIMIT`）。 */
export const SCAN_PAGE_LIMIT = 500;

/** 念のための周回上限。**無限に回さない**（壊れたサーバでハーネスごと止めない）。 */
export const SCAN_MAX_PAGES = 60;

/**
 * 走査を最後まで回して、出力を全部集める。
 *
 * @param {(args: {offset: number, limit: number, keys?: string[]}) => Promise<object>} scan
 *   1ページ引く口（`comfyHost.js` の `scanOutputs`）。
 * @param {{keys?: string[], limit?: number, maxPages?: number}} [options]
 * @returns {Promise<{outputs: object[], pages: number, total: number, reachable: boolean,
 *   stoppedBy: 'end'|'unreachable'|'no-progress'|'max-pages'}>}
 */
export async function scanAllOutputs(scan, options = {}) {
    const limit = Number(options.limit) > 0 ? Number(options.limit) : SCAN_PAGE_LIMIT;
    const maxPages = Number(options.maxPages) > 0 ? Number(options.maxPages) : SCAN_MAX_PAGES;
    const keys = Array.isArray(options.keys) && options.keys.length ? options.keys : null;

    const outputs = [];
    let offset = 0;
    let total = 0;
    let pages = 0;
    let reachable = false;
    let stoppedBy = 'end';

    for (; pages < maxPages; pages += 1) {
        const result = await scan({ offset, limit, ...(keys ? { keys } : {}) });
        if (!result?.reachable) { stoppedBy = pages === 0 ? 'unreachable' : 'end'; break; }
        reachable = true;
        outputs.push(...(result.outputs || []));
        total = Number(result.total) || total;

        // **消費した幅で進める。** 読めた件数で進めると、落ちた枚数ぶん重なる。
        const next = Number.isFinite(Number(result.nextOffset))
            ? Number(result.nextOffset) : offset + (result.outputs || []).length;
        if (next <= offset) { stoppedBy = 'no-progress'; break; }
        offset = next;
        if (total > 0 && offset >= total) { stoppedBy = 'end'; break; }
    }
    if (pages >= maxPages) stoppedBy = 'max-pages';

    return { outputs, pages, total, reachable, stoppedBy };
}
