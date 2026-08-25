/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 出力画像の**条件**を1つの形へ落とす、**唯一の抽出器**。
 *
 * ---
 *
 * **なぜ1本しか置かないのか。**
 *
 * 同じ「条件」を Python 側でも組むと、正規化が2つになる。2つあれば必ず食い違い、
 * しかも食い違いは「どちらかが壊れている」ようには見えず**件数が少し違うだけ**なので、
 * どちらが正しいかを毎回人間が決めることになる。
 * だから Python は生の文字列を返すだけで、解釈はここ1箇所でやる。
 *
 * ---
 *
 * **見ているもの／見ていないもの**（`FINGERPRINT_FIELDS` が真実源）
 *
 * 画面には**必ずこの一覧を出す**こと。「差が無い」は強い主張で、
 * 何を見た上での「無い」なのかが判らないと、読んだ人を誤らせる。
 *
 * **エンコーダ族は数えない。** テキストエンコーダや VAE の違いは、
 * 実測（2026-08-20）で**条件が2つ以上ある258件のうち142件＝55%**が
 * 「差はエンコーダだけ」だった。これを軸に数えると、同じ絵を作る条件が
 * 別物として並び、差分ラベルが**エンコーダの名前で埋まる**。
 *
 * ---
 *
 * **2つの入口を同じ形へ落とす。**
 *
 *   `conditionsFromPrompt(raw)` … 出力 PNG に焼かれた API グラフから
 *   `conditionsFromRecord(rec)` … 書庫の記録（レシピ）から
 *
 * 帰属（この画像はどの記録から出たか）は、**同じ関数群を通した後の値**で比べる。
 * 片方だけ別の正規化を通すと、比較は「対象の違い」ではなく「測り方の違い」を測る。
 */

import { resolveSamplerScheduler } from './genParamsMapper.js';

/**
 * 指紋が見ている項目。**画面へそのまま列挙する。**
 *
 * `label` は文言の鍵。値そのもの（モデル名やプロンプト）は訳さない。
 */
export const FINGERPRINT_FIELDS = Object.freeze([
    { key: 'checkpoint', label: 'core.fingerprint.field.checkpoint' },
    { key: 'loras', label: 'core.fingerprint.field.loras' },
    { key: 'positive', label: 'core.fingerprint.field.positive' },
    { key: 'negative', label: 'core.fingerprint.field.negative' },
    { key: 'seed', label: 'core.fingerprint.field.seed' },
    { key: 'steps', label: 'core.fingerprint.field.steps' },
    { key: 'cfg', label: 'core.fingerprint.field.cfg' },
    { key: 'sampler', label: 'core.fingerprint.field.sampler' },
    { key: 'scheduler', label: 'core.fingerprint.field.scheduler' },
    { key: 'size', label: 'core.fingerprint.field.size' },
]);

/**
 * 指紋が**見ていない**もの。画面にはこちらも出す
 * （「見ていない」を黙っていると、差が無い＝同一だと読まれる）。
 */
export const FINGERPRINT_BLIND_SPOTS = Object.freeze([
    'core.fingerprint.blind.encoders',
    'core.fingerprint.blind.upscale',
    'core.fingerprint.blind.postprocess',
]);

/** 差分の見出しに使わない項目。**seed は条件だが「違い」としては煩い。** */
const NOISY_FOR_LABELS = new Set(['seed']);

/** モデルを載せるノードの入力名。**エンコーダと VAE は入れない。** */
const CHECKPOINT_INPUTS = ['ckpt_name', 'unet_name'];

/** サンプラーが持つ入力。 */
const SAMPLER_NUMBERS = { steps: 'steps', cfg: 'cfg', denoise: 'denoise' };

/** モデル名の正規化。**ここにしか無い。** */
export function normalizeModelName(value) {
    const text = String(value ?? '').replaceAll('\\', '/');
    const base = text.split('/').at(-1) || text;
    return base.replace(/\.(safetensors|ckpt|pt|pth|sft|bin)$/i, '').trim().toLowerCase();
}

/** 文字列の正規化。**空白の畳み方を1つに決める。** */
function normalizeText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

/** グラフのノードから入力値を引く。参照（`[nodeId, slot]`）は辿らない。 */
function inputValue(node, name) {
    const value = node?.inputs?.[name];
    return Array.isArray(value) ? null : value;
}

/** 参照（`[nodeId, slot]`）の指す先。 */
function linkedNode(prompt, node, name) {
    const link = node?.inputs?.[name];
    if (!Array.isArray(link) || link.length === 0) return null;
    return prompt?.[String(link[0])] || null;
}

/** その枝から最初に見つかるテキストを取る（Conditioning の鎖を遡る）。 */
function textFromBranch(prompt, node, seen = new Set(), depth = 0) {
    if (!node || depth > 8) return '';
    const key = JSON.stringify([node.class_type, Object.keys(node.inputs || {})]);
    if (seen.has(node)) return '';
    seen.add(node);
    const direct = inputValue(node, 'text');
    if (typeof direct === 'string' && direct.trim()) return direct;
    for (const name of Object.keys(node.inputs || {})) {
        const next = linkedNode(prompt, node, name);
        if (!next) continue;
        const found = textFromBranch(prompt, next, seen, depth + 1);
        if (found) return found;
    }
    void key;
    return '';
}

/**
 * 実行された API グラフから条件を取り出す。
 *
 * @param {string|object} raw `prompt` チャンクの**生の文字列**、または解析済みの物
 * @returns {object|null} 取り出せなければ null（**空の条件を返さない**——
 *   空を返すと「条件が同じ」に見えて、全部が同じ絵として畳まれる）
 */
export function conditionsFromPrompt(raw) {
    let prompt = raw;
    if (typeof raw === 'string') {
        if (!raw.trim()) return null;
        try { prompt = JSON.parse(raw); } catch { return null; }
    }
    if (!prompt || typeof prompt !== 'object') return null;

    const nodes = Object.values(prompt).filter(node => node && typeof node === 'object');
    if (nodes.length === 0) return null;

    // --- 土台のモデル ---------------------------------------------------
    let checkpoint = '';
    for (const node of nodes) {
        for (const name of CHECKPOINT_INPUTS) {
            const value = inputValue(node, name);
            if (typeof value === 'string' && value) { checkpoint = value; break; }
        }
        if (checkpoint) break;
    }

    // --- LoRA -----------------------------------------------------------
    const loras = [];
    for (const node of nodes) {
        const single = inputValue(node, 'lora_name');
        if (typeof single === 'string' && single) {
            loras.push({
                name: normalizeModelName(single),
                strength: finite(inputValue(node, 'strength_model') ?? inputValue(node, 'strength')),
            });
        }
        const stack = node?.inputs?.loras;
        if (Array.isArray(stack)) {
            for (const entry of stack) {
                const name = entry?.name || entry?.lora_name;
                if (!name) continue;
                loras.push({
                    name: normalizeModelName(name),
                    strength: finite(entry?.strength_model ?? entry?.strength),
                });
            }
        }
    }
    // **並び順で違いを作らない。** 同じ組み合わせは同じ指紋になるべき。
    loras.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    // --- サンプラー ------------------------------------------------------
    const sampler = nodes.find(node => inputValue(node, 'sampler_name') !== null
        && inputValue(node, 'sampler_name') !== undefined) || null;
    const seedHolder = nodes.find(node => inputValue(node, 'seed') !== null
        && inputValue(node, 'seed') !== undefined)
        || nodes.find(node => inputValue(node, 'noise_seed') !== null
            && inputValue(node, 'noise_seed') !== undefined)
        || null;

    // --- 寸法 ------------------------------------------------------------
    const latent = nodes.find(node => inputValue(node, 'width') !== null
        && inputValue(node, 'height') !== null
        && inputValue(node, 'width') !== undefined) || null;

    // --- プロンプト ------------------------------------------------------
    let positive = '';
    let negative = '';
    if (sampler) {
        positive = textFromBranch(prompt, linkedNode(prompt, sampler, 'positive'));
        negative = textFromBranch(prompt, linkedNode(prompt, sampler, 'negative'));
    }
    if (!positive) {
        // サンプラーの枝から辿れないときだけ、最初のテキストへ落とす。
        const anyText = nodes.map(node => inputValue(node, 'text'))
            .find(value => typeof value === 'string' && value.trim());
        positive = anyText || '';
    }

    return {
        checkpoint: normalizeModelName(checkpoint),
        loras,
        positive: normalizeText(positive),
        negative: normalizeText(negative),
        seed: finite(inputValue(seedHolder, 'seed') ?? inputValue(seedHolder, 'noise_seed')),
        steps: finite(inputValue(sampler, SAMPLER_NUMBERS.steps)),
        cfg: finite(inputValue(sampler, SAMPLER_NUMBERS.cfg)),
        sampler: normalizeText(inputValue(sampler, 'sampler_name')).toLowerCase(),
        scheduler: normalizeText(inputValue(sampler, 'scheduler')).toLowerCase(),
        size: latent
            ? normalizeSize(`${finite(inputValue(latent, 'width'))}x${finite(inputValue(latent, 'height'))}`)
            : '',
    };
}

/**
 * 書庫の記録から条件を取り出す。**上と同じ正規化を通す。**
 *
 * 片方だけ別の道を通すと、比べているのは「対象の違い」ではなく「測り方の違い」になる。
 */
export function conditionsFromRecord(record) {
    if (!record || typeof record !== 'object') return null;
    const gen = record.gen_params || record.genParams || {};
    const checkpoint = record.checkpoint;
    // **`modelName` も読む。** 実データに `{modelName, type}` だけを持つ記録が在り
    // （`Civitai_Recipe_115941302`）、ここを落とすと土台のモデルが**空**になる。
    // 空は帰属の比較で「未知」として飛ばされるので、**一番強い手掛かりが消えたまま
    // 弱い項目だけで一致率を出す**——別の記録から出た絵が7枚ぶら下がっていた。
    const checkpointName = typeof checkpoint === 'string'
        ? checkpoint
        : (checkpoint?.file_name || checkpoint?.name || checkpoint?.modelName || '');
    const loras = (Array.isArray(record.loras) ? record.loras : []).map(lora => ({
        name: normalizeModelName(lora?.file_name || lora?.name || lora?.localPath || ''),
        strength: finite(lora?.strength_model ?? lora?.strength),
    })).filter(item => item.name);
    loras.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    // **記録は寸法を `size` に持つ**（実測: 346件中241件。`width`/`height` は0件）。
    // ここを `gen.width` だけ見ていたので、寸法の一致率が **0.0%** だった。
    const size = normalizeSize(gen.size ?? (
        finite(gen.width) !== null && finite(gen.height) !== null
            ? `${finite(gen.width)}x${finite(gen.height)}`
            : ''
    ));

    // **サンプラーの表記は2つの世界で違う。** 記録は A1111 の表記
    // （`DPM++ 2M Karras`）で、実行されたグラフは ComfyUI の内部名
    // （`dpmpp_2m` ＋ `karras`）。素朴に比べると一致率は **16.0% / 17.6%** しかない
    // ——**対象が違うのではなく、測り方が違う**。上流の対応表で解いてから比べる。
    const resolved = resolveSamplerScheduler(String(gen.sampler ?? gen.sampler_name ?? ''));
    return {
        checkpoint: normalizeModelName(checkpointName),
        loras,
        positive: normalizeText(gen.prompt),
        negative: normalizeText(gen.negative_prompt),
        seed: finite(gen.seed),
        steps: finite(gen.steps),
        cfg: finite(gen.cfg_scale ?? gen.cfg),
        sampler: normalizeText(resolved.sampler ?? gen.sampler ?? gen.sampler_name).toLowerCase(),
        scheduler: normalizeText(gen.scheduler ?? resolved.scheduler).toLowerCase(),
        size,
    };
}

/** `1024x1024` / `1024 x 1024` / `1024×1024` を1つの形へ。 */
function normalizeSize(value) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    const match = text.match(/(\d+)\s*[x×]\s*(\d+)/i);
    return match ? `${Number(match[1])}x${Number(match[2])}` : '';
}

/** 条件を1つの文字列へ畳む。`seed` を含めるかは呼び手が決める。 */
export function fingerprintOf(conditions, { includeSeed = false } = {}) {
    if (!conditions) return '';
    const parts = FINGERPRINT_FIELDS
        .filter(field => includeSeed || field.key !== 'seed')
        .map(field => `${field.key}=${valueText(conditions[field.key])}`);
    return parts.join('|');
}

/** 表示・比較用の1行。 */
function valueText(value) {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) {
        return value.map(item => (item && typeof item === 'object'
            ? `${item.name}@${item.strength ?? ''}`
            : String(item))).join(',');
    }
    return String(value);
}

/**
 * 基準との**差だけ**を返す。これがバリアントのラベルになる（裁定③）。
 *
 * **刻印には頼らない。** 条件ラベルを焼いた画像は実測で 4,256枚中**12枚**しか
 * 無く、刻印方式は将来分しか救わない。差分なら過去の絵にも当たる。
 *
 * @returns {Array<{key: string, label: string, from: string, to: string}>}
 */
export function describeDifference(baseline, other, { includeSeed = false } = {}) {
    if (!baseline || !other) return [];
    const out = [];
    for (const field of FINGERPRINT_FIELDS) {
        if (!includeSeed && NOISY_FOR_LABELS.has(field.key)) continue;
        const from = valueText(baseline[field.key]);
        const to = valueText(other[field.key]);
        if (from === to) continue;
        out.push({ key: field.key, label: field.label, from, to });
    }
    return out;
}
