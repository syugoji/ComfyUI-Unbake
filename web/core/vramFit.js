/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **VRAM に収まらないモデルを、投げる前に言う。**
 *
 * 2026-08-26 実機の報告「`civitai_139164303` で生成すると動作が極端に遅くなり、
 * 生成が始まりませんでした」。実測すると壊れていたのはグラフではなかった:
 *
 *   - 組み立ては 11ms・`object_info` と突き合わせて**候補外の入力は0件**
 *   - `krea2Turbo_v10.safetensors` は **13.1 GB**
 *   - 手元の GPU は RTX 3080 Ti の **12.0 GB**
 *
 * **入らない。** ComfyUI は主記憶へ追い出しながら回すので、機械ごと重くなり、
 * 押した人からは「始まらない」に見える。**故障ではないので、待てばいつかは
 * 出る**——だから止めない。言うだけにする。
 *
 * 判定は**一番大きい1本**で見る。テキストエンコーダと拡散モデルは同時には
 * 常駐しない（ComfyUI が入れ替える）ので、合計で見ると入るものまで警告する。
 *
 * **余裕（マージン）は引かない。** 「11.5 GB なら平気か」は測っていないので、
 * 数字を決めれば当てずっぽうになる。**確実に入らない側だけ**を言い、
 * 実際の大きさと VRAM をそのまま見せて、判断は人に返す。
 */

/** モデル名を取る入力と、その置き場。 */
export const MODEL_INPUT_FOLDERS = {
    unet_name: 'diffusion_models',
    ckpt_name: 'checkpoints',
    clip_name: 'text_encoders',
    vae_name: 'vae',
    lora_name: 'loras',
};

/** グラフが読むモデルのファイル名を、置き場つきで並べる。 */
export function modelFilesIn(prompt) {
    const found = [];
    for (const node of Object.values(prompt || {})) {
        for (const [key, folder] of Object.entries(MODEL_INPUT_FOLDERS)) {
            const value = node?.inputs?.[key];
            // **繋いだ線は名前ではない。** `['12', 0]` を名前として扱わない。
            if (typeof value !== 'string' || !value) continue;
            found.push({ folder, name: value });
        }
    }
    return found;
}

/**
 * 名前の突き合わせ。ComfyUI は入れ子のフォルダを名前の一部として返すので
 * （`Krea 2\\base model\\krea2Turbo_v10.safetensors`）、**区切りを揃えてから**
 * 比べる。揃えないと、入れ子に置いたモデルは1本も当たらない。
 */
function sizeKey(name) {
    return String(name || '').replace(/\\/g, '/').toLowerCase();
}

/** `{ folder: { name: bytes } }` から、そのファイルの大きさを引く。 */
export function sizeOf(sizes, folder, name) {
    const table = sizes?.[folder];
    if (!table) return 0;
    const want = sizeKey(name);
    for (const [key, bytes] of Object.entries(table)) {
        if (sizeKey(key) === want) return Number(bytes) || 0;
    }
    return 0;
}

/**
 * **収まらない一番大きいモデル**を返す。収まるなら `null`。
 *
 * @param {object} prompt 投げるグラフ
 * @param {{sizes: object, vramTotal: number}} measured 実測値
 */
export function modelTooBigForVram(prompt, { sizes, vramTotal } = {}) {
    const total = Number(vramTotal) || 0;
    // **測れていないときは黙る。** 0 と比べると全部が「入らない」になる。
    if (total <= 0 || !sizes) return null;
    let worst = null;
    for (const file of modelFilesIn(prompt)) {
        const bytes = sizeOf(sizes, file.folder, file.name);
        if (bytes <= total) continue;
        if (!worst || bytes > worst.bytes) worst = { name: file.name, bytes, vramTotal: total };
    }
    return worst;
}

/** 人に見せる大きさ（GB・小数1桁）。 */
export function gigabytes(bytes) {
    return (Number(bytes) || 0) / 1e9;
}
