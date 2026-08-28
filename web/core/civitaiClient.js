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
            // **プロンプトは meta を優先する。**（2026-08-25 利用者の報告で判明）
            //
            // グラフから要約すると、テキストのノードが複数あるときに**別のノードを掴む**。
            // 実測（`civitai_139981506`）では品質語だけの `4k，高清` を拾い、
            // ページの Generation data が出している長い本文と食い違っていた。
            //
            // **どちらが正しいかは決められる**——利用者が見比べる相手は Civitai の
            // ページであり、そこが出しているのは `meta.prompt` である。要約は
            // 当てにいく推測で、`meta` は投稿された値そのもの。**推測より値を採る。**
            //
            // **空なら上書きしない。** `meta` を持たない画像では要約が唯一の手がかりで、
            // 空で潰すと「プロンプトが無い」という別の嘘になる。
            ...(typeof meta?.prompt === 'string' && meta.prompt.trim()
                ? { positive: meta.prompt } : {}),
            ...(typeof meta?.negativePrompt === 'string' && meta.negativePrompt.trim()
                ? { negative: meta.negativePrompt } : {}),
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
/**
 * `meta.hashes` を読み解く。**Unbake はこの鍵を一度も見ていなかった。**
 *
 * 実測（2026-08-25・人気画像200枚）で、`meta` を持つ117枚のうち **23枚が `hashes` を持ち**、
 * **15枚は LoRA の項目を持つ**。形はこう:
 *
 *     "hashes": { "model": "EB4DD8C612",
 *                 "LORA:Krea2_TextFusion_Refusal_Reduction": "84EC722DDA" }
 *
 * ここから得られるものは2つある。
 *
 *   **① 名前。** `civitaiResources` は版IDしか持たないことがあり、そのとき
 *      LoRA の名前は **`hashes` にしか無い**（実測3枚）。読まないと名無しになる。
 *
 *   **② hash。** これが本命で、**照合の根拠が `name` から `hash` へ上がる**
 *      ——同名の別ファイルを掴む余地が消える。15枚ぶんが該当した。
 *
 * **接頭辞は `LORA:` だけではない。** `EMBED:` / `TI:` のような別種も来るので、
 * 種別が読めないものは**捨てずに未分類として残す**（捨てると「無かった」になる）。
 */
export function readHashes(meta) {
    const table = meta?.hashes;
    const out = { checkpoint: null, loras: [], embeddings: [] };
    if (!table || typeof table !== 'object') return out;
    for (const [rawKey, rawValue] of Object.entries(table)) {
        const value = String(rawValue || '').trim();
        if (!value) continue;
        const key = String(rawKey);
        if (key.toLowerCase() === 'model') { out.checkpoint = value; continue; }
        const at = key.indexOf(':');
        if (at < 0) continue;
        const kind = key.slice(0, at).toLowerCase();
        const name = key.slice(at + 1).trim();
        if (!name) continue;
        if (kind === 'lora' || kind === 'locon' || kind === 'lycoris') {
            out.loras.push({ name, hash: value });
        } else if (kind === 'embed' || kind === 'embedding' || kind === 'ti') {
            out.embeddings.push({ name, hash: value });
        }
    }
    return out;
}

/** 名前の同一性は**ファイル名だけ**で見る（フォルダと拡張子の違いを無視する）。 */
function sameName(a, b) {
    const norm = (v) => String(v || '').replace(/\\/g, '/').split('/').pop()
        .replace(/\.[^.]+$/, '').toLowerCase();
    const left = norm(a);
    return left !== '' && left === norm(b);
}

/**
 * 資源の種類を1つに寄せる。**実測に基づく**（2026-08-26 / 316件の走査）。
 *
 * 出てくる値は揃っていない:
 *
 *   - `lora` 305 / `checkpoint` 130 / `embed` 65 / **型が無い** 57 /
 *     `upscaler` 15 / `vae` 6 / `embedding` 3 / `lycoris` 2
 *   - `diffusionmodel`（実例 `civitai_139164303`）——`checkpoint` しか見て
 *     いなかったので、**チェックポイントごと落としていた**
 *   - `imagejobnetworkparams { strength = 1, triggerword = , type = lora }`
 *     という**構造体の文字列がそのまま入る**壊れた値が 13件。
 *     中に本当の型（`type = lora`）が書いてある
 *
 * **判らないときは null を返す。** 呼び手が版を引いて、Civitai 自身が言う
 * 型（`model.type`）で決め直す——推測で振り分けると、別の欄へ入った素材が
 * 「無い」ことになる。
 */
/**
 * 記録されている数値だけを返す。**未記録は `null`**（`D-20260828-01` 群A）。
 *
 * `recipeWorkflowBuilder.js` の `firstRecordedNumber()` と同じ役目。
 * あちらを import すると**中核の重い側を丸ごと引き込む**ので、
 * 3行の判定はここに置く（規則そのものは短く、写しても食い違いようがない）。
 */
function recordedNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

export function resourceKind(rawType) {
    let text = String(rawType ?? '').trim().toLowerCase();
    if (!text || text === 'null' || text === 'undefined' || text === 'none') return null;
    // 壊れた値の中から本当の型を取り出す。
    const inner = /(?:^|[^a-z])type\s*=\s*([a-z]+)/.exec(text);
    if (inner) text = inner[1];
    if (['checkpoint', 'model', 'diffusionmodel', 'diffusion_model'].includes(text)) return 'checkpoint';
    if (['lora', 'locon', 'dora', 'lycoris'].includes(text)) return 'lora';
    if (['embed', 'embedding', 'textualinversion'].includes(text)) return 'embedding';
    if (['vae'].includes(text)) return 'vae';
    if (['upscaler'].includes(text)) return 'upscaler';
    return null;
}

/** Civitai がその版について言う型（`model.type`）から寄せる。 */
export function kindFromVersion(version) {
    return resourceKind((version?.model || {}).type);
}

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
        const kind = resourceKind(resource?.type);
        const entry = {
            modelVersionId: resource?.modelVersionId ?? null,
            modelVersionName: resource?.modelVersionName ?? null,
            file_name: fileNameOf(resource?.modelVersionId),
            // **未記録は 1**（`D-20260828-01` 群A の同型）。`Number(null)` は 0 で
            // `Number.isFinite(0)` は true なので、素直に書くと**強度 0 で積む**
            // ——`normalizeResources` は重みが数値でなければ**明示的に `null`**
            // を書くので、これは実際に通る道である。
            strength: recordedNumber(resource?.weight) ?? 1,
            // 版IDは**その版そのもの**を指すので、名前照合より強い根拠になる。
            evidence: 'versionId',
        };
        // **型が無い／判らないときは、版に聞く。** 実測で 57件が型を持たず、
        // そのまま落としていた——`civitai_139164303` は
        // `type: "diffusionmodel"` でチェックポイントごと消えていた。
        const settled = kind
            || kindFromVersion(versions.get(String(resource?.modelVersionId))
                ?? versions.get(Number(resource?.modelVersionId)));
        if (settled === 'checkpoint') checkpoint = checkpoint || entry;
        else if (settled === 'lora') loras.push(entry);
        else if (settled === 'embedding') embeddings.push(entry);
    }
    // 版IDが無い古い形（`resources: [{hash, name, type}]`）も拾う。
    for (const resource of named) {
        const kind = resourceKind(resource?.type);
        const entry = {
            file_name: resource?.name || null,
            hash: resource?.hash || null,
            strength: 1,
            // hash が在ればバイト同一性の根拠。無ければ名前しか手がかりが無い。
            evidence: resource?.hash ? 'hash' : 'name',
        };
        if (kind === 'checkpoint') checkpoint = checkpoint || entry;
        else if (kind === 'lora') loras.push(entry);
        else if (kind === 'embedding') embeddings.push(entry);
    }
    // **ComfyUI で作られた絵は、モデルを別の鍵に置く。**
    //
    // Civitai の `meta` には形が3つあり、読む鍵を間違えると**値が在るのに空になる**。
    // 実測（2026-08-25・人気画像400枚）:
    //
    //   `comfy` あり ................ 56枚（14.0%）← 捕捉経路で成功する
    //   `civitaiResources` あり ..... 94枚（23.5%）← 版IDが付く。従来ここだけ読んでいた
    //   **どちらも無い** ............ 77枚（19.2%）← ここが丸ごと落ちていた
    //     うちモデル情報が在る ...... 26枚（ 6.5%）
    //   `meta` 自体が無い ........... 173枚（43.2%）← 投稿者が消している。これは直せない
    //
    // 落ちていた側は `models` / `vaes` / `additionalResources` を持つ。
    // **どれも版IDを持たず、名前と強度だけ**なので、拾っても Civitai からは落とせない
    // ——それでも拾う理由は、**手元に在るものは名前で照合できる**からで、
    // 拾わないと「モデルが1つも判らない」＝再現不可として畳まれてしまう。
    //
    // **名前しか無いことは、後で読む側に伝える**（`evidence: 'name'`）。
    // 同名の別ファイルを掴む余地があるので、黙って同じ扱いにしない。
    for (const resource of (Array.isArray(meta?.additionalResources) ? meta.additionalResources : [])) {
        const kind = String(resource?.type || '').toLowerCase();
        const name = resource?.name || resource?.modelName || null;
        if (!name) continue;
        const strength = recordedNumber(resource?.strength) ?? 1;
        const entry = { file_name: String(name), strength, evidence: 'name' };
        if (kind === 'lora' || kind === 'locon' || kind === 'lycoris' || kind === 'dora') {
            if (!loras.some(item => item?.file_name === entry.file_name)) loras.push(entry);
        } else if (kind === 'model' || kind === 'checkpoint') {
            checkpoint = checkpoint || entry;
        } else if (kind === 'embed' || kind === 'embedding' || kind === 'textualinversion') {
            embeddings.push(entry);
        }
    }
    // `models` は checkpoint の名前だけの配列（ComfyUI 形）。`vaes` も同じ形。
    if (!checkpoint) {
        const first = (Array.isArray(meta?.models) ? meta.models : []).find(Boolean);
        if (first) checkpoint = { file_name: String(first), evidence: 'name' };
    }

    if (!checkpoint && meta?.Model) {
        checkpoint = {
            file_name: String(meta.Model),
            hash: meta['Model hash'] || null,
            // hash が在れば同一性の根拠になる。無ければ名前だけ。
            evidence: meta['Model hash'] ? 'hash' : 'name',
        };
    }

    // **`hashes` を最後に混ぜる。** 先に集めた資源へ hash を足し、
    // 名前しか無かったものは名前ごと補う。**上書きはしない**——
    // 既に版IDで引き当てているものの根拠を、弱い側で塗り替えないため。
    const hashed = readHashes(meta);
    if (hashed.checkpoint && checkpoint && !checkpoint.hash) {
        checkpoint = { ...checkpoint, hash: hashed.checkpoint, evidence: 'hash' };
    }
    for (const entry of hashed.loras) {
        const found = loras.find(item => sameName(item?.file_name, entry.name));
        if (found) {
            if (!found.hash) { found.hash = entry.hash; found.evidence = 'hash'; }
            continue;
        }
        // **名前が `hashes` にしか無い場合。** 版IDだけの項目に名前を与える。
        const nameless = loras.find(item => !item?.file_name);
        if (nameless) {
            nameless.file_name = entry.name;
            nameless.hash = entry.hash;
            nameless.evidence = 'hash';
        } else {
            loras.push({ file_name: entry.name, hash: entry.hash, strength: 1, evidence: 'hash' });
        }
    }
    for (const entry of hashed.embeddings) {
        if (embeddings.some(item => sameName(item?.file_name, entry.name))) continue;
        embeddings.push({ file_name: entry.name, hash: entry.hash, evidence: 'hash' });
    }

    const size = String(meta?.Size || '').trim();
    const [width, height] = size.includes('x')
        ? size.split('x').map(part => Number(part.trim()))
        : [Number(meta?.width), Number(meta?.height)];

    return {
        id: String(item?.id ?? ''),
        title: `civitai_${item?.id ?? ''}`.trim(),
        // 土台のモデル。**推測しない**——API が言っているときだけ持つ。
        // 同じリテラルの下の方にもう1つ同じ鍵が在り（後ろが勝っていた）、
        // 2026-08-26 に片方を消した。挙動は変わらないが、**2つ在ると
        // 片方を直したつもりで直っていない**という壊れ方をする。
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
            // **画面は既に出す用意ができていた。** `recipeReferenceInfo.js` に
            // `vae` / `hires_*` の表示ラベルが在るのに、ここが値を入れていなかった
            // ——**表示側だけ移して抽出側を移していない**状態だった。
            model: meta?.Model ?? null,
            vae: meta?.VAE ?? meta?.vae ?? null,
            hires_upscale: meta?.['Hires upscale'] ?? null,
            hires_resize: meta?.['Hires resize'] ?? null,
            hires_steps: meta?.['Hires steps'] ?? null,
            hires_upscaler: meta?.['Hires upscaler'] ?? null,
            hires_cfg_scale: meta?.['Hires CFG Scale'] ?? null,
            // **Flux の誘導値**（実測 2026-08-26・316件中25件＝7.9%）。
            // 絵が変わる値なのに落としていた。
            distilled_cfg_scale: meta?.['Distilled CFG Scale'] ?? null,
            // **Forge は VAE をモジュールの枠に入れる**（実測: `Module 1` が
            // `"ae"`・22件＝7.0%）。`VAE` が無いときだけ使う。
            // `Hires Module 1` は使わない——実測の値が `"Use same choices"` で、
            // **ファイル名ではなく「同じものを使え」という指示**だった。
            ...(meta?.VAE || meta?.vae ? {} : (meta?.['Module 1']
                ? { vae: meta['Module 1'] } : {})),
            // **顔の描き直し**（ADetailer・実測 26件＝8.2%）。
            //
            // これが在る絵は、**本体の生成のあとにもう1回**顔だけ描き直して
            // いる。こちらが組むグラフはその工程を持たないので、値を採っても
            // そのままでは再現できない——**だからこそ落とさない**。
            // 落とすと「同じ材料なのに絵が違う」の理由が記録から消える。
            ...(meta?.['ADetailer model'] ? {
                adetailer_model: meta['ADetailer model'],
                adetailer_confidence: meta['ADetailer confidence'] ?? null,
                adetailer_denoising_strength: meta['ADetailer denoising strength'] ?? null,
            } : {}),
        },
        // **拡大器**（実測 19件＝6.0%・`["DAT_x4.pth"]`）。
        //
        // 使う側（`recipeWorkflowBuilder` の `generation_metadata.upscalers`）は
        // 元から在ったのに、**取り込みが値を入れていなかった**——この面の
        // すぐ上のコメントが名指ししている「表示側だけ移して抽出側を移して
        // いない」と同じ形が、もう1つ残っていた。
        ...(Array.isArray(meta?.upscalers) && meta.upscalers.length
            ? { generation_metadata: { upscalers: meta.upscalers } } : {}),
        // 土台のモデル。**推測しない**——API が言っているときだけ持つ。
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
