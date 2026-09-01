/**
 * ComfyUI をホストとして core/ へ差し込む層。**大域の HTTP はここにしか無い。**
 *
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 切り出す前、`/object_info` と `/api/embeddings` の取得は
 * `recipeReplayCapability.js` の中にあり、**プロセス内キャッシュまでそこが持っていた**。
 * その2本があるせいで、判定の中核がブラウザとフォークのページに縛られていた。
 *
 * ここが唯一「外へ出る」場所で、core/ には大域の HTTP 識別子が1つも無いことを
 * `tests/source_integrity_test.mjs` が固定する。**境界は文章ではなく検査で保つ。**
 */

import { installEnvironment } from '../core/environment.js';
import { t } from '../i18n/index.js';

/** `/object_info` と埋め込み一覧のキャッシュ。**core からは見えない。** */
let objectInfoPromise = null;
let embeddingsPromise = null;
let request = null;

/**
 * ホストを据える。
 *
 * @param {object} [options]
 * @param {(input: string, init?: object) => Promise<any>} [options.request]
 *   HTTP の実体。既定はブラウザの大域実装。**テストはここへダブルを入れる。**
 * @param {string} [options.baseUrl] ComfyUI の基点（LAN 越しに開いた場合など）
 * @param {object|null} [options.storage] 手元に残す値の入れ物。既定はブラウザの
 *   `localStorage`。**無い環境（プライベート窓・埋め込み）では null を渡す**——
 *   core は揮発の入れ物へ倒すので、例外にはならない。
 */
export function installComfyHost({
    request: injected = null,
    baseUrl = '',
    storage = undefined,
} = {}) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    // **大域の呼び出しはこの1行だけ。** `web/core/` 側に同じ識別子が0件であることと
    // 対にして、`tests/source_integrity_test.mjs` が両側から境界を固定する
    // （片側だけ見ると「注入した」と「経路ごと消した」が見分けられない）。
    const raw = injected || ((input, init) => fetch(input, init));
    request = (input, init) => raw(base && String(input).startsWith('/') ? base + input : input, init);
    objectInfoPromise = null;
    embeddingsPromise = null;
    // **大域の入れ物へ触るのもここだけ。** `web/core/` 側に `localStorage` の
    // 識別子が0件であることと対にして、`tests/source_integrity_test.mjs` が
    // 両側から境界を固定する（HTTP と同じ形）。
    const resolvedStorage = storage === undefined
        ? readGlobalStorage()
        : storage;
    installEnvironment({ request, storage: resolvedStorage });
    return { request, storage: resolvedStorage };
}

/**
 * 大域の入れ物を**読めたら**返す。読めなければ `null`（揮発へ倒す）。
 *
 * **`?? null` では受けられない**（2026-08-31・監査 I-20260831-10）。
 * `localStorage` は「無い」だけでなく **`localStorage` と書いた瞬間に投げる**
 * ことがある——Chrome の「すべての Cookie とサイトデータをブロック」、
 * `allow-same-origin` の無い `iframe`。投げるのは getter そのものなので、
 * 合体演算子は例外を受け止めない。
 *
 * **落ちる先が悪い。** ここは `registerUnbake(app)` の中で、その
 * `registerUnbake` は `web/unbake.js` の最上位で try 無しに呼ばれる。
 * つまりモジュール評価ごと失敗して `registerExtension` に一度も到達せず、
 * **タブもコマンドも出ない**——同ファイルが「静かに何も出ないのが最悪の
 * 落ち方」と書いている、まさにその形になっていた。
 *
 * `web/core/storage.js` も `environment.js` も入れ物が無いときは揮発へ
 * 倒すように作ってあるので、**ここを通しさえすれば後ろは既に守られている。**
 */
function readGlobalStorage() {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        // **黙らない。** 保存が効かないことは利用者に見える差になる。
        console.info(t('host.storageDenied'));
        return null;
    }
}

function ensureInstalled() {
    if (!request) throw new Error('Unbake: call installComfyHost() first');
    return request;
}

/**
 * 導入済みノード・モデルの一覧。**判定の材料そのもの。**
 *
 * 取れなければ投げる。空で返すと「全モデルが未導入」に見えて
 * 「再現不能」という誤った答えが静かに出る。
 */
export function getObjectInfo({ force = false } = {}) {
    const doRequest = ensureInstalled();
    if (force || !objectInfoPromise) {
        objectInfoPromise = doRequest('/object_info')
            .then(response => {
                if (!response?.ok) throw new Error(`object_info request failed (${response?.status})`);
                return response.json();
            })
            .catch(error => {
                objectInfoPromise = null;
                throw error;
            });
    }
    return objectInfoPromise;
}

/**
 * 導入済みの埋め込み一覧。
 *
 * A1111 は裸の名前を埋め込みとして解決するが ComfyUI はしないので、
 * どの名前が実在するかを知らないと `embedding:` を付けてよいか判らない。
 * **取れない環境では空で返す**——判定を壊すより、補いをしないほうが安全。
 */
export function getEmbeddings({ force = false } = {}) {
    const doRequest = ensureInstalled();
    if (force || !embeddingsPromise) {
        embeddingsPromise = doRequest('/api/embeddings')
            .then(response => (response?.ok ? response.json() : []))
            .then(list => (Array.isArray(list) ? list : []))
            .catch(() => []);
    }
    return embeddingsPromise;
}

/**
 * 導入済み一覧のキャッシュを捨てる。
 * **ダウンロード直後に呼ぶこと**——呼ばないと古い応答を見続けて、
 * 入れたばかりのモデルが「未導入」のまま残る。
 */
export function resetHostCaches() {
    objectInfoPromise = null;
    embeddingsPromise = null;
}

/** core へ渡す判定材料を1回で揃える。 */
export async function collectAnalysisInputs({ force = false } = {}) {
    const [objectInfo, embeddings] = await Promise.all([
        getObjectInfo({ force }),
        getEmbeddings({ force }),
    ]);
    return { objectInfo, embeddings };
}

/**
 * 書庫の記録を数える。**要約だけ**（本体は id を引いたときに取る）。
 *
 * 口が無い＝Python 側が登録できていない、を**「記録が0件」と混ぜない。**
 * 混ぜると「設定したのに出ない」の原因が永久に判らなくなるので、
 * 届かなかったことは `reachable: false` として返す。
 */
export async function listLibraryRecords({ offset = 0, limit = 500, rescan = false } = {}) {
    const doRequest = ensureInstalled();
    const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    if (rescan) query.set('rescan', '1');
    let response;
    try {
        response = await doRequest(`/unbake/records?${query.toString()}`);
    } catch (error) {
        return { reachable: false, records: [], total: 0, errors: [String(error?.message || error)] };
    }
    if (!response?.ok) {
        return { reachable: false, records: [], total: 0, errors: [`/unbake/records (${response?.status})`] };
    }
    return { reachable: true, ...(await response.json()) };
}

/**
 * 記録に紐付く**出力画像**を引く。
 *
 * **印が焼かれている分だけ**が返る（確実な経路）。過去の絵を指紋で拾うのは
 * `outputAttribution.js` の仕事で、こちらとは証拠の強さが違う。
 *
 * 取れなくても投げない——Sweep は索引が無くても回せる（回し直しが増えるだけ）。
 */
export async function listRecordOutputs(recordId, { refresh = false } = {}) {
    if (!recordId) return { outputs: [], total: 0, reachable: false };
    const doRequest = ensureInstalled();
    try {
        /*
         * **数え直しは頼んだときだけ**（`D-20260828-01` 群D）。
         *
         * サーバ側の数え直しは出力フォルダ全体を歩いて**全ファイルの更新時刻を
         * 取る**（実測 4,851枚で初回 2,891ms・差分でも 187ms）。既定で付けると
         * **再現を押すたび・Sweep を始めるたびに**それが走る。
         * 要るのは「今出たばかりの絵を探す」場面だけなので、そこだけが頼む。
         */
        const query = new URLSearchParams({ id: String(recordId) });
        if (refresh) query.set('refresh', '1');
        const response = await doRequest(`/unbake/outputs?${query.toString()}`);
        if (!response?.ok) return { outputs: [], total: 0, reachable: false };
        return { reachable: true, ...(await response.json()) };
    } catch {
        return { outputs: [], total: 0, reachable: false };
    }
}

/** 出力画像の**生の値**を1ページ引く（指紋はこの値から JS 側で計算する）。 */
export async function scanOutputs({ offset = 0, limit = 200, keys = null } = {}) {
    const doRequest = ensureInstalled();
    const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    if (keys?.length) query.set('keys', keys.join(','));
    try {
        const response = await doRequest(`/unbake/outputs?${query.toString()}`);
        if (!response?.ok) return { outputs: [], total: 0, reachable: false };
        return { reachable: true, ...(await response.json()) };
    } catch {
        return { outputs: [], total: 0, reachable: false };
    }
}

/**
 * **名指しした絵だけ**、生の値を引く（`I-20260829-01`）。
 *
 * 起動時の走査は印だけを取る。`prompt` は転送の 97% を占めるのに、実データで
 * 帰属を1件も増やしていなかった——だが「何が違うか」の表示には要る。
 * そこで**記録を開いた時に、その記録の絵のぶんだけ**ここで引く。
 *
 * **どの絵が要るかは呼び手が決める。** サーバ側の帰属に任せると、名前で
 * 帰属した絵が漏れる（帰属の規則は `core/outputAttribution.js` の1本が持つ）。
 *
 * @returns {{raw: Record<string, object>, reachable: boolean}}
 *   `raw` は `"<subfolder>/<filename>"` から生の値への対応。**取れなければ空。**
 */
export async function readOutputRaw(items, keys = null) {
    const list = (items || [])
        .filter(item => item?.filename)
        .map(item => ({ subfolder: item.subfolder || '', filename: item.filename }));
    if (!list.length) return { raw: {}, reachable: true };
    const doRequest = ensureInstalled();
    try {
        const response = await doRequest('/unbake/output-raw', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: list, ...(keys?.length ? { keys } : {}) }),
        });
        if (!response?.ok) return { raw: {}, reachable: false };
        const body = await response.json();
        return { reachable: true, raw: body?.raw || {} };
    } catch {
        return { raw: {}, reachable: false };
    }
}

/**
 * hash と Civitai の id から導入済みモデルを引く索引。**1回だけ取る。**
 *
 * 取れない環境（LoRA Manager を入れていない）では空で返る——**そこで落とさない**。
 * 索引が無いことは「モデルが無い」ことではないので、名前での解決だけが残る。
 */
let modelIndexPromise = null;

export async function readModelIndex({ refresh = false } = {}) {
    if (refresh) modelIndexPromise = null;
    if (!modelIndexPromise) {
        modelIndexPromise = (async () => {
            try {
                const doRequest = ensureInstalled();
                const response = await doRequest(`/unbake/model-index${refresh ? '?refresh=1' : ''}`);
                if (!response?.ok) return { kinds: {}, unavailable: `http-${response?.status ?? 'error'}` };
                return await response.json();
            } catch (error) {
                return { kinds: {}, unavailable: String(error?.message || error) };
            }
        })();
    }
    return modelIndexPromise;
}

/** 記録1件の本体。**Sweep が押された時点でだけ取る。** */
export async function readLibraryRecord(recordId) {
    const doRequest = ensureInstalled();
    const response = await doRequest(`/unbake/record?id=${encodeURIComponent(recordId)}`);
    if (!response?.ok) {
        // **「無い」と「読めなかった」を混ぜない**（2026-08-28）。
        // 呼び手が見分けられないと、消えた記録を「読めなかっただけ」と見なして
        // **書き戻す**——消したものが戻ってくる。番号をそのまま渡す。
        const error = new Error(`/unbake/record (${response?.status})`);
        error.status = response?.status ?? 0;
        throw error;
    }
    return response.json();
}

/** 設定を読む。**秘密の値は入っていない**（Python 側が伏せて返す）。 */
export async function readUnbakeSettings() {
    const doRequest = ensureInstalled();
    const response = await doRequest('/unbake/settings');
    if (!response?.ok) throw new Error(`/unbake/settings (${response?.status})`);
    return response.json();
}

/** 設定を書く。**送らなかった鍵は変わらない。** */
export async function writeUnbakeSettings(patch) {
    const doRequest = ensureInstalled();
    const response = await doRequest('/unbake/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch || {}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response?.ok) {
        throw new Error(payload?.error || `/unbake/settings (${response?.status})`);
    }
    return payload;
}

/** ComfyUI 自身が配っている出力画像を取る（D&D の捕捉経路が使う）。 */
export async function fetchOutputImage(viewUrl) {
    const doRequest = ensureInstalled();
    const response = await doRequest(viewUrl);
    if (!response?.ok) throw new Error(`view request failed (${response?.status})`);
    return response.arrayBuffer();
}
