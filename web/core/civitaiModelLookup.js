/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **ファイル名から Civitai の版を引く。当たらなければ何も返さない。**
 *
 * ## なぜ要るか
 *
 * Civitai の `meta` は形が3つあり、**ComfyUI で作られた絵は
 * `additionalResources` / `models` に「名前と強度」しか置かない**——
 * 版IDも hash も無い（実測 2026-08-25）。版IDが無いと:
 *
 *   `fetchModelVersion` を呼ぶ材料が無い → 可否を判定できない
 *   → 「落とせば試せる」に分類できない → **落とせば済むものが「再現不可」になる**
 *
 * 実際に利用者がそう報告した（`civitai_139981506`）。
 *
 * ## なぜ「あいまい検索」ではないのか
 *
 * 名前で当てにいくと聞くと、同名の別物を掴む話に聞こえる。ここでやるのは違う。
 *
 *   1. 検索は**候補を集めるためだけ**に使う（Civitai には名前で引く口しかない）
 *   2. 採否は**ファイル名の完全一致**で決める。部分一致も類似度も使わない
 *   3. **完全一致が2つ以上あったら、何も返さない**
 *
 * 3つ目が要になる。同名のファイルを持つ別のモデルは実在しうるので、
 * **「どちらか」を選ばない**。選べば、黙って違う絵を再現することになる
 * ——投稿URLを1枚目に決め打ちしなかったのと同じ理由である。
 *
 * ## 返す `sha256` が印を格上げする
 *
 * 版の応答にはファイルの SHA256 が付いてくる。手元のファイルと突き合わせれば、
 * 照合の根拠が `name`（同名の別物を掴みうる）から `hash`（バイト同一）へ上がる。
 * **ここでは突き合わせない**——手元のハッシュを知っているのはサーバ側なので、
 * この関数は材料を返すところまでを持つ。
 */

import { environmentRequestOrNull } from './environment.js';
import { API_DOMAINS } from './civitaiClient.js';

/** 検索の取り出し件数。**増やしても精度は上がらない**（採否は完全一致なので）。 */
const SEARCH_LIMIT = 20;

/** フォルダ区切りを落として、拡張子込みのファイル名だけにする。 */
export function baseName(value) {
    return String(value || '').replace(/\\/g, '/').split('/').pop().trim();
}

/**
 * 検索語を**短くしながら何通りか作る**。
 *
 * Civitai の検索はモデルの**名前**に当てるもので、ファイル名の語幹をそのまま
 * 渡すと当たらない。実測（2026-08-25）:
 *
 *   `hassakuXLIllustrious`（20字）→ **0件** / `hassaku` → 当たる（v1240288）
 *   `748cmSDXL`（9字）      → **0件** / `748cm`   → 当たる（v1056404）
 *
 * **長く連結した語ほど当たらない。** 規則性は「小文字→大文字の境目で切った
 * 先頭語」で説明できるので、そこまで段階的に短くする。
 *
 * **短くするのは検索語だけで、採否は変えない。** どの語で引いても、
 * 採るのは**ファイル名が完全一致した1件だけ**である。短い語ほど無関係な
 * モデルが混ざるが、混ざっても完全一致しなければ落ちる。
 *
 * @returns {string[]} 試す順（重複は除いてある）
 */
export function searchTermsFor(fileName) {
    const stem = baseName(fileName).replace(/\.[^.]+$/, '').trim();
    if (!stem) return [];
    const terms = [];
    const push = (value) => {
        const v = String(value || '').trim();
        if (v && v.length >= 3 && !terms.includes(v)) terms.push(v);
    };
    // 1. 語幹そのまま（区切りは空白へ）。上流由来の素直な名前はこれで当たる。
    push(stem.replace(/[_-]+/g, ' ').replace(/\s+/g, ' '));
    // 2. 最初の区切りまで。版の記号（`_v13StyleA`）を落とす。
    const head = stem.split(/[_-]/)[0];
    push(head);
    // 3. 小文字→大文字の境目で切った先頭語。`hassakuXL…` → `hassaku`。
    push(head.replace(/([a-z0-9])([A-Z].*)$/, '$1'));
    return terms;
}

/** 後方互換。**単数形は最初の1つ**を返す（古い呼び手のため）。 */
export function searchTermFor(fileName) {
    return searchTermsFor(fileName)[0] || '';
}

/**
 * 版1件ぶんの、ファイルの手がかり。
 * @typedef {{modelId: number, modelName: string, versionId: number,
 *            versionName: string, fileName: string, sha256: string|null,
 *            sizeKB: number|null, nsfw: boolean}} VersionMatch
 */

/** 応答から、ファイル名が完全一致する版を全部集める。**選ばない。集めるだけ。** */
export function collectExactMatches(payload, fileName) {
    const wanted = baseName(fileName).toLowerCase();
    if (!wanted) return [];
    const out = [];
    for (const model of (payload?.items || [])) {
        for (const version of (model?.modelVersions || [])) {
            for (const file of (version?.files || [])) {
                if (baseName(file?.name).toLowerCase() !== wanted) continue;
                out.push({
                    modelId: model?.id ?? null,
                    modelName: model?.name ?? '',
                    versionId: version?.id ?? null,
                    versionName: version?.name ?? '',
                    fileName: file?.name ?? '',
                    sha256: (file?.hashes?.SHA256 || '').toLowerCase() || null,
                    sizeKB: Number.isFinite(Number(file?.sizeKB)) ? Number(file.sizeKB) : null,
                    nsfw: model?.nsfw === true,
                });
            }
        }
    }
    return out;
}

/**
 * 集めた候補から**1つに決まるときだけ**返す。
 *
 * **同じ版が複数回出ても1つと数える**（検索が同じモデルを重複して返すことがある）。
 * 別の版が2つ以上あれば `null`——**選ばないことが仕様**である。
 *
 * @returns {{match: VersionMatch|null, reason: 'unique'|'none'|'ambiguous', candidates: number}}
 */
export function decideMatch(matches) {
    const byVersion = new Map();
    for (const m of matches) {
        if (m.versionId === null || m.versionId === undefined) continue;
        if (!byVersion.has(String(m.versionId))) byVersion.set(String(m.versionId), m);
    }
    if (byVersion.size === 0) return { match: null, reason: 'none', candidates: 0 };
    if (byVersion.size > 1) return { match: null, reason: 'ambiguous', candidates: byVersion.size };
    return { match: [...byVersion.values()][0], reason: 'unique', candidates: 1 };
}

/**
 * ファイル名から版を引く。**投げない。** 引けなければ理由を返す。
 *
 * @param {string} fileName 記録に書いてあるファイル名（フォルダ付きでもよい）
 * @returns {Promise<{match: VersionMatch|null, reason: string, candidates: number}>}
 */
export async function findVersionByFileName(fileName, {
    domain = API_DOMAINS[0], apiKey = '', request = null, limit = SEARCH_LIMIT,
} = {}) {
    const terms = searchTermsFor(fileName);
    if (terms.length === 0) return { match: null, reason: 'no-name', candidates: 0 };
    const doRequest = request || environmentRequestOrNull();
    if (!doRequest) return { match: null, reason: 'no-request', candidates: 0 };

    // **短くしながら順に試す。** 当たった時点で止めるので、素直な名前なら1回で済む。
    let last = { match: null, reason: 'none', candidates: 0 };
    for (const term of terms) {
        const attempt = await searchOnce(term, fileName, { domain, apiKey, doRequest, limit });
        // **曖昧は曖昧のまま返す。** 短い語で引き直して1件に減っても、
        // それは「絞れた」のではなく「別の母集団を見た」だけである。
        if (attempt.reason === 'ambiguous') return attempt;
        if (attempt.reason === 'unique') return attempt;
        last = attempt;
    }
    return last;
}

/** 検索語1つぶん。**採否は完全一致だけ**で決める。 */
async function searchOnce(term, fileName, { domain, apiKey, doRequest, limit }) {
    const host = API_DOMAINS.includes(domain) ? domain : API_DOMAINS[0];
    const query = new URLSearchParams({
        limit: String(limit),
        query: term,
        // **`nsfw=true` が無いと、成人向けのモデルは検索結果から静かに消える。**
        //
        // 実測（2026-08-25）: `query=hassaku` で `Hassaku XL (Illustrious)`（id 140272・
        // `nsfw: true`）が**1件も返らない**。付けると返り、ファイル名も完全一致する
        // （version 1240288）。**エラーにならず 200 のまま消える**ので、
        // 付け忘れると「Civitai に無い」と誤読する。
        //
        // **画像の口とは書き方が違う。** `/images` は `nsfw=X`（格付けの名前）、
        // `/models` は `nsfw=true`（真偽値）。`/models` へ `nsfw=X` を渡すと
        // **HTTP 400** で落ちる（実測）。`REQUIRED_QUERY` を流用しないこと。
        nsfw: 'true',
    });
    const init = { headers: { Accept: 'application/json' } };
    if (apiKey) init.headers.Authorization = `Bearer ${apiKey}`;

    let response;
    try {
        response = await doRequest(`https://${host}/api/v1/models?${query.toString()}`, init);
    } catch (error) {
        return { match: null, reason: `network:${error?.message || error}`, candidates: 0 };
    }
    if (!response?.ok) return { match: null, reason: `http-${response?.status ?? 'error'}`, candidates: 0 };

    let payload;
    try {
        payload = await response.json();
    } catch {
        return { match: null, reason: 'malformed', candidates: 0 };
    }
    return decideMatch(collectExactMatches(payload, fileName));
}
