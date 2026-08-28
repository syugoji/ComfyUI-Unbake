/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * ComfyUI-Unbake の一部。**この行の意味**——著作権の所在を明示してある限り、
 * 後から別のライセンスを足せる。表示が無いまま配ると、それが言いづらくなる。
 */
/**
 * **出た絵の URL を作るのは、ここ1本だけ**（2026-08-29）。
 *
 * ## 直そうとしていたもの
 *
 * 利用者の報告（複数回）:
 * 「レコードの出た絵の削除を行った後再現すると比較画像が表示されたり、
 *  再度生成した後に表示が前の画像だったりします」。
 *
 * 成り立ちの条件は2つで、どちらも repo 内で実測済み:
 *
 *   1. ComfyUI の `/api/view` は `Cache-Control` を返さない（`ETag` と
 *      `Last-Modified` だけ）。ブラウザは推測でキャッシュを効かせるので、
 *      **同じ URL なら問い合わせずに前の中身を出す**。
 *      実測（同じ URL のままディスクの中身を差し替えた）:
 *          差し替え前  f596cb46:1327543
 *          既定で取得  f596cb46:1327543  ← **古いまま**
 *          強制再取得  e82d662e:1328607  ← 実体はこちら
 *   2. **ComfyUI は消して空いた番号を再利用する。** `_00006_` を消して
 *      作り直すと出来上がる絵も `_00006_` になり、**URL が完全に同じ**になる。
 *
 * ## なぜ何度直しても直らなかったか（この module が在る理由）
 *
 * URL を組み立てている所が **5箇所**あったのに、キャッシュ回避は
 * **表示側の1箇所**（`openCompare` の相手側）にしか入っていなかった:
 *
 *     web/core/recipeTrialRunner.js:144    ← 回避なし
 *     web/core/sweepRunner.js:93           ← 回避なし
 *     web/core/sweepRunner.js:293          ← 回避なし
 *     web/panel/variantsView.js:43         ← 回避なし（「出た絵」の一覧）
 *     web/unbake.js:1075                   ← 回避なし
 *     web/panel/panel.js:1771              ← ここだけ回避あり
 *
 * **口を1つずつ塞ぐ形だったので、塞いでいない口から同じ症状が出続けた。**
 * 「直したのに直っていない」の正体はこれで、直すべきは画面ではなく
 * **URL を作る側が1本しか無いこと**だった。
 *
 * ## 印に時刻（`Date.now()`）を使わない
 *
 * 毎回変わる印を全部の口へ入れると、**実測 4,275枚の一覧が毎回全部再取得**になる
 * ——今度は重くて使えない面ができる。印は**中身が変わったときだけ変わる**必要があり、
 * それ以外では変わってはいけない。
 *
 * サーバは各出力の `modified`（mtime）と `size` を既に返しているので、そこから作る
 * （`unbake/services/recipe_output_index.py` の `get_outputs`・
 *  `unbake/outputs.py` の `page`）。**両方を見る**——片方だけだと、
 * 同じ大きさで上書き／時刻を保った複製、のどちらかで素通りする。
 *
 * 鮮度が判らないとき（生成直後は履歴から名前しか来ない）だけは毎回変える。
 * **判らないときこそ古い絵が出る場面**なので、そこで諦めない。
 */

/** 鮮度が判らないときの、毎回変わる印。 */
let volatileCounter = 0;

/**
 * その絵の「中身が変わったら変わる」印。
 *
 * @param {{modified?: number|string, size?: number|string}} entry
 * @returns {string} 判れば安定した印、判らなければ毎回変わる印
 */
export function freshnessToken(entry) {
    const modified = Number(entry?.modified);
    const size = Number(entry?.size);
    const hasModified = Number.isFinite(modified) && modified > 0;
    const hasSize = Number.isFinite(size) && size > 0;
    if (hasModified || hasSize) {
        // ミリ秒まで見る（同じ秒に作り直されても分かれる）。**丸めない。**
        const stamp = hasModified ? Math.round(modified * 1000).toString(36) : '0';
        const bytes = hasSize ? Math.round(size).toString(36) : '0';
        return `${stamp}x${bytes}`;
    }
    volatileCounter += 1;
    return `n${Date.now().toString(36)}${volatileCounter.toString(36)}`;
}

/**
 * ComfyUI の `/api/view` で1枚を引く URL。**パスは組み立てない。**
 *
 * @param {{filename?: string, subfolder?: string, modified?: number, size?: number}} entry
 * @param {{type?: string, preview?: string}} [options]
 */
export function outputImageUrl(entry, options = {}) {
    const query = new URLSearchParams({
        filename: String(entry?.filename || ''),
        subfolder: String(entry?.subfolder || ''),
        type: String(options.type || 'output'),
    });
    let url = `/api/view?${query.toString()}`;
    // preview は値の中に `;` を含むので `URLSearchParams` へ入れずに直接繋ぐ
    // （エンコードされると ComfyUI 側が解釈しない）。
    if (options.preview) url += `&preview=${options.preview}`;
    return `${url}&_ub=${freshnessToken(entry)}`;
}

/**
 * **既にある URL へ印を足し直す**（素材の値が手元に無い呼び手のため）。
 *
 * 既に `_ub=` が付いていれば**付け替える**——重ねると、古い印が先に読まれて
 * 効かないことがある。
 */
export function withFreshness(url, entry = null) {
    const text = String(url || '');
    if (!text) return text;
    const [head, query = ''] = text.split('?');
    const params = new URLSearchParams(query);
    params.delete('_ub');
    // **`preview` は `URLSearchParams` に通さない。** 値に `;` を含むので、
    // 通すと `%3B` になって ComfyUI 側が解釈しない（`recipeOutputs.js` と同じ罠）。
    params.delete('preview');
    const rest = params.toString();
    const preserved = query
        .split('&')
        .filter(part => part.startsWith('preview='))
        .join('&');
    const token = freshnessToken(entry || {});
    const merged = [rest, preserved].filter(Boolean).join('&');
    return `${head}?${merged ? `${merged}&` : ''}_ub=${token}`;
}
