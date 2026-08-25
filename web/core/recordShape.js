/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * **記録の形を、レシピの形へ揃える**（2026-08-24 利用者の報告）。
 *
 * この道具には形が2つある:
 *
 *   レシピの形 … 上流（LoRA Manager）が書く。`gen_params` に条件がまとまり、
 *                `checkpoint` は資源のオブジェクト
 *   記録の形   … こちらが画像から作る。条件は**直下**（`positive` / `seed` /
 *                `cfg` / `width`）で、`checkpoint` は**ただの文字列**
 *
 * **下流は全部レシピの形を読む。** 詳細も、計画も、組み立ても。だから記録の形が
 * そのまま流れると、値が在るのに**画面が空になる**——実際に
 * `ComfyUI_00444_` の詳細でプロンプトも seed も出なかった（値は持っていた）。
 *
 * 同じ食い違いを既に3回踏んでいる（グラフの鍵・保存の本体・ここ）。
 * **読む側を増やすのではなく、境界で1度だけ揃える。**
 */

import { summarizePrompt } from './generationRecord.js';

/** 数として読めるときだけ数にする。**`Number('')` の 0 を通さない。** */
function numberOf(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

/** 記録の形か（＝`gen_params` を持たず、直下に条件が在る）。 */
export function looksLikeRecordShape(record) {
    if (!record || typeof record !== 'object') return false;
    if (record.gen_params && typeof record.gen_params === 'object') return false;
    return ['positive', 'seed', 'steps', 'cfg', 'sampler', 'width']
        .some(key => record[key] !== undefined && record[key] !== null);
}

/**
 * 条件を `gen_params` へ、`checkpoint` を資源の形へ。**元は変えない。**
 *
 * **既に在るものは触らない。** レシピの形で来たものを作り直すと、
 * 上流が持っている項目（`clip_skip` や `denoising_strength`）が落ちる。
 */
/** 中身のある方を採る。**空文字は「無い」と同じ**（記録の空は抽出漏れが多い）。 */
function firstText(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value;
    }
    return '';
}

/** 記録が抱えているグラフから、正負のプロンプトを拾い直す。 */
function fillFromGraph(record) {
    const graph = record?.prompt && typeof record.prompt === 'object' ? record.prompt : null;
    if (!graph) return { positive: null, negative: null };
    try {
        const summary = summarizePrompt(graph);
        return { positive: summary.positive, negative: summary.negative };
    } catch {
        // **拾えなくても止めない。** ここは補いであって、本筋ではない。
        return { positive: null, negative: null };
    }
}

export function toRecipeShape(record) {
    if (!record || typeof record !== 'object') return record;
    const out = { ...record };

    if (looksLikeRecordShape(record)) {
        const width = numberOf(record.width);
        const height = numberOf(record.height);
        // **足りない分はグラフから拾い直す。**
        //
        // 古い記録は負のプロンプトを持っていない——要約器が抜いていなかったので、
        // **保存済みの分は全件が空**である（2026-08-24 実機 `ComfyUI_00444_`）。
        // グラフは記録の中に残っているので、取り込み直さなくてもここで埋まる。
        // **空を空のまま流すと、画面は「無かった」と言い、再現もそう振る舞う。**
        const fromGraph = fillFromGraph(record);
        out.gen_params = {
            prompt: firstText(record.positive, fromGraph.positive),
            negative_prompt: firstText(record.negative, fromGraph.negative),
            seed: numberOf(record.seed),
            steps: numberOf(record.steps),
            // **名前が違うだけ。** 記録は `cfg`、レシピは `cfg_scale`。
            cfg_scale: numberOf(record.cfg),
            sampler: record.sampler ?? null,
            scheduler: record.scheduler ?? null,
            size: width && height ? `${width}x${height}` : null,
        };
    }

    // **文字列の checkpoint は、そのままでは読まれない。** 組み立ては
    // `file_name` / `localPath` を見るので、裸の文字列は「無い」になる。
    if (typeof out.checkpoint === 'string' && out.checkpoint.trim()) {
        out.checkpoint = { file_name: out.checkpoint.trim() };
    }

    // LoRA も名前が違う（記録は `name` / `strength`、レシピは `file_name` / `weight`）。
    if (Array.isArray(out.loras)) {
        out.loras = out.loras.map(lora => {
            if (!lora || typeof lora !== 'object') return lora;
            if (lora.file_name) return lora;
            const name = lora.name ?? null;
            if (!name) return lora;
            const strength = numberOf(lora.strength);
            return {
                ...lora,
                file_name: name,
                weight: lora.weight ?? strength,
                strength: strength ?? lora.weight ?? null,
            };
        });
    }

    return out;
}
