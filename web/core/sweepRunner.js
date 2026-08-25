/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Sweep を**実際に回す**層。
 *
 * `recipeSweep.js` が計画を組み（展開・適用・変更検査）、ここがそれを ComfyUI へ流す。
 * 分けてあるのは、**計画の正しさは実行しなくても確かめられる**から——実行は遅くて
 * 環境に依存するので、そこに検査を混ぜると計画の検査まで回せなくなる。
 *
 * 実行側の決めごとは4つ。どれも「壊れても赤くならない」種類のもの。
 *
 * 1. **投げる前に計画を1回全部組む（preflight）。** `buildSweepPlan` は基準セルと
 *    各セルのグラフを突き合わせて、**宣言した軸以外が動いていたら例外を投げる。**
 *    これが Sweep の商品性そのもので、走らせてから気づく形にはしない。
 * 2. **同じ signature のセルは回さない。** signature は「組み上がったグラフ」から
 *    採る（値ではなく結果）。既に回したものは `reused` で残る——**回した回数ではなく
 *    出た画像の枚数が揃っていること**が比較の前提なので、飛ばした事実も表に出す。
 * 3. **1セルごとに保存する。** 途中で閉じても、次に開いたときに続きから回せる。
 *    保存できなかったことは真偽値で返す（黙って飲むと、閉じた瞬間に全部消える）。
 * 4. **自動スコアは表示だけ。勝者は人間が選ぶ。** ここは採点しない。
 */

import { requireEnvironment } from './environment.js';
import { readStored, writeStored, removeStored } from './storage.js';
import { buildSweepPlan } from './recipeSweep.js';
import { t } from '../i18n/index.js';

const JOB_SCHEMA = 'unbake.sweep';
const JOB_VERSION = 1;
const JOB_PREFIX = 'unbake.sweep.job.';
const OUTPUT_INDEX_KEY = 'unbake.sweep.outputs';
const DEFAULT_POLL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** 終わった状態。**ここに入ったセルは二度と投げ直さない。** */
/**
 * これ以上投げない状態。
 *
 * `skipped` は**人が「投入しない」と決めたセル**。実機で、束を投げると ComfyUI が
 * 不安定になるという報告があり、こちらは元から1件ずつしか投げていない（実測: 待ち行列の
 * 深さは常に 1）。だが**投げる前に気が変わることがある**ので、順番が来る前に外せる
 * ようにした——`failed` と混ぜないのは、外したことと落ちたことで次に打つ手が違うから。
 */
const DONE_STATES = new Set(['completed', 'reused', 'failed', 'skipped']);

/**
 * **他の生成が走っているので受け付けなかった**、の印。
 *
 * 失敗ではあるが**こちらの落ち度ではなく、待てば通る**——呼び手はこれを
 * ほかの失敗と別に見せてよい（実際、ボタンを止まった姿にしている）。
 */
export const QUEUE_NOT_EMPTY = 'queue_not_empty';
/** 出た状態（比較に使える）。 */
const HAS_OUTPUT_STATES = new Set(['completed', 'reused']);

function clone(value) {
    return value === undefined || value === null ? null : JSON.parse(JSON.stringify(value));
}

function browserUuid() {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

/**
 * 生成履歴から画像を拾う。URL は `/api/view`——**Unbake の投入経路と同じ形**にして
 * あるので、出たセルをそのまま記録として落とし直せる（Sweep → 記録 → Sweep の輪）。
 */
export function sweepHistoryImages(entry) {
    const images = [];
    for (const output of Object.values(entry?.outputs || {})) {
        for (const image of output?.images || []) {
            if (!image?.filename) continue;
            const params = new URLSearchParams({
                filename: image.filename,
                type: image.type || 'output',
            });
            if (image.subfolder) params.set('subfolder', image.subfolder);
            images.push({
                filename: image.filename,
                subfolder: image.subfolder || '',
                type: image.type || 'output',
                url: `/api/view?${params.toString()}`,
            });
        }
    }
    return images;
}

/** 出た画像へ焼く印。**これが無いと、後から見て「どの実験の何番目か」が判らない。** */
export function buildSweepStamp(recordId, templateId, jobId, cell) {
    return {
        schema: JOB_SCHEMA,
        version: JOB_VERSION,
        record_id: String(recordId ?? ''),
        template_id: String(templateId ?? ''),
        job_id: String(jobId ?? ''),
        cell_id: String(cell?.id ?? ''),
        signature: String(cell?.signature ?? ''),
        seed: cell?.seed ?? null,
        baseline: cell?.baseline === true,
        labels: (cell?.labels || []).map(({ axis, label, value, valueLabel, baseline }) => ({
            axis, label, value, valueLabel, baseline,
        })),
    };
}

/** 保存する形。**グラフと記録は落とす**——1セルあたり数十KBあり、入れ物が溢れる。 */
function serializableJob(job) {
    return {
        schema: JOB_SCHEMA,
        version: JOB_VERSION,
        id: job.id,
        recordId: job.recordId,
        templateId: job.templateId,
        status: job.status,
        updatedAt: job.updatedAt,
        cells: job.cells.map(({ recipe: _recipe, workflow: _workflow, ...cell }) => cell),
    };
}

export class SweepRunner {
    /**
     * @param {object} options
     * @param {object} options.objectInfo 宿主の `/object_info`（**必須**）
     * @param {Array} [options.embeddings] 導入済みの埋め込み一覧。**再現側と揃える**
     *   ——片方だけ欠けると、同じ記録でも Sweep のグラフだけ埋め込みが効かない。
     */
    constructor({
        objectInfo = null,
        embeddings = null,
        knownModelCatalog = null,
        maxReplayPixels = 0,
        request = null,
        now = () => Date.now(),
        sleep = milliseconds => new Promise(resolve => { setTimeout(resolve, milliseconds); }),
        uuid = browserUuid,
        pollIntervalMs = DEFAULT_POLL_MS,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        plan = buildSweepPlan,
        loadRecordOutputs = null,
    } = {}) {
        this.objectInfo = objectInfo;
        this.embeddings = embeddings;
        this.knownModelCatalog = knownModelCatalog;
        this.maxReplayPixels = maxReplayPixels;
        this.injectedRequest = request;
        this.now = now;
        this.sleep = sleep;
        this.uuid = uuid;
        this.pollIntervalMs = pollIntervalMs;
        this.timeoutMs = timeoutMs;
        // **ディスク由来の索引。** 呼び手（ホスト）が据える。
        this.loadRecordOutputs = loadRecordOutputs;
        this.plan = plan;
        this.currentJob = null;
        this.running = false;
        this.stopRequested = false;
        this.onUpdate = null;
    }

    request(input, init) {
        const doRequest = this.injectedRequest || requireEnvironment().request;
        return doRequest(input, init);
    }

    async jsonRequest(url, options = {}, label = 'ComfyUI request') {
        const response = await this.request(url, options);
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const detail = payload?.message || payload?.error?.message || payload?.error
                || `${label} failed (${response.status})`;
            throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
        }
        return payload;
    }

    emit(job = this.currentJob) {
        if (typeof this.onUpdate === 'function') this.onUpdate(clone(serializableJob(job)));
    }

    // --- 保存 ---------------------------------------------------------

    jobKey(recordId, templateId) {
        return `${JOB_PREFIX}${encodeURIComponent(String(recordId))}.${encodeURIComponent(String(templateId))}`;
    }

    /** 途中で終わっている実験を拾う。無ければ null。 */
    storedJob(recordId, templateId) {
        const job = readStored(this.jobKey(recordId, templateId), null);
        if (!job || job.schema !== JOB_SCHEMA || job.version !== JOB_VERSION) return null;
        return job;
    }

    forgetJob(recordId, templateId) {
        return removeStored(this.jobKey(recordId, templateId));
    }

    persist(job) {
        job.updatedAt = this.now();
        const ok = writeStored(this.jobKey(job.recordId, job.templateId), serializableJob(job));
        job.storagePersisted = ok;
        return ok;
    }

    /**
     * signature → 出た画像 の索引。**実験をまたいで効く。**
     *
     * 同じ雛形を別の日に回し直したとき、既に出ているセルを回し直すのは
     * 時間の無駄であるだけでなく、**同じ条件から別の画像が2枚できる**ので
     * どちらを比べたのか判らなくなる。
     */
    outputIndex() {
        const stored = readStored(OUTPUT_INDEX_KEY, {});
        return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    }

    /**
     * **ディスクに出ている分を索引へ入れる。**
     *
     * 手元の入れ物（`localStorage`）に入るのは「このブラウザでこの Unbake が
     * 回した分」だけで、実測ではそれが**3枚**しか無かった。索引の意味は
     * 「同じ条件をもう一度回さない」ことなので、**入れ物ではなく出力フォルダを
     * 真実源にする**と、次の3つが同時に直る:
     *
     *   - 別のブラウザ・別の窓で回した分が効く
     *   - 入れ物を消しても効く（`localStorage` は消える）
     *   - **新しい環境でも2回目の実験から効く**（＝誰にでも効く恒久の利得）
     *
     * 印が読めた分だけを入れる。**指紋での推定はここへ混ぜない**——
     * 「既に出ている」は回し直しを止める判断なので、**推定で止めない。**
     */
    async loadDiskOutputs(recordId) {
        if (typeof this.loadRecordOutputs !== 'function' || !recordId) return {};
        let result;
        try {
            result = await this.loadRecordOutputs(recordId);
        } catch {
            return {};
        }
        const index = {};
        for (const entry of result?.outputs || []) {
            const signature = entry?.sweep?.signature;
            if (!signature) continue;
            const query = new URLSearchParams({
                filename: String(entry.filename || ''),
                subfolder: String(entry.subfolder || ''),
                type: 'output',
            });
            index[String(signature)] = {
                url: `/api/view?${query.toString()}`,
                filename: entry.filename,
                subfolder: entry.subfolder,
                // **どこから来た索引かを残す。** 手元の入れ物と混ざると、
                // 「消したのに残っている」の理由が読めない。
                source: 'disk',
            };
        }
        return index;
    }

    rememberOutput(signature, output) {
        if (!signature || !output?.url) return false;
        const index = this.outputIndex();
        index[signature] = output;
        return writeStored(OUTPUT_INDEX_KEY, index);
    }

    /** 索引を捨てる（全部回し直したいとき）。 */
    forgetOutputs() {
        return removeStored(OUTPUT_INDEX_KEY);
    }

    // --- 計画 ---------------------------------------------------------

    /**
     * 投げずに計画だけ組む。**`buildSweepPlan` がここで変更検査を通す**ので、
     * 宣言した軸以外が動く雛形はこの時点で例外になる。
     *
     * @returns {{cells: object[], baselineId: string, cellCount: number, estimatedSeconds: number}}
     */
    preflight(record, template, { secondsPerCell = 60 } = {}) {
        if (!this.objectInfo || typeof this.objectInfo !== 'object') {
            throw new TypeError('SweepRunner: objectInfo must be supplied by the caller (the host fetches /object_info)');
        }
        const plan = this.plan(record, template, {
            objectInfo: this.objectInfo,
            embeddings: this.embeddings,
            knownModelCatalog: this.knownModelCatalog,
            maxReplayPixels: this.maxReplayPixels,
        });
        // **見積もりは計画そのものから出す。** `estimateSweep` は雛形を独立に展開し直すので、
        // 編集中の安い概算には使えるが、ここで使うと**画面に出る件数と実際に回る件数が
        // 別の計算から来る**。ずれても例外にならないので、ずれたまま出続ける。
        const cellCount = plan.cells.length;
        const perCell = Number.isFinite(Number(secondsPerCell)) && Number(secondsPerCell) >= 0
            ? Number(secondsPerCell)
            : 60;
        return { ...plan, cellCount, estimatedSeconds: Math.ceil(cellCount * perCell) };
    }

    // --- 実行 ---------------------------------------------------------

    async queueCell(job, cell) {
        cell.status = 'running';
        cell.error = null;
        this.persist(job);
        this.emit(job);

        const promptId = this.uuid();
        const stamp = buildSweepStamp(job.recordId, job.templateId, job.id, cell);
        let queued;
        try {
            queued = await this.jsonRequest('/prompt', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Comfy-Usage-Source': 'unbake-sweep',
                },
                body: JSON.stringify({
                    // **手元で解決し切ったグラフをそのまま投げる。**
                    // フォークの整形エンドポイントは使わない（独立した拡張であること）。
                    prompt: cell.workflow.prompt,
                    prompt_id: promptId,
                    extra_data: {
                        unbake_sweep: stamp,
                        // ComfyUI が PNG へ焼くのは `extra_pnginfo` の中身だけ。
                        extra_pnginfo: { unbake_sweep: stamp },
                    },
                }),
            }, 'Prompt submission');
        } catch (error) {
            // **投げたか判らない。** 失敗と混ぜず、投げ直しもしない。
            cell.status = 'submission_unknown';
            cell.promptId = promptId;
            cell.error = t('core.sweep.cell.submitUnknown', { reason: error?.message || String(error) });
            this.persist(job);
            this.emit(job);
            return false;
        }
        if (queued?.prompt_id && queued.prompt_id !== promptId) {
            cell.status = 'submission_unknown';
            cell.promptId = queued.prompt_id;
            cell.error = t('core.sweep.cell.promptIdMismatch');
            this.persist(job);
            this.emit(job);
            return false;
        }
        cell.promptId = promptId;
        cell.status = 'queued';
        this.persist(job);
        this.emit(job);
        return true;
    }

    /**
     * 1つの投入が終わるのを待つ。
     * @returns {Promise<object|null>} 決着した状態。**停止要求で抜けたときは null。**
     */
    async waitForPrompt(promptId) {
        const startedAt = this.now();
        while (!this.stopRequested) {
            if (this.now() - startedAt >= this.timeoutMs) {
                return { status: 'failed', error: t('core.sweep.cell.timeout') };
            }
            await this.sleep(this.pollIntervalMs);
            if (this.stopRequested) break;
            const history = await this.jsonRequest(
                `/history/${encodeURIComponent(promptId)}`, {}, 'History check'
            ).catch(() => null);
            const entry = history?.[promptId];
            if (!entry) continue;
            const status = String(entry?.status?.status_str || '').toLowerCase();
            if (status === 'error') {
                return { status: 'failed', error: t('core.sweep.cell.failed') };
            }
            if (entry?.status?.completed === true || status === 'success') {
                const images = sweepHistoryImages(entry);
                return images.length
                    ? { status: 'completed', output: images[0], outputs: images }
                    : { status: 'failed', error: t('core.sweep.cell.noImages') };
            }
        }
        return null;
    }

    /**
     * 実験を回す（初回も再開も同じ入口）。
     *
     * @param {object} params
     * @param {object} params.record 記録
     * @param {object} params.template 軸の宣言
     * @param {(job: object) => void} [params.onUpdate] 1セルごとに呼ばれる
     * @param {boolean} [params.reuseExisting] 既に出ているセルを飛ばすか（既定 true）
     */
    async run({
        record, template, onUpdate = null, reuseExisting = true,
        /**
         * **投げる直前に**キューが空であることを要求する（2026-08-24）。
         *
         * 元は呼び手が `run()` の**手前で** `requireEmptyQueue()` を呼んでいた。
         * だが**既に出ている絵をそのまま出すだけの回**は、キューへ1件も投げない
         * （`reused` は `DONE_STATES` なので投入の輪を素通りする）。
         * それでも手前で弾いていたので、**他の生成が走っている間は、
         * 出来上がっている絵すら開けなかった**（実機の報告・2026-08-24）。
         *
         * **要求するのは、本当に投げるときだけでよい。**
         */
        requireEmptyQueueBeforeSubmit = false,
    }) {
        if (this.running) throw new Error(t('core.sweep.busy'));
        const recordId = String(record?.id ?? record?.recipe_id ?? '');
        if (!recordId) throw new Error(t('core.sweep.noRecordId'));
        const templateId = String(template?.id ?? '');
        if (!templateId) throw new Error(t('core.sweep.noTemplateId'));

        this.onUpdate = onUpdate;
        // **投げる前に全部組む。** ここで変更検査に落ちたら1件も投げない。
        const plan = this.preflight(record, template);

        const stored = this.storedJob(recordId, templateId);
        // **`reuseExisting: false` は「全部回し直す」。** 索引だけ無視して保存済みの
        // 状態を重ねると、前回 `completed` になったセルが飛ばされ、
        // **指示したのに1件も回らない**（それでも「完了」と出るので気づけない）。
        const storedCells = reuseExisting
            ? new Map((stored?.cells || []).map(cell => [cell.signature, cell]))
            : new Map();
        // **ディスクが先、手元の入れ物が後。** 出力フォルダに実在する分のほうが
        // 強い証拠で、入れ物のほうは消えていることがある。
        const outputs = reuseExisting
            ? { ...this.outputIndex(), ...(await this.loadDiskOutputs(recordId)) }
            : {};

        const cells = plan.cells.map(cell => {
            const reused = outputs[cell.signature];
            if (reused?.url) {
                return { ...cell, status: 'reused', output: reused, error: null };
            }
            const previous = storedCells.get(cell.signature);
            // 保存された状態を重ねる。**グラフと記録は今組んだものを使う**——
            // 保存には入っていないし、雛形が変わっていれば signature も変わる。
            return {
                ...cell,
                ...(previous || {}),
                recipe: cell.recipe,
                workflow: cell.workflow,
                signature: cell.signature,
            };
        });

        const job = {
            schema: JOB_SCHEMA,
            version: JOB_VERSION,
            id: stored?.id || `job-${this.uuid()}`,
            recordId,
            templateId,
            status: 'running',
            updatedAt: this.now(),
            cells,
        };
        // **1件も投げないなら、キューの状態は関係が無い**（2026-08-24 実機の報告）。
        // 既に出ている分は `reused` として `DONE_STATES` に入り、下の輪を素通りする
        // ——**投入が0件の回まで「キューが空であること」を要求していた**ので、
        // 他の生成が走っている間は**出来上がっている絵すら開けなかった**。
        //
        // **輪の中ではなく手前で確かめる。** 中で投げると、内側の `catch` が
        // セルを `failed` にして**「完了・0枚」に化ける**——断られたことが伝わらない。
        if (requireEmptyQueueBeforeSubmit && cells.some(cell => !DONE_STATES.has(cell.status))) {
            await this.requireEmptyQueue();
        }

        this.currentJob = job;
        this.running = true;
        this.stopRequested = false;
        this.persist(job);
        this.emit(job);

        try {
            for (const cell of cells) {
                if (this.stopRequested) break;
                if (DONE_STATES.has(cell.status)) continue;
                try {
                    // 前回投げたまま閉じた場合は、**投げ直さずに待つ。**
                    const alreadyQueued = (cell.status === 'queued' || cell.status === 'running')
                        && Boolean(cell.promptId);
                    const submitted = alreadyQueued || await this.queueCell(job, cell);
                    if (!submitted) continue;
                    if (this.stopRequested) break;
                    const verdict = await this.waitForPrompt(cell.promptId);
                    if (!verdict) break;
                    Object.assign(cell, verdict);
                    if (verdict.status === 'completed') {
                        this.rememberOutput(cell.signature, verdict.output);
                    }
                } catch (error) {
                    cell.status = 'failed';
                    cell.error = error?.message || String(error);
                }
                this.persist(job);
                this.emit(job);
            }

            const unfinished = cells.some(cell => !DONE_STATES.has(cell.status));
            job.status = unfinished ? 'paused' : 'completed';
            this.persist(job);
            this.emit(job);
            return clone(serializableJob(job));
        } finally {
            this.running = false;
        }
    }

    /** 止める。**投げ済みのものは取り消さない**——結果は履歴から拾い直せる。 */
    stop() {
        this.stopRequested = true;
    }

    // --- 束で回すための2つの安全装置（手順13）---------------------------
    //
    // どちらも `recipeTrialRunner` が既に持っていたものを移した。
    // **新しく考えない**——あちらは実機で使われて形が固まっている。

    /** ComfyUI のキューの様子。 */
    queueState() {
        return this.jsonRequest('/queue', {}, 'Queue check');
    }

    /**
     * **キューが空であることを要求する。**
     *
     * 他人の生成に混ぜない——混ざると、出た画像がどの投入によるものか
     * 履歴から辿るしかなくなり、失敗したときに切り分けができない。
     * 束にするほど効く（1件ずつなら目で見て判る）。
     */
    async requireEmptyQueue() {
        const queue = await this.queueState();
        const busy = (queue?.queue_running || []).length > 0
            || (queue?.queue_pending || []).length > 0;
        if (!busy) return;
        // **理由を種類で返す**（2026-08-24）。呼び手は「押したが受け付けなかった」を
        // ほかの失敗と別に見せたい（ボタンを止まった姿にする）が、
        // **文言を読んで当てさせない**——訳が変わった日に分岐が黙って死ぬ。
        const error = new Error(t('core.sweep.queueNotEmpty'));
        error.code = QUEUE_NOT_EMPTY;
        throw error;
    }

    /**
     * **本物の取消。** 旗を立てるだけの `stop()` と違い、
     * 既にキューへ入ったものを実際に消し、走っているものを止める。
     *
     * **投げたか判らないものは触らない**（`submission_unknown`）——
     * 消しにいって「無い」と言われたのを成功と読むと、二重生成に気づけない。
     *
     * @returns {Promise<{deleted: string[], interrupted: string[]}>}
     */
    async cancel() {
        this.stopRequested = true;
        const job = this.currentJob;
        if (!job) return { deleted: [], interrupted: [] };
        job.status = 'canceled';

        const queue = await this.queueState()
            .catch(() => ({ queue_running: [], queue_pending: [] }));
        const idsOf = (items) => new Set((items || [])
            .map(item => (Array.isArray(item) ? item[1] : item?.prompt_id))
            .filter(Boolean)
            .map(String));
        const running = idsOf(queue.queue_running);
        const pending = idsOf(queue.queue_pending);

        const deleted = [];
        const interrupted = [];
        for (const cell of job.cells || []) {
            if (!cell.promptId) {
                if (cell.status === 'pending') cell.status = 'canceled';
                continue;
            }
            if (pending.has(String(cell.promptId))) deleted.push(String(cell.promptId));
            if (running.has(String(cell.promptId))) {
                interrupted.push(String(cell.promptId));
                await this.request('/interrupt', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt_id: cell.promptId }),
                }).catch(() => null);
            }
            if (!DONE_STATES.has(cell.status) && cell.status !== 'submission_unknown') {
                cell.status = 'canceled';
            }
        }
        if (deleted.length > 0) {
            await this.request('/queue', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ delete: deleted }),
            }).catch(() => null);
        }
        this.persist(job);
        this.emit(job);
        return { deleted, interrupted };
    }
}

/**
 * その記録を Sweep にかけられるか。**かけられない理由を返す**——
 * 押せないボタンだけ出すと「壊れている」と読まれる。
 *
 * かけられるのは**レシピ由来の記録**だけ。捕捉した画像は実行したグラフを
 * そのまま持っていて、`applySweepCell` が扱う `gen_params`/`loras`/`checkpoint` の
 * 形を持っていない。**組み直せば形は作れるが、それは捕捉したグラフを捨てて
 * 近似を作ることになる**——「埋まっているグラフをそのまま使う」ことが
 * 捕捉の価値そのものなので、黙って別のものへすり替えない。
 *
 * @returns {{ok: boolean, recipe: object|null, reason: string|null}}
 */
export function sweepableRecord(record) {
    if (!record || typeof record !== 'object') {
        return { ok: false, recipe: null, reason: 'not-a-record' };
    }
    const recipe = record.recipe;
    if (!recipe || typeof recipe !== 'object') {
        return { ok: false, recipe: null, reason: 'no-recipe-payload' };
    }
    if (!(recipe.id ?? record.id)) {
        return { ok: false, recipe: null, reason: 'no-record-id' };
    }
    return { ok: true, recipe: { ...recipe, id: recipe.id ?? record.id }, reason: null };
}

/**
 * 実験の状態を1行にまとめる。
 *
 * **「N/M 完了」だけでは足りない。** 飛ばした（`reused`）と投げたか判らない
 * （`submission_unknown`）を完了に混ぜると、比較に使える画像の枚数が判らなくなる。
 */
export function summarizeSweep(job) {
    const cells = job?.cells || [];
    const count = status => cells.filter(cell => cell.status === status).length;
    const withOutput = cells.filter(cell => HAS_OUTPUT_STATES.has(cell.status) && cell.output?.url);
    return {
        status: job?.status || 'unknown',
        total: cells.length,
        completed: count('completed'),
        reused: count('reused'),
        failed: count('failed'),
        unknown: count('submission_unknown'),
        pending: cells.filter(cell => !DONE_STATES.has(cell.status)).length,
        comparable: withOutput.length,
        baselineHasOutput: withOutput.some(cell => cell.baseline === true),
    };
}
