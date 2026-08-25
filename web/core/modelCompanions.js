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

const STATUS_ENDPOINT = '/api/lm/model-companions';
const DOWNLOAD_ENDPOINT = '/api/lm/download-model-companions';

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
        const response = await request(`${STATUS_ENDPOINT}?base_model=${encodeURIComponent(key)}`);
        if (response?.ok) {
            const data = await response.json();
            if (data?.success && Array.isArray(data.companions)) {
                status = {
                    companions: data.companions,
                    missingCount: Number(data.missing_count) || 0,
                    missingBytes: Number(data.missing_bytes) || 0,
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
            body: JSON.stringify({ base_model: baseModel.trim() }),
        });
        if (!response?.ok) return null;
        const data = await response.json();
        if (!data?.success || !Array.isArray(data.companions)) return null;
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

/**
 * Add "+N files (X GB)" badges to already-rendered version rows.
 *
 * The rows are built synchronously from the Civitai payload, so the badge is
 * attached afterwards rather than blocking the list on a round trip.
 *
 * @param {HTMLElement} container element holding the rows
 * @param {Array<{id: any, baseModel?: string}>} versions
 */
export async function annotateVersionCompanions(container, versions, options = {}) {
    if (!container || !Array.isArray(versions)) return;
    const {
        translate: translateFn = (key, params, fallback) => fallback ?? key,
        fetchImpl = null,
        // The batch preview lists the same models under a different markup.
        rowSelector = version => `.version-item[data-version-id="${version.id}"] .version-meta`,
    } = options;

    const baseModels = [...new Set(
        versions.map(version => version?.baseModel).filter(value => typeof value === 'string' && value.trim())
    )];
    if (!baseModels.length) return;

    const statuses = new Map();
    await Promise.all(baseModels.map(async baseModel => {
        statuses.set(baseModel, await fetchCompanionStatus(baseModel, { fetchImpl }));
    }));

    versions.forEach((version, index) => {
        const status = statuses.get(version?.baseModel);
        if (!status || status.missingCount <= 0) return;

        const row = container.querySelector(rowSelector(version, index));
        if (!row || row.querySelector('.companion-badge')) return;

        const label = translateFn(
            'modals.download.companionsNeeded',
            { count: status.missingCount, size: formatBytes(status.missingBytes) },
            `+${status.missingCount} required files (${formatBytes(status.missingBytes)})`
        );
        const badge = document.createElement('span');
        badge.className = 'companion-badge';
        badge.title = status.companions
            .filter(item => !item.installed)
            .map(item => item.filename)
            .join('\n');
        badge.innerHTML = '<i class="fas fa-puzzle-piece"></i> ';
        badge.appendChild(document.createTextNode(label));
        row.appendChild(badge);
    });
}
