/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 束を順に回す（手順13）。
 *
 * ---
 *
 * **実行器を新しく書かない。** 1件を投げて待って結果を拾うところは
 * `SweepRunner` が既に持っていて、実機で形が固まっている。ここがやるのは
 * **並べる・止める・数える**だけで、投げるのはあちらに任せる。
 *
 * 移した安全装置は3つ（どれも `recipeTrialRunner` 由来）:
 *
 *   1. **組めるかの門** … `buildBatch()` が判定 `blocked` を落とす。
 *      1件ずつなら投げ損ねても「1件失敗した」で済むが、束にすると
 *      **「N分待ってからまとめて失敗」**に化ける。
 *   2. **キューが空であることの要求** … 他人の生成に混ぜない。混ざると、
 *      出た画像がどの投入によるものか履歴から辿るしかなくなる。
 *   3. **本物の取消** … 旗を立てるだけでなく、キューに入ったものを実際に消す。
 *
 * ---
 *
 * **単位は「記録」ではなく「まだ出していない条件」。** 記録を単位にすると、
 * 既に絵がある記録も丸ごと回し直すことになる。
 *
 * **飛ばした件数を必ず返す。** 「N件回しました」だけだと、
 * **回らなかった分が黙って消える**——投げる前に落としたのか、既に出ていたのか、
 * 未判定だったのかで打つ手が違う。
 */

import { buildBatch } from './batchQueue.js';
import { t } from '../i18n/index.js';

/** これ以上は1回で回さない。**桁を間違えた指定で丸一日回らないため。** */
export const MAX_BATCH_ITEMS = 200;

/**
 * 束の実行器。
 *
 * @param {object} options
 * @param {(record: object) => object} options.makeRunner 記録1件ぶんの `SweepRunner`
 * @param {(record: object) => Promise<object>} options.loadRecord 本体を取る
 * @param {(record: object) => object} options.templateFor その記録へ当てる雛形
 */
export function createBatchRunner({ makeRunner, loadRecord = null, templateFor }) {
    if (typeof makeRunner !== 'function' || typeof templateFor !== 'function') {
        throw new TypeError('createBatchRunner: needs makeRunner() and templateFor()');
    }

    let running = false;
    let stopRequested = false;
    /** 今まさに走っている1件ぶんの実行器（取消の宛先）。 */
    let active = null;

    return {
        get running() { return running; },

        /**
         * 束を組んで回す。
         *
         * @returns {Promise<{done: object[], failed: object[], skipped: object, loads: object, stopped: boolean}>}
         */
        async run(records, {
            onProgress = null,
            stampedSignatures = null,
            wantedSignaturesOf = null,
            limit = MAX_BATCH_ITEMS,
            requireEmptyQueue = true,
        } = {}) {
            if (running) throw new Error(t('core.batch.busy'));
            const batch = buildBatch(records, { stampedSignatures, wantedSignaturesOf });
            const items = batch.items.slice(0, Math.max(0, Math.min(limit, MAX_BATCH_ITEMS)));
            // **切ったことを黙らせない。** 上限で落とした分も飛ばした数に入れる。
            const trimmed = batch.items.length - items.length;

            running = true;
            stopRequested = false;
            const done = [];
            const failed = [];
            try {
                if (items.length === 0) {
                    return {
                        done, failed, stopped: false,
                        skipped: { ...batch.skipped, trimmed },
                        loads: batch.loads,
                    };
                }

                // **投げる前に1回だけ確かめる。** 各件で確かめると、
                // 自分が投げたものを「他人の生成」と読んで2件目で止まる。
                if (requireEmptyQueue) {
                    const probe = makeRunner(items[0]);
                    if (probe.inputsReady?.then) await probe.inputsReady.catch(() => null);
                    await probe.requireEmptyQueue();
                }

                for (const [index, record] of items.entries()) {
                    if (stopRequested) break;
                    onProgress?.({ index, total: items.length, record, phase: 'start' });
                    try {
                        const recipe = record.recipe
                            || (loadRecord ? await loadRecord(record) : null);
                        const target = recipe ? { ...record, recipe } : record;
                        const runner = makeRunner(target);
                        active = runner;
                        // **材料が揃うのを待つ。** 実行器は同期で返るが `/object_info`
                        // は後から届く（人が押す Sweep では待っている間に揃うので出ない）。
                        // 待たずに投げると `objectInfo` 未設定で全件が落ちる
                        // ——実機で最初に回したとき **1件中1件がこれ**だった。
                        if (runner.inputsReady?.then) await runner.inputsReady;
                        const job = await runner.run({
                            record: recipe || target,
                            template: templateFor(target),
                            // **キューの確認は上で済ませてある。**
                            reuseExisting: true,
                        });
                        done.push({ record, job });
                    } catch (error) {
                        // **1件の失敗で束を止めない。** 止めると、後ろの分が
                        // 「回っていない」のか「落ちた」のか判らなくなる。
                        failed.push({ record, error: error?.message || String(error) });
                    } finally {
                        active = null;
                    }
                    onProgress?.({ index, total: items.length, record, phase: 'end' });
                }

                return {
                    done, failed, stopped: stopRequested,
                    skipped: { ...batch.skipped, trimmed },
                    loads: batch.loads,
                };
            } finally {
                running = false;
                active = null;
            }
        },

        /** 旗を立てるだけ。**投げ済みは触らない。** */
        stop() {
            stopRequested = true;
            active?.stop?.();
        },

        /**
         * **本物の取消。** 今走っている1件をキューから消し、束も止める。
         * @returns {Promise<{deleted: string[], interrupted: string[]}>}
         */
        async cancel() {
            stopRequested = true;
            if (!active?.cancel) return { deleted: [], interrupted: [] };
            return active.cancel();
        },
    };
}
