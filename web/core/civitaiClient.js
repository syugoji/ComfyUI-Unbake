/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * Civitai の公開 API から、画像1件ぶんの生成情報を取り直す。
 *
 * **上流の実装は開かずに書いた。** 材料にしたのは公開 API の応答そのもの
 * （実測 2026-08-20）と、URL の形。フォークの `civitai_client.py` は上流ファイルなので
 * 読んでいないし、写していない。
 *
 * ---
 *
 * **なぜ取り直しが要るのか。**
 *
 * 落とせる4経路のうち、Civitai だけは**バイト列が来ない**——ブラウザが渡すのは
 * URL だけである。ComfyUI の出力とローカルの PNG は実行したグラフをそのまま
 * 持っているので読むだけでよいが、こちらは ID から取り直すしかない。
 *
 * ---
 *
 * **引数を1つ落とすと、`200` で空が返る。**（実測で2回踏んだ）
 *
 *   `withMeta=true` … **無いと `meta` が全部 `null` で返る。** 実データの
 *                      画像ID 30件で測ると **0/29 → 29/29** と切り替わった。
 *                      エラーにならないので、**機能が無いと誤読する。**
 *   `nsfw=X`        … **無いと項目そのものが返らない**（`items: []`）。
 *                      成人向けの格付けが既定の閾値を超えると静かに消える。
 *
 * どちらも **`200 OK` のまま空になる**ので、**「空の成功応答は不在の証拠ではない」**。
 * ここでは両方を必ず付け、**空で返ったことを「見つからなかった」と混ぜない。**
 *
 * ---
 *
 * **`meta` は二重に入れ子になっている。**（実測）
 *
 *     item.meta = { id: <画像ID>, meta: { seed, comfy, steps, ... } }
 *
 * 素直に `item.meta.seed` と書くと **`undefined` が並ぶだけで例外は出ない**ので、
 * 「この画像には情報が無い」という誤った結論になる。内側を必ず解く。
 *
 * ---
 *
 * **ドメインは1つではない。** 手元の記録346件の出典は `civitai.red` **326件** /
 * `civitai.com` **14件**。`.com` だけを受ける実装は実データの94%を取りこぼす。
 */

import { environmentRequestOrNull } from './environment.js';
import { buildRecordFromTextChunks } from './generationRecord.js';
import { t } from '../i18n/index.js';

/** 応答が空になる引数の欠落を、コードの側で起こさないための固定値。 */
export const REQUIRED_QUERY = Object.freeze({
    // **生成情報を返させる。** 無いと `meta` が全部 null。
    withMeta: 'true',
    // **格付けで消させない。** 無いと項目そのものが返らない。
    nsfw: 'X',
});

/** 既定のドメイン。**実測で出た全部**（増えたらここへ足す）。 */
export const API_DOMAINS = Object.freeze(['civitai.com', 'civitai.red']);

/** 1件の画像を引く URL を組む。**引数の欠落をここで防ぐ。** */
export function imageQueryUrl(imageId, domain = API_DOMAINS[0]) {
    const host = API_DOMAINS.includes(domain) ? domain : API_DOMAINS[0];
    const query = new URLSearchParams({ imageId: String(imageId), ...REQUIRED_QUERY });
    return `https://${host}/api/v1/images?${query.toString()}`;
}

/**
 * 二重の入れ子を解く。**片方しか無い形でも読めるようにする**
 * （API の形が変わったときに、静かに空を返さないため）。
 */
export function unwrapMeta(item) {
    const outer = item?.meta;
    if (!outer || typeof outer !== 'object') return null;
    const inner = outer.meta;
    if (inner && typeof inner === 'object') return inner;
    // 内側が無ければ外側を使う（鍵が1つでも生成情報らしければ）。
    return Object.keys(outer).some(key => key !== 'id') ? outer : null;
}

/**
 * 画像1件を引く。
 *
 * @param {string|number} imageId
 * @param {object} [options]
 * @param {string} [options.domain] `civitai.com` / `civitai.red`
 * @param {string} [options.apiKey] 有れば `Authorization` に載せる（無くても引ける）
 * @param {(url: string, init?: object) => Promise<any>} [options.request]
 * @returns {Promise<{ok: boolean, item: object|null, meta: object|null, reason: string|null}>}
 *   **投げない。** 落とし込み1件の失敗で面が壊れてはいけないので、理由を返す。
 */
export async function fetchCivitaiImage(imageId, {
    domain = API_DOMAINS[0], apiKey = '', request = null,
} = {}) {
    const id = String(imageId ?? '').trim();
    if (!/^\d+$/.test(id)) return { ok: false, item: null, meta: null, reason: 'bad-image-id' };
    const doRequest = request || environmentRequestOrNull();
    if (!doRequest) return { ok: false, item: null, meta: null, reason: 'no-request' };

    const init = { headers: { Accept: 'application/json' } };
    // **鍵は無くても引ける。** 実測で30件中29件が鍵なしで取れた。
    if (apiKey) init.headers.Authorization = `Bearer ${apiKey}`;

    let response;
    try {
        response = await doRequest(imageQueryUrl(id, domain), init);
    } catch (error) {
        return { ok: false, item: null, meta: null, reason: `network:${error?.message || error}` };
    }
    if (!response?.ok) {
        return { ok: false, item: null, meta: null, reason: `http-${response?.status ?? 'error'}` };
    }

    let payload;
    try {
        payload = await response.json();
    } catch {
        return { ok: false, item: null, meta: null, reason: 'malformed' };
    }
    const item = (payload?.items || [])[0];
    if (!item) {
        // **空を「無い」と断定しない。** 引数の欠落でも同じ形になるので、
        // 呼び手が区別できるよう理由を分ける。
        return { ok: false, item: null, meta: null, reason: 'not-found-or-filtered' };
    }
    return { ok: true, item, meta: unwrapMeta(item), reason: null };
}

/**
 * 引いた結果を Generation Record へ変える。
 *
 * **記録の形は1つ。** 画像のバイト列から組むのと**同じ関数**へ渡す
 * ——分けると「画像から来た記録」と「API から来た記録」で形が割れ、
 * 画面がどちらから来たかで分岐を持つことになる。
 *
 * `meta.comfy` は実行された API グラフの**文字列**で、PNG の `prompt` チャンクと
 * 同じ中身（実測）。だから同じ入口へ流せる。
 */
export function recordFromCivitaiImage(item, meta, { url = null, domain = null } = {}) {
    const comfy = meta?.comfy;
    const chunks = {};
    if (typeof comfy === 'string' && comfy.trim()) {
        // `comfy` は `{"prompt": {...}, "workflow": {...}}` を含む文字列。
        let parsed = null;
        try { parsed = JSON.parse(comfy); } catch { parsed = null; }
        // **チャンクは平たいマップ**（`{鍵: 文字列}`）。`{key, value}` の形で渡すと
        // `no-metadata` になる——例外は出ないので「情報が無い」と誤読する。
        if (parsed?.prompt) chunks.prompt = JSON.stringify(parsed.prompt);
        if (parsed?.workflow) chunks.workflow = JSON.stringify(parsed.workflow);
        if (!parsed) {
            // グラフではない形で入っていることがある。**捨てずに渡す。**
            chunks.prompt = comfy;
        }
    }
    if (!chunks.prompt && !chunks.workflow) {
        return {
            ok: false, record: null,
            reason: t('reason.civitaiNoGraph', { id: String(item?.id ?? '') }),
        };
    }

    const built = buildRecordFromTextChunks(chunks, {
        kind: 'civitai',
        url: url || `https://${domain || API_DOMAINS[0]}/images/${item?.id}`,
        filename: null,
    });
    if (!built.ok) return { ok: false, record: null, reason: built.reason };

    return {
        ok: true,
        reason: null,
        record: {
            ...built.record,
            id: String(item?.id ?? built.record.id),
            title: `civitai_${item?.id ?? ''}`.trim(),
            // **格付けをそのまま持ち歩く。** 関門はこれを見る。
            nsfwLevel: nsfwLevelOf(item),
            // どの版から出た絵かは API が知っている。**推測しない。**
            modelVersionIds: Array.isArray(item?.modelVersionIds) ? item.modelVersionIds : [],
            baseModel: item?.baseModel || null,
            // **見本の在処。** グラフを持つ経路（実測 2/29）でも、保存したときに
            // 対の画像が要るのは同じ。捨てると一覧が絵で選べなくなる。
            previewUrl: typeof item?.url === 'string' ? item.url : null,
        },
    };
}

/** Civitai の格付けを、記録が持っている数値の尺度へ寄せる。 */
export function nsfwLevelOf(item) {
    // 文字の格付け（`None`/`Soft`/`Mature`/`X`）と数値が両方来る。
    const NAMED = { None: 1, Soft: 2, Mature: 4, X: 16 };
    const named = NAMED[String(item?.nsfwLevel ?? '')];
    if (named !== undefined) return named;
    const numeric = Number(item?.nsfwLevel);
    return Number.isFinite(numeric) ? numeric : null;
}

/**
 * モデルの版1件を引く。**ダウンロードにも記録の組み立てにも同じ口を使う。**
 *
 * 返るもの（実測 2026-08-20）: `files[]`（`name` / `sizeKB` / `type` / `primary` /
 * `downloadUrl` / `hashes.SHA256`）、`model.type`（`LORA` / `Checkpoint`）、`baseModel`。
 */
export async function fetchModelVersion(versionId, {
    domain = API_DOMAINS[0], apiKey = '', request = null,
} = {}) {
    const id = String(versionId ?? '').trim();
    if (!/^\d+$/.test(id)) return { ok: false, version: null, reason: 'bad-version-id' };
    const doRequest = request || environmentRequestOrNull();
    if (!doRequest) return { ok: false, version: null, reason: 'no-request' };
    const host = API_DOMAINS.includes(domain) ? domain : API_DOMAINS[0];
    const init = { headers: { Accept: 'application/json' } };
    if (apiKey) init.headers.Authorization = `Bearer ${apiKey}`;
    let response;
    try {
        response = await doRequest(`https://${host}/api/v1/model-versions/${id}`, init);
    } catch (error) {
        return { ok: false, version: null, reason: `network:${error?.message || error}` };
    }
    if (!response?.ok) return { ok: false, version: null, reason: `http-${response?.status ?? 'error'}` };
    try {
        return { ok: true, version: await response.json(), reason: null };
    } catch {
        return { ok: false, version: null, reason: 'malformed' };
    }
}

/**
 * 版の応答から、落とすべきファイル1つを選ぶ。
 *
 * **`primary` を優先する。** 版には `.safetensors` の他に学習用の設定や
 * 画像が付いていることがあり、最初の1つを取ると本体でない物を落とす。
 */
export function primaryFileOf(version) {
    const files = Array.isArray(version?.files) ? version.files : [];
    return files.find(file => file?.primary)
        || files.find(file => String(file?.type || '').toLowerCase() === 'model')
        || files[0]
        || null;
}

/** 版の種別を、モデルの置き場の名前へ寄せる。**判らないものは判らないままにする。** */
export function folderKindOf(version) {
    const type = String(version?.model?.type || '').toLowerCase();
    if (type === 'lora' || type === 'locon' || type === 'dora') return 'loras';
    if (type === 'checkpoint') return 'checkpoints';
    if (type === 'textualinversion') return 'embeddings';
    if (type === 'vae') return 'vae';
    if (type === 'controlnet') return 'controlnet';
    if (type === 'upscaler') return 'upscale_models';
    return null;
}

/**
 * Civitai の `meta` を、**このパッケージが既に読める記録の形**へ落とす。
 *
 * **新しい形を作らない。** 書庫の記録（`.recipe.json`）と同じ形にすれば、
 * 判定・Sweep・不足の集計が**そのまま通る**。別の形を作ると、
 * 「Civitai から来た記録」専用の分岐が全部の消費者に生える。
 *
 * **実測（画像30件・2026-08-20）で、`comfy`（ComfyUI のグラフ）を持つのは
 * 2件（6.9%）だけ**で、残りは A1111 形式の平たい値だった。だから
 * グラフがある前提で書くと**93%が組めない**——実際に最初の版が0件だった。
 *
 * @param {object} meta `unwrapMeta()` の結果
 * @param {Map<string|number, object>} [versions] 版ID → 版の応答（引けた分だけ）
 */
export function recipeFromCivitaiMeta(item, meta, versions = new Map()) {
    const resources = Array.isArray(meta?.civitaiResources) ? meta.civitaiResources : [];
    const named = Array.isArray(meta?.resources) ? meta.resources : [];

    const fileNameOf = (versionId) => {
        const file = primaryFileOf(versions.get(String(versionId)) || versions.get(Number(versionId)));
        return file?.name || null;
    };

    let checkpoint = null;
    const loras = [];
    const embeddings = [];
    for (const resource of resources) {
        const kind = String(resource?.type || '').toLowerCase();
        const entry = {
            modelVersionId: resource?.modelVersionId ?? null,
            modelVersionName: resource?.modelVersionName ?? null,
            file_name: fileNameOf(resource?.modelVersionId),
            strength: Number.isFinite(Number(resource?.weight)) ? Number(resource.weight) : 1,
        };
        if (kind === 'checkpoint') checkpoint = checkpoint || entry;
        else if (kind === 'lora' || kind === 'locon' || kind === 'dora') loras.push(entry);
        else if (kind === 'embed' || kind === 'textualinversion') embeddings.push(entry);
    }
    // 版IDが無い古い形（`resources: [{hash, name, type}]`）も拾う。
    for (const resource of named) {
        const kind = String(resource?.type || '').toLowerCase();
        const entry = { file_name: resource?.name || null, hash: resource?.hash || null, strength: 1 };
        if (kind === 'model' || kind === 'checkpoint') checkpoint = checkpoint || entry;
        else if (kind === 'lora') loras.push(entry);
    }
    if (!checkpoint && meta?.Model) checkpoint = { file_name: String(meta.Model), hash: meta['Model hash'] || null };

    const size = String(meta?.Size || '').trim();
    const [width, height] = size.includes('x')
        ? size.split('x').map(part => Number(part.trim()))
        : [Number(meta?.width), Number(meta?.height)];

    return {
        id: String(item?.id ?? ''),
        title: `civitai_${item?.id ?? ''}`.trim(),
        base_model: meta?.baseModel || item?.baseModel || null,
        checkpoint,
        loras,
        embeddings,
        gen_params: {
            prompt: String(meta?.prompt ?? ''),
            negative_prompt: String(meta?.negativePrompt ?? ''),
            seed: meta?.seed ?? null,
            steps: meta?.steps ?? null,
            cfg_scale: meta?.cfgScale ?? null,
            sampler: meta?.sampler ?? null,
            scheduler: meta?.scheduler ?? meta?.['Schedule type'] ?? null,
            clip_skip: meta?.clipSkip ?? null,
            size: Number.isFinite(width) && Number.isFinite(height) ? `${width}x${height}` : (size || null),
            denoising_strength: meta?.denoise ?? meta?.['Denoising strength'] ?? null,
        },
        // **どこから来たかを残す。** 画像のバイト列から読んだ記録とは根拠が違う。
        source_path: `https://${API_DOMAINS[0]}/images/${item?.id ?? ''}`,
        // **見本の在処を落とさない。** ここで捨てると、記録を保存したときに
        // 対の画像が作れず、一覧が絵で選べなくなる（実機で「画像が無い」と報告された）。
        // 実物は `image.civitai.com` に置かれていて、出典のページ URL とは別。
        preview_url: typeof item?.url === 'string' ? item.url : null,
        generation_source: 'civitai-api',
        preview_nsfw_level: nsfwLevelOf(item),
    };
}
