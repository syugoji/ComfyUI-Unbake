/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 移してきた4本の検査。
 *
 * **固定するのは「安全側の決めごと」だけ。** どれも壊れても例外にならず、
 * 静かに別の意味へ変わる種類のもの——
 *
 *  - 記録そのものを書き換えていないこと（上書きは別レイヤ）
 *  - 旧い形の実行リストを読んで束を失わないこと
 *  - 数えられなかった記録を「0件が使っている」と混ぜないこと
 *  - 投げたか判らない候補を自動で投げ直さないこと
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installEnvironment, resetEnvironment } from '../web/core/environment.js';
import {
    readStored, writeStored, storageIsVolatile, resetMemoryStorage,
} from '../web/core/storage.js';
import {
    applyLoraOverrides, applyRecordOverrides, clearAllOverrides, clearLoraOverrides,
    getLoraOverride, getModelOverride, hasAnyOverride, hasLoraOverrides,
    setLoraOverride, setModelOverride,
} from '../web/core/recipeLoraOverrides.js';
import {
    addRunListEntries, createList, deleteList, getActiveList, loadRunListState,
    moveRunListEntry, normalizeRunListState, removeRunListEntry, saveRunListState,
} from '../web/core/recipeRunList.js';
import {
    buildModelUsageIndex, modelNamesInBuilt, otherUsers, rankMissingByUnlock,
    summarizeRecordModels, usageKey,
} from '../web/core/recipeModelUsage.js';
import {
    createTrialSeeds, historyImages, RecipeTrialRunner, summarizeTrial,
} from '../web/core/recipeTrialRunner.js';

/** 手元の入れ物のダブル。`throwOnSet` で容量超過を作れる。 */
function fakeStorage({ throwOnSet = false } = {}) {
    const map = new Map();
    return {
        map,
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => {
            if (throwOnSet) throw new Error('QuotaExceededError');
            map.set(k, String(v));
        },
        removeItem: (k) => { map.delete(k); },
    };
}

function install({ request = (input) => Promise.resolve({ ok: true, status: 200, json: () => ({}) }), storage = fakeStorage() } = {}) {
    resetMemoryStorage();
    installEnvironment({ request, storage });
    return storage;
}

// ---------------------------------------------------------------- storage

test('入れ物が据えられていなければ揮発の入れ物へ倒れる（例外にしない）', () => {
    resetEnvironment();
    resetMemoryStorage();
    assert.equal(storageIsVolatile(), true);
    assert.equal(writeStored('k', { a: 1 }), true);
    assert.deepEqual(readStored('k', null), { a: 1 });
});

test('壊れた JSON は既定へ倒す（画面ごと落とさない）', () => {
    const storage = install();
    storage.map.set('broken', '{ not json');
    assert.deepEqual(readStored('broken', { fallback: true }), { fallback: true });
});

test('書けなかったことを true で返さない（容量超過を黙って飲まない）', () => {
    install({ storage: fakeStorage({ throwOnSet: true }) });
    assert.equal(writeStored('k', 1), false);
});

// --------------------------------------------------------- LoRA の上書き

test('上書きしても記録そのものは変わらない（比較の基準点が動かない）', () => {
    install();
    const record = {
        id: 'r1',
        loras: [{ modelVersionId: 111, file_name: 'a.safetensors', strength_model: 0.4, strength_clip: 0.4 }],
    };
    const frozen = JSON.stringify(record);
    setLoraOverride('r1', record.loras[0], 0, 0.9);
    const applied = applyLoraOverrides(record);

    assert.equal(JSON.stringify(record), frozen, '元の記録が書き換わっている');
    assert.notEqual(applied, record);
    assert.equal(applied.loras[0].strength_model, 0.9);
    assert.equal(applied.loras[0].strength_clip, 0.9);
    // **自動抑制の対象から外す印。** 手で指した値を勝手に縮めない。
    assert.equal(applied.loras[0].user_override, true);
});

// --- モデルの差し替え（2026-08-22 利用者の指示）------------------------------

test('差し替えは `localPath` も一緒に書く（`file_name` だけでは効かない）', () => {
    install();
    const record = {
        id: 's1',
        loras: [{ modelVersionId: 111, file_name: 'old.safetensors', localPath: 'a\\old.safetensors' }],
    };
    const frozen = JSON.stringify(record);
    setModelOverride('s1', record.loras[0], 0, 'b\\new.safetensors');
    const applied = applyRecordOverrides(record);

    assert.equal(JSON.stringify(record), frozen, '元の記録が書き換わっている');
    // **組み立ては `inLibrary ? localPath : null` を先に見る**
    //（`recipeWorkflowBuilder.getResourceFilename`）。`localPath` が古いままだと
    // そちらが勝ち、**画面は変わったのに違うモデルで回る**——一番わかりにくい形。
    assert.equal(applied.loras[0].localPath, 'b\\new.safetensors', 'localPath が古いまま');
    assert.equal(applied.loras[0].file_name, 'b\\new.safetensors');
    assert.equal(applied.loras[0].inLibrary, true, '手元に在る印が付いていない');
});

test('checkpoint は文字列で持っていても差し替えられる', () => {
    install();
    // 記録によって checkpoint は文字列だったり資源だったりする。
    setModelOverride('s2', null, 0, 'new_ck.safetensors');
    const applied = applyRecordOverrides({ id: 's2', checkpoint: 'old_ck', loras: [] });
    assert.equal(applied.checkpoint.file_name, 'new_ck.safetensors');
    assert.equal(applied.checkpoint.localPath, 'new_ck.safetensors');
    // 元の名前は捨てない（何から差し替えたのかが辿れなくなる）。
    assert.equal(applied.checkpoint.name, 'old_ck');
});

test('強度と差し替えが同じ1本に両方効く', () => {
    install();
    const lora = { modelVersionId: 333, file_name: 'old.safetensors', strength_model: 0.5 };
    const record = { id: 's3', loras: [lora] };
    setLoraOverride('s3', lora, 0, 1.1);
    setModelOverride('s3', lora, 0, 'new.safetensors');
    const applied = applyRecordOverrides(record);
    // **強度を先に重ねる。** 差し替えでファイル名が変わった後に強度を引くと、
    // 版 ID を持たない記録では鍵が変わって当たらなくなる。
    assert.equal(applied.loras[0].strength_model, 1.1, '強度が当たっていない');
    assert.equal(applied.loras[0].file_name, 'new.safetensors', '差し替えが当たっていない');
});

test('差し替えの鍵も modelVersionId を優先する', () => {
    install();
    const lora = { modelVersionId: 444, file_name: 'old.safetensors' };
    setModelOverride('s4', lora, 0, 'picked.safetensors');
    assert.equal(getModelOverride('s4', { modelVersionId: 444, file_name: 'renamed' }, 0), 'picked.safetensors');
    assert.equal(getModelOverride('s4', { modelVersionId: 999 }, 0), null);
});

test('強度と差し替えは別の入れ物に置く（片方を消してももう片方は残る）', () => {
    install();
    const lora = { modelVersionId: 555 };
    setLoraOverride('s5', lora, 0, 0.7);
    setModelOverride('s5', lora, 0, 'x.safetensors');
    clearLoraOverrides('s5');
    assert.equal(getLoraOverride('s5', lora, 0), null);
    assert.equal(getModelOverride('s5', lora, 0), 'x.safetensors', '関係ない方まで消えている');
    assert.equal(hasAnyOverride('s5'), true);
    clearAllOverrides('s5');
    assert.equal(hasAnyOverride('s5'), false);
});

test('手入れが無ければ複製を返さない（同じ物として比べられる）', () => {
    install();
    const record = { id: 's6', checkpoint: 'ck', loras: [{ modelVersionId: 1 }] };
    assert.equal(applyRecordOverrides(record), record, '手入れが無いのに複製を返している');
});

test('鍵は modelVersionId を優先する（改名・版差し替えで迷子にならない）', () => {
    install();
    const lora = { modelVersionId: 222, file_name: 'old-name.safetensors' };
    setLoraOverride('r2', lora, 0, 0.55);
    // ファイル名だけ変えても同じ上書きが引ける。
    assert.equal(getLoraOverride('r2', { modelVersionId: 222, file_name: 'new-name.safetensors' }, 0), 0.55);
    // 版が違えば別物。
    assert.equal(getLoraOverride('r2', { modelVersionId: 999, file_name: 'old-name.safetensors' }, 0), null);
});

test('上書きを全部消すと、記録どおりへ戻る', () => {
    install();
    const record = { id: 'r3', loras: [{ modelVersionId: 1, strength_model: 0.3, strength_clip: 0.3 }] };
    setLoraOverride('r3', record.loras[0], 0, 1.2);
    assert.equal(hasLoraOverrides('r3'), true);
    clearLoraOverrides('r3');
    assert.equal(hasLoraOverrides('r3'), false);
    assert.equal(applyLoraOverrides(record), record, '上書きが無いのに複製を返している');
});

test('null を渡した1本だけが消える（他の上書きは残る）', () => {
    install();
    const a = { modelVersionId: 1 };
    const b = { modelVersionId: 2 };
    setLoraOverride('r4', a, 0, 0.5);
    setLoraOverride('r4', b, 1, 0.7);
    setLoraOverride('r4', a, 0, null);
    assert.equal(getLoraOverride('r4', a, 0), null);
    assert.equal(getLoraOverride('r4', b, 1), 0.7);
});

// ------------------------------------------------------------ 実行リスト

test('旧い形（ただの配列）を読んでも束を失わない', () => {
    install();
    const state = normalizeRunListState([{ id: 'x', title: 'X' }, { id: 'y', title: 'Y' }]);
    assert.equal(state.lists.length, 1);
    assert.equal(state.lists[0].entries.length, 2);
    assert.equal(state.activeId, state.lists[0].id);
});

test('壊れた保存値でも入れ物を1つ返す（追加すらできない状態を作らない）', () => {
    install();
    for (const broken of [null, 0, 'nope', { lists: 'no' }, { lists: [] }]) {
        const state = normalizeRunListState(broken);
        assert.equal(state.lists.length, 1, JSON.stringify(broken));
        assert.ok(state.activeId);
    }
});

test('重複は足さず、足せた件数と飛ばした件数を返す', () => {
    const first = addRunListEntries([], [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]);
    assert.deepEqual([first.added, first.skipped], [2, 0]);
    const second = addRunListEntries(first.entries, [{ id: 'b' }, { id: 'c' }, { no: 'id' }]);
    assert.deepEqual([second.added, second.skipped], [1, 2]);
    assert.deepEqual(second.entries.map(e => e.id), ['a', 'b', 'c']);
});

test('端を越える移動は並びを変えない（黙って端で折り返さない）', () => {
    const entries = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    assert.deepEqual(moveRunListEntry(entries, 'a', -1).map(e => e.id), ['a', 'b', 'c']);
    assert.deepEqual(moveRunListEntry(entries, 'c', 1).map(e => e.id), ['a', 'b', 'c']);
    assert.deepEqual(moveRunListEntry(entries, 'a', 1).map(e => e.id), ['b', 'a', 'c']);
    assert.deepEqual(removeRunListEntry(entries, 'b').map(e => e.id), ['a', 'c']);
});

test('最後の1本は消せない（入れ物が無くなる）', () => {
    install();
    let state = normalizeRunListState(null);
    const onlyId = state.lists[0].id;
    state = deleteList(state, onlyId);
    assert.equal(state.lists.length, 1);

    state = createList(state, 'second');
    assert.equal(state.lists.length, 2);
    state = deleteList(state, onlyId);
    assert.equal(state.lists.length, 1);
    assert.equal(state.activeId, state.lists[0].id, '消した束が active のまま残っている');
});

test('保存して読み直しても束と順番が残る', () => {
    install();
    let state = normalizeRunListState(null);
    state = { ...state, lists: [{ ...state.lists[0], entries: [{ id: 'z' }, { id: 'y' }] }] };
    assert.equal(saveRunListState(state), true);
    assert.deepEqual(getActiveList(loadRunListState()).entries.map(e => e.id), ['z', 'y']);
});

// -------------------------------------------------------- モデルの共有度

const builtOf = (...names) => ({
    prompt: Object.fromEntries(names.map((name, i) => [String(i), { inputs: { lora_name: name } }])),
});

test('照合鍵が区切りと大小を無視する', () => {
    assert.equal(usageKey('Sub\\Dir\\A.safetensors'), 'sub/dir/a.safetensors');
    assert.equal(modelNamesInBuilt(builtOf('X\\y.safetensors')).size, 1);
});

test('数えられなかった記録を「0件が使っている」と混ぜない', () => {
    const build = (record) => {
        if (record.bad) throw new Error('組めない');
        return builtOf('shared.safetensors');
    };
    const index = buildModelUsageIndex(
        [{ id: '1' }, { id: '2', bad: true }, { id: '3' }],
        { objectInfo: {}, build }
    );
    assert.equal(index.scanned, 3);
    assert.equal(index.counted, 2, '組めた件数');
    assert.equal(index.failures.length, 1);
    assert.equal(index.failures[0].id, '2');
    assert.equal(index.usage.get('shared.safetensors').length, 2);
});

test('自分自身は共有件数に入らない', () => {
    const build = () => builtOf('shared.safetensors');
    const index = buildModelUsageIndex([{ id: 'me' }, { id: 'other' }], { objectInfo: {}, build });
    assert.equal(otherUsers(index, 'shared.safetensors', 'me').length, 1);
    const rows = summarizeRecordModels(builtOf('shared.safetensors'), index, 'me');
    assert.equal(rows[0].others, 1);
    assert.equal(rows[0].sharedWithOthers, true);
});

test('不足しているモデルは「解ける件数」の多い順に並ぶ', () => {
    const usage = new Map([
        ['a.safetensors', [{ id: '1' }, { id: '2' }, { id: '3' }]],
        ['b.safetensors', [{ id: '1' }]],
    ]);
    const ranked = rankMissingByUnlock(['b.safetensors', 'A.safetensors', 'c.safetensors'], { usage });
    assert.deepEqual(ranked.map(r => [r.name, r.unlocks]), [
        ['A.safetensors', 3],
        ['b.safetensors', 1],
        ['c.safetensors', 0],
    ]);
});

test('削除の示唆を持たない（モデルの整理はこの製品の外）', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../web/core/recipeModelUsage.js', import.meta.url), 'utf8');
    // 上流にあった `selectedByDefault`（一括削除の既定選択）を持ち込んでいないこと。
    assert.equal(src.includes('selectedByDefault'), false);
});

// ---------------------------------------------------------------- 試行

test('記録の seed が必ず1本目に入り、4本とも重複しない', () => {
    let n = 100;
    const seeds = createTrialSeeds(42, () => n++);
    assert.equal(seeds.length, 4);
    assert.deepEqual(seeds[0], { seed: 42, origin: 'original' });
    assert.equal(new Set(seeds.map(s => s.seed)).size, 4);
    assert.deepEqual(seeds.slice(1).map(s => s.origin), ['random', 'random', 'random']);
});

test('記録に seed が無ければ4本とも無作為（完全再現の候補が無いと読める）', () => {
    let n = 7;
    const seeds = createTrialSeeds(undefined, () => n++);
    assert.equal(seeds.length, 4);
    assert.ok(seeds.every(s => s.origin === 'random'));
});

test('無作為源が同じ値しか返さなくても止まらない', () => {
    const seeds = createTrialSeeds(null, () => 5);
    assert.equal(new Set(seeds.map(s => s.seed)).size, 4);
});

test('履歴の画像は /api/view を指す（投入経路と同じ形）', () => {
    const images = historyImages({
        outputs: { 9: { images: [{ filename: 'a.png', subfolder: 'x', type: 'output' }, { filename: 'b.png' }] } },
    });
    assert.equal(images.length, 2);
    assert.match(images[0].url, /^\/api\/view\?/);
    assert.match(images[0].url, /filename=a\.png/);
    assert.deepEqual(images.map(i => i.image_index), [0, 1]);
});

/** 試行の実行を測るための宿主のダブル。 */
function trialHarness({ queueBusy = false, mismatchPromptId = false, submitThrows = false } = {}) {
    const calls = [];
    const submitted = [];
    const history = new Map();
    const json = (payload) => ({ ok: true, status: 200, json: async () => payload });
    const request = async (input, init = {}) => {
        calls.push({ input, init });
        if (input === '/queue' && init.method !== 'POST') {
            return json(queueBusy ? { queue_running: [[0, 'other']], queue_pending: [] } : { queue_running: [], queue_pending: [] });
        }
        if (input === '/queue' || input === '/interrupt') return json({});
        if (input === '/prompt') {
            if (submitThrows) return { ok: false, status: 500, json: async () => ({ message: 'boom' }) };
            const body = JSON.parse(init.body);
            submitted.push(body);
            // 食い違うときは、ComfyUI が**別の id で**受け付けた状況を作る。
            // こちらが握っている id には履歴が付かない＝結果を辿れない。
            const id = mismatchPromptId ? 'somebody-elses-id' : body.prompt_id;
            history.set(id, {
                status: { completed: true, status_str: 'success' },
                outputs: { 9: { images: [{ filename: `${body.prompt_id}.png`, type: 'output' }] } },
            });
            return json({ prompt_id: id });
        }
        if (input.startsWith('/history/')) {
            const id = decodeURIComponent(input.slice('/history/'.length));
            return json(history.has(id) ? { [id]: history.get(id) } : {});
        }
        throw new Error(`unexpected request: ${input}`);
    };
    return { request, calls, submitted, history };
}

function makeRunner(harness, overrides = {}) {
    let counter = 0;
    return new RecipeTrialRunner({
        objectInfo: {},
        request: harness.request,
        analyze: async (record) => ({
            level: 'exact',
            reasons: [],
            audit: { ok: true, failures: [] },
            built: {
                prompt: { 3: { inputs: { seed: record.gen_params.seed } } },
                replayManifest: { manifest_hash: 'hash-1' },
            },
        }),
        now: () => 1_000_000,
        sleep: async () => {},
        randomSeed: () => 1000 + (counter += 1),
        uuid: () => `id-${counter += 1}`,
        pollIntervalMs: 0,
        warn: () => {},
        ...overrides,
    });
}

const RECORD = { id: 'rec-1', title: 'T', gen_params: { seed: 42 }, loras: [] };

test('4件とも投げて成功し、印が PNG に載る側にも入る', async () => {
    install();
    const harness = trialHarness();
    const job = await makeRunner(harness).start({ record: RECORD });

    assert.equal(job.status, 'completed');
    assert.equal(harness.submitted.length, 4);
    const stamp = harness.submitted[0].extra_data.extra_pnginfo.unbake_trial;
    assert.equal(stamp.schema, 'unbake.trial');
    assert.equal(stamp.record_id, 'rec-1');
    assert.equal(stamp.seed_origin, 'original');
    assert.equal(stamp.manifest_hash, 'hash-1');

    const summary = summarizeTrial(job);
    assert.deepEqual([summary.succeeded, summary.total], [4, 4]);
    assert.equal(summary.originalSeedSucceeded, true, '記録の seed で出た1枚が数えられていない');
    assert.equal(summary.images.length, 4);
});

test('seed ごとに組み直す（同じグラフを4回投げない）', async () => {
    install();
    const harness = trialHarness();
    await makeRunner(harness).start({ record: RECORD });
    const seeds = harness.submitted.map(body => body.prompt[3].inputs.seed);
    assert.equal(new Set(seeds).size, 4, '投げたグラフの seed が重複している');
    assert.equal(seeds[0], 42);
});

test('キューが空でなければ1件も投げない', async () => {
    install();
    const harness = trialHarness({ queueBusy: true });
    await assert.rejects(() => makeRunner(harness).start({ record: RECORD }));
    assert.equal(harness.submitted.length, 0, '他人の生成に混ぜている');
});

test('prompt ID が食い違ったら submission_unknown で止め、投げ直さない', async () => {
    install();
    const harness = trialHarness({ mismatchPromptId: true });
    await makeRunner(harness).start({ record: RECORD }).catch(() => {});
    assert.equal(harness.submitted.length, 1, '食い違ったのに投げ直している');

    const runner = makeRunner(harness);
    const job = await runner.recover('rec-1');
    assert.equal(job.candidates[0].status, 'submission_unknown');
    assert.deepEqual(job.candidates.slice(1).map(c => c.status), ['not_submitted', 'not_submitted', 'not_submitted']);
});

test('投げられたか判らない失敗を「失敗」と混ぜない', async () => {
    install();
    const harness = trialHarness({ submitThrows: true });
    // **例外で終わらせない。** 投げた分の行方が呼び手へ返らなくなる。
    const job = await makeRunner(harness).start({ record: RECORD });
    assert.equal(job.status, 'failed');
    assert.equal(job.candidates[0].status, 'submission_unknown');
    assert.match(job.candidates[0].error, /boom/);

    const stored = await makeRunner(harness).recover('rec-1');
    assert.equal(stored.candidates[0].status, 'submission_unknown', '拾い直しで失敗へ格下げしている');
});

test('未完了の試行が残っていれば、新しい試行を始めない', async () => {
    const storage = install();
    const harness = trialHarness({ submitThrows: true });
    await makeRunner(harness).start({ record: RECORD }).catch(() => {});
    // 記録した job を「まだ走っている」形へ戻す。
    const key = [...storage.map.keys()].find(k => k.startsWith('unbake.trial.'));
    const job = JSON.parse(storage.map.get(key));
    job.status = 'running';
    storage.map.set(key, JSON.stringify(job));

    await assert.rejects(
        () => makeRunner(harness).start({ record: RECORD }),
        /unfinished|未完了|已存在|存在|незавершённый|완료되지|inachevé|terminar|inacabada|tamamlanmamış|مكتملة|ناتمام/u
    );
});

test('期限切れの試行は読んだ時点で消える（永久に始められない状態を作らない）', async () => {
    const storage = install();
    const harness = trialHarness();
    const runner = makeRunner(harness, { now: () => 5_000_000 });
    storage.map.set('unbake.trial.rec-1', JSON.stringify({
        schema: 'unbake.trial', version: 1, record_id: 'rec-1',
        expires_at: 1_000, status: 'running', candidates: [],
    }));
    assert.equal(runner.readStoredJob('rec-1'), null);
    assert.equal(storage.map.has('unbake.trial.rec-1'), false);
});

test('記録に ID が無ければ始めない（追跡できない試行を作らない）', async () => {
    install();
    const harness = trialHarness();
    await assert.rejects(() => makeRunner(harness).start({ record: { gen_params: { seed: 1 } } }));
    assert.equal(harness.submitted.length, 0);
});

test('組めない記録ではキューを一切触らない', async () => {
    install();
    const harness = trialHarness();
    const runner = makeRunner(harness, {
        analyze: async () => ({ level: 'unavailable', reasons: ['missing model'], built: null }),
    });
    await assert.rejects(() => runner.start({ record: RECORD }), /missing model/);
    assert.equal(harness.submitted.length, 0);
    assert.equal(harness.calls.filter(c => c.input === '/queue').length, 0, 'キューを見に行っている');
});
