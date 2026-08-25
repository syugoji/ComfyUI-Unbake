/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * Sweep の**軸を書く側**と**回す側**の検査。
 *
 * `recipeSweep.js`（展開・適用・変更検査）は別に検査がある。ここが固定するのは、
 * その周りで**壊れても赤くならない**決めごと:
 *
 *  - 基準がちょうど1つであること（自動で真ん中を選ばない）
 *  - 端に張り付いた値でも軸が2点以上になること
 *  - **投げる前に計画を全部組む**こと（変更検査に落ちたら1件も投げない）
 *  - 同じ signature を回し直さないこと、飛ばした事実が表に出ること
 *  - 途中で閉じても投げ直さずに続きから回せること
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installEnvironment } from '../web/core/environment.js';
import { resetMemoryStorage } from '../web/core/storage.js';
import { setLocale } from '../web/i18n/index.js';
import {
    buildBuiltinSweepTemplates, describeLoraTarget, extractPromptPlaceholders,
    formatAxisValues, loraTargetIdentity, nextUnusedLoraTarget, originalRecipeSeed,
    parseAxisValues,
} from '../web/core/sweepAxes.js';
import {
    buildSweepStamp, QUEUE_NOT_EMPTY, SweepRunner, summarizeSweep, sweepHistoryImages,
} from '../web/core/sweepRunner.js';

function fakeStorage() {
    const map = new Map();
    return {
        map,
        getItem: k => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => { map.set(k, String(v)); },
        removeItem: k => { map.delete(k); },
    };
}

function install(request = async (_input) => ({ ok: true, status: 200, json: async () => ({}) })) {
    resetMemoryStorage();
    const storage = fakeStorage();
    installEnvironment({ request, storage });
    return storage;
}

// ------------------------------------------------------------ 軸を書く

test('基準は行頭の * で明示する（自動で真ん中を選ばない）', () => {
    const values = parseAxisValues('低 = 0.6\n*現在 = 0.8\n高 = 1.0');
    assert.deepEqual(values.map(v => v.value), [0.6, 0.8, 1.0]);
    assert.deepEqual(values.map(v => v.baseline), [false, true, false]);
    assert.deepEqual(values.map(v => v.label), ['低', '現在', '高']);
});

test('基準が0個でも2個でも通さない（比較の土台が定まらない）', () => {
    setLocale('en');
    assert.throws(() => parseAxisValues('a = 1\nb = 2'), /baseline/i);
    assert.throws(() => parseAxisValues('*a = 1\n*b = 2'), /baseline/i);
    assert.throws(() => parseAxisValues('*a = 1'), /two values/i);
    assert.throws(() => parseAxisValues(' = 1\n*b = 2'), /Line 1/);
});

test('`=` が無ければラベルがそのまま値（文字列の軸を書きやすくする）', () => {
    const values = parseAxisValues('*euler\ndpmpp_2m');
    assert.deepEqual(values.map(v => v.value), ['euler', 'dpmpp_2m']);
});

test('書いた形へ戻せる（読み直して直せる）', () => {
    const text = '低 = 0.6\n*現在 = 0.8';
    const values = parseAxisValues(text);
    assert.deepEqual(parseAxisValues(formatAxisValues(values)).map(v => [v.label, v.value, v.baseline]),
        values.map(v => [v.label, v.value, v.baseline]));
});

test('LoRA の指し先は modelVersionId を優先する', () => {
    assert.equal(loraTargetIdentity({ modelVersionId: 77, file_name: 'a.safetensors' }), '77');
    assert.equal(loraTargetIdentity({ file_name: 'a.safetensors' }), 'a.safetensors');
    assert.equal(loraTargetIdentity({}, 3), '3');
});

test('選択肢の説明が「prompt token ではない」と言う', () => {
    setLocale('en');
    const described = describeLoraTarget({
        modelName: 'Foo', modelVersionId: 12, file_name: 'foo.safetensors', strength: 0.8,
    }, 0);
    assert.equal(described.value, '12');
    assert.match(described.label, /current 0\.8/);
    assert.match(described.help, /not a prompt token/);
    assert.match(described.help, /foo\.safetensors/);
});

test('記録の seed が無ければ null（元seed固定ができない印）', () => {
    assert.equal(originalRecipeSeed({ gen_params: { seed: 5 } }), 5);
    assert.equal(originalRecipeSeed({ gen_params: {} }), null);
    assert.equal(originalRecipeSeed({ gen_params: { seed: -1 } }), null);
    assert.equal(originalRecipeSeed({ gen_params: { seed: 1.5 } }), null);
});

test('まだ使っていない LoRA を次の軸の既定にする', () => {
    const record = { loras: [{ modelVersionId: 1 }, { modelVersionId: 2 }] };
    assert.equal(nextUnusedLoraTarget(record, []), '1');
    assert.equal(nextUnusedLoraTarget(record, ['1']), '2');
    // 全部使い切ったら先頭へ戻す（未定義を返さない）。
    assert.equal(nextUnusedLoraTarget(record, ['1', '2']), '1');
    assert.equal(nextUnusedLoraTarget({ loras: [] }), '0');
});

test('プロンプトの差し替え口を拾う', () => {
    assert.deepEqual(
        extractPromptPlaceholders({ gen_params: { prompt: 'a {hair}, b {outfit}, c {hair}' } }),
        ['{hair}', '{outfit}']
    );
});

test('雛形はどれもそのまま展開できる（基準1つ・値2つ以上）', async () => {
    setLocale('en');
    const { expandSweepTemplate } = await import('../web/core/recipeSweep.js');
    const record = {
        id: 'r1',
        gen_params: { seed: 42, cfg_scale: 7, steps: 20, prompt: 'a girl' },
        loras: [
            { modelName: 'A', modelVersionId: 1, strength: 0.8 },
            { modelName: 'B', modelVersionId: 2, strength: 1.0 },
        ],
    };
    const templates = buildBuiltinSweepTemplates(record);
    assert.ok(templates.length >= 6, `雛形が少なすぎる（${templates.length}）`);
    for (const template of templates) {
        const cells = expandSweepTemplate(template);
        assert.ok(cells.length >= 2, `${template.id}: セルが少なすぎる`);
        assert.equal(cells.filter(c => c.baseline).length, 1, `${template.id}: 基準が1つでない`);
        for (const axis of template.axes) {
            assert.ok(axis.values.length >= 2, `${template.id}/${axis.id}: 値が2個未満`);
            assert.equal(axis.values.filter(v => v.baseline).length, 1, `${template.id}/${axis.id}: 基準が1つでない`);
        }
    }
});

test('強度が下限に張り付いていても2点以上になる', async () => {
    const { expandSweepTemplate } = await import('../web/core/recipeSweep.js');
    const record = { id: 'r', gen_params: { seed: 1 }, loras: [{ modelName: 'Z', strength: 0 }] };
    const template = buildBuiltinSweepTemplates(record).find(t => t.id === 'builtin-lora-1');
    assert.ok(template);
    const values = template.axes[0].values;
    assert.ok(values.length >= 2, '下限に当たって1点へ潰れている');
    assert.equal(new Set(values.map(v => v.value)).size, values.length, '同じ値が重複している');
    assert.equal(expandSweepTemplate(template).length, values.length);
});

test('プロンプトへ入る値は訳さない（訳すと別の実験になる）', () => {
    const record = { id: 'r', gen_params: { seed: 1 }, loras: [] };
    for (const locale of ['en', 'ja', 'ar']) {
        setLocale(locale);
        const template = buildBuiltinSweepTemplates(record).find(t => t.id === 'builtin-prompt-detail');
        assert.deepEqual(template.axes[0].values.map(v => v.value),
            ['', 'highly detailed', 'sharp focus, intricate details'], locale);
    }
    setLocale('en');
});

// -------------------------------------------------------------- 回す側

test('履歴の画像は /api/view を指す（そのまま記録へ落とし直せる）', () => {
    const images = sweepHistoryImages({
        outputs: { 7: { images: [{ filename: 'a.png', subfolder: 'x', type: 'output' }] } },
    });
    assert.equal(images.length, 1);
    assert.match(images[0].url, /^\/api\/view\?/);
    assert.match(images[0].url, /subfolder=x/);
});

test('焼く印にセルの識別と基準かどうかが入る', () => {
    const stamp = buildSweepStamp('r1', 'tpl-1', 'job-1', {
        id: 'cell-001', signature: 'sweep-v1-abcd0000', seed: 5, baseline: true,
        labels: [{ axis: 'a', label: 'A', value: 1, valueLabel: 'one', baseline: true }],
    });
    assert.equal(stamp.schema, 'unbake.sweep');
    assert.deepEqual(
        [stamp.record_id, stamp.template_id, stamp.cell_id, stamp.baseline, stamp.seed],
        ['r1', 'tpl-1', 'cell-001', true, 5]
    );
    assert.equal(stamp.labels[0].valueLabel, 'one');
});

/** 計画のダブル。実グラフを組まずに runner の筋だけ測る。 */
function fakePlan(cellCount = 3, { throwOnBuild = null } = {}) {
    return () => {
        if (throwOnBuild) throw new Error(throwOnBuild);
        const cells = Array.from({ length: cellCount }, (_, i) => ({
            id: `cell-${String(i + 1).padStart(3, '0')}`,
            signature: `sig-${i + 1}`,
            seed: i,
            baseline: i === 0,
            labels: [{ axis: 'a', label: 'A', value: i, valueLabel: String(i), baseline: i === 0 }],
            status: 'pending',
            recipe: {},
            workflow: { prompt: { 3: { inputs: { seed: i } } } },
        }));
        return { cells, baselineId: cells[0].id };
    };
}

function sweepHarness({
    failAt = null, neverFinish = false, mismatch = false, submitThrows = false,
    // **キューの中身を差し替えられるようにする**（2026-08-24）。
    // 既定は空——これまでの検査はキューを見ていなかったので、見ないまま通る。
    queue = { queue_running: [], queue_pending: [] },
} = {}) {
    const submitted = [];
    const history = new Map();
    const json = payload => ({ ok: true, status: 200, json: async () => payload });
    const request = async (input, init = {}) => {
        if (input === '/prompt') {
            if (submitThrows) return { ok: false, status: 500, json: async () => ({ message: 'boom' }) };
            const body = JSON.parse(init.body);
            submitted.push(body);
            if (mismatch) return json({ prompt_id: 'not-ours' });
            const cellId = body.extra_data.unbake_sweep.cell_id;
            if (!neverFinish) {
                history.set(body.prompt_id, cellId === failAt
                    ? { status: { completed: false, status_str: 'error' } }
                    : {
                        status: { completed: true, status_str: 'success' },
                        outputs: { 9: { images: [{ filename: `${cellId}.png`, type: 'output' }] } },
                    });
            }
            return json({ prompt_id: body.prompt_id });
        }
        if (input === '/queue') return json(queue);
        if (input.startsWith('/history/')) {
            const id = decodeURIComponent(input.slice('/history/'.length));
            return json(history.has(id) ? { [id]: history.get(id) } : {});
        }
        throw new Error(`unexpected request: ${input}`);
    };
    return { request, submitted, history };
}

function makeRunner(harness, overrides = {}) {
    let n = 0;
    return new SweepRunner({
        objectInfo: {},
        request: harness.request,
        plan: fakePlan(3),
        now: () => 1_000_000,
        sleep: async () => {},
        uuid: () => `u-${n += 1}`,
        pollIntervalMs: 0,
        ...overrides,
    });
}

const RECORD = { id: 'rec-1', gen_params: { seed: 1 } };
const TEMPLATE = { id: 'tpl-1', mode: 'cartesian', axes: [], seeds: [] };

test('3セルを回して全部完了する', async () => {
    install();
    const harness = sweepHarness();
    const job = await makeRunner(harness).run({ record: RECORD, template: TEMPLATE });
    assert.equal(job.status, 'completed');
    assert.equal(harness.submitted.length, 3);
    const summary = summarizeSweep(job);
    assert.deepEqual([summary.completed, summary.comparable, summary.pending], [3, 3, 0]);
    assert.equal(summary.baselineHasOutput, true, '基準セルの画像が無い＝比較の土台が無い');
});

test('計画が変更検査に落ちたら1件も投げない', async () => {
    install();
    const harness = sweepHarness();
    const runner = makeRunner(harness, {
        plan: fakePlan(3, { throwOnBuild: 'Sweep changed unintended graph inputs: 5.inputs.cfg' }),
    });
    await assert.rejects(
        () => runner.run({ record: RECORD, template: TEMPLATE }),
        /unintended graph inputs/
    );
    assert.equal(harness.submitted.length, 0, '検査に落ちたのに投げている');
});

test('同じ signature は回し直さず、飛ばした事実が表に出る', async () => {
    install();
    const first = sweepHarness();
    await makeRunner(first).run({ record: RECORD, template: TEMPLATE });

    const second = sweepHarness();
    const job = await makeRunner(second).run({ record: RECORD, template: TEMPLATE });
    assert.equal(second.submitted.length, 0, '出ているセルを回し直している');
    const summary = summarizeSweep(job);
    assert.deepEqual([summary.reused, summary.completed, summary.comparable], [3, 0, 3]);
    assert.equal(job.status, 'completed');
});

// --- キューの門は「本当に投げるとき」だけ（2026-08-24 実機の報告）------------
//
// **既に出ている絵をそのまま出す回は、キューへ1件も投げない**（`reused` は
// `DONE_STATES` なので投入の輪を素通りする）。それでも呼び手が `run()` の手前で
// 弾いていたので、**他の生成が走っている間は出来上がっている絵すら開けなかった。**

test('投げる分が在るときだけ、キューが空であることを求める', async () => {
    install();
    const busy = { queue_running: [['x', 'p1']], queue_pending: [] };
    const harness = sweepHarness({ queue: busy });
    await assert.rejects(
        () => makeRunner(harness).run({
            record: RECORD, template: TEMPLATE, requireEmptyQueueBeforeSubmit: true,
        }),
        /queue|キュー/i,
        '投げる分が在るのに、他人の生成へ混ぜている',
    );
    assert.equal(harness.submitted.length, 0, '断ったのに投げている');
});

test('断りの理由は種類で返す（文言を読ませない）', async () => {
    install();
    const harness = sweepHarness({ queue: { queue_running: [['x', 'p1']], queue_pending: [] } });
    const error = await makeRunner(harness).run({
        record: RECORD, template: TEMPLATE, requireEmptyQueueBeforeSubmit: true,
    }).then(() => null, (e) => e);
    assert.ok(error, '断っていない');
    // **呼び手はこれで分岐する**（ボタンを止まった姿にする）。
    // 文言で当てさせると、**訳が変わった日に分岐が黙って死ぬ。**
    assert.equal(error.code, QUEUE_NOT_EMPTY, '理由の種類が付いていない');
});

test('投げる分が無ければ、キューが埋まっていても出す', async () => {
    install();
    // 1回目で3セルとも出しておく（＝2回目は全部 `reused`）。
    await makeRunner(sweepHarness()).run({ record: RECORD, template: TEMPLATE });

    const busy = { queue_running: [['x', 'p1']], queue_pending: [] };
    const harness = sweepHarness({ queue: busy });
    const job = await makeRunner(harness).run({
        record: RECORD, template: TEMPLATE, requireEmptyQueueBeforeSubmit: true,
    });
    assert.equal(harness.submitted.length, 0, '出ているのに投げ直している');
    assert.equal(job.status, 'completed');
    // **これが実機で言われた症状。** 出来上がっているのに開けなかった。
    assert.equal(summarizeSweep(job).comparable, 3, '出ている絵を返していない');
});

test('reuseExisting を切れば回し直す（明示したときだけ）', async () => {
    install();
    await makeRunner(sweepHarness()).run({ record: RECORD, template: TEMPLATE });
    const harness = sweepHarness();
    await makeRunner(harness).run({ record: RECORD, template: TEMPLATE, reuseExisting: false });
    assert.equal(harness.submitted.length, 3);
});

test('止めると paused で残り、続きから回せる（投げ直さない）', async () => {
    install();
    const harness = sweepHarness();
    const runner = makeRunner(harness);
    // 1セル目が出た時点で止める。**通知の回数ではなく状態で判断する**
    // ——通知は1セルにつき複数回来るので、回数で数えると止める位置が動く。
    const job = await runner.run({
        record: RECORD,
        template: TEMPLATE,
        onUpdate: (snapshot) => {
            if (snapshot.cells.some(c => c.status === 'completed')) runner.stop();
        },
    });
    assert.equal(job.status, 'paused');
    const done = job.cells.filter(c => c.status === 'completed').length;
    assert.ok(done >= 1 && done < 3, `途中で止まっていない（完了 ${done}）`);
    const submittedFirstRun = harness.submitted.length;

    // 続き。**出たセルは投げ直さない**（索引から reused で戻る）。
    const resumed = await makeRunner(harness).run({ record: RECORD, template: TEMPLATE });
    assert.equal(resumed.status, 'completed');
    assert.equal(harness.submitted.length - submittedFirstRun, 3 - done,
        '出たセルを投げ直している');
    assert.equal(summarizeSweep(resumed).reused, done);
});

test('失敗したセルは残り、ほかのセルは回り続ける', async () => {
    install();
    const harness = sweepHarness({ failAt: 'cell-002' });
    const job = await makeRunner(harness).run({ record: RECORD, template: TEMPLATE });
    const summary = summarizeSweep(job);
    assert.deepEqual([summary.completed, summary.failed], [2, 1]);
    assert.equal(job.status, 'completed', '失敗も決着なので paused にしない');
    assert.equal(job.cells.find(c => c.id === 'cell-002').status, 'failed');
});

test('投げたか判らない失敗を「失敗」と混ぜず、投げ直さない', async () => {
    install();
    const harness = sweepHarness({ submitThrows: true });
    const job = await makeRunner(harness).run({ record: RECORD, template: TEMPLATE });
    const summary = summarizeSweep(job);
    assert.equal(summary.unknown, 3);
    assert.equal(summary.failed, 0, '判らないものを失敗に混ぜている');
    assert.equal(job.status, 'paused');
    assert.equal(harness.submitted.length, 0);
});

test('prompt ID が食い違ったら投げ直さない', async () => {
    install();
    const harness = sweepHarness({ mismatch: true });
    const job = await makeRunner(harness).run({ record: RECORD, template: TEMPLATE });
    assert.equal(summarizeSweep(job).unknown, 3);
    assert.equal(harness.submitted.length, 3, '食い違うたびに投げ直している');
});

test('待ち続けるセルはタイムアウトで決着する（永久に止まらない）', async () => {
    install();
    const harness = sweepHarness({ neverFinish: true });
    let clock = 0;
    const job = await makeRunner(harness, {
        now: () => (clock += 1000),
        timeoutMs: 5000,
    }).run({ record: RECORD, template: TEMPLATE });
    assert.equal(summarizeSweep(job).failed, 3);
});

test('1セルごとに保存する（閉じても続きから回せる）', async () => {
    const storage = install();
    const harness = sweepHarness();
    await makeRunner(harness).run({ record: RECORD, template: TEMPLATE });
    const key = [...storage.map.keys()].find(k => k.startsWith('unbake.sweep.job.'));
    assert.ok(key, '実験が保存されていない');
    const saved = JSON.parse(storage.map.get(key));
    assert.equal(saved.schema, 'unbake.sweep');
    assert.equal(saved.cells.length, 3);
    // **グラフと記録は保存しない**（1セル数十KBで入れ物が溢れる）。
    assert.equal(Object.hasOwn(saved.cells[0], 'workflow'), false);
    assert.equal(Object.hasOwn(saved.cells[0], 'recipe'), false);
    assert.ok(saved.cells[0].signature, 'signature が落ちている＝続きから照合できない');
});

test('記録IDと軸のIDが無ければ始めない（追跡も保存もできない）', async () => {
    install();
    const harness = sweepHarness();
    await assert.rejects(() => makeRunner(harness).run({ record: {}, template: TEMPLATE }));
    await assert.rejects(() => makeRunner(harness).run({ record: RECORD, template: { mode: 'cartesian' } }));
    assert.equal(harness.submitted.length, 0);
});

test('objectInfo を渡さずに計画を組ませない（縮んだ判定が静かに出る）', () => {
    install();
    const runner = new SweepRunner({ objectInfo: null, plan: fakePlan(2) });
    assert.throws(() => runner.preflight(RECORD, TEMPLATE), /objectInfo/);
});

test('preflight は投げずにセル数と見積もりを返す', () => {
    install();
    const harness = sweepHarness();
    const runner = makeRunner(harness, {
        plan: fakePlan(4),
    });
    const result = runner.preflight(RECORD, TEMPLATE);
    assert.equal(result.cellCount, 4);
    assert.equal(result.cells.length, result.cellCount);
    // **見積もりは計画のセル数から出る。** 雛形を別に展開し直すと、
    // 画面に出る件数と実際に回る件数が別の計算から来て、ずれても気づけない。
    assert.equal(result.estimatedSeconds, 4 * 60);
    assert.equal(runner.preflight(RECORD, TEMPLATE, { secondsPerCell: 15 }).estimatedSeconds, 60);
    assert.equal(harness.submitted.length, 0);
});

// -------------------------------------------------- seed だけを振る

test('seed だけの実験は軸を1本も持たず、seed の数だけセルができる', async () => {
    setLocale('en');
    const { expandSweepTemplate } = await import('../web/core/recipeSweep.js');
    const record = { id: 'r', gen_params: { seed: 100, cfg_scale: 7, steps: 20 }, loras: [] };
    const template = buildBuiltinSweepTemplates(record).find(t => t.id === 'builtin-seed-only');

    assert.ok(template, 'seed だけの雛形が無い');
    assert.equal(template.mode, 'seeds_only');
    assert.deepEqual(template.axes, [], '軸を持っている＝seed 以外も動く');
    assert.deepEqual(template.seeds, [100, 101, 102, 103], '記録の seed から始まっていない');

    const cells = expandSweepTemplate(template);
    assert.equal(cells.length, 4);
    assert.deepEqual(cells.map(c => c.seed), [100, 101, 102, 103]);
    // **記録の seed が基準。** ここがずれると「元の1枚」と比べられない。
    assert.deepEqual(cells.map(c => c.baseline), [true, false, false, false]);
    assert.equal(new Set(cells.map(c => c.signature)).size, 4, 'signature が重複している');
    for (const cell of cells) assert.deepEqual(cell.labels, []);
});

test('seed だけの雛形は一番上に出る（一番よく要る実験なので）', () => {
    setLocale('en');
    const record = { id: 'r', gen_params: { seed: 1 }, loras: [{ modelName: 'A', strength: 0.8 }] };
    assert.equal(buildBuiltinSweepTemplates(record)[0].id, 'builtin-seed-only');
});

test('記録に seed が無いことを説明に書く（同じ絵が1枚も出ない）', () => {
    setLocale('en');
    const withSeed = buildBuiltinSweepTemplates({ id: 'r', gen_params: { seed: 42 }, loras: [] })[0];
    const without = buildBuiltinSweepTemplates({ id: 'r', gen_params: {}, loras: [] })[0];
    assert.match(withSeed.description, /recorded seed 42/);
    assert.match(without.description, /no seed/);
    assert.deepEqual(without.seeds, [0, 1, 2, 3]);
});

test('seeds_only に軸を足したら弾く（名前と中身が食い違う）', async () => {
    const { expandSweepTemplate } = await import('../web/core/recipeSweep.js');
    assert.throws(() => expandSweepTemplate({
        id: 'x', mode: 'seeds_only', seeds: [1, 2],
        axes: [{ id: 'a', kind: 'generation_parameter', parameter: 'steps', values: [
            { label: 'p', value: 1, baseline: true }, { label: 'q', value: 2, baseline: false },
        ] }],
    }), /seeds_only takes no axis/);
});

test('seed だけの実験は seed 以外の入力を動かさない（変更検査で固定）', async () => {
    const { assertOnlySweepInputsChanged, applySweepCell } = await import('../web/core/recipeSweep.js');
    const template = { id: 'x', mode: 'seeds_only', axes: [], seeds: [1, 2] };
    const record = { id: 'r', gen_params: { seed: 1, steps: 20 } };
    // seed だけを差し替えた記録になっていること。
    const varied = applySweepCell(record, template, { selections: {}, seed: 2 });
    assert.equal(varied.gen_params.seed, 2);
    assert.equal(varied.gen_params.steps, 20);

    // グラフの seed だけが動いているなら通る。
    assertOnlySweepInputsChanged(
        { 3: { inputs: { seed: 1, steps: 20 } } },
        { 3: { inputs: { seed: 2, steps: 20 } } },
        template, { includeSeed: true },
    );
    // steps まで動いていたら通らない。
    assert.throws(() => assertOnlySweepInputsChanged(
        { 3: { inputs: { seed: 1, steps: 20 } } },
        { 3: { inputs: { seed: 2, steps: 30 } } },
        template, { includeSeed: true },
    ), /unintended graph inputs/);
});
