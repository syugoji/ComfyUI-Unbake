/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 判定の表。**1回だけ回して、4人の消費者が同じ表を読む。**
 *
 * ---
 *
 * **なぜ表にするのか。**
 *
 * 判定を要るところで individually 出すと、次の4つが**別々の入力**から答えを作る:
 *
 *   (a) チップの絞り込み  … 何件が再現できるか
 *   (b) 並び替えの軸      … 再現できるものを上へ
 *   (c) 投入してよいかの門 … 遮断されている記録を投げない
 *   (d) 不足の集計        … 何を落とせば何件が解けるか
 *
 * 同じ記録について4箇所が別々に判定すると、**同じ画面の中で数が食い違う。**
 * しかも食い違いは「片方が壊れている」ようには見えず、ただ数が合わないだけなので、
 * どちらが正しいのかを毎回人間が決めることになる。だから表は1つにする。
 *
 * ---
 *
 * **条件を固定する（これがこのモジュールの本体）。**
 *
 * 判定は**入力条件で答えが変わる**。実測（2026-08-20・実データ346件）で、
 * 既知モデル台帳を渡すかどうかだけで `unavailable` が **51 ↔ 59** と動いた。
 * 条件を決めずに回すと、4人の消費者が「たまたまその時に取れた条件」で
 * 別々の答えを持つ。**先に固定して、固定した条件を画面へ出す。**
 *
 * 固定した条件は下の `FIXED_CONDITIONS`。今の値と理由:
 *
 *   `catalog: 'none'`
 *       既知モデル台帳を**渡さない**。渡す唯一の経路が
 *       `/api/lm/known-models`（フォークの口）で、そこへ配線すると
 *       Unbake がフォーク無しでは動かなくなる。**保守側に倒れる**
 *       ——別名で解決できたはずの記録が「不足」に見える方向の誤り。
 *   `availabilityProbe: false`
 *       遮断された素材が本当に配布されているかを問い合わせない。
 *       口が `/api/lm/recipes/resource-availability` しか無いのと、
 *       346件ぶんの遮断素材へ一斉に投げることになるため。
 *
 * **どちらも「安全側に倒した」のではなく「確かめていない」。** その区別が
 * 消えると、次に台帳を配線した人が数の変化を退行だと読む。だから表は
 * 条件そのものを持ち歩き、`describeConditions()` で言葉にして返す。
 */

import { analyzeRecipeReplayCapability } from './recipeReplayCapability.js';
import { summarizeWarnings } from './recipeWarningSeverity.js';
import { t } from '../i18n/index.js';

/**
 * 判定器が返す語と、画面の語の対応。
 *
 * **組み立てずに literal で書く。** 文字列を組むと、対応が抜けていることを
 * 機械で確かめられない（実行して初めて未知の判定が出る）。
 */
export const VERDICT_OF = {
    exact: 'reproducible',
    compatible: 'approximate',
    unavailable: 'blocked',
};

/** まだ回していない状態。**「不足」とは別**——組む前と組んだ結果を混ぜない。 */
export const NOT_RUN = 'pending';

/**
 * 固定した入力条件。**表と一緒に持ち歩く。**
 * 変えるときは、変えた事実が画面に出る（`describeConditions()` を通る）。
 */
export const FIXED_CONDITIONS = Object.freeze({
    catalog: 'none',
    availabilityProbe: false,
});

/**
 * 条件を、読んだ人が「何が測られていないか」を判る言葉にする。
 * **「差が無い」は強い主張なので、検出可能範囲とセットで出す。**
 *
 * @returns {string[]}
 */
export function describeConditions(conditions = FIXED_CONDITIONS) {
    const out = [];
    if (conditions.catalog === 'none') {
        out.push(t('core.verdictTable.catalogNotUsed'));
    }
    if (!conditions.availabilityProbe) {
        out.push(t('core.verdictTable.availabilityNotChecked'));
    }
    return out;
}

/**
 * 空の台帳。**`null` を渡すと判定器が自分で取りに行く**ので、
 * 「渡さない」ではなく「空を渡す」で条件を固定する。
 */
const EMPTY_CATALOG = Object.freeze({ models: [], installed: [], unavailable: 'not-wired' });

/**
 * 記録1件を判定して、表の1行を作る。
 *
 * **例外を verdict へ落とさない。** 組めなかったのか、判定器が壊れたのかは
 * 打つ手が違う。前者は `blocked`、後者は `error` として別に数える。
 */
/**
 * 判定を「注記の有無」ではなく **「絵が変わる注記があるか」** で決める。
 *
 * **元は 81.3% が同じ値だった**（実測 346件: exact 22 / compatible 282 / blocked 42）。
 * 1件見て「近似」と答えるだけで81%当たる＝**絞れない**。原因は `compatible` が
 * 「何か注記がある」という意味でしかなく、中身が混ざっていたこと:
 *
 *   82件 「A1111互換パーサで解釈します。**元画像と同じ適用式です**」  ← 忠実
 *   28件 「埋め込みをComfyUIが読み込める形へ**直しました**」          ← 忠実
 *   48件 「**完全再現ではなく質感や構図が変わる**可能性があります」    ← 変わる
 *    5件 「**縦横比が変わります**」                                  ← 変わる
 *
 * **忠実度を上げた処理まで減点していた。** `recipeWarningSeverity` は元々この
 * ためにある分類器で、`riskCount` を既に返していたのに、判定へ繋がっていなかった。
 *
 * **`exact` も無条件では上へ置かない**（2026-08-22 利用者の指摘）。
 * 材料が揃っていることは同じ絵が出る保証ではない——サンプラーの実装差・計算精度・
 * GPU で結果は動く。だから上の段は「**再現性 高**」であって「再現できる」ではない。
 *
 * 実測（346件・この規則で）: 高 133 (38.4%) / 中 171 (49.4%) / 不可 42 (12.1%)。
 * エントロピー 0.939 → **1.402 bit**、最頻値で当たる率 81.3% → **49.4%**。
 *
 * **分類できない注記は「中」へ落とす。** 分類表に無い文を「高」にすると、
 * 新しく増えた注記が黙って合格する（`summarizeWarnings` が `unknown` を
 * `riskCount` へ足しているのと同じ理由）。実測で25種が未分類。
 */
function verdictFrom(capability) {
    const base = VERDICT_OF[capability?.level];
    if (!base || base === 'blocked') return { verdict: base || 'blocked', riskCount: 0 };
    const fidelity = summarizeWarnings(capability?.reasons || []);
    return {
        verdict: fidelity.riskCount > 0 ? 'approximate' : 'reproducible',
        riskCount: fidelity.riskCount,
        // **未分類の件数を捨てない。** 溜まっていることを画面が言えるようにする
        // ——溜まったまま気づかないのが、この分類器が過去3回踏んだ形。
        unclassified: fidelity.unknown.length,
    };
}

async function judgeOne(recipe, inputs) {
    const capability = await analyzeRecipeReplayCapability(recipe, {
        objectInfo: inputs.objectInfo,
        embeddings: inputs.embeddings,
        knownModelCatalog: EMPTY_CATALOG,
        probeAvailability: FIXED_CONDITIONS.availabilityProbe,
    });
    // **鍵の名前は `level`。** ここを `status` と書いていて、対応表が
    // 全件 undefined を引き、**346件すべてが `blocked` になった**
    // （`not built 346` を `missing 346` へ置き換えただけで、絞れなさは同じ）。
    // 名前は推測せず、`result()` が返す形を読んで合わせること。
    const decided = verdictFrom(capability);
    return {
        verdict: decided.verdict,
        // **「絵が変わる」と数えた注記の数。** 画面はこれで並べ替えも絞り込みもできる。
        riskCount: decided.riskCount,
        unclassified: decided.unclassified || 0,
        rawStatus: capability?.level ?? null,
        // **「落とせば試せる」と「初めから無理」を分けて持ち回る**
        // （2026-08-23 利用者の指示）。判定器は既に区別しているのに、
        // 画面へ渡すところで落としていたので、一覧では同じ「再現不可」に見えていた。
        blocker: capability?.blocker ?? null,
        reasons: capability?.reasons || [],
        missing: capability?.missing || { models: [], resources: [] },
        // **判定器の語を捨てない。** 画面の4語へ潰すと、なぜそうなったかが
        // 表から辿れなくなる（`exact` と `compatible` は同じ「再現できる」でも
        // 打つ手が違う）。
        conditions: FIXED_CONDITIONS,
    };
}

/**
 * 判定の表。
 *
 * @param {object} options
 * @param {(id: string) => Promise<object>} options.loadRecord 本体を取る
 * @param {() => Promise<{objectInfo: object, embeddings: string[]}>} options.collectInputs
 *   判定材料。**1回だけ取る**（346件ぶん取り直さない）。
 * @param {number} [options.concurrency] 同時に走らせる件数
 */
export function createVerdictTable({ loadRecord, collectInputs, concurrency = 6 } = {}) {
    if (typeof loadRecord !== 'function' || typeof collectInputs !== 'function') {
        throw new TypeError('createVerdictTable: needs loadRecord() and collectInputs()');
    }

    /** @type {Map<string, object>} 記録 id → 行。 */
    const rows = new Map();
    let inputsPromise = null;
    let cancelled = false;

    const ensureInputs = () => {
        if (!inputsPromise) inputsPromise = collectInputs();
        return inputsPromise;
    };

    return {
        conditions: FIXED_CONDITIONS,
        describeConditions: () => describeConditions(FIXED_CONDITIONS),

        /** 表の1行。**まだ回していなければ null**（`pending` と同義）。 */
        get: (id) => rows.get(String(id)) || null,

        /** 判定の語だけ。消費者(a)(b)(c)が読むのはここ。 */
        verdictOf(id) {
            return rows.get(String(id))?.verdict ?? NOT_RUN;
        },

        /** 判定ごとの件数。消費者(d)が読むのはここ。 */
        tally(ids) {
            const out = { reproducible: 0, approximate: 0, blocked: 0, pending: 0, error: 0 };
            for (const id of ids) {
                const row = rows.get(String(id));
                if (!row) { out.pending += 1; continue; }
                out[row.verdict] = (out[row.verdict] || 0) + 1;
            }
            return out;
        },

        get size() { return rows.size; },
        cancel() { cancelled = true; },

        /**
         * 記録を順に判定して表を埋める。
         *
         * **進むたびに呼び戻す。** 346件ぶん待ってから一度に描くと、
         * 待っている間の画面は「壊れている」と見分けが付かない。
         *
         * @param {object[]} records `libraryId` を持つ記録
         * @param {(done: number, total: number) => void} [onProgress]
         * @returns {Promise<{done: number, failed: number, ms: number}>}
         */
        async run(records, onProgress = null) {
            cancelled = false;
            const started = nowMs();
            const targets = (records || []).filter(r => r?.libraryId && !rows.has(String(r.libraryId)));
            const total = targets.length;
            let done = 0;
            let failed = 0;

            const inputs = await ensureInputs();
            let cursor = 0;
            const worker = async () => {
                while (!cancelled) {
                    const index = cursor;
                    cursor += 1;
                    if (index >= targets.length) return;
                    const record = targets[index];
                    const id = String(record.libraryId);
                    try {
                        const recipe = record.recipe || await loadRecord(id);
                        rows.set(id, await judgeOne(recipe, inputs));
                    } catch (error) {
                        // **判定器が落ちたことを「不足」と混ぜない。**
                        failed += 1;
                        rows.set(id, {
                            verdict: 'error',
                            rawStatus: null,
                            reasons: [String(error?.message || error)],
                            missing: { models: [], resources: [] },
                            conditions: FIXED_CONDITIONS,
                        });
                    }
                    done += 1;
                    onProgress?.(done, total);
                }
            };

            await Promise.all(
                Array.from({ length: Math.max(1, Math.min(concurrency, total || 1)) }, worker)
            );
            return { done, failed, ms: Math.round(nowMs() - started) };
        },
    };
}

/**
 * 表の内容を記録へ写す。**記録の側を書き換えて返す**（画面は記録しか見ない）。
 *
 * `error` は画面の4語に無いので `blocked` へ寄せるが、**理由に「判定できなかった」
 * と書く**——不足と同じ見た目にしたまま理由まで同じにすると、直す先を誤る。
 */
export function applyVerdicts(records, table) {
    return (records || []).map(record => {
        const row = record?.libraryId ? table.get(record.libraryId) : null;
        if (!row) return record;
        return {
            ...record,
            verdict: row.verdict === 'error' ? 'blocked' : row.verdict,
            verdictStatus: row.rawStatus,
            verdictBlocker: row.blocker ?? null,
            verdictFailed: row.verdict === 'error',
            blockedReason: row.reasons?.[0] || record.blockedReason || null,
            missing: row.missing,
            verdictConditions: row.conditions,
        };
    });
}

/** `performance.now()` が無い環境（Node のテスト）でも測れるようにする。 */
function nowMs() {
    return globalThis.performance?.now?.() ?? Date.now();
}
