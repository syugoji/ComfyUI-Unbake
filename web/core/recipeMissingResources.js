/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * ComfyUI-Unbake の一部。**この行の意味**——著作権の所在を明示してある限り、
 * 後から別のライセンスを足せる。表示が無いまま配ると、それが言いづらくなる。
 */
/**
 * レシピが持つ「不足素材」を、ダウンロード待ち行列へ載る形へ揃える。
 *
 * `BulkMissingLoraDownloadManager` から切り出した。切り出した理由は2つある。
 *
 * 1. **ここで落ちた素材は利用者から見えない。** 待ち行列へ載る前に捨てた素材は
 *    トーストの分母にすら入らないので、「9個のうち3個」の9にも6にも現れない。
 *    どの規則が何件落としているかは、実データへ当てて初めて判る。
 * 2. **判定の写しを作らないため。** ブラウザ外（`_measurements/scripts/`）から
 *    同じ規則で数えるには、DOM に触らないモジュールである必要がある。
 *    規則を書き写した probe は、規則が変わった瞬間に黙って別の数を出す。
 *
 * そのため、このモジュールは `apiConfig.js` を import しない（`state/index.js` 経由で
 * `localStorage` に触るため Node から読めない）。型の文字列は下でローカルに宣言し、
 * `MODEL_TYPES` と同値であることをテストが両ファイルを読んで固定する。
 */

import { t } from '../i18n/index.js';
import { analyzeRecipeReplayCapability } from './recipeReplayCapability.js';
import {
    blockingVerdict,
    classifyMissing,
    fetchResourceAvailability,
    getKnownModelCatalog,
} from './recipeMissingModels.js';

/**
 * 素材の種別。`api/apiConfig.js` の `MODEL_TYPES` と同一でなければならない。
 * 同値性は `tests/frontend/utils/recipeMissingResources.test.js` が固定する。
 */
export const RECIPE_RESOURCE_TYPES = {
    LORA: 'loras',
    CHECKPOINT: 'checkpoints',
    EMBEDDING: 'embeddings',
};

// アップスケーラ等、Civitai 経由では取れない既知モデル。type ごとに
// 保存先ルートを引く既存の流れに乗らないので、専用の印を付けて分岐する。
export const KNOWN_MODEL_TYPE = 'known_model';

/** capability の単数形 type を、ダウンロード側の型（複数形）へ写す。 */
function toModelType(type) {
    const normalized = String(type || '').toLowerCase();
    if (normalized === 'checkpoint' || normalized === RECIPE_RESOURCE_TYPES.CHECKPOINT) {
        return RECIPE_RESOURCE_TYPES.CHECKPOINT;
    }
    if (normalized === 'embedding' || normalized === RECIPE_RESOURCE_TYPES.EMBEDDING) {
        return RECIPE_RESOURCE_TYPES.EMBEDDING;
    }
    return RECIPE_RESOURCE_TYPES.LORA;
}

/** 待ち行列へ載る前に素材を捨てた理由。**利用者に見えない失敗はここに集まる。** */
export const SKIP_REASONS = {
    IN_LIBRARY: 'in_library',
    GENERIC_PLACEHOLDER: 'generic_placeholder',
    DELETED_WITHOUT_IDENTITY: 'deleted_without_identity',
    NO_ID: 'no_id',
};

function normalizeHash(value) {
    return String(value || '').trim().toLowerCase();
}

/**
 * 名前そのものに埋まっている Civitai の `<modelId>@<versionId>` を読む。
 *
 * ワークフロー側の経路（`classifyMissing`）は前からこれを読んでいたが、
 * レシピ側は読んでいなかった。実測（2026-08-16・346レシピ）で、
 * **`urn:air:sd1:embedding:civitai:222256@250708` のような素材が3件、
 * 名前にIDを持ちながら「Civitai のモデルIDが記録されていません」と表示されていた。**
 * 手がかりを読まずに「手がかりが無い」と結論していただけである。
 */
const CIVITAI_AIR_PATTERN = /civitai:(\d+)@(\d+)/i;

export function idsFromName(...candidates) {
    for (const candidate of candidates) {
        const match = CIVITAI_AIR_PATTERN.exec(String(candidate || ''));
        if (match) return { modelId: Number(match[1]), versionId: Number(match[2]) };
    }
    return null;
}

export function getRecipeFileParams(resource) {
    const files = resource?.civitai?.files;
    const targetFileId = resource.fileId ?? resource.file_id;
    const targetHash = normalizeHash(resource.hash || resource.sha256);
    if (!Array.isArray(files) || files.length === 0) {
        return targetHash.length >= 8 ? { sha256: targetHash } : null;
    }
    let selectedFile = null;

    if (targetFileId !== undefined && targetFileId !== null) {
        selectedFile = files.find(file => String(file?.id) === String(targetFileId)) || null;
    }

    if (!selectedFile && targetHash.length >= 8) {
        selectedFile = files.find(file => Object.values(file?.hashes || {}).some(value => {
            const candidate = normalizeHash(value);
            return candidate === targetHash
                || candidate.startsWith(targetHash)
                || targetHash.startsWith(candidate);
        })) || null;
    }

    if (!selectedFile) {
        return targetHash.length >= 8 ? { sha256: targetHash } : null;
    }

    const metadata = selectedFile.metadata || {};
    return Object.fromEntries(Object.entries({
        fileId: selectedFile.id,
        sha256: selectedFile.hashes?.SHA256,
        type: selectedFile.type,
        format: metadata.format,
        size: metadata.size,
        fp: metadata.fp,
        isPrimary: selectedFile.primary === true,
    }).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

/**
 * 選択されたレシピから、重複を除いた不足素材を集める。
 *
 * 戻り値の `skipped` は待ち行列へ載らなかった素材とその理由。**捨てた件数を
 * 返さないと、分母に現れない失敗を後から数えられない。**
 *
 * @param {Array} selectedRecipes
 * @returns {{uniqueResources: Array, uniqueCount: number, totalMissingCount: number, skipped: Array}}
 */
export function collectMissingResources(selectedRecipes) {
    const resources = new Map();
    const skipped = [];
    let totalMissingCount = 0;

    const addResource = (resource, type, recipe) => {
        if (!resource) return;
        // 名前に埋まったIDは、記録されたIDが無いときだけ使う（記録の方が確かなので）。
        const fromName = idsFromName(
            resource.file_name, resource.filename, resource.name, resource.modelName);
        const modelId = resource.modelId || resource.model_id || resource.civitai?.modelId
            || fromName?.modelId || null;
        const versionId = resource.id || resource.modelVersionId || resource.civitai?.id
            || fromName?.versionId || null;

        const skip = (reason) => {
            skipped.push({
                reason,
                type,
                recipeTitle: recipe?.title ?? null,
                name: resource.name || resource.modelName || resource.civitai?.name || null,
                fileName: resource.file_name || resource.filename || null,
                modelId,
                versionId,
            });
        };

        if (resource.inLibrary) {
            skip(SKIP_REASONS.IN_LIBRARY);
            return;
        }

        const fileParams = getRecipeFileParams(resource);
        const fileIdentity = fileParams?.sha256 || fileParams?.fileId;
        const filename = String(resource.file_name || resource.filename || '')
            .replaceAll('\\', '/').split('/').at(-1) || '';
        const genericPlaceholder = /^(?:flux(?:1)?|model|checkpoint|unet|unknown)(?:\.safetensors)?$/i
            .test(filename.trim());
        const hasStrongFileIdentity = Boolean(
            fileIdentity
            || resource.hash
            || resource.fileId
            || resource.file_id
            || (Array.isArray(resource.civitai?.files) && resource.civitai.files.length > 0)
        );
        if (type === RECIPE_RESOURCE_TYPES.CHECKPOINT && genericPlaceholder && !hasStrongFileIdentity) {
            // Civitai's API-only generators can expose a model/version ID but no
            // downloadable file. Re-queueing their placeholder name (for example
            // "FLUX") can never satisfy ComfyUI and causes an endless prompt.
            skip(SKIP_REASONS.GENERIC_PLACEHOLDER);
            return;
        }
        const hasRecipeFileIdentity = Boolean(
            fileIdentity
            || resource.hash
            || resource.file_name
            || resource.filename
        );
        if (
            resource.isDeleted
            && type !== RECIPE_RESOURCE_TYPES.CHECKPOINT
            && !hasRecipeFileIdentity
        ) {
            // A deleted optional resource with only a remote version ID
            // cannot be verified against the recipe. Archive mirrors may
            // serve a different file under that ID, so do not ask for the
            // same unverifiable download on every replay.
            skip(SKIP_REASONS.DELETED_WITHOUT_IDENTITY);
            return;
        }
        const uniqueKey = `${type}:${fileIdentity || resource.hash || versionId || modelId}`;
        if (!versionId && !modelId) {
            skip(SKIP_REASONS.NO_ID);
            return;
        }

        totalMissingCount++;
        if (!resources.has(uniqueKey)) {
            resources.set(uniqueKey, {
                ...resource,
                type,
                modelId,
                id: versionId,
                name: resource.name || resource.modelName || resource.civitai?.name,
                version: resource.version || resource.modelVersionName || resource.civitai?.name,
                fileParams,
                // Deleted Civitai resources may still be available through
                // CivArchive mirrors. Let the downloader verify availability
                // instead of replaying an invalid placeholder model name.
                metadataSource: resource.metadataSource
                    || (resource.isDeleted ? 'civarchive' : undefined),
            });
        }
    };

    (selectedRecipes || []).forEach(recipe => {
        addResource(recipe.checkpoint, RECIPE_RESOURCE_TYPES.CHECKPOINT, recipe);
        (recipe.loras || []).forEach(lora => addResource(lora, RECIPE_RESOURCE_TYPES.LORA, recipe));
        (recipe.embeddings || []).forEach(
            embedding => addResource(embedding, RECIPE_RESOURCE_TYPES.EMBEDDING, recipe)
        );
    });

    return {
        uniqueResources: Array.from(resources.values()),
        uniqueCount: resources.size,
        totalMissingCount,
        skipped,
    };
}

/**
 * ワークフローを組んで初めて判る不足モデル（アップスケーラ等）を集める。
 *
 * レシピJSONの loras/checkpoint/embeddings には現れないので、
 * collectMissingResources だけでは永久に取りこぼす。
 */
export async function collectMissingKnownModels(
    recipes,
    { objectInfo = null, embeddings = null, knownModelCatalog = null } = {}
) {
    const incomplete = [];
    // ワークフロー側で「落としても使えない」と判った素材。**捨てない。**
    // 以前はここを読み捨てていたので、実測59件がどこにも出ていなかった。
    const blocked = new Map();
    const catalog = knownModelCatalog || await getKnownModelCatalog();
    if (catalog.unavailable) {
        // **0件と「調べられなかった」を混ぜない。** 台帳が引けないと、この経路は
        // 何も見つけないまま黙って 0 を返す（実測 2026-08-16: 待ち行列9件のうち
        // 5件がこの経路から来ている＝丸ごと消える）。
        incomplete.push({ code: 'catalog_unavailable', detail: catalog.unavailable });
        return { models: [], incomplete, blocked: [] };
    }
    if ((catalog.models || []).length === 0) return { models: [], incomplete, blocked: [] };

    const found = new Map();
    let analysisFailures = 0;
    for (const recipe of recipes || []) {
        let capability = null;
        try {
            capability = await analyzeRecipeReplayCapability(recipe, {
                objectInfo,
                embeddings,
                knownModelCatalog: catalog,
            });
        } catch (error) {
            // 1本のレシピが解析できなくても、残りの収集は続ける。
            // ただし**何本落ちたかは数える**——`/object_info` が落ちていれば全本が
            // ここを通り、件数だけが静かに 0 になる。
            console.warn(t('core.recipeMissingResources.1'), error);
            analysisFailures++;
            continue;
        }
        // 落としても使えない素材をキューへ積まない。判定はプロセス内と
        // サーバー側の両方でキャッシュされるので、素材あたり1回で済む。
        let availability = null;
        try {
            availability = await fetchResourceAvailability([
                ...(capability.missing?.models || []),
                ...(capability.missing?.resources || []),
            ]);
        } catch (error) {
            availability = null;
        }
        const classified = classifyMissing(capability.missing, catalog, availability);
        for (const item of classified.blocked || []) {
            // ID があるならそれで束ねる。同じモデルがモデル名・ファイル名・
            // 拡張子つきの3通りで現れるので、名前で束ねると3行に散る。
            const key = (item.modelId || item.versionId)
                ? `${item.modelId ?? ''}:${item.versionId ?? ''}`
                : `name:${item.name}`;
            if (!blocked.has(key)) {
                blocked.set(key, {
                    name: item.name,
                    code: item.code,
                    why: item.why,
                    modelId: item.modelId ?? null,
                    versionId: item.versionId ?? null,
                });
            }
        }
        for (const item of classified.catalog) {
            if (found.has(item.entry.key)) continue;
            found.set(item.entry.key, {
                type: KNOWN_MODEL_TYPE,
                catalogKey: item.entry.key,
                name: item.entry.filename,
                file_name: item.entry.filename,
                version: item.entry.license || '',
                sizeBytes: item.entry.size_bytes || null,
                sourceKind: item.entry.source_kind || 'official',
            });
        }
        // **レシピが持っていない素材**（元画像では使われたのに保存されて
        // いないLoRA等）は collectMissingResources では拾えない。
        // capability が manifest の記録から見つけたものを合流させる。
        for (const item of classified.civitai) {
            const key = `civitai:${item.type}:${item.versionId || item.modelId}`;
            if (found.has(key)) continue;
            found.set(key, {
                // capability は 'lora' / 'checkpoint' の単数形を返すが、
                // ダウンロード側は複数形で API クライアントを選ぶ。
                // 写し違えると checkpoint を LoRA として落としにいく。
                type: toModelType(item.type),
                id: item.versionId,
                modelId: item.modelId,
                name: item.name,
                file_name: item.name,
                metadataSource: item.isDeleted ? 'civarchive' : undefined,
            });
        }
    }
    if (analysisFailures > 0) {
        incomplete.push({ code: 'capability_analysis_failed', detail: analysisFailures });
    }
    return { models: [...found.values()], incomplete, blocked: [...blocked.values()] };
}

/**
 * 待ち行列へ載せる前に、「落としても使えない」と判っている素材を外す。
 *
 * **同じ判定をワークフロー側の経路（`classifyMissing`）は既に引いている。**
 * レシピ側だけが引いていなかったため、削除済み・生成専用の素材が待ち行列へ積まれ、
 * 取得まで進んでから失敗していた（実測 2026-08-16: 待ち行列9件のうち3件がこれ）。
 *
 * **外した素材は捨てずに返す。** 黙って分母から消すと、失敗は減っても
 * 「なぜ落ちてこないのか」が前より判らなくなる。
 *
 * @param {Array} resources `collectMissingResources` が返した素材
 * @returns {Promise<{downloadable: Array, blocked: Array}>}
 */
export async function partitionByAvailability(resources) {
    const list = resources || [];
    if (list.length === 0) return { downloadable: [], blocked: [] };

    let availability = null;
    try {
        availability = await fetchResourceAvailability(list.map(resource => ({
            modelId: resource.modelId ?? null,
            versionId: resource.id ?? resource.modelVersionId ?? null,
        })));
    } catch (error) {
        // 判定が取れないことは可否を変えない。従来どおり取得の導線へ委ねる。
        availability = null;
    }

    const downloadable = [];
    const blocked = [];
    for (const resource of list) {
        const verdict = blockingVerdict(availability, {
            modelId: resource.modelId ?? null,
            versionId: resource.id ?? resource.modelVersionId ?? null,
        });
        if (verdict) {
            blocked.push({ ...resource, blockCode: verdict.code, blockReason: verdict.why });
        } else {
            downloadable.push(resource);
        }
    }
    return { downloadable, blocked };
}
