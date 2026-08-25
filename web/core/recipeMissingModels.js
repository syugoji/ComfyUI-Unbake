/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * ComfyUI-Unbake の一部。**この行の意味**——著作権の所在を明示してある限り、
 * 後から別のライセンスを足せる。表示が無いまま配ると、それが言いづらくなる。
 */
import { t } from '../i18n/index.js';
// 再現を止めている「不足モデル」を、解決手段ごとに仕分ける。
//
// 遮断の理由は日本語の文章なので、UI がそれを読んで「これはDLで直る」と
// 判断すると、文言を直した瞬間に壊れる。capability が返す構造（missing）
// だけを見て仕分ける。
//
// 手段は3つに分かれる:
//   civitai   … modelVersionId/modelId が記録されている素材（既存のDL経路）
//   catalog   … 既知モデル台帳にURLがあるファイル（アップスケーラ等）
//   manual    … 正体は判るが自動DLできない（配布がzipのみ、要ログイン等）
//   blocked   … 手がかりが無い（ローカル学習物、記録欠落）

import { compactModelName } from './modelFileNames.js';
import { environmentRequestOrNull } from './environment.js';

const CATALOG_ENDPOINT = '/api/lm/known-models';
const AVAILABILITY_ENDPOINT = '/api/lm/recipes/resource-availability';

let catalogPromise = null;

/** 解決済みの配布可否。キーは `modelId:versionId`。 */
const availabilityCache = new Map();
/** 同じキーを同時に何度も問い合わせないための飛行中テーブル。 */
const availabilityInFlight = new Map();

/**
 * 別名照合用の正規化。
 *
 * **規則の実体は `modelFileNames.js`**（バックエンドの `normalize_model_name` と
 * 同値であることをテストが両言語のファイルを読んで固定する）。以前ここには
 * 「バックエンドと同じ規則」というコメントだけがあり、実体は一致していなかった
 * ——`.sft` を欠いていて `ae.sft` が導入済みの `ae.safetensors` と照合できなかった。
 * **宣言は検査ではない。**
 */
export function normalizeModelName(value) {
    return compactModelName(String(value || '').trim());
}

/**
 * 既知モデル台帳を取得する（プロセス内で1回だけ）。
 * 取得できない環境（旧バックエンド）でも再現判定を壊さないよう、空で返す。
 *
 * **ただし「空だった」と「取れなかった」を呼び出し側から見分けられるようにする。**
 * 取れないと `collectMissingKnownModels` は**何も見つけずに 0 件を返す**ので、
 * 利用者には「不足なし」と読める小さい数字だけが出る。数字が黙って縮む経路は、
 * 縮んだこと自体が見えないと直しようがない（`I-20260816-03`）。
 */
export async function getKnownModelCatalog({ force = false, fetchImpl = null } = {}) {
    if (force) catalogPromise = null;
    if (!catalogPromise) {
        // **環境は呼び手が据える。** 元は大域の HTTP 呼び出しへ直接落ちていたので、
        // ブラウザで LoRA Manager のページを開いている状態にしか置けなかった。
        const doFetch = fetchImpl || environmentRequestOrNull();
        const unavailable = (reason) => ({ models: [], installed: [], unavailable: reason });
        catalogPromise = (async () => {
            if (!doFetch) return unavailable('no-request');
            try {
                const response = await doFetch(CATALOG_ENDPOINT);
                if (!response?.ok) return unavailable(`http-${response?.status ?? 'error'}`);
                const data = await response.json();
                if (!data?.success || !Array.isArray(data.models)) {
                    return unavailable('malformed');
                }
                return {
                    models: data.models,
                    installed: Array.isArray(data.installed) ? data.installed : [],
                    unavailable: null,
                };
            } catch {
                return unavailable('exception');
            }
        })();
    }
    return catalogPromise;
}

export function resetKnownModelCatalogCache() {
    catalogPromise = null;
}

/**
 * 台帳から名前で1件引く。別名も見る。
 *
 * 別名の配列名は `aliases`（バックエンドの entry_to_dict が返す名前）。
 * ここを `names` と取り違えると、**両側のテストは自前fixtureで緑のまま
 * 実環境でだけ1件も引けなくなる**（実際に起きた）。形の一致は
 * tests/test_known_model_catalog.py の契約テストが固定している。
 */
export function findCatalogEntry(catalog, name) {
    const key = normalizeModelName(name);
    if (!key) return null;
    return (catalog?.models || []).find(entry => {
        if (normalizeModelName(entry.filename) === key) return true;
        return (entry.aliases || []).some(alias => normalizeModelName(alias) === key);
    }) || null;
}

/**
 * capability.missing を解決手段ごとに仕分ける。
 *
 * `resolvable` は「この手を打てば遮断が消える」ものだけを数える。
 * 打つ手が無いものを混ぜると「あと少しで再現できる」の件数が嘘になる。
 */
/**
 * Civitai のファイル一覧に、実際に読み込めるモデルが1つでもあるか。
 *
 * Civitai には**生成専用**として登録されたモデルがある。ページは存在し
 * ID も付くが、配布されるのは学習データや設定ファイルだけで、モデル本体は無い。
 * 実測（2026-08-10 / Civitai_Recipe_76666001）: `OpenAI's GPT-image-1` は
 * `usageControl: "Generation"` で、files は
 * `openaisGPTImage1_4oImageGen1_trainingData.zip`（type "Training Data"・1.6MB）
 * の1件だけ。**IDがあるのでダウンロード可能に見えるが、何を落としても使えない。**
 *
 * 一覧そのものが無いときは判断しない（true を返す）。「配布なし」と誤って
 * 断じると、取れるはずのモデルまで手段を奪うことになる。
 *
 * **判定は「読み込めない種別の黒リスト」で書く。** 当初の版は逆に白リストで、
 * 実データ512素材の掃引＋実ダウンロードによる反証で、`Diffusion Model`
 * （12GBの safetensors・実DLは HTTP 200/206）が白リストに無いというだけで
 * 「配布なし」に落ちていた。焼き付いた `civitai.files` だけを見ても
 * `Krea 2 Turbo` ×2 と `redcraft23INT8INT4FP8_30Krea2` の**3件が現に遮断されていた**。
 * 白リストは Civitai が種別を増やすたびに、取れるモデルを黙って遮断する。
 */
const NON_LOADABLE_FILE_TYPES = new Set(['training data', 'config']);

export function hasDistributableFile(resource) {
    const files = resource?.civitai?.files ?? resource?.files;
    if (!Array.isArray(files) || files.length === 0) return true;
    return files.some(file => !NON_LOADABLE_FILE_TYPES.has(
        String(file?.type || '').trim().toLowerCase()
    ));
}

/** 配布可否の問い合わせキー。サーバー側 `cache_key()` と同じ形。 */
export function availabilityKey(item) {
    const modelId = item?.modelId ?? item?.model_id ?? null;
    const versionId = item?.versionId ?? item?.modelVersionId ?? null;
    return `${modelId ?? ''}:${versionId ?? ''}`;
}

/**
 * 不足素材が「そもそも配布されているか」をサーバーへ問い合わせる。
 *
 * **判定材料は `.recipe.json` に焼き付いた `civitai` ブロックにしか無かった。**
 * 実測（2026-08-13・346レシピ）でその材料を持つのは LoRA 1,036件中1件・
 * checkpoint 337件中80件で、`hasDistributableFile` は9割の素材へ一度も届いていない。
 * 取れなかったキーは**入れない**（不明を覚えると復旧しても古い判定が残る）。
 */
export async function fetchResourceAvailability(items, { fetchImpl = null, refresh = false } = {}) {
    const doFetch = fetchImpl || environmentRequestOrNull();
    const wanted = new Map();
    for (const item of items || []) {
        const key = availabilityKey(item);
        if (key === ':') continue;
        if (!refresh && (availabilityCache.has(key) || availabilityInFlight.has(key))) continue;
        if (!wanted.has(key)) {
            wanted.set(key, {
                modelId: item?.modelId ?? item?.model_id ?? null,
                versionId: item?.versionId ?? item?.modelVersionId ?? null,
            });
        }
    }

    if (doFetch && wanted.size > 0) {
        const request = (async () => {
            try {
                const response = await doFetch(AVAILABILITY_ENDPOINT, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ resources: [...wanted.values()], refresh }),
                });
                if (!response?.ok) return;
                const data = await response.json();
                if (!data?.success || !data.results) return;
                for (const [key, verdict] of Object.entries(data.results)) {
                    if (verdict?.verdict) availabilityCache.set(key, verdict);
                }
            } catch {
                // 判定が取れないことは再現の可否を変えない。従来どおりDL導線へ委ねる。
            }
        })();
        for (const key of wanted.keys()) availabilityInFlight.set(key, request);
        try {
            await request;
        } finally {
            for (const key of wanted.keys()) availabilityInFlight.delete(key);
        }
    } else {
        await Promise.all([...new Set(availabilityInFlight.values())]);
    }

    const resolved = {};
    for (const item of items || []) {
        const key = availabilityKey(item);
        if (availabilityCache.has(key)) resolved[key] = availabilityCache.get(key);
    }
    return resolved;
}

export function resetResourceAvailabilityCache() {
    availabilityCache.clear();
    availabilityInFlight.clear();
}

/**
 * 「落としても使えない」と確定した判定だけを理由つきで返す。
 *
 * 明示的に渡された `availability` が無ければ**プロセス内のキャッシュを見る**。
 * これが無いと、`classifyMissing` を同期で呼ぶ経路（カードのバッジを決める
 * `classifyBlocker`）だけが判定を受け取れず、**詳細モーダルは「削除されています」
 * と出すのに一覧のバッジは「モデル待ち」のまま**という食い違いが残る。
 */
export function blockingVerdict(availability, item) {
    const key = availabilityKey(item);
    const entry = availability?.[key] ?? availabilityCache.get(key);
    const verdict = entry?.verdict;
    if (verdict === 'generation_only') {
        return {
            code: 'generation_only',
            why: t('core.recipeMissingModels.1'),
        };
    }
    if (verdict === 'deleted') {
        return { code: 'deleted', why: t('core.recipeMissingModels.2') };
    }
    if (verdict === 'unresolvable') {
        // 削除済みとは限らないが、記録が版IDだけなので辿り直せない。
        // ダウンロード側も同じ1本の経路しか持たないため、押せば必ず失敗する。
        return {
            code: 'unresolvable',
            why: t('core.recipeMissingModels.3'),
        };
    }
    return null;
}

/**
 * 「入手先が判らない」と「入手先は判っているが配布されていない」は別物。
 *
 * **理由文（日本語）を読んで判定しない。** 文言を直した瞬間に壊れる。
 * `code` を見る。
 */
export function hasUndistributableBlock(groups) {
    return (groups?.blocked || []).some(
        item => item.code === 'generation_only' || item.code === 'deleted'
    );
}

export function classifyMissing(missing, catalog, availability = null) {
    const civitai = [];
    const catalogItems = [];
    const manual = [];
    const blocked = [];

    for (const resource of missing?.resources || []) {
        // 問い合わせ済みなら実データの判定を優先する（レシピ内の焼き付きより新しい）。
        const verdict = blockingVerdict(availability, resource);
        if (verdict) {
            blocked.push({ ...resource, via: 'blocked', code: verdict.code, why: verdict.why });
            continue;
        }
        // IDがあっても配布ファイルが無いなら、落としても使えない。
        if (!hasDistributableFile(resource)) {
            blocked.push({
                ...resource,
                via: 'blocked',
                code: 'generation_only',
                why: t('core.recipeMissingModels.4'),
            });
            continue;
        }
        // 配布終了でもIDがあれば CivArchive 経由で取れることがあるので、
        // ここでは弾かず既存のDL経路の判断へ委ねる。
        if (resource.versionId || resource.modelId) {
            civitai.push({ ...resource, via: 'civitai' });
        } else {
            blocked.push({
                ...resource, via: 'blocked', code: 'no_id',
                why: t('core.recipeMissingModels.5'),
            });
        }
    }

    for (const model of missing?.models || []) {
        const entry = findCatalogEntry(catalog, model.name);
        if (entry) {
            if (entry.downloadable === false) {
                manual.push({ ...model, via: 'manual', entry });
            } else {
                catalogItems.push({ ...model, via: 'catalog', entry });
            }
            continue;
        }
        // 台帳（`catalog`）で解決できるものは、Civitai 側が消えていても取れる。
        // だから判定を効かせるのは台帳を引いた**後**。
        const verdict = blockingVerdict(availability, model);
        if (verdict) {
            blocked.push({ ...model, via: 'blocked', code: verdict.code, why: verdict.why });
            continue;
        }
        // 台帳に無くても、レシピ台帳側にCivitaiのIDが記録されていれば
        // 既存のダウンロード経路で取れる（アップスケーラ以外のLoRA・
        // チェックポイントはこちらが本線）。
        if (model.versionId || model.modelId) {
            civitai.push({
                type: model.resourceType || 'lora',
                name: model.name,
                modelId: model.modelId ?? null,
                versionId: model.versionId ?? null,
                isDeleted: Boolean(model.isDeleted),
                via: 'civitai',
            });
            continue;
        }
        // 名前そのものが Civitai の URN を含んでいることがある。
        // 実測（2026-08-10 / 全339レシピ）で1件:
        //   urn:air:sdxl:checkpoint:civitai:153568@665047.safetensors
        // ワークフロー側がモデル名の欄へ URN をそのまま書いた形。
        // `<modelId>@<versionId>` が名前の中に在るのに「入手先が判っていません」と
        // 出していた。**手がかりを読まずに不明と結論していた**だけなので拾う。
        const air = /civitai:(\d+)@(\d+)/i.exec(String(model.name || ''));
        if (air) {
            civitai.push({
                type: model.resourceType || 'checkpoint',
                name: model.name,
                modelId: Number(air[1]),
                versionId: Number(air[2]),
                isDeleted: false,
                via: 'civitai',
            });
            continue;
        }
        // **判定側が理由を付けていたらそれを優先する。** 一律の文言で上書きすると、
        // 「近い物は入っているが別ファイルなので代用しない」といった具体が消える。
        blocked.push({
            ...model, via: 'blocked', code: 'unknown_source',
            why: model.why || t('core.recipeMissingModels.6'),
        });
    }

    return {
        civitai,
        catalog: catalogItems,
        manual,
        blocked,
        // 自動で解決できる件数。manual は人手が要るので数えない。
        resolvableCount: civitai.length + catalogItems.length,
        blockedCount: manual.length + blocked.length,
    };
}

/**
 * このレシピはダウンロードだけで再現できるようになるか。
 *
 * 「1件でも自動DLできる」ではなく「**打つ手の無い遮断が1件も無い**」で判定する。
 * 前者だと、DLしても遮断が残るレシピまで「解決できます」と表示してしまう。
 */
export function isDownloadResolvable(capability, catalog, availability = null) {
    if (capability?.level !== 'unavailable') return false;
    const classified = classifyMissing(capability.missing, catalog, availability);
    if (classified.resolvableCount === 0) return false;
    if (classified.blockedCount > 0) return false;
    // プロンプト欠落・不足ノードなどモデル以外の遮断は missing に出ない。
    // **全ての遮断理由がモデル起因で説明できるとき**だけ「DLで解ける」と言える。
    // 1つでも説明できない理由が残れば、DLしても再現不可のままになる。
    return unexplainedReasons(capability).length === 0;
}

/** 遮断理由のうち、不足モデル／不足素材では説明がつかないもの。 */
export function unexplainedReasons(capability) {
    const modelReasons = new Set(
        (capability?.missing?.models || []).map(item => item.reason)
    );
    const resourceNames = (capability?.missing?.resources || [])
        .map(item => item.name)
        .filter(Boolean);
    return (capability?.reasons || []).filter(reason => {
        if (modelReasons.has(reason)) return false;
        return !resourceNames.some(name => reason.includes(name));
    });
}
