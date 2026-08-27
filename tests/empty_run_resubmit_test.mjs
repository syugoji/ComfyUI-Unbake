/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **出た絵を消した直後の再現が、何も作らずに終わる**（2026-08-27 実機の報告）。
 *
 * ComfyUI は**直前と同じグラフ**を投げると実行キャッシュに当てて何も実行せず、
 * `status: success` のまま `outputs` を空で返す。絵を消した直後の再現がまさにこれで、
 * **消したのに作り直されない**。呼び手からは「投げたのに何も出なかった」に見え、
 * 記録の絵が全部消えていれば「絵は出ませんでした。ComfyUI の履歴にも、
 * 出力フォルダにも見つかりません。」まで進む。
 *
 * ---
 *
 * **実測（同じ記録を連続で投げた4回・127.0.0.1:8188）**:
 *
 *     12c465f3  1回目            → 画像1枚（`civitai_66655100_00006_.png`）
 *     （ここで `_00006_` を消す）
 *     afc15d63  2回目（同一）     → **outputs 空・画像0枚・status success**
 *     8baeacb1  3回目（同一）     → 画像1枚（1.0秒で復活）
 *
 * **空振りした投入そのものがキャッシュを流す**ので、**もう1度同じものを投げれば出る**。
 * `filename_prefix` を変えてキャッシュを外す案も測ったが（1.0秒で成功する）、
 * **名前が汚れる害の方が大きい**ので採らなかった——帰属は出力名の `civitai_<id>` を
 * 読むので、細工した名前は後から読む側の負担になる。
 *
 * **`/free` も採らない。** ComfyUI の実装では `free_memory` は
 * `flags.get("unload_models", free_memory)` を通って**モデルもアンロードする**
 * （`main.py`）。1枚消しただけで土台モデルを落とすのは釣り合わない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SweepRunner } from '../web/core/sweepRunner.js';
import { setLocale } from '../web/i18n/index.js';

setLocale('ja');

/** 最小の object_info（実行器は投げる前にこれを見る）。 */
const OBJECT_INFO = {
    KSampler: { input: { required: { sampler_name: [['euler']], scheduler: [['normal']] } } },
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [['base.safetensors']] } } },
    SaveImage: { input: { required: { filename_prefix: ['STRING'] } } },
};

/**
 * 投入のたびに `outputs` を出し分ける偽の宿主。
 *
 * @param {Array<'empty'|'image'>} script 何回目に何を返すか
 */
function fakeHost(script) {
    const submits = [];
    const history = new Map();
    // **実在するファイルの集合。** `image` は作る、`ghost` は**名前だけ返して作らない**
    // ——キャッシュに当たった投入の実機の形がこれ（履歴は前回の名前を返す）。
    const onDisk = new Set();
    let turn = 0;
    const request = async (path, options = {}) => {
        if (path.startsWith('/api/view')) {
            const name = decodeURIComponent(/filename=([^&]+)/.exec(path)?.[1] || '');
            return onDisk.has(name)
                ? { ok: true, status: 200, json: async () => ({}) }
                : { ok: false, status: 404, json: async () => ({}) };
        }
        if (path === '/prompt') {
            const body = JSON.parse(options.body);
            const promptId = body.prompt_id;
            const kind = script[Math.min(turn, script.length - 1)];
            turn += 1;
            // **投げた名前を控える。** 投げ直しで本当にずれているかは、
            // ここを見ないと測れない（実装だけ直っていても検査は素通りする）。
            const saved = Object.values(body.prompt || {})
                .find(n => n?.class_type === 'SaveImage');
            submits.push({ promptId, kind, prefix: saved?.inputs?.filename_prefix ?? null });
            const named = (name) => ({
                status: { completed: true, status_str: 'success' },
                outputs: { 7: { images: [{ filename: name, subfolder: '', type: 'output' }] } },
            });
            if (kind === 'image') {
                const name = `out_${turn}.png`;
                onDisk.add(name);
                history.set(promptId, named(name));
            } else if (kind === 'ghost') {
                // **実機の主な形**: 成功・履歴は前回の名前・**ファイルは作られない**。
                history.set(promptId, named('out_ghost.png'));
            } else {
                // **もう1つの形**: 成功しているのに outputs が空。
                history.set(promptId, { status: { completed: true, status_str: 'success' }, outputs: {} });
            }
            return { ok: true, json: async () => ({ prompt_id: promptId }) };
        }
        if (path.startsWith('/history/')) {
            const id = decodeURIComponent(path.slice('/history/'.length));
            const entry = history.get(id);
            return { ok: true, json: async () => (entry ? { [id]: entry } : {}) };
        }
        if (path === '/queue') {
            return { ok: true, json: async () => ({ queue_running: [], queue_pending: [] }) };
        }
        return { ok: true, json: async () => ({}) };
    };
    return { request, submits };
}

const RECIPE = {
    id: 'rec-1',
    checkpoint: { file_name: 'base.safetensors' },
    loras: [],
    gen_params: { prompt: 'a girl', negative_prompt: '', seed: 7, steps: 20, cfg_scale: 7, sampler: 'Euler', size: '512x512' },
};
const TEMPLATE = { id: 'tpl-1', mode: 'seeds_only', axes: [], seeds: [7], recipeId: 'rec-1' };

function makeRunner(host) {
    let n = 0;
    return new SweepRunner({
        objectInfo: OBJECT_INFO,
        request: host.request,
        sleep: async () => {},
        now: () => Date.now(),
        uuid: () => `prompt-${++n}`,
        storage: null,
    });
}

test('成功しても画像0枚なら、1度だけ投げ直す', async () => {
    // 1投目は空（実行キャッシュに当たった形）、2投目で出る。
    const host = fakeHost(['empty', 'image']);
    const job = await makeRunner(host).run({ record: RECIPE, template: TEMPLATE, reuseExisting: false });
    assert.equal(host.submits.length, 2, `投げ直していない（投入 ${host.submits.length} 回）`);
    const cell = job.cells[0];
    assert.equal(cell.status, 'completed', `画像が出たのに完了になっていない: ${cell.error}`);
    assert.equal(cell.resubmitted, true, '投げ直したことが記録に残らない（画面で説明できない）');
});

test('1投目で出たなら、投げ直さない', async () => {
    const host = fakeHost(['image']);
    const job = await makeRunner(host).run({ record: RECIPE, template: TEMPLATE, reuseExisting: false });
    assert.equal(host.submits.length, 1, '出ているのに二重に投げている');
    assert.notEqual(job.cells[0].resubmitted, true);
});

test('2度目も空なら、そこで諦める（投入は2回で止まる）', async () => {
    // **止めているのは輪でないこと**——実装は各セルを1回通るだけの `if` で、
    // 通った後のセルは `failed`（`DONE_STATES`）になり再開しても素通りする。
    // `!cell.resubmitted` の側は**変異させても赤くならない**＝今は一度も偽にならない。
    // ここが見張るのは「投入が2回で止まる」という観測できる性質のほう。
    const host = fakeHost(['empty', 'empty']);
    const job = await makeRunner(host).run({ record: RECIPE, template: TEMPLATE, reuseExisting: false });
    assert.equal(host.submits.length, 2, `投げ直しが1度で止まっていない（${host.submits.length} 回）`);
    assert.equal(job.cells[0].status, 'failed', '空のまま完了扱いになっている');
});

test('投げ直しの判定は訳文ではなく理由の語で行う', async () => {
    // **locale を1つ足した日に静かに効かなくなる形**にしない。
    const host = fakeHost(['empty', 'image']);
    setLocale('en');
    try {
        const job = await makeRunner(host).run({ record: RECIPE, template: TEMPLATE, reuseExisting: false });
        assert.equal(host.submits.length, 2, '日本語以外だと投げ直さない（訳文で分岐している）');
        assert.equal(job.cells[0].status, 'completed');
    } finally {
        setLocale('ja');
    }
});

test('完了と言われても、その絵が実在しないなら投げ直す', async () => {
    /*
     * **これが実機の主な形**（2026-08-27 実測・素の投入を3回続けた）:
     *
     *     ①1回目  outputs=['7'] 履歴=`_00006_`  **実ファイル増えた**
     *     ②2回目  outputs=['7'] 履歴=`_00006_`  **増えない**
     *     ③3回目  outputs=['7'] 履歴=`_00006_`  **増えない**
     *
     * `outputs` は空にならないので、**空だけを見ていると丸ごと見逃す**
     * ——「再現しました（1枚）」と言いながら、指している絵が無い。
     */
    const host = fakeHost(['ghost', 'image']);
    const job = await makeRunner(host).run({ record: RECIPE, template: TEMPLATE, reuseExisting: false });
    assert.equal(host.submits.length, 2,
        `実在しない絵を「出た」として受け入れている（投入 ${host.submits.length} 回）`);
    assert.equal(job.cells[0].status, 'completed');
    assert.equal(job.cells[0].output.filename, 'out_2.png', '実在する方の絵を採っていない');
    assert.equal(job.cells[0].resubmitted, true);
});

test('実在する絵が返ったなら、存在確認で余計に投げない', async () => {
    const host = fakeHost(['image']);
    const job = await makeRunner(host).run({ record: RECIPE, template: TEMPLATE, reuseExisting: false });
    assert.equal(host.submits.length, 1, '在る絵にまで投げ直している');
    assert.equal(job.cells[0].status, 'completed');
});

test('存在を確かめられないときは、在るものとして扱う（作り直しにいかない）', async () => {
    // **404 のときだけ「無い」と言う。** 口が落ちているだけで作り直すと、
    // 出ている絵をもう一度作ることになる。
    const host = fakeHost(['image']);
    const runner = makeRunner(host);
    const original = runner.request.bind(runner);
    runner.request = async (path, init) => {
        if (String(path).startsWith('/api/view')) throw new Error('接続できない');
        return original(path, init);
    };
    const job = await runner.run({ record: RECIPE, template: TEMPLATE, reuseExisting: false });
    assert.equal(host.submits.length, 1, '確かめられないだけで投げ直している');
    assert.equal(job.cells[0].status, 'completed');
});

test('404 以外の不調は「無い」と読まない（500 で作り直しにいかない）', async () => {
    // **「確かめられなかった」と「消えた」を分ける。** 宿主が一時的に 500 を返す間、
    // 出ている絵をもう一度作りにいくと、同じ条件から2枚できて比較の前提が壊れる。
    const host = fakeHost(['image']);
    const runner = makeRunner(host);
    const original = runner.request.bind(runner);
    runner.request = async (path, init) => {
        if (String(path).startsWith('/api/view')) {
            return { ok: false, status: 500, json: async () => ({}) };
        }
        return original(path, init);
    };
    const job = await runner.run({ record: RECIPE, template: TEMPLATE, reuseExisting: false });
    assert.equal(host.submits.length, 1,
        `500 を「消えた」と読んで投げ直している（投入 ${host.submits.length} 回）`);
    assert.equal(job.cells[0].status, 'completed');
});

test('投げ直しても実体が無いなら、「出た」と言わない', async () => {
    /*
     * **実機で投げ直しは効かなかった**（2026-08-27）。同一グラフを3回続けて投げても
     * 履歴は3回とも `_00006_` と言い、**実ファイルは1度も作られなかった**。
     *
     * つまり投げ直しは「効くこともある」程度の手当てにすぎない。
     * **効かなかったときに「出た」と言わないこと**のほうが重い——実体の無い絵を
     * `completed` で返すと、上は「再現しました（1枚）」と言いながら
     * **存在しない絵を開き**、索引にも覚えてしまう。
     */
    const host = fakeHost(['ghost', 'ghost']);
    const job = await makeRunner(host).run({ record: RECIPE, template: TEMPLATE, reuseExisting: false });
    assert.equal(host.submits.length, 2, '投げ直しを試していない');
    const cell = job.cells[0];
    assert.equal(cell.status, 'failed', '実体が無いのに完了として返している');
    assert.equal(cell.reason, 'not-written');
    assert.match(cell.error, /実行済み/, `理由が説明になっていない: ${cell.error}`);
});

// --- 画面まで理由が届くか -----------------------------------------------------

test('作られなかった理由が、画面の履歴に出る', async () => {
    /*
     * **黙ると古い絵が開く。** 実行器が `not-written` で失敗させても、面の側が
     * 何も言わずに「記録の他の絵」を開くと、押した人には**同じ絵が出たようにしか
     * 見えない**。記録の絵が全部消えていれば「絵は出ませんでした…見つかりません」
     * まで進むが、**それは原因を1つも説明していない**（利用者の報告はこの形）。
     */
    const { createUnbakePanel } = await import('../web/panel/panel.js');
    const { fakeDocument } = await import('./fake_dom.mjs');
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc,
        // 記録には**別の絵が残っている**（黙って開かれてしまう条件）。
        loadFreshOutputs: async () => [{ url: '/api/view?filename=old.png', filename: 'old.png', subfolder: '' }],
        makeSweepRunner: () => ({
            inputsReady: Promise.resolve(),
            requireEmptyQueue: async () => {},
            run: async () => ({ cells: [{ id: 'c1', status: 'failed', reason: 'not-written', error: 'ComfyUI が同じ条件を実行済みとして扱い、絵を作りませんでした。' }] }),
        }),
    });
    panel.setRecords([{ id: 'a', title: 'A', recipe: { id: 'a', gen_params: { seed: 1 } } }]);
    panel.root.find(n => String(n.className).includes('unbake-act-replay')).dispatch('click', {});
    for (let i = 0; i < 12; i++) await new Promise(r => setTimeout(r, 0));
    const lines = panel.root.allByClass('unbake-log')
        .flatMap(n => [...n.walk()]).map(n => String(n.textContent || '')).filter(Boolean);
    assert.ok(lines.some(line => line.includes('実行済み')),
        `理由が画面に出ていない: ${JSON.stringify(lines.slice(-3))}`);
});

// --- キャッシュの外し方（2026-08-27・実測でここだけが効いた）------------------

test('投げ直すときは出す名前をずらす（前置きの後ろへ足す）', async () => {
    /*
     * ComfyUI のキャッシュは**ノードの入力だけ**で決まる。同じグラフの投げ直しも、
     * 印（`extra_pnginfo`）の変更も**実測で効かなかった**（どちらも0枚）。
     * 効いたのは `filename_prefix` を変えることだけ（1.0秒で復活）。
     *
     * **後ろへ足す**のが要点——帰属は出力名の `civitai_<id>` を読むので、
     * 前に足すと持ち主が消える。
     */
    const { SweepRunner: R } = await import('../web/core/sweepRunner.js');
    const runner = new R({ objectInfo: OBJECT_INFO, uuid: () => 'abcdef123456' });
    const cell = { workflow: { prompt: { 7: { class_type: 'SaveImage', inputs: { filename_prefix: 'civitai_77742180' } } } } };
    assert.equal(runner.bustOutputCache(cell), true, '名前を変えていない');
    const after = cell.workflow.prompt[7].inputs.filename_prefix;
    assert.ok(after.startsWith('civitai_77742180_'),
        `前置きの後ろへ足していない（帰属が壊れる）: ${after}`);
    assert.notEqual(after, 'civitai_77742180', '同じ名前のままではキャッシュに当たり続ける');
});

test('投げ直しごとに違う名前になる（同じ語を使い回さない）', async () => {
    const { SweepRunner: R } = await import('../web/core/sweepRunner.js');
    let n = 0;
    const runner = new R({ objectInfo: OBJECT_INFO, uuid: () => `id${++n}00000` });
    const make = () => ({ workflow: { prompt: { 7: { class_type: 'SaveImage', inputs: { filename_prefix: 'civitai_1' } } } } });
    const a = make(); const b = make();
    runner.bustOutputCache(a); runner.bustOutputCache(b);
    assert.notEqual(a.workflow.prompt[7].inputs.filename_prefix,
        b.workflow.prompt[7].inputs.filename_prefix,
        '同じ語を使い回すと2度目からまた当たる');
});

test('SaveImage が無いグラフでは何もしない', async () => {
    const { SweepRunner: R } = await import('../web/core/sweepRunner.js');
    const runner = new R({ objectInfo: OBJECT_INFO, uuid: () => 'zzz' });
    assert.equal(runner.bustOutputCache({ workflow: { prompt: { 1: { class_type: 'KSampler', inputs: {} } } } }), false);
    assert.equal(runner.bustOutputCache({}), false);
});

test('投げ直しの投入は、1回目と違う名前で出す', async () => {
    // **ここを見ないと「名前をずらす」が効いているか測れない。**
    // 実装だけ直っていても、投げる側が古いグラフを使っていれば同じ名前で当たり続ける。
    const host = fakeHost(['ghost', 'image']);
    await makeRunner(host).run({ record: RECIPE, template: TEMPLATE, reuseExisting: false });
    assert.equal(host.submits.length, 2, '投げ直していない');
    assert.ok(host.submits[0].prefix, '1回目の名前が取れていない（この検査が空振り）');
    assert.notEqual(host.submits[1].prefix, host.submits[0].prefix,
        `投げ直しが同じ名前なので、またキャッシュに当たる: ${host.submits[1].prefix}`);
    assert.ok(String(host.submits[1].prefix).startsWith(String(host.submits[0].prefix) + '_'),
        '前置きの後ろへ足していない（帰属が壊れる）');
});

test('前回落ちたセルは「済み」として引き継がない（押し直せばまた投げる）', async () => {
    /*
     * `failed` は `DONE_STATES` に入っている——**投入の輪を素通りさせるため**で、
     * 走っている最中の再開としては正しい。だが保存をまたいで引き継ぐと、
     * **次に人が ▶ を押しても、その1件は永久に飛ばされる**。
     *
     * 実測: 消した後の再現が `not-written` で落ちる → 保存に `failed` が残る
     * → **以降どれだけ押しても投入が1件も増えない**（履歴で確認した）。
     */
    // 1回目：落ちる。**実物の signature を採る**——作り物の署名では
    // `storedCells` に当たらず、この検査は何も測らない（変異で気づいた）。
    const host1 = fakeHost(['ghost', 'ghost']);
    const first = await makeRunner(host1).run({ record: RECIPE, template: TEMPLATE, reuseExisting: false });
    const signature = first.cells[0].signature;
    assert.ok(signature, '署名が取れていない（この検査が空振り）');
    assert.equal(first.cells[0].status, 'failed');

    // 2回目：**押し直し**。落ちた分を引き継がずに、また投げること。
    const host2 = fakeHost(['image']);
    const runner2 = makeRunner(host2);
    runner2.storedJob = () => ({
        schema: 'unbake.sweep', version: 1, cells: [{ signature, status: 'failed' }],
    });
    const job = await runner2.run({ record: RECIPE, template: TEMPLATE, reuseExisting: true });
    assert.equal(host2.submits.length, 1,
        `落ちたセルを「済み」として飛ばしている（投入 ${host2.submits.length} 回）`);
    assert.equal(job.cells[0].status, 'completed');
});

// --- 消した絵と見比べてしまう（2026-08-27 実機の報告）------------------------
//
// ComfyUI の `/api/view` は `Cache-Control` を返さない（`ETag` と `Last-Modified`
// だけ）。ブラウザは推測でキャッシュを効かせるので、**同じ URL なら問い合わせずに
// 前の中身を出す**。そして **ComfyUI は消して空いた番号を再利用する**ので、
// `_00006_` を消して再現すると出来上がる絵も `_00006_` になり **URL が完全に同じ**。
// 結果、**消したはずの絵と見比べる**ことになる。
//
// 実測（同じ URL のままディスクの中身を差し替えて確認）:
//     差し替え前  f596cb46:1327543
//     既定で取得  f596cb46:1327543  ← 古いまま
//     強制再取得  e82d662e:1328607  ← 実体はこちら

test('見比べる面の絵は、必ず取り直す形で出す', async () => {
    const { createUnbakePanel } = await import('../web/panel/panel.js');
    const { fakeDocument } = await import('./fake_dom.mjs');
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc,
        makeSweepRunner: () => ({
            inputsReady: Promise.resolve(),
            requireEmptyQueue: async () => {},
            run: async () => ({ cells: [{ id: 'c1', status: 'completed', signature: 's1',
                output: { url: '/api/view?filename=civitai_1_00006_.png&type=output', filename: 'civitai_1_00006_.png', subfolder: '' } }] }),
        }),
    });
    panel.setRecords([{ id: 'a', title: 'A', previewUrl: '/unbake/record-preview?id=a', recipe: { id: 'a', gen_params: { seed: 1 } } }]);
    panel.root.find(n => String(n.className).includes('unbake-act-replay')).dispatch('click', {});
    for (let i = 0; i < 12; i++) await new Promise(r => setTimeout(r, 0));

    const compare = panel.root.byClass('unbake-compare');
    assert.ok(compare, '見比べる面が開いていない（この検査が空振り）');
    const shown = [...compare.walk()]
        .map(n => n.getAttribute?.('src'))
        .filter(src => src && src.includes('_00006_'));
    assert.equal(shown.length, 1, `出した絵が1枚でない: ${JSON.stringify(shown)}`);
    assert.match(shown[0], /[?&]_ub=/,
        `同じ URL のままなので、消した絵がキャッシュから出る: ${shown[0]}`);
    // **元の filename は変えない。** 帰属は名前で引くので、合図は URL だけに付ける。
    assert.ok(shown[0].includes('filename=civitai_1_00006_.png'), 'ファイル名まで変えている');
});

/*
 * **見比べを畳むのは「出す物が無いと判ったとき」**（2026-08-27・2度直した所）。
 *
 * 面は開いたまま残るので、**出た絵が1枚も無い記録でも前の記録の見比べが出たまま**に
 * なる（実測: `civitai_128383826` を押しているのに `civitai_66655100` の絵が出ていた）。
 *
 * 最初は「始めるときに畳む」で直したが、**それは行列で壊れる**——次が動き出した
 * 瞬間に、たった今出た絵が消える。待っていた結果を見る間が無くなる。
 * 出る物が在るときは `openCompare` が差し替えるので、始めるときは触らない。
 */
async function comparePanel(runs, io = {}) {
    const { createUnbakePanel } = await import('../web/panel/panel.js');
    const { fakeDocument } = await import('./fake_dom.mjs');
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc,
        loadFreshOutputs: async () => [],
        loadVariants: async () => ({ outputs: [] }),
        makeSweepRunner: (target) => ({
            inputsReady: Promise.resolve(),
            requireEmptyQueue: async () => {},
            run: async () => runs(String(target?.id ?? target?.recipe?.id)),
        }),
        ...io,
    });
    panel.setRecords([
        { id: 'a', title: 'A', previewUrl: '/p?a', recipe: { id: 'a', gen_params: { seed: 1 } } },
        { id: 'b', title: 'B', previewUrl: '/p?b', recipe: { id: 'b', gen_params: { seed: 2 } } },
    ]);
    return panel;
}

const madeCell = (name) => ({ cells: [{ id: 'c1', status: 'completed', signature: 's-' + name,
    output: { url: `/api/view?filename=${name}`, filename: name, subfolder: '' } }] });

const settle = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

test('出た絵が1枚も無い記録では、前の見比べを残さない', async () => {
    const panel = await comparePanel(id => (id === 'a' ? madeCell('a_00001_.png') : { cells: [] }));
    const buttons = panel.root.findAll(n => String(n.className || '').includes('unbake-act-replay'));
    buttons[0].dispatch('click', {});
    await settle();
    assert.ok(panel.root.byClass('unbake-compare'), 'A の見比べが開いていない（この検査が空振り）');

    buttons[1].dispatch('click', {});
    await settle(20);
    assert.equal(panel.root.byClass('unbake-compare'), null,
        'B は1枚も出していないのに、A の見比べが残っている');
});

test('次の1件が走り出しただけでは、出たばかりの絵を消さない', async () => {
    // **行列で壊れないこと。** 始めるときに畳むと、待っていた結果を見る間が無い。
    let release;
    const gate = new Promise(r => { release = r; });
    const panel = await comparePanel(async (id) => {
        if (id === 'a') return madeCell('a_00001_.png');
        await gate;                      // b は走り続ける
        return madeCell('b_00001_.png');
    });
    const buttons = panel.root.findAll(n => String(n.className || '').includes('unbake-act-replay'));
    buttons[0].dispatch('click', {});
    await settle();
    buttons[1].dispatch('click', {});
    await settle();
    const shown = panel.root.byClass('unbake-compare');
    assert.ok(shown, 'B が走り出した瞬間に A の絵が消えている（待っていた結果が見られない）');
    const srcs = [...shown.walk()].map(n => n.getAttribute?.('src')).filter(Boolean);
    assert.ok(srcs.some(s => s.includes('a_00001_')), `出ているのが A の絵でない: ${srcs}`);

    release();
    await settle(20);
    const after = panel.root.byClass('unbake-compare');
    const afterSrcs = [...after.walk()].map(n => n.getAttribute?.('src')).filter(Boolean);
    assert.ok(afterSrcs.some(s => s.includes('b_00001_')), 'B が出ても差し替わらない');
});

// --- 投入が消えたときに待ち続けない（2026-08-27 実機で確定）------------------
//
// `waitForPrompt` は `/history/<id>` だけを見ていた。**履歴に出ないうちは待ち続ける**
// ので、投入そのものが消えると**2時間の上限まで待つ**——画面では ⟳ が回ったまま
// 止まり、**行列の後ろは全部 ⏸ のまま動かない**。
//
// 実測: ComfyUI が **21:30:07 に再起動**され（PID 42476 → 28136）、キューも履歴も
// 揮発した。待っていた分は宙に浮き、利用者の画面には ⏸ と ⟳ が残ったままになった。

function vanishingHost() {
    const submits = [];
    const request = async (path, options = {}) => {
        if (path === '/prompt') {
            const body = JSON.parse(options.body);
            submits.push(body.prompt_id);
            return { ok: true, json: async () => ({ prompt_id: body.prompt_id }) };
        }
        // **履歴にもキューにも居ない**＝再起動でキューごと消えた形。
        if (path.startsWith('/history/')) return { ok: true, json: async () => ({}) };
        if (path === '/queue') return { ok: true, json: async () => ({ queue_running: [], queue_pending: [] }) };
        return { ok: true, json: async () => ({}) };
    };
    return { request, submits };
}

test('投入がキューにも履歴にも無くなったら、待つのをやめる', async () => {
    const host = vanishingHost();
    const job = await makeRunner(host).run({ record: RECIPE, template: TEMPLATE, reuseExisting: false });
    const cell = job.cells[0];
    assert.equal(cell.status, 'failed', `2時間待ちに入っている: ${JSON.stringify(cell)}`);
    assert.equal(cell.reason, 'vanished');
    assert.match(cell.error, /ComfyUI/, `理由が説明になっていない: ${cell.error}`);
});

test('キューに居る間は待ち続ける（1回の見落としで諦めない）', async () => {
    // **投げた直後は、まだ履歴にもキューにも現れない一瞬が在る。**
    let polls = 0;
    const host = {
        submits: [],
        request: async (path, options = {}) => {
            if (path === '/prompt') {
                const body = JSON.parse(options.body);
                host.submits.push(body.prompt_id);
                return { ok: true, json: async () => ({ prompt_id: body.prompt_id }) };
            }
            if (path.startsWith('/history/')) {
                polls += 1;
                const id = decodeURIComponent(path.slice('/history/'.length));
                // 5回目で結果が出る。
                return { ok: true, json: async () => (polls >= 5 ? { [id]: {
                    status: { completed: true, status_str: 'success' },
                    outputs: { 7: { images: [{ filename: 'late.png', subfolder: '', type: 'output' }] } },
                } } : {}) };
            }
            if (path === '/queue') {
                // 途中まではキューに居る（＝消えていない）。
                return { ok: true, json: async () => (polls < 4
                    ? { queue_running: [[0, host.submits[0]]], queue_pending: [] }
                    : { queue_running: [], queue_pending: [] }) };
            }
            if (path.startsWith('/api/view')) return { ok: true, status: 200, json: async () => ({}) };
            return { ok: true, json: async () => ({}) };
        },
    };
    const job = await makeRunner(host).run({ record: RECIPE, template: TEMPLATE, reuseExisting: false });
    assert.equal(job.cells[0].status, 'completed',
        `キューに居るのに諦めている: ${JSON.stringify(job.cells[0])}`);
});

test('キューを読めないだけのときは「消えた」と数えない', async () => {
    // **「聞けなかった」と「消えた」を混ぜない。** 口が一時的に落ちただけで
    // 諦めると、実際には走っている生成を見捨てることになる。
    let polls = 0;
    const host = {
        submits: [],
        request: async (path, options = {}) => {
            if (path === '/prompt') {
                const body = JSON.parse(options.body);
                host.submits.push(body.prompt_id);
                return { ok: true, json: async () => ({ prompt_id: body.prompt_id }) };
            }
            if (path.startsWith('/history/')) {
                polls += 1;
                const id = decodeURIComponent(path.slice('/history/'.length));
                // 6回目で結果が出る。それまで履歴は空。
                return { ok: true, json: async () => (polls >= 6 ? { [id]: {
                    status: { completed: true, status_str: 'success' },
                    outputs: { 7: { images: [{ filename: 'slow.png', subfolder: '', type: 'output' }] } },
                } } : {}) };
            }
            // **キューはずっと読めない。**
            if (path === '/queue') throw new Error('接続できない');
            if (path.startsWith('/api/view')) return { ok: true, status: 200, json: async () => ({}) };
            return { ok: true, json: async () => ({}) };
        },
    };
    const job = await makeRunner(host).run({ record: RECIPE, template: TEMPLATE, reuseExisting: false });
    assert.equal(job.cells[0].status, 'completed',
        `キューを読めないだけで見捨てている: ${JSON.stringify(job.cells[0])}`);
});
