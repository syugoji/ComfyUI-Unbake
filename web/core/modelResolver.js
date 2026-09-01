/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 記録が指すモデルを、**名前で引けないときに hash と Civitai の id で引き直す**。
 *
 * ---
 *
 * **これが無いと、手元に在るモデルを「未導入」と言う。** 実測（2026-08-22・
 * 人間の判定シート292件との突き合わせ）で、**人間が「再現できた」と記録している
 * のに Unbake が「再現不可」と出していた2件**が、どちらもこれだった:
 *
 * | 記録 | 記録が持っている名前 | 手元の実体 | 引ける手掛かり |
 * |---|---|---|---|
 * | `43323642` | `prefectious_nsfw.fp16`（Civitai の内部名） | `prefectiousXLNSFW_v10` | `hash: 4286171e4b` |
 * | `21490268` | **空**（`isDeleted: true` の殻） | `realDream_sdxlPony9` | `id: 665047` |
 *
 * 名前でしか引かないと、前者は「未導入モデル」、後者は「情報がありません」で落ちる。
 *
 * **当てる順序に意味がある。**
 *
 * 1. **名前が既に手元の一覧に在るなら、何もしない。** 記録の名前が正しいのに
 *    索引で上書きすると、同名の別ファイルへ静かに移る余地を作る。
 * 2. **hash（sha256 の先頭10桁）。** 同一性の根拠として一番強い。
 * 3. **版 id（`civitai.id`）。** モデルの「その版」を指すので、絵は同じはず。
 * 4. **model id（`civitai.modelId`）。** 版が違えば絵も違うので**最後の手段**で、
 *    当てたことを `resolvedBy` に残す——強さの違う根拠を同じ顔で使わない。
 *
 * **書き換えるのは `localPath` と `inLibrary` だけ。** 組み立て側
 * （`getResourceFilename`）が既に「`inLibrary` なら `localPath` を最優先」で
 * 見ているので、**下流に新しい分岐を作らずに済む**。元の `file_name` は残す
 * ——消すと「記録には何と書いてあったか」が辿れなくなる。
 */

import { hashFromModelName, modelStem } from './modelFileNames.js';

/** `sha256` 由来の短い hash（Civitai の AutoV2）。**大文字小文字を揃える。** */
function shortHash(value) {
    const text = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{10,}$/.test(text) ? text.slice(0, 10) : null;
}

/** 手元の一覧に、この名前がそのまま在るか。**茎で比べる**（拡張子とフォルダを外す）。 */
function installedHas(installed, name) {
    /*
     * **茎の取り方は `modelFileNames.js` の1本だけ**（2026-08-31・監査 I-20260831-31）。
     *
     * ここは `.replace(/\.[^.]+$/, '')` で**末尾のドット区間を無条件に**落として
     * いて、「拡張子を落とす規則は唯一ここ」と宣言している
     * `MODEL_EXTENSION_PATTERN`（既知の拡張子だけを落とす）と食い違っていた。
     *
     * **版番号は名前の一部であって拡張子ではない。** 実測でレシピ343件の
     * LoRA 1,023本のうち **102本（10%）** が `GENESIS_MK0.4` /
     * `feet_anime_il_v2.5` のような拡張子でない末尾ドットを持ち、
     * 剥がしすぎて索引側と一致しなくなっていた。
     * `modelsView.js` の `stemOf` も同じ罠を名指ししている。
     */
    const wanted = modelStem(name).toLowerCase();
    if (!wanted) return false;
    return (installed || []).some(item => modelStem(item).toLowerCase() === wanted);
}

/**
 * モデル1つを引き直す。**当てられなければ触らない。**
 *
 * @param {object} resource 記録の `checkpoint` や `loras[]` の1件
 * @param {object} kindIndex `/unbake/model-index` の該当種別
 * @param {string[]} installed 導入済みの相対名（`/object_info` の COMBO）
 * @returns {{resolved: boolean, name: string|null, by: string|null}}
 */
export function resolveOne(resource, kindIndex, installed = []) {
    if (!resource || typeof resource !== 'object') return { resolved: false, name: null, by: null };
    const declared = resource.file_name || resource.filename || resource.localPath || '';

    // 0. **Civitai から引いてきた SHA256 が在れば、名前より先に見る。**
    //
    //    `civitaiModelLookup` はファイル名の完全一致で版を1つに決め、その版の
    //    SHA256 を `lookupSha256` として持ち帰る。手元の索引にその hash が在れば、
    //    **そのファイルがバイト同一だと確かめられる**——名前が同じかどうかは関係ない。
    //
    //    **名前一致より前に置くのが要。** 下の 1. は「名前で引けるなら索引を当てない」
    //    という近道で、そこへ落ちると**同名の別ファイルを掴んだまま `hash` を名乗れない**。
    //    利用者の環境には同名の LoRA が2箇所に在るものが8件あるので、机上の話ではない。
    //
    //    **`lookupSha256` を持たない資源の扱いは1文字も変えない。**
    const looked = shortHash(resource.lookupSha256);
    if (looked && kindIndex?.bySha10?.[looked]) {
        return { resolved: true, name: kindIndex.bySha10[looked], by: 'hash' };
    }

    // 1. 名前でそのまま引けるなら、索引を当てない。
    if (declared && installedHas(installed, declared)) {
        return { resolved: false, name: null, by: null };
    }
    if (!kindIndex) return { resolved: false, name: null, by: null };

    // 2. hash。
    const hash = shortHash(resource.hash) || shortHash(resource.sha256);
    if (hash && kindIndex.bySha10?.[hash]) {
        return { resolved: true, name: kindIndex.bySha10[hash], by: 'hash' };
    }
    // 2.5 **名前の中に埋まっているハッシュ**（2026-08-29 実機で確定）。
    //
    //     記録が要求     Illustrious/aMixIllustrious_aMix(B199B92EE9).safetensors
    //     手元に在る     IllustriousnimeMixIllustrious_aMix.safetensors
    //     索引の bySha10  "b199b92ee9" -> "aMixIllustrious_aMix"
    //
    // **括弧の中身は、その索引が持っているハッシュそのもの**だった。両側が鍵を
    // 持っているのに装飾つきの名前を素で突き合わせて外し、「未導入モデル」と
    // 言っていた（利用者の報告「再現不可に分類されます」の正体・記録 128383826）。
    //
    // **版 id より前に置く。** ハッシュはバイト同一の証拠で、版 id は申告にすぎない
    // ——上の 0. と 2. が同じ理由で名前より前に在るのと揃える。
    //
    // **括弧を外した名前では当てにいかない。** それは推測で、同じ名前の別の版を
    // 掴み得る。索引に当たらなければ、ここは何も言わない。
    const embedded = hashFromModelName(declared);
    if (embedded && kindIndex.bySha10?.[embedded]) {
        return { resolved: true, name: kindIndex.bySha10[embedded], by: 'hash' };
    }
    // 3. 版 id。**`modelVersionId` の別名も見る**（Civitai の API 経由だとこちら）。
    for (const key of ['id', 'modelVersionId', 'versionId']) {
        const value = resource[key];
        if (value === null || value === undefined || value === '') continue;
        const found = kindIndex.byVersionId?.[String(value)];
        if (found) return { resolved: true, name: found, by: 'versionId' };
    }
    // 4. model id。**版が違えば絵も違う**ので最後。
    for (const key of ['modelId', 'model_id']) {
        const value = resource[key];
        if (value === null || value === undefined || value === '') continue;
        const found = kindIndex.byModelId?.[String(value)];
        if (found) return { resolved: true, name: found, by: 'modelId' };
    }
    return { resolved: false, name: null, by: null };
}

/**
 * 記録まるごとを引き直す。**元は変えず、写しを返す。**
 *
 * @param {object} recipe 記録の本体
 * @param {object} index `/unbake/model-index` の応答
 * @param {{checkpoints?: string[], loras?: string[]}} [installed] 導入済みの相対名
 * @returns {{recipe: object, resolved: {kind: string, from: string, to: string, by: string}[]}}
 */
export function resolveRecipeModels(recipe, index, installed = {}) {
    const resolved = [];
    if (!recipe || typeof recipe !== 'object' || !index?.kinds) {
        return { recipe, resolved };
    }
    const out = { ...recipe };

    /**
     * `kinds` は**複数受ける**。checkpoint は `checkpoints` と
     * `diffusion_models` の両方に居うる（Flux 系は後者）ので、
     * 片方だけ見ると在るモデルを「未導入」と読む。
     */
    const apply = (resource, kinds, installedNames) => {
        const list = Array.isArray(kinds) ? kinds : [kinds];
        let found = { resolved: false, name: null, by: null };
        let kind = list[0];
        for (const candidate of list) {
            const hit = resolveOne(resource, index.kinds[candidate], installedNames);
            if (hit.resolved) { found = hit; kind = candidate; break; }
        }
        if (!found.resolved) return resource;
        /*
         * **`modelId` では差し替えない**（2026-08-26 実機で踏んだ）。
         *
         * `modelId` はモデル**ページ**の id で、そこには何本も版がぶら下がる。
         * 実機で `anima_aestheticV11`（要る版）を、同じページの
         * `anima_baseV10`（手元に在る別の版）へ差し替えていた——**別の重みなので
         * 別の絵が出る。**
         *
         * しかも害は二重だった。差し替えた記録は「手元に在る」ことになるので、
         * **正しい版を落とす候補から外れる**——利用者から見ると
         * 「再現不可なのに、落とすものが出てこない」。実際に 16件あった候補が
         * 6件しか出ず、チェックポイントが1件も出なかった。
         *
         * **手掛かりも足さない。** 「同じページの別の版が手元に在る」は
         * 役に立つ情報だが、**出す所を作らないまま値だけ増やす**のは、
         * このセッションで何度も踏んだ形（取り出したのに画面に出ない）。
         * 出すと決めたときに、出す所と一緒に足す。
         */
        if (found.by === 'modelId') return resource;
        resolved.push({
            kind,
            // **空だったことを日本語で埋めない。** ここは中核で、文言は画面が持つ
            // ——記録が名前を持っていなかったこと自体が情報なので、空のまま渡す。
            from: String(resource.file_name || resource.name || ''),
            to: found.name,
            by: found.by,
        });
        // **`file_name` は残す。** 記録に何と書いてあったかを消さない。
        return {
            ...resource,
            localPath: found.name,
            inLibrary: true,
            // どの根拠で当てたか。**強さが違うので、画面が言い分けられるようにする。**
            resolvedBy: found.by,
        };
    };

    if (out.checkpoint && typeof out.checkpoint === 'object') {
        out.checkpoint = apply(out.checkpoint, ['checkpoints', 'diffusion_models'], installed.checkpoints);
    }
    if (Array.isArray(out.loras)) {
        out.loras = out.loras.map(lora => (lora && typeof lora === 'object'
            ? apply(lora, ['loras'], installed.loras)
            : lora));
    }
    return { recipe: resolved.length ? out : recipe, resolved };
}

/** `/object_info` から、種別ごとの導入済み一覧を取り出す。**推測で組み立てない。** */
export function installedNamesFrom(objectInfo) {
    const pick = (classType, input) => {
        const spec = objectInfo?.[classType]?.input?.required?.[input];
        const options = Array.isArray(spec?.[0]) ? spec[0] : spec?.[1]?.options;
        return Array.isArray(options) ? options.filter(v => typeof v === 'string') : [];
    };
    // **`UNETLoader` も checkpoint の出どころ。** Flux 系の本体は
    // `models/checkpoints` に入らず `unet` / `diffusion_models` に置かれ、
    // 組み立ても `UNETLoader` で読む（`recipeWorkflowBuilder`）。
    // ここを `CheckpointLoaderSimple` だけにすると、**在るモデルが
    // 「未導入」に見えて記録が 再現不可 に落ちる**（実データ2件で踏んだ）。
    return {
        checkpoints: [...new Set([
            ...pick('CheckpointLoaderSimple', 'ckpt_name'),
            ...pick('UNETLoader', 'unet_name'),
        ])],
        loras: pick('LoraLoader', 'lora_name'),
    };
}
