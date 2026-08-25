/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **実験の型** — 軸の宣言を保存して、別の記録へ当てる。
 *
 * ---
 *
 * **「実行リスト」ではない。**（裁定②・2026-08-20）
 *
 * 最初の読みは「順番に回したい記録を名前付きで束ねる入れ物」だった。
 * だが実際に欲しかったのは
 * **「レコードの一部を固定し、キャラ／checkpoint／LoRA を変数にした画像群」**で、
 * これは**記録の束ではなく軸の宣言**である。束のほうは Sweep がほぼ同じことを
 * していて、足りなかったのは束ではなかった。
 *
 * だから「実行リスト」という語は使わない。**束を連想させて実体と合わない。**
 *
 * ---
 *
 * **保存するのは軸だけで、記録は入れない。**
 *
 * 型は「別の記録へ当てるもの」なので、作ったときの記録に縛られてはいけない。
 * `recipeId` も持たない——持つと「この記録専用の型」になり、2回目から使えない。
 *
 * 当てる先が違えば、軸が指す対象も違う:
 *
 *   `lora_strength` / `lora_swap` … `target` は**その記録の中の LoRA**を指す。
 *                                    別の記録では同じ target が存在しない。
 *   `prompt_placeholder`          … `token` がプロンプトに無ければ当たらない。
 *   `checkpoint` / `generation_parameter` … どの記録にも当たる。
 *
 * **当たらないものを黙って落とさない。** `applyExperimentType()` は
 * 当てられた軸と落ちた軸を**両方**返す。落ちたことが見えないと、
 * 「3軸の型を当てたのに1軸しか振れていない」が事故ではなく仕様に見える。
 *
 * 保存は `storage.js` 経由（`.recipe.json` へは書かない）。
 */

import { readStored, writeStored } from './storage.js';
import { loraTargetIdentity } from './sweepAxes.js';

export const EXPERIMENT_TYPE_STORAGE_KEY = 'unbake.experiment_types';

/** 型1件の形。**軸だけを持ち、記録の id は持たない。** */
function normalizeType(value) {
    if (!value || typeof value !== 'object') return null;
    const id = String(value.id ?? '').trim();
    const name = String(value.name ?? '').trim();
    const axes = Array.isArray(value.axes) ? value.axes : [];
    if (!id || !name || axes.length === 0) return null;
    return {
        id,
        name,
        mode: String(value.mode || 'cartesian'),
        seeds: Array.isArray(value.seeds) ? value.seeds.map(Number).filter(Number.isFinite) : [],
        // **記録に紐づく鍵をここで落とす。** 型は記録から独立している。
        axes: axes.map(axis => {
            const { recipeId: _recipeId, ...rest } = axis || {};
            return rest;
        }),
    };
}

/** 保存済みの型をすべて読む。**壊れた項目は落とすが、他は残す。** */
export function readExperimentTypes() {
    const stored = readStored(EXPERIMENT_TYPE_STORAGE_KEY, []);
    const list = Array.isArray(stored) ? stored : [];
    return list.map(normalizeType).filter(Boolean);
}

/**
 * 型を1つ保存する。同じ id が在れば置き換える。
 *
 * @returns {object[]} 保存後の一覧
 */
export function saveExperimentType(type) {
    const normalized = normalizeType(type);
    if (!normalized) throw new TypeError('saveExperimentType: needs {id, name, axes[]}');
    const existing = readExperimentTypes().filter(item => item.id !== normalized.id);
    const next = [normalized, ...existing];
    writeStored(EXPERIMENT_TYPE_STORAGE_KEY, next);
    return next;
}

/** 型を1つ消す。 */
export function removeExperimentType(id) {
    const next = readExperimentTypes().filter(item => item.id !== String(id));
    writeStored(EXPERIMENT_TYPE_STORAGE_KEY, next);
    return next;
}

/**
 * Sweep の雛形（または画面で編集した宣言）を、保存できる型へ落とす。
 *
 * **`recipeId` を落とすのがこの関数の仕事。** 落とさないと、
 * 「別の記録へ当てる」ときに元の記録を指したままの型が保存される。
 */
export function experimentTypeFromTemplate(template, { id = null, name = null } = {}) {
    return normalizeType({
        id: id || `type-${String(template?.id ?? 'custom')}`,
        name: name || String(template?.name ?? ''),
        mode: template?.mode,
        seeds: template?.seeds,
        axes: template?.axes,
    });
}

/**
 * 軸1本が、この記録へ当たるか。**当たらない理由も返す。**
 *
 * @returns {{ok: true, axis: object} | {ok: false, reason: string, axisId: string}}
 */
export function resolveAxisFor(record, axis) {
    const axisId = String(axis?.id ?? axis?.kind ?? '');
    switch (axis?.kind) {
        case 'checkpoint':
        case 'generation_parameter':
            // どの記録にも当たる（土台とパラメータは全部の記録が持つ）。
            return { ok: true, axis };
        case 'prompt_placeholder': {
            const prompt = String(record?.gen_params?.prompt ?? '');
            if (!axis.token || !prompt.includes(axis.token)) {
                return { ok: false, reason: 'token-not-in-prompt', axisId };
            }
            return { ok: true, axis };
        }
        case 'prompt_append':
            return { ok: true, axis };
        case 'lora_strength':
        case 'lora_swap': {
            const loras = Array.isArray(record?.loras) ? record.loras : [];
            if (loras.length === 0) return { ok: false, reason: 'record-has-no-lora', axisId };
            // **保存された target は別の記録の LoRA を指している。**
            // 同じ版が在ればそれを、無ければ**1本目へ寄せる**——寄せたことは
            // `rebound` で返すので、黙って別の LoRA を振ることにはならない。
            const wanted = String(axis.target ?? '');
            const matched = loras.findIndex((lora, index) => loraTargetIdentity(lora, index) === wanted);
            if (matched >= 0) return { ok: true, axis };
            return {
                ok: true,
                axis: { ...axis, target: loraTargetIdentity(loras[0], 0) },
                rebound: { from: wanted, to: loraTargetIdentity(loras[0], 0) },
            };
        }
        default:
            return { ok: false, reason: 'unsupported-axis-kind', axisId };
    }
}

/**
 * 保存した型を、別の記録へ当てる。
 *
 * @returns {{template: object|null, applied: object[], dropped: object[], rebound: object[]}}
 *   `template` は `buildSweepPlan()` へそのまま渡せる形。**当たる軸が1本も
 *   無ければ null**（0軸の雛形を返すと、seed だけの Sweep が黙って始まる）。
 */
export function applyExperimentType(type, record) {
    const normalized = normalizeType(type);
    if (!normalized) return { template: null, applied: [], dropped: [], rebound: [] };

    const applied = [];
    const dropped = [];
    const rebound = [];
    for (const axis of normalized.axes) {
        const result = resolveAxisFor(record, axis);
        if (!result.ok) { dropped.push({ axisId: result.axisId, reason: result.reason }); continue; }
        if (result.rebound) rebound.push({ axisId: String(axis.id ?? ''), ...result.rebound });
        applied.push(result.axis);
    }
    if (applied.length === 0) return { template: null, applied, dropped, rebound };

    return {
        template: {
            id: normalized.id,
            name: normalized.name,
            mode: normalized.mode,
            seeds: normalized.seeds,
            axes: applied,
            recipeId: String(record?.id ?? ''),
        },
        applied,
        dropped,
        rebound,
    };
}
