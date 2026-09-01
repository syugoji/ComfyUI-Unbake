/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * ComfyUI-Unbake の一部。**この行の意味**——著作権の所在を明示してある限り、
 * 後から別のライセンスを足せる。表示が無いまま配ると、それが言いづらくなる。
 */
import { environmentRequestOrNull } from './environment.js';
// ダウンロード前に、これから落とす総容量を見積もる。
//
// 数十GBになることがあるので、押す前に判るようにする。
// **判らない分を 0 として合計しない。** 過小な数字を出すと、
// 「1GBのつもりが20GBだった」という一番困る外し方をする。
// 判明分の合計と、判らなかった件数を別々に持つ。

const CACHE_TTL_MS = 10 * 60 * 1000;
const versionCache = new Map();

/** 素材が既に持っている情報からサイズ（バイト）を読む。無ければ null。 */
export function knownSizeOf(resource) {
    // 既知モデル台帳（アップスケーラ等）は台帳が実測値を持っている。
    //
    // **`Number(null)` を「判っているサイズ」にしない**（`I-20260831-62`）。
    // `recipeMissingResources.js` は `size_bytes || null` を作るので、台帳が
    // サイズを持たない資源は `null` で来る。`Number(null)` は 0 で
    // `Number.isFinite(0)` は true なので、素直に書くと **0 を「判っている」と
    // 返し、呼び手の `known !== null` で問い合わせが飛ぶ**。
    // このファイルの冒頭が言っている「判らない分を 0 として合計しない」は、
    // まずここで守る必要がある。
    const declared = resource?.sizeBytes;
    if (declared !== null && declared !== undefined && Number.isFinite(Number(declared))) {
        return Number(declared);
    }

    const files = resource?.civitai?.files;
    if (!Array.isArray(files) || files.length === 0) return null;

    // レシピが特定のファイルを指しているなら、そのファイルのサイズ。
    const wanted = resource?.fileParams;
    const match = files.find(file => {
        if (wanted?.fileId && String(file?.id) === String(wanted.fileId)) return true;
        if (wanted?.sha256 && String(file?.hashes?.SHA256 || '').toLowerCase()
            .startsWith(String(wanted.sha256).toLowerCase())) return true;
        return false;
    }) || files.find(file => file?.primary) || files[0];

    const sizeKB = Number(match?.sizeKB);
    return Number.isFinite(sizeKB) && sizeKB > 0 ? Math.round(sizeKB * 1024) : null;
}

/**
 * 版IDから素材の種類を表す語。**このパッケージの口が受ける綴り**に揃える
 * （`I-20260831-63`）。以前はフォークの経路（`/api/lm/{loras|checkpoints|
 * embeddings}/…`）の一部を組み立てていた。
 */
function kindOf(type) {
    if (type === 'checkpoint') return 'checkpoint';
    if (type === 'embedding') return 'embedding';
    return 'lora';
}

/**
 * Civitai のバージョン情報からサイズを引く（プロセス内で短期キャッシュ）。
 *
 * **口はこのパッケージのもの**（`I-20260831-63`）。以前はフォークの
 * `/api/lm/…` を叩いていたが、**このパッケージのサーバは `/unbake/` しか
 * 出していない**ので 404 になり、`!response.ok` で黙って `null` を返していた
 * ——**サイズが引ける相手でも必ず「判らない」になる**。
 * `modelCompanions.js` は 2026-08-26 に同じ理由で繋ぎ替えてあり、
 * ここと `recipeOutputs.js` だけ届いていなかった。
 */
async function fetchSizeFromCivitai(resource, fetchImpl) {
    const versionId = resource?.id || resource?.modelVersionId;
    if (!versionId) return null;

    const key = `${kindOf(resource?.type)}:${versionId}`;
    const cached = versionCache.get(key);
    // **結果ではなく Promise を持つ。** 同じ版が複数レシピで不足している
    // ことは普通にあり、結果だけ持つと並列実行では全部キャッシュ登録前に
    // 走って同じ問い合わせを何度も投げる。
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.promise;

    const promise = (async () => {
        try {
            const query = new URLSearchParams({
                id: String(versionId), kind: kindOf(resource?.type),
            });
            const response = await fetchImpl(`/unbake/civitai-version?${query.toString()}`);
            if (!response?.ok) return null;
            const data = await response.json();
            // **`ok:false` は 200 で返る**（取れなかった理由を載せるため）。
            // 素直に `data.bytes` を読むと、その形でも `undefined` を数として
            // 扱いかねないので、旗を先に見る。
            if (!data?.ok) return null;
            const bytes = Number(data.bytes);
            return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
        } catch {
            // サイズが判らないだけで、ダウンロード自体は止めない。
            return null;
        }
    })();
    versionCache.set(key, { promise, at: Date.now() });
    return promise;
}

export function resetDownloadSizeCache() {
    versionCache.clear();
}

/**
 * 総容量を見積もる。
 *
 * @returns {{ bytes: number, resolved: number, unknown: number }}
 *   bytes は**判明した分だけ**の合計。unknown は判らなかった件数。
 */
export async function estimateDownloadSize(resources, { fetchImpl = null, lookup = true } = {}) {
    const list = Array.isArray(resources) ? resources : [];
    // **環境は呼び手が据える。** 元は大域の HTTP 呼び出しへ落ちていたので、
    // フォークのページの上でしか動かせなかった（切り出しで最初に外した依存と同じ形）。
    const doFetch = fetchImpl || environmentRequestOrNull();

    const sizes = await Promise.all(list.map(async resource => {
        const known = knownSizeOf(resource);
        if (known !== null) return known;
        if (!lookup || !doFetch) return null;
        return fetchSizeFromCivitai(resource, doFetch);
    }));

    let bytes = 0;
    let resolved = 0;
    let unknown = 0;
    for (const size of sizes) {
        if (Number.isFinite(size) && size > 0) {
            bytes += size;
            resolved += 1;
        } else {
            unknown += 1;
        }
    }
    return { bytes, resolved, unknown };
}

/** 人が読める単位へ。GB到達で桁を落として読みやすくする。 */
export function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let index = 0;
    let scaled = value;
    while (scaled >= 1024 && index < units.length - 1) {
        scaled /= 1024;
        index += 1;
    }
    const digits = scaled >= 100 || index === 0 ? 0 : 1;
    return `${scaled.toFixed(digits)} ${units[index]}`;
}
