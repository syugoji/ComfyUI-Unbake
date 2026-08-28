/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 試行——**記録を実際に ComfyUI へ流して、再現できるかを目で確かめる。**
 *
 * `recipeReplayCapability` が出すのは「組めるか」という静的な判定で、それは
 * **実際に回したこととは違う**。ここは組んだものを 4 つの seed で投げ、出た画像を
 * 記録へ結び付けて残す。1つ目は記録に書いてある seed（＝完全再現の候補）、
 * 残り3つは無作為（＝seed 以外が合っているかを見るための対照）。
 *
 * 上流の同名の実装との違いは3つで、どれも切り出しの条件から来ている。
 *
 * 1. **フォークの `/api/lm/load-recipe-workflow` を使わない。** あちらは組んだ
 *    グラフをサーバ側で整えてから投げていた。Unbake は `objectInfo` を宿主から
 *    受け取って**手元で解決し切る**ので、`/prompt` へ直接投げられる。フォークの
 *    エンドポイントに依存したままでは、独立した拡張として動かない。
 * 2. **AI下書きを前提にしない。** 既定は「記録どおりを回す」で、文言の差し替えは
 *    `overrides` として任意で受ける。下書きの生成そのものは Unbake の面の外。
 * 3. **HTTP と保存を注入で受ける。** `core/` は自分で外へ出ない。
 *
 * 全体を貫く安全側の決めごと: **同じ候補を自動で投げ直さない。** 投げたかどうかが
 * 判らない状態（`submission_unknown`）を「失敗」と混ぜると、再送で二重生成が起き、
 * どちらが記録の再現なのか判らなくなる。判らないものは判らないまま残す。
 */

import { requireEnvironment } from './environment.js';
import { readStored, writeStored, removeStored } from './storage.js';
import { analyzeRecipeReplayCapability } from './recipeReplayCapability.js';
import { outputImageUrl } from './outputUrl.js';
import { t } from '../i18n/index.js';

const STORAGE_PREFIX = 'unbake.trial.';
const JOB_SCHEMA = 'unbake.trial';
const JOB_VERSION = 1;
const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_POLL_MS = 1500;
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const CANDIDATE_COUNT = 4;

/** これ以上動かない状態。**ここに入ったものは二度と投げ直さない。** */
const TERMINAL_STATES = new Set([
    'succeeded', 'failed', 'canceled', 'not_submitted', 'submission_unknown',
]);

/** 出来上がりとみなす状態。 */
const FINISHED_JOB_STATES = new Set(['completed', 'partial', 'failed', 'canceled']);

function safeIntegerSeed(value) {
    const seed = Number(value);
    if (!Number.isSafeInteger(seed) || seed < 0 || seed >= Number.MAX_SAFE_INTEGER) return null;
    return seed;
}

function browserRandomSeed() {
    const values = new Uint32Array(2);
    globalThis.crypto.getRandomValues(values);
    return (values[0] & 0xfffff) * 0x100000000 + values[1];
}

function browserUuid() {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0'));
    return [
        hex.slice(0, 4).join(''), hex.slice(4, 6).join(''), hex.slice(6, 8).join(''),
        hex.slice(8, 10).join(''), hex.slice(10).join(''),
    ].join('-');
}

/**
 * 試行する seed を4つ決める。
 *
 * 記録に seed があれば**必ず1本目**に入れる（origin=`original`）。無ければ4本とも
 * 無作為になり、そのときは「完全再現の候補が無い」ことが `origin` から読める。
 * 重複は避ける——同じ seed を2回回しても対照にならない。
 */
export function createTrialSeeds(originalSeed, randomSeed = browserRandomSeed) {
    const original = safeIntegerSeed(originalSeed);
    const used = new Set();
    const result = [];
    if (original !== null) {
        used.add(original);
        result.push({ seed: original, origin: 'original' });
    }
    while (result.length < CANDIDATE_COUNT) {
        let candidate = null;
        for (let attempt = 0; attempt < 64; attempt += 1) {
            const value = safeIntegerSeed(randomSeed());
            if (value !== null && !used.has(value)) {
                candidate = value;
                break;
            }
        }
        if (candidate === null) {
            // 無作為源が同じ値ばかり返す環境でも止まらない。
            candidate = 0;
            while (used.has(candidate)) candidate += 1;
        }
        used.add(candidate);
        result.push({ seed: candidate, origin: 'random' });
    }
    return result;
}

function queuePromptIds(items) {
    return new Set((Array.isArray(items) ? items : [])
        .map(item => (Array.isArray(item) ? item[1] : null))
        .filter(value => typeof value === 'string'));
}

/**
 * 生成履歴から画像を拾う。**出力ノードごとに番号を振る**——同じ枝から複数枚出る
 * 構成があるので、通し番号だけだとどの枝の何枚目か判らなくなる。
 *
 * URL は `/api/view`。Unbake の投入経路（`dropRouting`）が見るのと同じ形にしてあり、
 * **試行の結果をそのまま Unbake へ落とし直せる。**
 */
export function historyImages(entry) {
    const images = [];
    const visit = (value, outputNodeId) => {
        if (Array.isArray(value)) {
            for (const item of value) visit(item, outputNodeId);
            return;
        }
        if (!value || typeof value !== 'object') return;
        if (typeof value.filename === 'string') {
            const normalized = {
                filename: value.filename,
                subfolder: typeof value.subfolder === 'string' ? value.subfolder : '',
                type: typeof value.type === 'string' ? value.type : 'output',
                output_node_id: outputNodeId,
                image_index: images.filter(item => item.output_node_id === outputNodeId).length,
            };
            // **組み立ては `core/outputUrl.js` の1本だけ**（2026-08-29）。
            // 履歴から来た1枚は mtime も大きさも判らないので、印は毎回変わる形になる
            // ——**出したばかりの絵が古い中身で出る**のを防ぐには、それが正しい。
            normalized.url = outputImageUrl(normalized, { type: normalized.type });
            images.push(normalized);
            return;
        }
        for (const nested of Object.values(value)) visit(nested, outputNodeId);
    };
    for (const [nodeId, output] of Object.entries(entry?.outputs || {})) {
        visit(output, nodeId);
    }
    return images;
}

/** 履歴に残った失敗の理由。**最後の1件が最も具体的**なので後ろから探す。 */
function historyFailureMessage(entry) {
    const messages = entry?.status?.messages;
    if (Array.isArray(messages)) {
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            const detail = Array.isArray(messages[index]) ? messages[index][1] : null;
            const message = detail?.exception_message || detail?.message || detail?.error;
            if (typeof message === 'string' && message.trim()) return message.trim();
        }
    }
    return t('core.trial.failed');
}

function clone(value) {
    return value === undefined || value === null ? null : JSON.parse(JSON.stringify(value));
}

function recordIdOf(record) {
    const id = record?.id ?? record?.recipe_id;
    return id === undefined || id === null || id === '' ? null : String(id);
}

export class RecipeTrialRunner {
    /**
     * @param {object} [options]
     * @param {object} options.objectInfo 宿主の `/object_info`（**必須**・判定の材料）
     * @param {Array} [options.embeddings] 導入済みの埋め込み一覧
     * @param {object} [options.knownModelCatalog]
     */
    constructor({
        objectInfo = null,
        embeddings = null,
        knownModelCatalog = null,
        analyze = analyzeRecipeReplayCapability,
        request = null,
        now = () => Date.now(),
        sleep = milliseconds => new Promise(resolve => { setTimeout(resolve, milliseconds); }),
        randomSeed = browserRandomSeed,
        uuid = browserUuid,
        pollIntervalMs = DEFAULT_POLL_MS,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        warn = message => { console.warn(message); },
    } = {}) {
        this.objectInfo = objectInfo;
        this.embeddings = embeddings;
        this.knownModelCatalog = knownModelCatalog;
        this.analyze = analyze;
        this.injectedRequest = request;
        this.now = now;
        this.sleep = sleep;
        this.randomSeed = randomSeed;
        this.uuid = uuid;
        this.pollIntervalMs = pollIntervalMs;
        this.timeoutMs = timeoutMs;
        this.warn = warn;
        this.currentJob = null;
        this.onUpdate = null;
        this.running = false;
        this.cancelRequested = false;
    }

    /** HTTP の実体。**注入が無ければ環境から取る**（core は自分で外へ出ない）。 */
    request(input, init) {
        const doRequest = this.injectedRequest || requireEnvironment().request;
        return doRequest(input, init);
    }

    storageKey(recordId) {
        return `${STORAGE_PREFIX}${encodeURIComponent(String(recordId))}`;
    }

    /**
     * 保存してある試行。**期限切れは読んだ時点で消す**——24時間前の未完了が
     * いつまでも「未完了があります」と言い続けると、次の試行が永久に始められない。
     */
    readStoredJob(recordId) {
        const job = readStored(this.storageKey(recordId), null);
        if (!job || job.schema !== JOB_SCHEMA || job.version !== JOB_VERSION) return null;
        if (Number(job.expires_at) <= this.now()) {
            removeStored(this.storageKey(recordId));
            return null;
        }
        return job;
    }

    persist(job) {
        return writeStored(this.storageKey(job.record_id), job);
    }

    /** 保存してある試行を捨てる。 */
    forget(recordId) {
        return removeStored(this.storageKey(recordId));
    }

    emit(job = this.currentJob) {
        if (typeof this.onUpdate === 'function') this.onUpdate(clone(job));
    }

    async jsonRequest(url, options = {}, label = 'ComfyUI request') {
        const response = await this.request(url, options);
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const detail = payload?.message
                || payload?.error?.message
                || payload?.error
                || `${label} failed (${response.status})`;
            throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
        }
        return payload;
    }

    queueState() {
        return this.jsonRequest('/queue', {}, 'Queue check');
    }

    /**
     * キューが空であることを要求する。
     *
     * **他人の生成に混ぜない**ため。混ざると、出た画像がどの投入によるものか
     * 履歴から辿るしかなくなり、失敗したときに切り分けができない。
     */
    async requireEmptyQueue() {
        const queue = await this.queueState();
        const busy = (queue?.queue_running || []).length > 0 || (queue?.queue_pending || []).length > 0;
        if (busy) throw new Error(t('core.trial.queueNotEmpty'));
    }

    createJob(record, { manifestHash = '', overrides = null } = {}) {
        const createdAt = this.now();
        const recordId = recordIdOf(record);
        const seedSource = overrides?.seed ?? record?.gen_params?.seed;
        const seeds = createTrialSeeds(seedSource, this.randomSeed);
        return {
            schema: JOB_SCHEMA,
            version: JOB_VERSION,
            job_id: this.uuid(),
            record_id: recordId,
            record_title: String(record?.title || recordId || ''),
            manifest_hash: String(manifestHash || ''),
            overrides: clone(overrides),
            created_at: createdAt,
            expires_at: createdAt + JOB_TTL_MS,
            status: 'running',
            active_index: null,
            error: null,
            candidates: seeds.map((item, index) => ({
                index,
                candidate_id: `${recordId}:${createdAt}:${index}`,
                seed: item.seed,
                seed_origin: item.origin,
                status: 'pending',
                prompt_id: null,
                attempted_at: null,
                images: [],
                error: null,
            })),
        };
    }

    /** 記録に seed（と任意の差し替え）を重ねた、投げる用の複製。**元は変えない。** */
    trialRecord(record, seed, overrides = null) {
        const genParams = { ...(record?.gen_params || {}), seed };
        if (overrides && typeof overrides === 'object') {
            if (typeof overrides.prompt === 'string') genParams.prompt = overrides.prompt;
            if (typeof overrides.negative_prompt === 'string') {
                genParams.negative_prompt = overrides.negative_prompt;
            }
        }
        return { ...record, gen_params: genParams };
    }

    /**
     * 投げるグラフを組む。**組めなければここで止まる**——投げてから気づくと、
     * キューに半端なものが残る。
     */
    async prepareWorkflow(record, seed, overrides = null) {
        const analysis = await this.analyze(this.trialRecord(record, seed, overrides), {
            objectInfo: this.objectInfo,
            embeddings: this.embeddings,
            knownModelCatalog: this.knownModelCatalog,
        });
        if (analysis?.level === 'unavailable' || !analysis?.built?.prompt) {
            throw new Error((analysis?.reasons || []).join(' / ') || t('core.trial.unbuildable'));
        }
        if (analysis.built.replayManifest && analysis?.audit?.ok !== true) {
            const detail = (analysis?.audit?.failures || [])
                .map(item => item?.message)
                .filter(Boolean)
                .join(' / ');
            // **遮断しない。** 近似でも回して見た方が、判定だけ見るより速く分かる。
            // ただし「完全再現ではない」ことは残す——黙って通すと、出た画像が
            // 記録の再現だったのか近似だったのか、後から区別できなくなる。
            this.warn(t('core.trial.auditWarning', { detail: detail || t('core.trial.noDetail') }));
        }
        return {
            prompt: analysis.built.prompt,
            manifestHash: String(analysis.built.replayManifest?.manifest_hash || ''),
            level: analysis.level,
        };
    }

    async submitCandidate(job, candidate, prompt) {
        candidate.prompt_id = this.uuid();
        candidate.attempted_at = this.now();
        candidate.status = 'submitting';
        job.active_index = candidate.index;
        this.persist(job);
        this.emit(job);

        const stamp = {
            schema: JOB_SCHEMA,
            version: JOB_VERSION,
            job_id: job.job_id,
            record_id: job.record_id,
            manifest_hash: job.manifest_hash,
            candidate_id: candidate.candidate_id,
            candidate_index: candidate.index,
            seed: candidate.seed,
            seed_origin: candidate.seed_origin,
        };

        let payload;
        try {
            payload = await this.jsonRequest('/prompt', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Comfy-Usage-Source': 'unbake-trial',
                },
                body: JSON.stringify({
                    prompt,
                    prompt_id: candidate.prompt_id,
                    extra_data: {
                        unbake_trial: stamp,
                        // **PNG に載る側にも同じ印を置く。** ComfyUI は
                        // `extra_pnginfo` の中身だけを画像へ焼くので、ここへ入れて
                        // おかないと、出た画像を Unbake へ落とし直したときに
                        // 「どの試行の何番目か」が失われる。
                        extra_pnginfo: { unbake_trial: stamp },
                    },
                }),
            }, 'Prompt submission');
        } catch (error) {
            // **投げたかどうかが判らない。** 失敗と混ぜない。
            candidate.status = 'submission_unknown';
            candidate.error = t('core.trial.submitUnknown', { reason: error?.message || String(error) });
            this.persist(job);
            this.emit(job);
            throw error;
        }
        if (payload.prompt_id !== candidate.prompt_id) {
            candidate.status = 'submission_unknown';
            candidate.error = t('core.trial.promptIdMismatch');
            this.persist(job);
            this.emit(job);
            throw new Error(candidate.error);
        }
        candidate.status = 'queued';
        this.persist(job);
        this.emit(job);
    }

    /** 履歴の1件を候補へ反映する。**決着が付いたときだけ true。** */
    applyHistory(candidate, entry) {
        if (!entry) return false;
        const completed = entry?.status?.completed === true;
        const status = String(entry?.status?.status_str || '').toLowerCase();
        if (!completed && status !== 'error') return false;
        if (status === 'error') {
            candidate.status = 'failed';
            candidate.error = historyFailureMessage(entry);
            return true;
        }
        const images = historyImages(entry);
        if (images.length === 0) {
            // 完了したのに画像が無い＝保存ノードが繋がっていない構成。
            // 成功にすると「再現できた」と読まれるので失敗にする。
            candidate.status = 'failed';
            candidate.error = t('core.trial.noImages');
            return true;
        }
        candidate.status = 'succeeded';
        candidate.images = images;
        candidate.error = null;
        return true;
    }

    async historyEntry(promptId) {
        const history = await this.jsonRequest(
            `/history/${encodeURIComponent(promptId)}`, {}, 'History check'
        );
        return history?.[promptId] || null;
    }

    async pollCandidate(job, candidate) {
        const startedAt = this.now();
        while (!this.cancelRequested && this.now() - startedAt < this.timeoutMs) {
            const entry = await this.historyEntry(candidate.prompt_id);
            if (this.applyHistory(candidate, entry)) {
                this.persist(job);
                this.emit(job);
                return candidate.status === 'succeeded';
            }
            candidate.status = 'running';
            this.persist(job);
            this.emit(job);
            await this.sleep(this.pollIntervalMs);
        }
        if (this.cancelRequested) {
            candidate.status = 'canceled';
            candidate.error = t('core.trial.canceled');
        } else {
            candidate.status = 'failed';
            candidate.error = t('core.trial.timeout');
        }
        this.persist(job);
        this.emit(job);
        return false;
    }

    finalizeJob(job) {
        const succeeded = job.candidates.filter(item => item.status === 'succeeded').length;
        const unfinished = job.candidates.filter(item => !TERMINAL_STATES.has(item.status));
        if (this.cancelRequested || job.status === 'canceled') {
            job.status = 'canceled';
        } else if (unfinished.length > 0) {
            job.status = succeeded > 0 ? 'partial' : 'failed';
        } else if (succeeded === job.candidates.length) {
            job.status = 'completed';
        } else if (succeeded > 0) {
            job.status = 'partial';
        } else {
            job.status = 'failed';
        }
        job.active_index = null;
        this.persist(job);
        this.emit(job);
        return job;
    }

    /**
     * 試行を始める。
     *
     * @param {object} params
     * @param {object} params.record 記録
     * @param {object} [params.overrides] `{prompt, negative_prompt, seed}` の差し替え
     * @param {(job: object) => void} [params.onUpdate] 進捗（**複製が渡る**）
     */
    async start({ record, overrides = null, onUpdate = null }) {
        if (this.running) throw new Error(t('core.trial.busy'));
        const recordId = recordIdOf(record);
        if (!recordId) throw new Error(t('core.trial.noRecordId'));

        const stored = this.readStoredJob(recordId);
        if (stored && !FINISHED_JOB_STATES.has(stored.status)) {
            throw new Error(t('core.trial.unfinishedExists'));
        }

        this.running = true;
        this.cancelRequested = false;
        this.onUpdate = onUpdate;
        // 先に1回組んでみる。**組めない記録でキューを触らない**——投げてから
        // 気づくと、他人の生成の前に半端なものが1件入る。
        const probe = await this.prepareWorkflow(
            record,
            safeIntegerSeed(overrides?.seed ?? record?.gen_params?.seed) ?? 0,
            overrides
        ).catch(error => { this.running = false; throw error; });

        const job = this.createJob(record, { manifestHash: probe.manifestHash, overrides });
        this.currentJob = job;
        // 復旧できない状態では投げない——保存に失敗したまま投げると、
        // 途中で閉じたときに「投げた4件」の行方が完全に判らなくなる。
        job.storage_persisted = this.persist(job);
        this.emit(job);

        try {
            await this.requireEmptyQueue();
            for (const candidate of job.candidates) {
                if (this.cancelRequested) break;
                try {
                    // seed ごとに組み直す。**使い回さない**——組み直しは数ミリ秒だが、
                    // 使い回すと seed が差し替わっていないグラフを投げる事故が起こる。
                    const prepared = await this.prepareWorkflow(record, candidate.seed, overrides);
                    await this.requireEmptyQueue();
                    await this.submitCandidate(job, candidate, prepared.prompt);
                    await this.pollCandidate(job, candidate);
                } catch (error) {
                    if (!TERMINAL_STATES.has(candidate.status)) {
                        candidate.status = 'failed';
                        candidate.error = error?.message || String(error);
                    }
                    job.error = candidate.error || error?.message || String(error);
                    for (const remaining of job.candidates.slice(candidate.index + 1)) {
                        if (remaining.status === 'pending') remaining.status = 'not_submitted';
                    }
                    break;
                }
            }
            for (const candidate of job.candidates) {
                if (candidate.status === 'pending') candidate.status = 'not_submitted';
            }
            return clone(this.finalizeJob(job));
        } catch (error) {
            job.error = error?.message || String(error);
            for (const candidate of job.candidates) {
                if (candidate.status === 'pending') candidate.status = 'not_submitted';
            }
            this.finalizeJob(job);
            throw error;
        } finally {
            this.running = false;
        }
    }

    /**
     * 閉じてしまった試行を拾い直す。**投げ直しは一切しない。**
     *
     * 履歴に居れば結果を取り込み、キューに居れば待ちへ戻す。どちらにも居ない
     * `prompt_id` は `submission_unknown` にする——「無い」は「失敗した」ではない。
     */
    async recover(recordId, { onUpdate = null } = {}) {
        const job = this.readStoredJob(recordId);
        if (!job) return null;
        this.currentJob = job;
        this.onUpdate = onUpdate;
        this.emit(job);

        for (const candidate of job.candidates || []) {
            if (!candidate.prompt_id || candidate.status === 'succeeded') continue;
            try {
                this.applyHistory(candidate, await this.historyEntry(candidate.prompt_id));
            } catch {
                // 拾い直しは最善努力。**prompt_id は残したまま**次回へ回す。
            }
        }

        const queue = await this.queueState().catch(() => null);
        let queueActive = false;
        if (queue) {
            const runningIds = queuePromptIds(queue.queue_running);
            const pendingIds = queuePromptIds(queue.queue_pending);
            for (const candidate of job.candidates || []) {
                if (candidate.status === 'succeeded') continue;
                if (runningIds.has(candidate.prompt_id)) {
                    candidate.status = 'running';
                    queueActive = true;
                } else if (pendingIds.has(candidate.prompt_id)) {
                    candidate.status = 'queued';
                    queueActive = true;
                } else if (candidate.prompt_id && !TERMINAL_STATES.has(candidate.status)) {
                    candidate.status = 'submission_unknown';
                    candidate.error = t('core.trial.lostPromptId');
                }
            }
        }
        for (const candidate of job.candidates || []) {
            if (!candidate.prompt_id && !TERMINAL_STATES.has(candidate.status)) {
                candidate.status = 'not_submitted';
            }
        }

        if (queueActive) {
            job.status = 'recovering';
            job.active_index = (job.candidates || [])
                .find(item => item.status === 'running' || item.status === 'queued')?.index ?? null;
            this.persist(job);
            this.emit(job);
        } else {
            this.finalizeJob(job);
        }
        return clone(job);
    }

    /**
     * 止める。待ち行列からは削除し、走っている1本は中断させる。
     * **中断が届いたかは確かめられない**ので、状態は `canceled` で固定する。
     */
    async cancel() {
        const job = this.currentJob;
        if (!job) return null;
        this.cancelRequested = true;
        job.status = 'canceled';
        const queue = await this.queueState().catch(() => ({ queue_running: [], queue_pending: [] }));
        const runningIds = queuePromptIds(queue.queue_running);
        const pendingIds = queuePromptIds(queue.queue_pending);
        const deleteIds = [];
        for (const candidate of job.candidates || []) {
            if (!candidate.prompt_id) {
                if (candidate.status === 'pending') candidate.status = 'canceled';
                continue;
            }
            if (pendingIds.has(candidate.prompt_id)) deleteIds.push(candidate.prompt_id);
            if (runningIds.has(candidate.prompt_id)) {
                await this.request('/interrupt', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt_id: candidate.prompt_id }),
                }).catch(() => null);
            }
            if (!TERMINAL_STATES.has(candidate.status)) candidate.status = 'canceled';
        }
        if (deleteIds.length > 0) {
            await this.request('/queue', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ delete: deleteIds }),
            }).catch(() => null);
        }
        this.persist(job);
        this.emit(job);
        return clone(job);
    }
}

/**
 * 試行の結果を1行にまとめる。**「4件中N件が出た」だけでは足りない**——
 * 記録の seed で出た1枚があるかどうかが、再現できたかどうかそのものなので分けて返す。
 */
export function summarizeTrial(job) {
    const candidates = job?.candidates || [];
    const succeeded = candidates.filter(item => item.status === 'succeeded');
    const original = succeeded.find(item => item.seed_origin === 'original') || null;
    return {
        status: job?.status || 'unknown',
        total: candidates.length,
        succeeded: succeeded.length,
        unknown: candidates.filter(item => item.status === 'submission_unknown').length,
        originalSeedSucceeded: original !== null,
        images: succeeded.flatMap(item => item.images || []),
    };
}
