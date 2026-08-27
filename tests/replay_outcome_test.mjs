/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **再現の結果を、押した人に伝える**（2026-08-26 実機の報告）。
 *
 * 再生（▶）を押しても何も出ない、と言われた。追うと2つ重なっていた:
 *
 *   1. ComfyUI は**同じグラフを2回目に投げても実行しない**（キャッシュ）。
 *      そのとき `outputs` は空で返る。実測（同じ記録の2回の投入）:
 *        1回目 → 画像 1 枚、outputs の鍵 ['7']
 *        2回目 → 画像 0 枚、outputs の鍵 []
 *      それを「再現しました（0 枚）」と報告していた。**絵が無いのではなく、
 *      既に在る。**
 *   2. 断りも結果も**ログにしか出していなかった**ので、押した人からは
 *      無反応に見えた。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLocale, t, LOCALE_META } from '../web/i18n/index.js';

setLocale('ja');

const SOURCE = readFileSync(new URL('../web/panel/panel.js', import.meta.url), 'utf8');

/**
 * 再現1件の本文だけを見る。**切り出せなかったら赤くする**——空を渡すと
 * 検査が何も見ずに緑になる（この検査を書いたとき、実際にそうなった）。
 */
const START = SOURCE.indexOf('const withOutput = (job?.cells || [])');
const BODY = START >= 0 ? SOURCE.slice(START, START + 4200) : '';

test('本文を切り出せている（検出器の生死）', () => {
    assert.ok(BODY.length > 500, `切り出せていない（${BODY.length} 文字）`);
    assert.ok(BODY.includes('replay.done'), '見ている場所が違う');
});

test('0枚を「再現しました」と言わない', () => {
    const guardAt = BODY.indexOf('if (made.length) {');
    const doneAt = BODY.indexOf("t('replay.done'");
    assert.ok(guardAt >= 0, '枚数で分けていない');
    assert.ok(doneAt > guardAt, '枚数を確かめる前に「再現しました」と言っている');
});

test('作り直さなかったときは、前に出た絵を開く', () => {
    // **絵が無いのではなく、既に在る。** 前の分を開くのが正しい。
    assert.ok(BODY.includes('loadVariants'), '既に出ている絵を探していない');
    /*
     * **出し口は `showMade` へ寄せた**（2026-08-28）。見比べを開くかどうかは
     * 設定で切れるようになったので、**開く／代わりに一言出す**の分岐を
     * 1箇所に集めてある。ここで見るのは「前に出た絵を渡していること」。
     */
    assert.ok(BODY.includes('showMade(record, existing'), '前に出た絵を渡していない');
    // **その先で本当に開くこと**も見る（渡すだけで捨てていたら意味が無い）。
    const madeAt = SOURCE.indexOf('function showMade(record, items)');
    assert.ok(madeAt >= 0, 'showMade が見つからない（改名を見逃している）');
    // 閉じ括弧は**本物の改行を書いて**探す（逃がし文字を使わない）。
    const CLOSE = `
    }`;
    const madeBody = SOURCE.slice(madeAt, SOURCE.indexOf(CLOSE, madeAt));
    assert.ok(madeBody.includes('openCompare('), '設定が入なのに見比べを開かない');
    assert.ok(madeBody.includes('showCompare'), '設定を見ずに開くか決めている');
    assert.ok(madeBody.includes("t('replay.alreadyMade.quiet')"),
        '見比べを切ってあるときに黙る（押しても何も起きないに戻る）');
    // **断りは言わない**（2026-08-26 利用者の指示）。絵が開くことが答えで、
    // 「作り直しませんでした」は読む手間だけを足していた。
    assert.ok(!SOURCE.includes('replay.cached'), '消したはずの断りが残っている');
});

test('絵も無いときは、そう言う', () => {
    assert.ok(BODY.includes("t('replay.none')"), '何も無いことを言っていない');
});

test('結果は、押した人に見える所へ出す', () => {
    // **ログにしか出していなかった。** 押しても何も起きないように見える。
    for (const key of ['replay.done', 'replay.none']) {
        assert.ok(BODY.includes(`showToast(t('${key}'`), `${key} が見える所へ出ていない`);
    }
    assert.ok(SOURCE.includes("showToast(t('replay.failed'"), '断りが見える所へ出ていない');
});

test('文言が全部の言語に在る', () => {
    const locales = Object.keys(LOCALE_META || {});
    assert.ok(locales.length >= 10, `言語を数えられていない: ${locales.length}`);
    for (const locale of locales) {
        setLocale(locale);
        for (const key of ['replay.none', 'replay.tooBig.title', 'replay.tooBig.body']) {
            assert.notEqual(t(key, { n: 1 }), key, `${locale}: ${key} が無い`);
        }
    }
    setLocale('ja');
});

// --- 動きで確かめる ---------------------------------------------------------

import { createUnbakePanel } from '../web/panel/panel.js';
import { fakeDocument } from './fake_dom.mjs';

/** 何も出さずに終わる実行器（＝ComfyUI がキャッシュした回）。 */
const emptyRunner = () => ({ run: async () => ({ cells: [{ signature: 's' }] }) });

function mount(io = {}) {
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc,
        makeSweepRunner: emptyRunner,
        // **書庫から取り直せること**が、再生の口を出す条件（`fromLibrary`）。
        loadRecord: async () => ({ gen_params: { seed: 1, prompt: 'a' },
                                   checkpoint: { file_name: 'c.safetensors' }, loras: [] }),
        ...io,
    });
    panel.setRecords([{ id: '1', libraryId: '1', title: 'r1', verdict: 'reproducible' }]);
    return panel;
}

test('0枚のときは、サーバへ引き直してから言う', async () => {
    /*
     * 実機（2026-08-26）。直前の再現で**実際に1枚出ていた**のに
     * 「絵は出ませんでした。ComfyUI の履歴にも、出力フォルダにも
     * 見つかりません。」と出た。手元の索引は**開いたときに1度組んだもの**で、
     * その後に出た絵が入っていなかった——**絵は在ったのに。**
     */
    let freshAsked = 0;
    const panel = mount({
        loadFreshOutputs: async () => { freshAsked += 1; return [{ url: '/api/view?x', filename: 'x.png' }]; },
        // 索引の方は空（開いたときの姿）。
        loadVariants: async () => ({ outputs: [] }),
    });
    const row = panel.root.findAll(n => n.className === 'unbake-act unbake-act-replay')[0];
    await row.dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(freshAsked, 1, 'サーバへ引き直していない');
    assert.ok(panel.root.byClass('unbake-compare'), '引き直した絵を開いていない');
    assert.doesNotMatch(panel.root.text, /出ませんでした/,
        `絵が在るのに「出ませんでした」と言っている: ${panel.root.text.slice(-260)}`);
});

test('サーバにも無ければ、無いと言う', async () => {
    const panel = mount({
        loadFreshOutputs: async () => [],
        loadVariants: async () => ({ outputs: [] }),
    });
    const row = panel.root.findAll(n => n.className === 'unbake-act unbake-act-replay')[0];
    await row.dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.match(panel.root.text, /絵は出ませんでした/);
});

test('作り直さなかったとき、前に出た絵を実際に開く', async () => {
    // **原文に `loadVariants` と書いてあるだけでは足りない**——実際に呼んで
    // 結果を使っているかを見る（源を見るだけの検査は、返り値を空にしても緑だった）。
    let asked = 0;
    const panel = mount({
        loadVariants: async () => { asked += 1; return { outputs: [{ url: '/x.png' }] }; },
    });
    const row = panel.root.findAll(n => n.className === 'unbake-act unbake-act-replay')[0];
    assert.ok(row, '再生の口が無い');
    await row.dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(asked, 1, '既に出ている絵を探していない');
    assert.ok(panel.root.byClass('unbake-compare'), '前に出た絵を開いていない');
});

test('絵も無いときは「出ませんでした」と言う', async () => {
    const panel = mount({ loadVariants: async () => ({ outputs: [] }) });
    const row = panel.root.findAll(n => n.className === 'unbake-act unbake-act-replay')[0];
    await row.dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.match(panel.root.text, /絵は出ませんでした/,
        `何も無いことを言っていない: ${panel.root.text.slice(-260)}`);
    // **「再現しました」とは言わない。**
    assert.doesNotMatch(panel.root.text, /再現しました（0/, '0枚を成功として報せている');
});

test('既に在る絵を開いただけの回を「再現しました」と言わない', async () => {
    /*
     * 実機（2026-08-26 利用者の報告）。紐づいた画像を開くだけで
     * 「再現しました（1 枚）」と出ていた。**作っていないのに作ったと言う**のは、
     * 前に直した「0枚を成功と報せる」と同じ形の嘘。
     *
     * 走者は `status: 'reused'` で見分けを付けている。
     */
    const panel = mount({
        makeSweepRunner: () => ({
            run: async () => ({
                cells: [{
                    signature: 's', status: 'reused',
                    output: { url: '/api/view?x', filename: 'x.png' },
                    workflow: { prompt: {}, warnings: [] },
                }],
            }),
        }),
    });
    const row = panel.root.findAll(n => n.className === 'unbake-act unbake-act-replay')[0];
    await row.dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.doesNotMatch(panel.root.text, /再現しました/,
        `作っていないのに「再現しました」と言っている: ${panel.root.text.slice(-260)}`);
    // **何も言わない**（2026-08-26 利用者の指示）。絵が開くことが答え。
    assert.ok(panel.root.byClass('unbake-compare'), '前に出た絵を開いていない');
    assert.doesNotMatch(panel.root.text, /作り直しませんでした/, '消したはずの断りが出ている');
});

test('本当に作った回は「再現しました」と言う', async () => {
    const panel = mount({
        makeSweepRunner: () => ({
            run: async () => ({
                cells: [{
                    signature: 's', status: 'completed',
                    output: { url: '/api/view?y', filename: 'y.png' },
                    workflow: { prompt: {}, warnings: [] },
                }],
            }),
        }),
    });
    const row = panel.root.findAll(n => n.className === 'unbake-act unbake-act-replay')[0];
    await row.dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.match(panel.root.text, /再現しました/, '作ったのに言っていない');
});

// --- 待てば通る断りは、文で言わない（2026-08-26 利用者の指示）---------------

import { QUEUE_NOT_EMPTY } from '../web/core/sweepRunner.js';

test('行列が詰まっているだけの回は、失敗として言わない', async () => {
    /*
     * 「再現に失敗しました——ComfyUI に既に仕事が入っています」は、
     * **押した人が何も間違えていない**のに失敗として読める。ボタンは待ちの姿
     * （⏸）に変わって空けば自分で並び直すので、**姿だけで足りる。**
     */
    const panel = mount({
        makeSweepRunner: () => ({
            run: async () => {
                const error = new Error('ComfyUI に既に仕事が入っています');
                error.code = QUEUE_NOT_EMPTY;
                throw error;
            },
        }),
    });
    const row = panel.root.findAll(n => n.className === 'unbake-act unbake-act-replay')[0];
    await row.dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.doesNotMatch(panel.root.text, /失敗しました/,
        `待てば通る断りを失敗として出している: ${panel.root.text.slice(-260)}`);
});

test('本当の失敗は、今までどおり言う', async () => {
    // **全部を黙らせない。** 打つ手が要る失敗は見えないと困る。
    const panel = mount({
        makeSweepRunner: () => ({ run: async () => { throw new Error('壊れている'); } }),
    });
    const row = panel.root.findAll(n => n.className === 'unbake-act unbake-act-replay')[0];
    await row.dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.match(panel.root.text, /失敗しました/, '本当の失敗まで黙っている');
});

// --- VRAM に入らない大きさ（2026-08-26 実機）--------------------------------

/** 実物の形（`civitai_139164303` を組んだ結果）。 */
const KREA_PLAN = {
    cells: [{
        signature: 's',
        workflow: {
            warnings: [],
            prompt: {
                1: { class_type: 'UNETLoader', inputs: { unet_name: 'krea2Turbo_v10.safetensors' } },
                5: { class_type: 'KSampler', inputs: { model: ['1', 0], seed: 1 } },
            },
        },
    }],
};

function planningRunner(extra = {}) {
    return () => ({
        preflight: () => KREA_PLAN,
        run: async () => ({ cells: [] }),
        ...extra,
    });
}

test('VRAM に入らないモデルは、投げる前に聞く', async () => {
    /*
     * 実機の報告「動作が極端に遅くなり生成が始まりませんでした」。
     * グラフは正しかった——13.1 GB を 12.9 GB の GPU で回していた。
     *
     * **2026-08-26 実機で最後まで回したら、ComfyUI がプロセスごと落ちた**
     * （テキストエンコーダ 8.46 GB を読み終えた次の行でログが途切れ、
     * 応答も無くなった）。「遅くなる」ではなく「消える」なので、聞く。
     */
    let askedFolders = null;
    const panel = mount({
        makeSweepRunner: planningRunner(),
        loadVariants: async () => ({ outputs: [] }),
        loadFreshOutputs: async () => [],
        measureVramFit: async (folders) => {
            askedFolders = folders;
            return {
                vramTotal: 12884377600,
                sizes: { diffusion_models: { 'krea2Turbo_v10.safetensors': 13100000000 } },
            };
        },
    });
    const row = panel.root.findAll(n => n.className === 'unbake-act unbake-act-replay')[0];
    await row.dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(askedFolders, ['diffusion_models'], '測る置き場が違う');
    assert.match(panel.root.text, /13\.1 GB/, `実際の大きさを言っていない: ${panel.root.text.slice(-300)}`);
    assert.match(panel.root.text, /12\.9 GB/, 'VRAM の量を言っていない');
    assert.match(panel.root.text, /この GPU に載りません/, '聞いていない（言うだけになっている）');
});

test('やめると言えば、投げない', async () => {
    // **落ちると並んでいた他の生成もまとめて消える。** 押した本人に決めさせる。
    let submitted = 0;
    const panel = mount({
        makeSweepRunner: () => ({
            preflight: () => KREA_PLAN,
            run: async () => { submitted += 1; return { cells: [] }; },
        }),
        loadVariants: async () => ({ outputs: [] }),
        loadFreshOutputs: async () => [],
        measureVramFit: async () => ({
            vramTotal: 12884377600,
            sizes: { diffusion_models: { 'krea2Turbo_v10.safetensors': 13100000000 } },
        }),
    });
    const row = panel.root.findAll(n => n.className === 'unbake-act unbake-act-replay')[0];
    await row.dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 30));
    const back = panel.root.findAll(n => n.className === 'unbake-confirm-cancel');
    assert.ok(back.length, `やめる口が無い: ${panel.root.text.slice(-300)}`);
    await back[back.length - 1].dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(submitted, 0, 'やめると言ったのに投げている');
});

test('収まるなら黙る', async () => {
    const panel = mount({
        makeSweepRunner: planningRunner(),
        loadVariants: async () => ({ outputs: [] }),
        loadFreshOutputs: async () => [],
        measureVramFit: async () => ({
            vramTotal: 12884377600,
            sizes: { diffusion_models: { 'krea2Turbo_v10.safetensors': 4000000000 } },
        }),
    });
    const row = panel.root.findAll(n => n.className === 'unbake-act unbake-act-replay')[0];
    await row.dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.doesNotMatch(panel.root.text, /GB/, '収まるのに聞いている');
});

test('測れなければ黙る（止めもしない）', async () => {
    // **古い ComfyUI には `/experiment/models` が無い。**
    // 測れないことを「入らない」と読むと、全件に警告が出る。
    const panel = mount({
        makeSweepRunner: planningRunner(),
        loadVariants: async () => ({ outputs: [] }),
        loadFreshOutputs: async () => [],
        measureVramFit: async () => null,
    });
    const row = panel.root.findAll(n => n.className === 'unbake-act unbake-act-replay')[0];
    await row.dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.doesNotMatch(panel.root.text, /GB/, '測れていないのに警告している');
    assert.match(panel.root.text, /絵は出ませんでした/, '警告のせいで再現が止まっている');
});
