/**
 * Civitai の URL から画像 ID を取り出す。**上流の実装は開かずに書いた。**
 *
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 材料にしたのは URL の形だけで、これは公開事実である:
 *
 *   ページ  `https://civitai.com/images/47986787` （`?postId=…` などが付く）
 *   CDN    `https://image.civitai.com/{uuid}/{変換パラメータ}/{image_id}.{ext}`
 *
 * **ドメインは1つではない。** 手元の既存レシピ346件で実測したところ、
 * `civitai.red` **326件** / `civitai.com` **14件** / URL でない（ローカル画像）6件だった。
 * `.com` だけを受ける実装は、**実データの94%を静かに取りこぼす**。
 * 取得側（`sync_image_hybrid(domain, image_id, …)`）が元から `domain` を引数で
 * 受けているのも同じ理由で、**ドメインは可変であることが前提**になっている。
 * だから判定結果には解決したドメインを載せて返す。
 *
 * **フォークの `py/utils/civitai_utils.py` は上流と完全同一（381行）**なので、
 * 切り出しの前提（著作権の単独保有）を守るために、そこは読まずに組み直してある。
 *
 * **判定の根拠にファイル名を使わないこと。** `Civitai_Recipe_{id}_00045_.png` は
 * 自分の命名規約にすぎず、prefix を変えた瞬間に**例外もログも出さずに0件になる**。
 * 照合の確認には使ってよいが、判定には使わない（`extractIdFromFilename` は
 * その用途に限って別名で置いてある）。
 */

/** ページ URL の形。`/images/<数字>` だけを見る。 */
const PAGE_PATH = /^\/images\/(\d+)(?:\/|$)/;

/**
 * **投稿** URL の形。`/posts/<数字>`。
 *
 * ここは画像 ID ではない。**投稿は絵を複数持てる**ので、1つに決められない。
 * それでも見分けるのは、**見分けないと無言で落ちる**から——`/posts/30572284` は
 * `PAGE_PATH` に当たらず、最終セグメントに拡張子が無いので `CDN_LAST_SEGMENT` にも
 * 当たらず、結果は `null`。呼び手には「読めなかった」としか伝わらない（実測 2026-08-24）。
 *
 * **落ちること自体は正しい。** 直すのは、落ちた理由を種類で返せるようにすること。
 */
const POST_PATH = /^\/posts\/(\d+)(?:\/|$)/;

/** CDN の最終セグメント。`<数字>.<拡張子>` の形だけを受ける。 */
const CDN_LAST_SEGMENT = /^(\d+)\.[A-Za-z0-9]+$/;

/** 確認用。**判定には使わない。** */
const FILENAME_HINT = /(\d{5,})/;

function parseUrl(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    try {
        // 相対 URL も受ける（基点は使い捨て。host は下で必ず読み直す）。
        return new URL(text, 'https://civitai.com');
    } catch {
        return null;
    }
}

/**
 * 既定で受けるドメイン。**実測（既存レシピ346件）で出た全部**。
 * 新しいミラーが増えたらここへ足す——取りこぼしは例外もログも出さずに0件になる。
 */
export const CIVITAI_DOMAINS = Object.freeze(['civitai.com', 'civitai.red']);

/** Civitai のホストか。`image.civitai.com` などのサブドメインも含める。 */
export function isCivitaiHost(url, domains = CIVITAI_DOMAINS) {
    const host = String(url?.hostname || '').toLowerCase();
    return domains.some(domain => host === domain || host.endsWith(`.${domain}`));
}

/** ホストから、取得側へ渡すドメインを取り出す（`image.civitai.red` → `civitai.red`）。 */
export function resolveCivitaiDomain(url, domains = CIVITAI_DOMAINS) {
    const host = String(url?.hostname || '').toLowerCase();
    return domains.find(domain => host === domain || host.endsWith(`.${domain}`)) || null;
}

/**
 * URL から Civitai の画像 ID を1つ取る。
 *
 * @param {string} value ドロップされた URL
 * @returns {{ id: string, source: 'page' | 'cdn' } | null} 取れなければ null
 */
export function extractCivitaiImageId(value, { domains = CIVITAI_DOMAINS } = {}) {
    const url = parseUrl(value);
    if (!url || !/^https?:$/.test(url.protocol)) return null;
    if (!isCivitaiHost(url, domains)) return null;
    const domain = resolveCivitaiDomain(url, domains);

    const page = PAGE_PATH.exec(url.pathname);
    if (page) return { id: page[1], source: 'page', domain };

    const segments = url.pathname.split('/').filter(Boolean);
    const last = segments.at(-1) || '';
    const cdn = CDN_LAST_SEGMENT.exec(last);
    if (cdn) return { id: cdn[1], source: 'cdn', domain };

    return null;
}

/**
 * URL から Civitai の**投稿** ID を取る。**画像 ID ではない。**
 *
 * 使い道は1つだけ——**「読めなかった」ではなく「投稿URLだった」と言えるようにする**。
 * 投稿は絵を複数持つので、ここから画像を1枚に決めることはできない。
 * 決めるなら API（`?postId=` を受ける）へ問い合わせる別の仕事になる。
 *
 * @returns {{ postId: string, domain: string|null, url: string } | null}
 */
export function extractCivitaiPostId(value, { domains = CIVITAI_DOMAINS } = {}) {
    const url = parseUrl(value);
    if (!url || !/^https?:$/.test(url.protocol)) return null;
    if (!isCivitaiHost(url, domains)) return null;
    const post = POST_PATH.exec(url.pathname);
    if (!post) return null;
    return { postId: post[1], domain: resolveCivitaiDomain(url, domains), url: url.href };
}

/**
 * `dataTransfer` に複数の書式が来たとき、最初に ID が取れたものを採る。
 *
 * Civitai のページから画像を引くと `text/uri-list` と `text/html` の両方が来る。
 * 前者はページ URL、後者は `<img src=…>` を含む断片で CDN URL が入っている。
 */
export function extractCivitaiImageIdFromCandidates(candidates, options = {}) {
    for (const candidate of candidates || []) {
        const text = String(candidate || '');
        const direct = extractCivitaiImageId(text, options);
        if (direct) return direct;
        // HTML 断片は URL そのものではないので、含まれる URL を順に見る。
        for (const match of text.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
            const found = extractCivitaiImageId(match[0], options);
            if (found) return found;
        }
    }
    return null;
}

/**
 * ファイル名に見える ID。**確認用**——判定に使わないこと。
 * @returns {string | null}
 */
export function extractIdFromFilenameForConfirmationOnly(filename) {
    const match = FILENAME_HINT.exec(String(filename || ''));
    return match ? match[1] : null;
}
