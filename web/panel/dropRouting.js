/**
 * ドロップされたものを3経路へ振り分ける。**分岐を1か所に閉じ込める。**
 *
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * | ドロップ元 | 来るもの | 何をするか |
 * |---|---|---|
 * | Civitai のページ／画像 | **URL のみ**（バイト列は来ない） | ID 抽出 → API 取得 → **再構成** |
 * | ローカルファイル | `dataTransfer.files`（**バイト列**） | PNG メタから読む |
 * | ComfyUI の Media Assets | **`/api/view` の URL** | 実体を取ってワークフローを**捕捉** |
 * | LoRA Manager のレシピ | `.recipe.json`（**バイト列**） | 中の `comfy_prompt` をそのまま使う |
 *
 * **3つ目は質的に別物である。** Civitai 経路が「再現」なのに対し、
 * ComfyUI 出力の経路は「捕捉」——ワークフローが既に埋まっているので再構成が要らない。
 *
 * **分岐はホスト名で書かない。** LAN 越しに ComfyUI を開くとホストが変わるので、
 * **`/api/view` かどうか**で見る。実測の payload:
 *
 *   `http://127.0.0.1:8188/api/view?filename=…&type=output&subfolder=`
 *
 * `subfolder` は**空のこともある**（実測）。
 */

import { extractCivitaiImageIdFromCandidates, extractCivitaiPostId } from './civitaiImageId.js';

/** 振り分けの結果。 */
export const DROP_ROUTES = {
    /** Civitai の画像 ID から作り直す。 */
    CIVITAI: 'civitai',
    /** ローカルの画像ファイルをそのまま読む。 */
    LOCAL_FILE: 'local_file',
    /** ComfyUI 自身の出力を取り戻す。 */
    COMFY_OUTPUT: 'comfy_output',
    /**
     * **LoRA Manager が書き出したレシピ。**
     *
     * 「レシピ」という語をこの1経路にだけ使う（2026-08-20 決定）。
     * 主語にしないのは、**残り3経路がレシピではない**から
     * ——Civitai の画像も、ローカルの PNG も、ComfyUI の出力もレシピではない。
     */
    RECIPE_FILE: 'recipe_file',
    /**
     * **形は判ったが、まだ取り込めないもの**（2026-08-24）。
     *
     * `null`（＝何も判らなかった）と分ける。判らないのと、判ったうえで扱えないのは
     * **打つ手が違う**——前者は URL の形を疑うしかないが、後者は理由を名指しできる。
     * どれなのかは `code` で返す。**文言を読んで当てさせない**（残件6と同じ作法）。
     */
    UNSUPPORTED: 'unsupported',
};

/**
 * 扱えなかったものの種類。**呼び手はこれで分岐する。**
 *
 * `civitai_post`: Civitai の**投稿** URL（`/posts/<数字>`）。投稿は絵を複数持つので、
 * URL だけからは1枚に決められない。**画像ページ（`/images/<数字>`）なら通る。**
 */
export const UNSUPPORTED_CODES = { CIVITAI_POST: 'civitai_post' };

/** `dataTransfer` から URL 候補の文字列を全部集める。 */
export function readUrlCandidates(dataTransfer) {
    const out = [];
    for (const type of ['text/uri-list', 'text/html', 'text/plain', 'URL', 'Text']) {
        let value = '';
        try {
            value = dataTransfer?.getData?.(type) || '';
        } catch {
            value = '';
        }
        if (value) out.push(value);
    }
    return out;
}

/** ComfyUI の `/api/view` を指しているか。**ホスト名では判定しない。** */
export function parseComfyViewUrl(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    let url;
    try {
        url = new URL(text, 'http://127.0.0.1');
    } catch {
        return null;
    }
    if (!/(^|\/)api\/view$/.test(url.pathname.replace(/\/+$/, ''))) return null;
    const filename = url.searchParams.get('filename') || '';
    if (!filename) return null;
    return {
        url: text,
        filename,
        // `type` の既定は `output`。**`subfolder` は空のことがある**ので既定を空文字にする
        // ——`null` にすると後段で "null" という部分パスを作る事故が起きる。
        type: url.searchParams.get('type') || 'output',
        subfolder: url.searchParams.get('subfolder') || '',
    };
}

/**
 * ドロップを振り分ける。**先に URL を見る。**
 *
 * Civitai のページから画像を引くと `files` は空で URL だけが来る。
 * 逆にローカルファイルのドロップでは `files` が埋まる。
 * `/api/view` の判定を先に置くのは、ComfyUI 出力が
 * **Civitai 由来のファイル名を持っていることがある**ため
 * （今出るのは `civitai_47986787_00045_.png`。手元には古い形の
 * `Recipe_Civitai_Recipe_47986787_00045_.png` も 2,387枚残っている）——
 * ここで名前を先に見ると、捕捉できるものをわざわざ再構成しにいってしまう。
 *
 * @param {DataTransfer} dataTransfer
 * @returns {{route: string, [key: string]: any} | null}
 */
export function routeDrop(dataTransfer) {
    const candidates = readUrlCandidates(dataTransfer);

    for (const candidate of candidates) {
        for (const text of [candidate, ...String(candidate).match(/https?:\/\/[^\s"'<>]+/g) || []]) {
            const view = parseComfyViewUrl(text);
            if (view) return { route: DROP_ROUTES.COMFY_OUTPUT, ...view };
        }
    }

    const civitai = extractCivitaiImageIdFromCandidates(candidates);
    if (civitai) {
        // **ドメインを落とさない。** 判定側は `.red` / `.com` を見分けて返しているのに
        // ここで捨てていた——手元の記録の出典は `.red` が326/340件なので、
        // 既定へ落とすと**94%が別のドメインへ問い合わせに行く**。
        return {
            route: DROP_ROUTES.CIVITAI,
            imageId: civitai.id,
            source: civitai.source,
            domain: civitai.domain || null,
            url: civitai.url || null,
        };
    }

    // **画像として読めなかったときだけ、投稿URLかどうかを見る**（2026-08-24）。
    // 順序が逆だと、投稿ページから絵をつまんだ場合（`text/html` に CDN URL が入っている）に
    // **取り込めるものを扱えない扱いにしてしまう**。落とす前に、まず拾えるだけ拾う。
    for (const candidate of candidates) {
        for (const text of [candidate, ...String(candidate).match(/https?:\/\/[^\s"'<>]+/g) || []]) {
            const post = extractCivitaiPostId(text);
            if (post) {
                return {
                    route: DROP_ROUTES.UNSUPPORTED,
                    code: UNSUPPORTED_CODES.CIVITAI_POST,
                    postId: post.postId,
                    domain: post.domain,
                    url: post.url,
                };
            }
        }
    }

    const files = [...(dataTransfer?.files || [])];

    // レシピを先に見る。**`.recipe.json` は画像判定に当たらない**ので順序に依存しないが、
    // 「json だから」で拾うと関係ないファイルまで飲み込むので、拡張子を明示する。
    const recipes = files.filter(file => /\.recipe\.json$/i.test(file?.name || ''));
    if (recipes.length > 0) return { route: DROP_ROUTES.RECIPE_FILE, files: recipes };

    const images = files.filter(file => /^image\//.test(file?.type || '')
        || /\.(png|jpe?g|webp)$/i.test(file?.name || ''));
    if (images.length > 0) return { route: DROP_ROUTES.LOCAL_FILE, files: images };

    return null;
}
