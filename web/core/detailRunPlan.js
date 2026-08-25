/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 詳細の面から出す計画を組む（2026-08-22 利用者の指示）。
 *
 * 「振る」の面は**軸を宣言してから回す**形だった。やりたいことはたいてい
 * 「この seed の隣も見たい」「この `{...}` を別の語で試したい」の2つで、
 * *軸*という言い方はその手前に挟まっていただけだった。ここは**画面が持って
 * いる素直な入力**（seed・枚数・置き換えの候補）から、既にある
 * `expandSweepTemplate` が食える雛形へ落とすだけの層。
 *
 * **新しい実行器は作らない。** 組み立ても実行も `recipeSweep` / `SweepRunner`
 * のままで、ここが変えるのは「人が何を入れるか」だけ。
 */

import { t } from '../i18n/index.js';

/** 一度に出す上限。**押し間違いで100枚積まない**ための歯止め。 */
export const MAX_CELLS = 24;

/** 枚数の上限。seed をこの数だけ連番で伸ばす。 */
export const MAX_SEEDS = 8;

/**
 * seed の連番。**元の seed が必ず1つ目**＝基準になる。
 *
 * 連番にしてあるのは**再現できること**を優先したから（`sweepAxes` と同じ判断）。
 * 無作為に採ると「良かったあの1枚」の seed を後から言えなくなる。
 *
 * 上限に近いときは下へ伸ばす——`expandSweepTemplate` は安全整数の
 * 非負しか受けないので、はみ出すと**投入の直前で落ちる**。
 */
export function seedSeries(seed, count) {
    const total = Math.max(1, Math.min(MAX_SEEDS, Math.trunc(Number(count) || 1)));
    const maximum = Number.MAX_SAFE_INTEGER - 1;
    const parsed = Number(seed);
    const baseline = Number.isSafeInteger(parsed) && parsed >= 0 ? Math.min(parsed, maximum) : 0;
    const step = baseline <= maximum - (total - 1) ? 1 : -1;
    const series = Array.from({ length: total }, (_, index) => baseline + (index * step));
    // 下へ伸ばして 0 を割ったときだけ、上へ折り返す（負の seed は通らない）。
    return series.every(value => value >= 0) ? series : series.map((_, index) => baseline - index)
        .filter(value => value >= 0);
}

/**
 * 「20, 30, 40」を候補の配列へ。**区切りは読点・カンマ・空白**。
 *
 * 数の欄はここで複数を受ける（「振る」で*軸*を宣言する形をやめた）。
 * **数へ直せない片は落とす**——`Number('')` は 0 なので、そのまま通すと
 * 「20, 」と打った瞬間に 0 ステップの絵が1枚混ざる。
 */
export function parseNumberList(text) {
    return [...new Set(String(text ?? '').split(/[,、\s]+/)
        .map(part => part.trim())
        .filter(Boolean)
        .map(Number)
        .filter(Number.isFinite))];
}

/** 1行1候補。**空行は数えない**（末尾の改行で「空の候補」を作らない）。 */
export function parseChoices(text) {
    return String(text ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

/** プロンプトに書かれている `{差し替え口}`。**出た順のまま**（並べ替えない）。 */
export function placeholdersIn(prompt) {
    return [...new Set(String(prompt ?? '').match(/\{[^{}]+\}/g) || [])];
}

/**
 * 数の欄が出す候補。**書いてあればそのとおり、書いていなければ刻む。**
 *
 * 「20, 30, 40」と打つのは面倒だという指摘（2026-08-22）で、欄の隣に
 * **枚数**を置いた。枚数だけ指せば、今の値から `spread` ずつ増やした候補になる。
 * **手で複数書いたときは、そちらが勝つ**——書いた値を勝手に置き換えない。
 */
function valuesFor(entry) {
    const written = parseNumberList(entry?.text);
    if (written.length >= 2) return written;
    const count = Math.max(1, Math.min(MAX_SEEDS, Math.trunc(Number(entry?.count) || 1)));
    if (count < 2 || written.length !== 1) return written;
    const spread = Number(entry?.spread);
    if (!Number.isFinite(spread) || spread === 0) return written;
    const out = [];
    for (let i = 0; i < count; i += 1) {
        const value = written[0] + (spread * i);
        // **負の値は作らない。** ステップ 0 や負の CFG は投入で落ちる。
        if (value < 0) break;
        // 端数は元の刻みに合わせて丸める（0.1 刻みで 4.300000000000001 を作らない）。
        out.push(Math.round(value * 1e6) / 1e6);
    }
    return [...new Set(out)];
}

/** 軸の名札。**長い候補でも読める長さに詰める。** */
function labelFor(value) {
    const text = String(value);
    return text.length <= 24 ? text : `${text.slice(0, 23)}…`;
}

/**
 * 画面の入力から、実行できる雛形を組む。
 *
 * @param {object} options
 * @param {number} options.seed          いま欄に入っている seed
 * @param {number} options.count         出す枚数（seed を連番で伸ばす）
 * @param {{token: string, text: string}[]} options.placeholders 置き換えの候補
 * @param {{key: string, text: string, label?: string, count?: number, spread?: number}[]} options.parameters
 *        数の欄。`text` に複数書けばそのとおり、1つなら `count`/`spread` で刻む。
 * @param {{target: string, values: string[], label?: string}[]} options.loraSwaps LoRA の差し替え先
 * @param {string[]} options.checkpointSwaps 土台のモデルの差し替え先（2つ以上で軸）
 * @param {string} options.appendWords プロンプトの末尾へ足す語（1行1つ・2つ以上で軸）
 * @param {string} [options.id]          雛形の id
 * @param {string} [options.name]        雛形の名前
 * @returns {{template: object, cellCount: number, substitutions: {token: string, value: string}[]}}
 *
 * `substitutions` は**候補が1つだけ**だった置き換え口。軸にできない
 * （軸は2つ以上要る）ので、呼び手がプロンプトへ直接埋める——
 * **黙って捨てない**。捨てると「入れたのに効かない欄」ができる。
 */
export function buildDetailRunPlan({
    seed, count = 1, placeholders = [], parameters = [], loraSwaps = [],
    checkpointSwaps = [], appendWords = '',
    id = 'detail-run', name = null,
} = {}) {
    const seeds = seedSeries(seed, count);
    const axes = [];
    const substitutions = [];

    // --- 数の欄（ステップ・CFG）------------------------------------------
    //
    // **1つなら軸にしない。** 軸は2つ以上要るし、1つの値は「変えた欄」として
    // そのまま通せばよい（呼び手が `gen_params` へ入れる）。
    for (const entry of parameters) {
        const key = String(entry?.key || '');
        if (!key) continue;
        const values = valuesFor(entry);
        if (values.length < 2) continue;
        axes.push({
            id: `p-${key}`,
            kind: 'generation_parameter',
            parameter: key,
            label: entry?.label || key,
            values: values.map((value, index) => ({
                label: String(value), value, baseline: index === 0,
            })),
        });
    }

    // --- checkpoint を複数振る --------------------------------------------
    //
    // **`target` は要らない。** 記録の checkpoint は1つなので、指す先が1つに決まる。
    {
        const names = [...new Set((checkpointSwaps || []).map(String).map(v => v.trim()).filter(Boolean))];
        if (names.length >= 2) {
            axes.push({
                id: 'checkpoint',
                kind: 'checkpoint',
                label: t('detail.axis.checkpoint'),
                values: names.map((value, index) => ({
                    label: labelFor(value), value, baseline: index === 0,
                })),
            });
        }
    }

    // --- 語の追記 -----------------------------------------------------------
    //
    // **置き換えとは別。** `{...}` が無いプロンプトでも、末尾へ足すだけなら振れる。
    {
        const words = [...new Set(parseChoices(appendWords))];
        if (words.length >= 2) {
            axes.push({
                id: 'append',
                kind: 'prompt_append',
                label: t('detail.axis.append'),
                values: words.map((value, index) => ({
                    label: labelFor(value), value, baseline: index === 0,
                })),
            });
        }
    }

    // --- LoRA の差し替え ---------------------------------------------------
    //
    // **`target` は身元で持つ。** 並び順で持つと、記録によって順が違うので
    // 静かに別の LoRA へ当たる（`recipeSweep` の `selectedLora` も身元で引く）。
    for (const entry of loraSwaps) {
        const target = String(entry?.target ?? '');
        if (!target) continue;
        const names = [...new Set((entry?.values || []).map(String).map(v => v.trim()).filter(Boolean))];
        if (names.length < 2) continue;
        axes.push({
            id: `lora-${axes.length + 1}`,
            kind: 'lora_swap',
            target,
            label: entry?.label || target,
            values: names.map((value, index) => ({
                label: labelFor(value), value, baseline: index === 0,
            })),
        });
    }

    for (const entry of placeholders) {
        const token = String(entry?.token || '');
        if (!/^\{[^{}]+\}$/.test(token)) continue;
        // **同じ候補を2度置かない。** セル数だけ増えて同じ絵が出る
        // （`expandSweepTemplate` はそこを見て投げる）。
        const choices = [...new Set(parseChoices(entry?.text))];
        if (choices.length === 0) continue;
        if (choices.length === 1) {
            substitutions.push({ token, value: choices[0] });
            continue;
        }
        axes.push({
            id: `ph-${axes.length + 1}`,
            kind: 'prompt_placeholder',
            token,
            label: token,
            // **1つ目を基準にする。** 基準が無いと「どれが元だったか」が
            // 出た絵の側から言えなくなる。
            values: choices.map((value, index) => ({
                label: labelFor(value), value, baseline: index === 0,
            })),
        });
    }

    const cellCount = axes.reduce((total, axis) => total * axis.values.length, 1) * seeds.length;
    if (cellCount > MAX_CELLS) {
        throw new Error(t('detail.plan.tooMany', { count: cellCount, max: MAX_CELLS }));
    }

    const mode = axes.length === 0
        ? 'seeds_only'
        : (axes.length === 1 ? 'single_axis_seeds' : 'cartesian_seeds');
    return {
        template: { id, name: name || id, mode, axes, seeds },
        cellCount,
        substitutions,
    };
}
