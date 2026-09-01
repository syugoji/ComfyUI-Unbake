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
import { outputImageUrl } from './outputUrl.js';
// **鍵は読む側と同じ物を使う**（`I-20260830-24`）。literal を書くと、
// 読む側だけが別の字を見ている状態に戻る。
import { SWEEP_STAMP_KEY } from './generationRecord.js';
import { t } from '../i18n/index.js';

const JOB_SCHEMA = 'unbake.sweep';
const JOB_VERSION = 1;
const JOB_PREFIX = 'unbake.sweep.job.';
const OUTPUT_INDEX_KEY = 'unbake.sweep.outputs';
const DEFAULT_POLL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/**
 * 投入がキューにも履歴にも見えない回数の上限。
 *
 * **1回で諦めない**——投げた直後は、まだキューにも履歴にも現れない一瞬が在る。
 * 3回（既定の間隔で約6秒）続けて見えなければ、消えたものとして扱う。
 */
const MISSING_PROMPT_STRIKES = 3;

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
            // **組み立ては `core/outputUrl.js` の1本だけ**（2026-08-29）。
            // ここは履歴から来た「今出たばかりの絵」で、鮮度が判らない。
            images.push({
                filename: image.filename,
                subfolder: image.subfolder || '',
                type: image.type || 'output',
                url: outputImageUrl(image, { type: image.type || 'output' }),
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
        /**
         * 人が「投入しない」と決めた升の id（`D-20260828-01` E6）。
         *
         * **画面が持っているのは写し**（`onUpdate` は `clone()` を渡す）なので、
         * そちらの `status` を書き換えても実行器には届かない——タイルは即
         * `skipped` に見えるのに、**順番が来ると投入されて GPU 時間を使い**、
         * 次の `onUpdate` で `completed` に戻る。押した人には「×が効かない」
         * ではなく「押したのに勝手に戻った」と見える。
         */
        this.droppedCells = new Set();
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

    /**
     * 升を1つ「投入しない」にする。**実体へ書く。**
     *
     * 走る前（計画を見ている段階）に押されることも、走っている最中に
     * 押されることもある。**どちらでも効くように**、id を覚えたうえで
     * 手元に実体が在るならその場でも印を付ける。
     *
     * @returns {boolean} 実体へ書けたか（覚えるのは常に行う）
     */
    dropCell(cellId) {
        const id = String(cellId ?? '');
        if (!id) return false;
        this.droppedCells.add(id);
        const job = this.currentJob;
        const cell = (job?.cells || []).find(item => String(item.id) === id);
        if (!cell || DONE_STATES.has(cell.status)) return false;
        cell.status = 'skipped';
        this.persist(job);
        this.emit(job);
        return true;
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
            // **ここはサーバの索引から来る**ので `modified` と `size` が判る
            // ＝**中身が変われば印も変わる**（消して作り直しても前の絵を出さない）。
            index[String(signature)] = {
                url: outputImageUrl(entry),
                filename: entry.filename,
                subfolder: entry.subfolder,
                // **どこから来た索引かを残す。** 手元の入れ物と混ざると、
                // 「消したのに残っている」の理由が読めない。
                source: 'disk',
            };
        }
        return index;
    }

    /**
     * 控えの絵が**本当に在るか**を確かめる（2026-08-26 実機）。
     *
     * 手元の入れ物（`localStorage`）の索引は、**ファイルを消しても残る**。
     * すると次の再現で「もう出ている」と判断され、**死んだ URL を指したまま
     * 1枚も作らない**——利用者からは「再現できませんでした」に見えるうえ、
     * **存在しない画像と見比べる**ことになる（実機: `hshi_00001_.png`）。
     *
     * **ディスク由来（`source: 'disk'`）は確かめない。** あれは走査した
     * その場の真実で、確かめ直すのは往復の無駄。
     *
     * **確かめられなければ捨てない。** 口が無い・繋がらないだけで作り直すと、
     * 出ている絵をもう一度作ることになる。
     */
    async verifyReusable(outputs, signatures) {
        /*
         * **`this` ごと束ねて呼ぶ**（2026-08-26 実機で判明）。
         *
         * 元は `const request = this.request || environmentRequestOrNull();` と
         * 書いていた。`request` は**クラスのメソッド**なので `this.request` は
         * 常に真——後ろの環境ごしの取得には一度も届かない。しかも外して呼ぶと
         * 中の `this.injectedRequest` で
         *
         *     TypeError: Cannot read properties of undefined (reading 'injectedRequest')
         *
         * が飛び、下の `catch` が「確かめられなければ捨てない」として飲み込む。
         * つまり**この検算は一度も働いていなかった**——消えた絵をいつまでも
         * 使い続け、存在しない画像と見比べていた（実機で再現）。
         *
         * 検査が緑だったのは、作り物が `runner.request` を**自前の関数**として
         * 置いていたから。実物はメソッドなので、束ねないと呼べない。
         */
        const checked = { ...outputs };
        for (const signature of signatures) {
            const output = checked[signature];
            if (!output?.url || output.source === 'disk') continue;
            if (await this.outputIsAlive(output)) continue;
            delete checked[signature];
            SweepRunner.forgetOutputFile({
                filename: output.filename, subfolder: output.subfolder || '',
            });
        }
        return checked;
    }

    /**
     * **`SaveImage` の出す名前をずらして、キャッシュを外す**（2026-08-27）。
     *
     * ComfyUI のキャッシュは**ノードの入力だけ**で決まる。同じグラフを投げ直しても、
     * 印を変えても出ない（実測）。`filename_prefix` を変えると `SaveImage` の入力が
     * 変わるので**そこだけ**が実行し直され、上流は当たったまま
     * ——**絵は同じで、待ち時間はほぼ無い**（実測 1.0秒）。
     *
     * **前置きは `<元の名前>_` で始まる形にする。** 帰属は出力名の `civitai_<id>` を
     * 読むので（`outputAttribution.namedRecordId`）、後ろに足す限り持ち主は変わらない。
     * **前に足すと持ち主が消える**ので、ここは必ず後ろへ。
     *
     * 変えるのは**この1回だけ**。普段の出力名は素のままにしておく。
     */
    bustOutputCache(cell) {
        const nodes = cell?.workflow?.prompt;
        if (!nodes || typeof nodes !== 'object') return false;
        // **投入ごとに違う語**。同じ語を使い回すと2度目からまた当たる。
        const token = String(this.uuid()).replace(/[^a-z0-9]/gi, '').slice(0, 6) || 'redo';
        let changed = false;
        for (const node of Object.values(nodes)) {
            if (node?.class_type !== 'SaveImage') continue;
            const before = String(node.inputs?.filename_prefix ?? '');
            if (!before) continue;
            node.inputs.filename_prefix = `${before}_r${token}`;
            changed = true;
        }
        return changed;
    }

    /**
     * その絵が**まだ在るか**を宿主に聞く。**404 のときだけ「無い」と言う。**
     *
     * 口が無い・繋がらない・別のエラーは全部「判らない」＝在る扱いにする
     * ——確かめられないことを不在と読むと、出ている絵を作り直しにいく。
     *
     * **`this` ごと束ねて呼ぶ**（`verifyReusable` の注記と同じ理由。`request` は
     * クラスのメソッドなので、外して渡すと中の `this` が undefined になる）。
     *
     * 対照つきで実測（2026-08-27・127.0.0.1:8188）:
     *   在るファイル → **200** ／ 無いファイル → **404**。判定は成立している。
     */
    async outputIsAlive(output) {
        if (!output?.url) return true;
        try {
            const response = await this.request(output.url, { method: 'HEAD' });
            if (response && response.ok === false && Number(response.status) === 404) return false;
        } catch {
            return true;
        }
        return true;
    }

    /** その投入がキュー（実行中・待ち）に居るか。 */
    queueHasPrompt(queue, promptId) {
        const wanted = String(promptId);
        for (const key of ['queue_running', 'queue_pending']) {
            for (const job of queue?.[key] || []) {
                // ComfyUI の並びは `[番号, prompt_id, prompt, extra, outputs]`。
                if (Array.isArray(job) && job.some(part => String(part) === wanted)) return true;
            }
        }
        return false;
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

    /**
     * 消した絵を索引から落とす（2026-08-26 実機）。
     *
     * 索引は `localStorage` に残るので、**ファイルを消しても控えは生き残る**。
     * すると次の再現で「もう出ている」と判断され、**死んだ URL を指したまま
     * 1枚も作らない**——利用者からは「再現できませんでした」に見える
     *（実機: 消した `hshi_00001_.png` がそれだった）。
     *
     * **ディスクの走査では直らない。** 消えたものは出てこないので、
     * 索引の側から落とすしかない。
     */
    static forgetOutputFile({ filename, subfolder = '' } = {}) {
        if (!filename) return 0;
        const stored = readStored(OUTPUT_INDEX_KEY, {});
        if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return 0;
        let dropped = 0;
        for (const [signature, output] of Object.entries(stored)) {
            const sameName = String(output?.filename || '') === String(filename);
            const sameFolder = String(output?.subfolder || '') === String(subfolder || '');
            // **名前だけで落とさない。** 別のフォルダに同じ名前が在りうる。
            if (!sameName || !sameFolder) continue;
            delete stored[signature];
            dropped += 1;
        }
        if (dropped) writeStored(OUTPUT_INDEX_KEY, stored);
        return dropped;
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
                        [SWEEP_STAMP_KEY]: stamp,
                        // ComfyUI が PNG へ焼くのは `extra_pnginfo` の中身だけ。
                        extra_pnginfo: { [SWEEP_STAMP_KEY]: stamp },
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
        /*
         * **投げた分が消えていないかも見る**（2026-08-27 実機で確定）。
         *
         * ここは `/history/<id>` だけを見ていた。**履歴に出ないうちは待ち続ける**
         * ので、投入そのものが消えると**2時間の上限まで待つ**——画面では
         * ⟳ が回ったまま止まり、**行列の後ろは全部 ⏸ のまま動かない**。
         *
         * 消えるのは普通に起きる:
         *   - **ComfyUI を再起動した**（キューも履歴も揮発する。実測 2026-08-27:
         *     21:30:07 に再起動され、待っていた分が全部宙に浮いた）
         *   - ComfyUI の画面で「Clear queue」を押した
         *
         * **キューにも履歴にも居ないなら、それは消えている。** ただし1回の
         * 見落としで諦めない——投入直後は履歴にもキューにも現れない一瞬が在る。
         * 続けて何度も見えなかったときだけ落とす。
         */
        let missingStrikes = 0;
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
            if (!entry) {
                const queue = await this.queueState().catch(() => null);
                // **読めないときは数えない。** 「聞けなかった」と「消えた」を混ぜない。
                if (queue && !this.queueHasPrompt(queue, promptId)) {
                    missingStrikes += 1;
                    if (missingStrikes >= MISSING_PROMPT_STRIKES) {
                        return {
                            status: 'failed', reason: 'vanished',
                            error: t('core.sweep.cell.vanished'),
                        };
                    }
                } else {
                    missingStrikes = 0;
                }
                continue;
            }
            missingStrikes = 0;
            const status = String(entry?.status?.status_str || '').toLowerCase();
            if (status === 'error') {
                return { status: 'failed', error: t('core.sweep.cell.failed') };
            }
            if (entry?.status?.completed === true || status === 'success') {
                const images = sweepHistoryImages(entry);
                return images.length
                    ? { status: 'completed', output: images[0], outputs: images }
                    // **理由は機械可読で返す**（2026-08-27）。呼び手はここを見て
                    // 投げ直すので、**訳文で分岐させない**——locale を1つ足した日に
                    // 静かに効かなくなる。
                    : { status: 'failed', reason: 'no-images', error: t('core.sweep.cell.noImages') };
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
        /*
         * **落ちたセルは「済み」として引き継がない**（2026-08-27 実機で確定）。
         *
         * `failed` は `DONE_STATES` に入っている。**投入の輪を素通りさせるため**で、
         * 走っている最中の再開としては正しい。だが保存した状態をまたいで
         * 引き継ぐと、**次に人が ▶ を押しても、その1件は永久に飛ばされる**
         * ——投入も無く、結果も無いので、面は「他に在る古い絵」を黙って開く。
         *
         * 実測: 出た絵を消した後の再現が `not-written` で落ちる → 保存に `failed`
         * が残る → **以降どれだけ押しても投入が1件も増えない**（履歴で確認）。
         *
         * **押し直しは「もう一度やれ」という意味。** 済んだ（`completed` /
         * `reused`）ものだけを引き継ぎ、落ちたものは引き継がない。
         */
        const storedCells = reuseExisting
            ? new Map((stored?.cells || [])
                .filter(cell => cell?.status !== 'failed')
                .map(cell => [cell.signature, cell]))
            : new Map();
        // **ディスクが先、手元の入れ物が後。** 出力フォルダに実在する分のほうが
        // 強い証拠で、入れ物のほうは消えていることがある。
        let outputs = reuseExisting
            ? { ...this.outputIndex(), ...(await this.loadDiskOutputs(recordId)) }
            : {};
        if (reuseExisting) {
            // **手元の控えだけを頼りにしない**（2026-08-26 実機）。
            // 消えたファイルを指したままだと、1枚も作らずに終わる。
            outputs = await this.verifyReusable(
                outputs, plan.cells.map(cell => cell.signature));
        }

        const cells = plan.cells.map(cell => {
            const reused = outputs[cell.signature];
            if (reused?.url) {
                return { ...cell, status: 'reused', output: reused, error: null };
            }
            const previous = storedCells.get(cell.signature);
            // **控えの「もう出ている」も、絵が無ければ効かせない**（2026-08-26）。
            // `outputs` から落ちた署名は、実在を確かめて消えていたもの。
            if (previous?.output?.url && !outputs[cell.signature]
                && previous.output.source !== 'disk') {
                return {
                    ...cell, ...previous,
                    status: 'pending', output: null, error: null,
                    recipe: cell.recipe, workflow: cell.workflow, signature: cell.signature,
                    // **身元も今組んだ側**（I-20260831-06）。下の分岐と同じ理由で、
                    // ここだけ揃え忘れると「片方の道でだけ × が別の升に効く」になる。
                    id: cell.id, labels: cell.labels, baseline: cell.baseline,
                };
            }
            /*
             * 保存された状態を重ねる。**グラフと記録は今組んだものを使う**——
             * 保存には入っていないし、雛形が変わっていれば signature も変わる。
             *
             * **身元も今組んだ側のものを使う**（2026-08-31・監査 I-20260831-06）。
             * 再固定していたのは `recipe` / `workflow` / `signature` の3つだけで、
             * `id` / `labels` / `baseline` は**保存済みの側で上書きされていた**。
             *
             * `storedCells` は署名で引くので、**軸の値を編集して升の並び位置が
             * 変わると、今の升に前回の別位置の `id` が乗る**。`id` は
             * `cell-NNN` の位置由来なので、新しく増えた升の素の id と衝突しうる。
             * `dropCell` は先頭一致で拾うため、**× を押した升とは別の升が
             * `skipped` になり**、押した升はそのまま投入されて GPU を使う。
             *
             * `baseline` も同じで、`*` の位置だけ動かした編集（値は同じ＝署名も
             * 同じ）だと前回の基準が焼き直され、PNG へ書く `baseline` と画面の
             * 基準バッジが宣言と食い違う。
             *
             * **雛形IDは内容ハッシュではない**ので、軸を編集しても保存の鍵は
             * 変わらない——だからこの経路は実際に通る。
             */
            return {
                ...cell,
                ...(previous || {}),
                recipe: cell.recipe,
                workflow: cell.workflow,
                signature: cell.signature,
                id: cell.id,
                labels: cell.labels,
                baseline: cell.baseline,
            };
        });

        // **走る前に外した分をここで効かせる。** 計画を見ている段階の × は
        // まだ実体が無いので id だけ覚えてある（`dropCell`）。
        for (const cell of cells) {
            if (this.droppedCells.has(String(cell.id)) && !DONE_STATES.has(cell.status)) {
                cell.status = 'skipped';
            }
        }

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
                    let verdict = await this.waitForPrompt(cell.promptId);
                    if (!verdict) break;
                    /*
                     * **「成功したが画像0枚」は1度だけ投げ直す**
                     *（2026-08-27 実機・「出た絵を消してから再現すると生成が始まらない」）。
                     *
                     * ComfyUI は**直前と同じグラフ**を投げると実行キャッシュに当てて
                     * 何も実行せず、`status: success` のまま `outputs` を空で返す。
                     * 絵を消した直後の再現がまさにこれで、**消したのに作り直されない**。
                     *
                     * **実測（同じ記録の連続4投入）**:
                     *
                     *     12c465f3  1回目            → 画像1枚（`_00006_`）
                     *     （ここで `_00006_` を消す）
                     *     afc15d63  2回目（同一）     → **outputs 空・画像0枚**
                     *     8baeacb1  3回目（同一）     → 画像1枚（1.0秒で復活）
                     *
                     * **さらに悪い形が在る**（同じ日に実測して前の見立てを訂正した）。
                     * キャッシュに当たった投入は `outputs` を空にするとは限らず、
                     * **前回の画像名をそのまま返しながらファイルを1つも書かない**:
                     *
                     *     ①1回目  outputs=['7'] 履歴=`_00006_`  **実ファイル増えた**
                     *     ②2回目  outputs=['7'] 履歴=`_00006_`  **増えない**
                     *     ③3回目  outputs=['7'] 履歴=`_00006_`  **増えない**
                     *
                     * つまり `outputs` の空だけを見ていると**この形を丸ごと見逃す**
                     * ——「再現しました（1枚）」と言いながら、指している絵が無い。
                     * だから判定は **`outputs` の有無ではなく、出たと言われた絵が
                     * 実在するか**で行う（`outputIsAlive`・404 のときだけ「無い」）。
                     *
                     * **同じものを投げ直しても出ない**（2026-08-27 実測・3連投で0枚）。
                     * 印（`extra_pnginfo` の `unbake_sweep`）を変えても出ない
                     * ——**キャッシュはノードの入力だけで決まる**。
                     *
                     * **効いたのは `filename_prefix` を変えることだけ**（1.0秒で復活）。
                     * `SaveImage` の入力が変わるので**そこだけ**が実行し直され、
                     * 上流は当たったまま＝**絵は同じで、待ち時間はほぼ無い**。
                     *
                     * **常にやらない。** 名前は帰属の手掛かり（`civitai_<id>`）なので、
                     * 普段の出力名は素のままにしておきたい。**作られなかったと判った
                     * 時だけ**、`civitai_<id>_r<token>` の形へ寄せる——前置きは
                     * `civitai_<id>_` で始まるので、名乗りによる帰属はそのまま効く。
                     *
                     * **1度で止まるのは輪でないから**——ここは各セルを1回通るだけの
                     * `if` で、通った後のセルは `completed` か `failed` になり、
                     * どちらも `DONE_STATES` なので再開しても素通りする。
                     * **`!cell.resubmitted` は今は一度も偽にならない**（変異で確認）。
                     * それでも残すのは、**将来ここを輪にしたときの保険**として——
                     * ただし**今それが repeat を止めている、とは読まないこと。**
                     * 2度目も空なら原因はキャッシュではないので、そのまま
                     * 「画像が保存されていません」として返す。
                     */
                    const missing = verdict.status === 'completed'
                        && !(await this.outputIsAlive(verdict.output));
                    if ((verdict.reason === 'no-images' || missing)
                        && !cell.resubmitted && !this.stopRequested) {
                        cell.resubmitted = true;
                        this.bustOutputCache(cell);
                        const again = await this.queueCell(job, cell);
                        if (again && !this.stopRequested) {
                            const second = await this.waitForPrompt(cell.promptId);
                            if (!second) break;
                            verdict = second;
                        }
                    }
                    /*
                     * **最後にもう一度だけ実体を見る**（2026-08-27・実機で確定）。
                     *
                     * 投げ直しても出ないことが在る。**同一グラフの連投は3回とも
                     * 実ファイルを作らなかった**（履歴は3回とも `_00006_` と言った）。
                     * つまり投げ直しは「効くこともある」程度の手当てにすぎない。
                     *
                     * **効かなかったときに「出た」と言わないことのほうが重い。**
                     * 実体の無い絵を `completed` で返すと、上は「再現しました（1枚）」と
                     * 言いながら**存在しない絵を開く**。索引にも覚えてしまう。
                     */
                    if (verdict.status === 'completed' && !(await this.outputIsAlive(verdict.output))) {
                        verdict = {
                            status: 'failed',
                            reason: 'not-written',
                            error: t('core.sweep.cell.notWritten'),
                        };
                    }
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
