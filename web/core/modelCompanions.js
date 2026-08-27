/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * ComfyUI-Unbake の一部。**この行の意味**——著作権の所在を明示してある限り、
 * 後から別のライセンスを足せる。表示が無いまま配ると、それが言いづらくなる。
 */
import { environmentRequestOrNull } from './environment.js';
/**
 * Companion files for UNet-only model families.
 *
 * Civitai publishes only the diffusion model for Flux / Qwen-Image / HiDream /
 * Chroma / Z-Image / Krea 2 / Anima. Downloading the checkpoint alone leaves the
 * user unable to run anything, and the gap only shows up after the download has
 * already finished. These helpers surface the cost before the user commits and
 * close it right after the main file lands.
 */

/*
 * **口はこちらのもの**（2026-08-26 の到達性の棚卸しで直した）。
 *
 * ここは元々 `/api/lm/…` を叩いていた——**フォーク（LoRA Manager）のサーバの
 * 口**である。持ってきたまま繋ぎ替えていなかったので、この面は
 * 「LoRA Manager も入っている環境でだけ動くかもしれないもの」だった。
 * Unbake は単体で入る拡張なので、これは動かないのと同じ。
 */
const STATUS_ENDPOINT = '/unbake/model-companions';
const DOWNLOAD_ENDPOINT = '/unbake/download-model-companions';

// The same base model appears on every version of a model page, so the modal
// would otherwise ask the backend once per row.
const statusCache = new Map();

export function resetCompanionCache() {
    statusCache.clear();
}

/**
 * Ask which companion files a base model still needs. Never throws: the download
 * modal must keep working when the endpoint is unavailable.
 *
 * @returns {Promise<{companions: Array, missingCount: number, missingBytes: number}|null>}
 */
export async function fetchCompanionStatus(baseModel, { fetchImpl = null } = {}) {
    const request = fetchImpl || environmentRequestOrNull();
    if (typeof baseModel !== 'string' || !baseModel.trim()) return null;
    const key = baseModel.trim();
    if (statusCache.has(key)) return statusCache.get(key);

    let status = null;
    try {
        const response = await request(`${STATUS_ENDPOINT}?baseModel=${encodeURIComponent(key)}`);
        if (response?.ok) {
            const data = await response.json();
            if (data?.ok && Array.isArray(data.companions)) {
                status = {
                    companions: data.companions,
                    missingCount: Number(data.missingCount) || 0,
                    missingBytes: Number(data.missingBytes) || 0,
                    // **大きさの判らないものを数え落とさない。** 落とすと
                    // 「0 MB」と出て、実際には何GBも引くことになる。
                    missingUnknown: Number(data.missingUnknown) || 0,
                };
            }
        }
    } catch (error) {
        status = null;
    }

    statusCache.set(key, status);
    return status;
}

/** Fetch every missing companion of a base model. */
export async function downloadCompanions(baseModel, { fetchImpl = null } = {}) {
    const request = fetchImpl || environmentRequestOrNull();
    if (typeof baseModel !== 'string' || !baseModel.trim()) return null;
    try {
        const response = await request(DOWNLOAD_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ baseModel: baseModel.trim() }),
        });
        if (!response?.ok) return null;
        const data = await response.json();
        if (!Array.isArray(data?.companions)) return null;
        // The cache would otherwise keep reporting the files as missing.
        statusCache.delete(baseModel.trim());
        return data.companions;
    } catch (error) {
        return null;
    }
}

export function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '0 MB';
    const gib = value / 1024 ** 3;
    if (gib >= 1) return `${gib.toFixed(1)} GB`;
    return `${Math.round(value / 1024 ** 2)} MB`;
}

/*
 * ここには `annotateVersionCompanions()` が在った（2026-08-26 に外した）。
 *
 * フォークの画面の作り（`.version-item[data-version-id]` / `.version-meta` /
 * FontAwesome の `fa-puzzle-piece` / グローバルの `document`）を前提に書かれて
 * いて、**Unbake の画面にはその要素が1つも無い**。呼び手も無かった。
 *
 * **動かないものを「在る」ままにしない。** 残っていると、次に読む人は
 * 「伴走の表示はもう在る」と読む——実際にはどの面にも出ない。
 * 出す所は、落とす前の見積り（`downloadMissing`）に持たせた。
 */
