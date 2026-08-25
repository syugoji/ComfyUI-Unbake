/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 記録の詳細（2026-08-22 利用者の指示）。
 *
 * ここで固定するのは、**指示そのもの**にあたる4つ:
 *
 *  1. ホイールで **元画像 → 最新の生成画像 → 古い生成画像** の順に送る
 *  2. 絵を押すと**拡大へ進む**（閉じるのではない）
 *  3. 周りを押すと閉じる／中を押しても閉じない
 *  4. 「一つだけ変えて結果を見比べます」が**この面の中**に在り、変えた印が付いて戻せる
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compareSequence, createDetailView, paramsOf } from '../web/panel/detailView.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale } from '../web/i18n/index.js';

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

const RECORD = {
    id: 'a', libraryId: 'a', title: 'Civitai_Recipe_1', verdict: 'approximate',
    previewUrl: '/unbake/record-preview?id=a',
    checkpoint: 'ck.safetensors',
    loras: [{ file_name: 'lora_one' }],
};
// **口は新しい順で返す。** ここで並べ替えない（並べ替えると口の意味が消える）。
const OUTPUTS = [
    { url: '/api/view?filename=new.png', differenceLabel: 'seed 2' },
    { url: '/api/view?filename=old.png', differenceLabel: 'seed 1' },
];

function open(options = {}) {
    setLocale('en');
    const documentRef = fakeDocument();
    const view = createDetailView({
        documentRef, record: RECORD, outputs: OUTPUTS,
        recipe: { gen_params: { prompt: 'a cat', negative_prompt: 'blurry', seed: 7, steps: 20, cfg_scale: 5 } },
        ...options,
    });
    return view;
}

test('見比べる並びは 元画像 → 最新 → 古い の順', () => {
    setLocale('en');
    const sequence = compareSequence(RECORD, OUTPUTS);
    assert.equal(sequence.length, 3);
    assert.equal(sequence[0].kind, 'source', '元画像が先頭でない');
    assert.equal(sequence[0].url, '/unbake/record-preview?id=a');
    assert.equal(sequence[1].url, '/api/view?filename=new.png', '最新が2番目でない');
    assert.equal(sequence[2].url, '/api/view?filename=old.png', '古い方が3番目でない');
    // 元画像が無い記録では、生成画像だけが並ぶ（空の枠を作らない）。
    assert.deepEqual(compareSequence({ previewUrl: null }, []).length, 0);
});

test('ホイールを回すと、その順に切り替わる', () => {
    const view = open();
    const stage = view.root.byClass('unbake-detail-image');
    assert.equal(stage.getAttribute('src'), '/unbake/record-preview?id=a', '元画像から始まっていない');
    stage.dispatch('wheel', { deltaY: 1 });
    assert.equal(stage.getAttribute('src'), '/api/view?filename=new.png');
    stage.dispatch('wheel', { deltaY: 1 });
    assert.equal(stage.getAttribute('src'), '/api/view?filename=old.png');
    // **一周する。** 端で止まると「壊れた」と読まれる。
    stage.dispatch('wheel', { deltaY: 1 });
    assert.equal(stage.getAttribute('src'), '/unbake/record-preview?id=a');
    // 逆に回すと戻る。
    stage.dispatch('wheel', { deltaY: -1 });
    assert.equal(stage.getAttribute('src'), '/api/view?filename=old.png');
});

test('今どこを見ているかを、字だけでなく形でも出す', () => {
    const view = open();
    const dots = view.root.allByClass('unbake-detail-dot');
    assert.equal(dots.length, 3, '並びの数だけ印が出ていない');
    assert.equal(dots[0].getAttribute('data-on'), 'true');
    // **元画像と生成画像を形で分ける**（色だけに頼らない）。
    assert.equal(dots[0].getAttribute('data-kind'), 'source');
    assert.equal(dots[1].getAttribute('data-kind'), 'output');
    view.root.byClass('unbake-detail-image').dispatch('wheel', { deltaY: 1 });
    assert.equal(view.root.allByClass('unbake-detail-dot')[1].getAttribute('data-on'), 'true');
});

test('絵を押すと拡大へ進む（今見ている1枚を渡す）', () => {
    const seen = [];
    const view = open({ onEnlarge: (url, list, index) => seen.push({ url, count: list.length, index }) });
    const stage = view.root.byClass('unbake-detail-image');
    stage.dispatch('wheel', { deltaY: 1 });
    stage.dispatch('click', {});
    assert.deepEqual(seen, [{ url: '/api/view?filename=new.png', count: 3, index: 1 }]);
});

test('周りを押すと閉じる／中を押しても閉じない', () => {
    let closed = 0;
    const view = open({ onClose: () => { closed += 1; } });
    view.root.dispatch('click', { target: view.box });
    assert.equal(closed, 0, '中を押したら閉じている');
    view.root.dispatch('click', { target: view.root });
    assert.equal(closed, 1, '周りを押しても閉じない');
});

test('書き換えると印が付き、元へ戻せる', () => {
    const view = open();
    const fields = view.root.allByClass('unbake-detail-field');
    const prompt = fields[0];
    const input = prompt.byClass('unbake-detail-input');
    assert.equal(input.value, 'a cat', '元の値が入っていない');
    assert.equal(prompt.getAttribute('data-changed'), 'false');

    input.value = 'a dog';
    input.dispatch('input', {});
    // **変えた項目に印を付ける。** 何を変えたのか判らなくなるのが一番困る。
    assert.equal(prompt.getAttribute('data-changed'), 'true', '変えた印が付かない');
    assert.deepEqual(view.changes, { prompt: 'a dog' });

    prompt.byClass('unbake-detail-revert').dispatch('click', {});
    assert.equal(input.value, 'a cat', '戻せていない');
    assert.equal(prompt.getAttribute('data-changed'), 'false');
    assert.deepEqual(view.changes, {}, '戻したのに変更として残っている');
});

test('「一つだけ変えて」がこの面の中で完結する', async () => {
    const runs = [];
    const view = open({ onRun: async (changes) => { runs.push(changes); return { ok: true }; } });
    const input = view.root.allByClass('unbake-detail-field')[2].byClass('unbake-detail-input');
    input.value = '99';
    input.dispatch('input', {});
    await view.root.byClass('unbake-detail-run').dispatch('click', {});
    await settle();
    assert.deepEqual(runs, [{ seed: '99' }], '書き換えた分だけを渡していない');
});

// --- 「振る」から移した2つ（2026-08-22 利用者の指示）-------------------------
//
//  1. seed の複数振り → seed の隣の**枚数**（元の seed が必ず1枚目）
//  2. プロンプトの置換 → `{...}` を見つけたら、その場で候補を書く欄
//
// どちらも**元の値と変えた値が同時に読める**ことを一緒に守る。

/** 欄を鍵で引く（並び順に依存しない——欄が増えるたびに番号がずれる）。 */
function fieldOf(view, label) {
    return view.root.allByClass('unbake-detail-field')
        .find(group => group.byClass('unbake-detail-label').textContent === label);
}

test('変えた欄には、元の値が並んで出る', () => {
    const view = open();
    const seed = fieldOf(view, 'Seed');
    assert.equal(seed.byClass('unbake-detail-was').textContent, '', '変えていないのに元の値を出している');
    const input = seed.byClass('unbake-detail-input');
    input.value = '99';
    input.dispatch('input', {});
    // **元が消えると「何から何へ」が読めなくなる。**
    assert.match(seed.byClass('unbake-detail-was').textContent, /7/, '元の値が出ていない');
    seed.byClass('unbake-detail-revert').dispatch('click', {});
    assert.equal(seed.byClass('unbake-detail-was').textContent, '', '戻したのに元の値が残っている');
});

test('seed の隣の枚数で、連番の複数枚になる', async () => {
    const runs = [];
    const view = open({ onRun: async (changes, plan) => { runs.push(plan); return { ok: true, count: 3 }; } });
    const count = view.root.byClass('unbake-detail-count');
    count.value = '3';
    count.dispatch('input', {});
    // **押す前に枚数が字で出る。** 押してから4枚だと判るのでは遅い。
    assert.match(view.root.byClass('unbake-detail-run').textContent, /3/, '枚数がボタンに出ていない');

    await view.root.byClass('unbake-detail-run').dispatch('click', {});
    await settle();
    assert.equal(runs[0].template.mode, 'seeds_only');
    // **元の seed が必ず1枚目**＝比べる基準がいつも手元に残る。
    assert.deepEqual(runs[0].template.seeds, [7, 8, 9], '連番になっていない');
    assert.match(view.root.byClass('unbake-detail-status').textContent, /3/, '出た枚数を言っていない');
});

test('プロンプトに `{...}` を書くと、その場で候補の欄が出る', () => {
    const view = open();
    assert.equal(view.root.allByClass('unbake-detail-choices').length, 0, '口が無いのに欄を出している');
    const prompt = fieldOf(view, 'Prompt').byClass('unbake-detail-input');
    prompt.value = 'a {style} cat';
    prompt.dispatch('input', {});
    const areas = view.root.allByClass('unbake-detail-choices');
    assert.equal(areas.length, 1, '口の数だけ欄が出ていない');
    assert.equal(areas[0].getAttribute('aria-label'), '{style}', 'どの口の欄か判らない');
});

test('候補を2つ書くと、その数だけ絵が出る計画になる', async () => {
    const runs = [];
    const view = open({ onRun: async (changes, plan) => { runs.push(plan); return { ok: true, count: 2 }; } });
    const prompt = fieldOf(view, 'Prompt').byClass('unbake-detail-input');
    prompt.value = 'a {style} cat';
    prompt.dispatch('input', {});
    const area = view.root.byClass('unbake-detail-choices');
    area.value = 'watercolor\noil';
    area.dispatch('input', {});
    assert.match(view.root.byClass('unbake-detail-run').textContent, /2/, '枚数がボタンに出ていない');

    await view.root.byClass('unbake-detail-run').dispatch('click', {});
    await settle();
    assert.equal(runs[0].template.mode, 'single_axis_seeds');
    assert.equal(runs[0].template.axes[0].token, '{style}');
    assert.deepEqual(runs[0].template.axes[0].values.map(v => v.value), ['watercolor', 'oil']);
});

test('候補が1つだけでも黙って捨てない（置換として渡す）', async () => {
    const runs = [];
    const view = open({ onRun: async (changes, plan) => { runs.push(plan); return { ok: true }; } });
    const prompt = fieldOf(view, 'Prompt').byClass('unbake-detail-input');
    prompt.value = 'a {style} cat';
    prompt.dispatch('input', {});
    const area = view.root.byClass('unbake-detail-choices');
    area.value = 'watercolor';
    area.dispatch('input', {});
    await view.root.byClass('unbake-detail-run').dispatch('click', {});
    await settle();
    // 軸は2つ以上要るので軸にはできない。**入れたのに効かない欄を作らない。**
    assert.deepEqual(runs[0].substitutions, [{ token: '{style}', value: 'watercolor' }]);
});

test('書いた候補は、口が消えても覚えている', () => {
    const view = open();
    const prompt = fieldOf(view, 'Prompt').byClass('unbake-detail-input');
    prompt.value = 'a {style} cat';
    prompt.dispatch('input', {});
    const area = view.root.byClass('unbake-detail-choices');
    area.value = 'watercolor\noil';
    area.dispatch('input', {});
    // 打ち間違いで口を消して、書き直した。**候補を打ち直させない。**
    prompt.value = 'a cat';
    prompt.dispatch('input', {});
    assert.equal(view.root.allByClass('unbake-detail-choices').length, 0);
    prompt.value = 'a {style} cat';
    prompt.dispatch('input', {});
    assert.equal(view.root.byClass('unbake-detail-choices').value, 'watercolor\noil', '候補を捨てている');
});

test('出せない枚数になったら、押す前に理由を出して押させない', () => {
    const view = open({ onRun: async () => ({ ok: true }) });
    const prompt = fieldOf(view, 'Prompt').byClass('unbake-detail-input');
    prompt.value = 'a {style} cat';
    prompt.dispatch('input', {});
    const area = view.root.byClass('unbake-detail-choices');
    area.value = Array.from({ length: 9 }, (_, i) => `v${i}`).join('\n');
    area.dispatch('input', {});
    const count = view.root.byClass('unbake-detail-count');
    count.value = '8';
    count.dispatch('input', {});
    // **待たされた末に落ちるより、押す前に数で止める。**
    assert.equal(view.root.byClass('unbake-detail-run').disabled, true, '出せないのに押せる');
    assert.match(view.root.byClass('unbake-detail-status').textContent, /72|24/, '理由が読めない');
});

test('落ちた理由を黙らせない', async () => {
    const view = open({ onRun: async () => ({ ok: false, error: 'queue is busy' }) });
    await view.root.byClass('unbake-detail-run').dispatch('click', {});
    await settle();
    assert.match(view.root.byClass('unbake-detail-status').textContent, /queue is busy/);
});

test('生成パラメータは、記録と本体のどちらからでも同じ形で取れる', () => {
    setLocale('en');
    const fromRecipe = paramsOf({}, { gen_params: { prompt: 'x', seed: 3 } });
    assert.equal(fromRecipe.prompt, 'x');
    assert.equal(fromRecipe.seed, 3);
    const fromRecord = paramsOf({ positive: 'y', seed: 4 }, null);
    assert.equal(fromRecord.prompt, 'y');
    assert.equal(fromRecord.seed, 4);
    // 無い値は null のまま（0 へ丸めない——0 は指定した値）。
    assert.equal(paramsOf({}, null).steps, null);
});

test('実行の口が無ければ押せるボタンを出さない', () => {
    const view = open({ onRun: null });
    assert.equal(view.root.byClass('unbake-detail-run').disabled, true,
        '押しても何も起きないボタンを押せる状態で出している');
});

test('製品が渡す形（`url` ではなく filename/subfolder）でも並ぶ', () => {
    // **これを見逃した。** 検査は `url` を持つ作り物を渡していたが、
    // 実際に `loadVariants()` が返す出力は `filename` と `subfolder` しか持たない。
    // そのため実データで **47枚あるのに1枚も並ばなかった**
    // （既出の面は URL を組み立てていたので、あちらだけ出ていた）。
    //
    // **同じ間違いを前にもしている**——判定の帰属で、検査にフルのレシピを渡して
    // いたが製品は要約を渡していた。**製品と同じ形で測る。**
    setLocale('en');
    const real = [
        { filename: 'civitai_1_00002_.png', subfolder: '', differenceLabel: 'seed 2' },
        { filename: 'civitai_1_00001_.png', subfolder: 'sub', differenceLabel: 'seed 1' },
    ];
    const sequence = compareSequence(RECORD, real);
    assert.equal(sequence.length, 3, '元画像＋出力2枚にならない');
    assert.match(sequence[1].url, /filename=civitai_1_00002_\.png/, '最新の URL を組み立てていない');
    assert.match(sequence[2].url, /subfolder=sub/, 'サブフォルダを落としている');
    // 名前が無い出力は並べない（空の枠を作らない）。
    assert.equal(compareSequence({ previewUrl: null }, [{ subfolder: '' }]).length, 0);
});

// --- − / ＋ と枚数（2026-08-22「20, 30, 40 と書くのは面倒」）------------------

test('− / ＋ で数の欄をその場で動かせる', () => {
    const view = open();
    const steps = fieldOf(view, 'Steps');
    const input = steps.byClass('unbake-detail-input');
    const [down, up] = steps.allByClass('unbake-detail-nudge');
    assert.equal(input.value, '20');
    up.dispatch('click', {});
    assert.equal(input.value, '25', 'ステップの刻みで増えていない');
    down.dispatch('click', {});
    down.dispatch('click', {});
    assert.equal(input.value, '15');
    // **押した分は「変えた」として扱う**（元の値も並んで出る）。
    assert.match(steps.byClass('unbake-detail-was').textContent, /20/);
    assert.deepEqual(view.changes, { steps: '15' });
});

test('負にはしない（0 ステップの絵を作らない）', () => {
    const view = open();
    const cfg = fieldOf(view, 'CFG');
    const input = cfg.byClass('unbake-detail-input');
    const [down] = cfg.allByClass('unbake-detail-nudge');
    input.value = '0';
    input.dispatch('input', {});
    down.dispatch('click', {});
    assert.equal(input.value, '0', '負の値にしている');
});

test('小数の刻みで端数を持ち込まない', () => {
    const view = open();
    const cfg = fieldOf(view, 'CFG');
    const input = cfg.byClass('unbake-detail-input');
    const up = cfg.allByClass('unbake-detail-nudge')[1];
    input.value = '4.3';
    input.dispatch('input', {});
    up.dispatch('click', {});
    // **`4.800000000000001` を作らない。**
    assert.equal(input.value, '4.8');
});

test('数の欄の枚数を指すと、書かなくても複数枚になる', async () => {
    const runs = [];
    const view = open({ onRun: async (changes, plan) => { runs.push(plan); return { ok: true, count: 3 }; } });
    const steps = fieldOf(view, 'Steps');
    const count = steps.byClass('unbake-detail-count');
    count.value = '3';
    count.dispatch('input', {});
    assert.match(view.root.byClass('unbake-detail-run').textContent, /3/, '枚数がボタンに出ていない');
    await view.root.byClass('unbake-detail-run').dispatch('click', {});
    await settle();
    assert.deepEqual(runs[0].template.axes[0].values.map(v => v.value), [20, 25, 30]);
});

// --- 出した絵をレコードにする（2026-08-22 利用者の指示）---------------------

test('出すまでは保存の口を出さない', () => {
    const view = open({ onRun: async () => ({ ok: true }), onCapture: async () => ({ ok: true, count: 1 }) });
    // **押せるのに何も起きない口を作らない。**
    assert.equal(view.root.byClass('unbake-detail-save').style.display, 'none');
});

test('出した絵を、その場でレコードにできる', async () => {
    const captured = [];
    const outputs = [{ filename: 'a.png' }, { filename: 'b.png' }];
    const view = open({
        onRun: async () => ({ ok: true, count: 2, outputs }),
        onCapture: async (list) => { captured.push(list); return { ok: true, count: list.length }; },
    });
    await view.root.byClass('unbake-detail-run').dispatch('click', {});
    await settle();
    const save = view.root.byClass('unbake-detail-save');
    assert.equal(save.style.display, '', '出したのに保存の口が出ていない');

    await save.dispatch('click', {});
    await settle();
    // **出した絵を全部渡す。** 1枚目だけだと、残りを保存する道が無くなる。
    assert.deepEqual(captured, [outputs]);
    assert.match(view.root.byClass('unbake-detail-status').textContent, /2/);
    // **同じ絵を2度取り込ませない**（押し直すと重複した記録ができる）。
    assert.equal(save.style.display, 'none', '保存後も押せるままになっている');
});

test('落ちたら理由を出し、押し直せる', async () => {
    const view = open({
        onRun: async () => ({ ok: true, count: 1, outputs: [{ filename: 'a.png' }] }),
        onCapture: async () => ({ ok: false, errors: ['disk is full'] }),
    });
    await view.root.byClass('unbake-detail-run').dispatch('click', {});
    await settle();
    await view.root.byClass('unbake-detail-save').dispatch('click', {});
    await settle();
    assert.match(view.root.byClass('unbake-detail-status').textContent, /disk is full/);
    assert.equal(view.root.byClass('unbake-detail-save').style.display, '', '落ちたのに押し直せない');
});

test('出せなかった回に保存の口を出さない', async () => {
    const view = open({
        onRun: async () => ({ ok: false, error: 'queue is busy' }),
        onCapture: async () => ({ ok: true, count: 1 }),
    });
    await view.root.byClass('unbake-detail-run').dispatch('click', {});
    await settle();
    assert.equal(view.root.byClass('unbake-detail-save').style.display, 'none');
});

// --- 出た絵の升目・進捗・取消（2026-08-22 に「振る」から移した）--------------

const job = (cells) => ({ cells });

test('1枚ずつ届くたびに升目を描き直し、進捗を字で出す', async () => {
    let push = null;
    const view = open({
        onRun: async (changes, plan, onProgress) => {
            push = onProgress;
            onProgress(job([
                { id: 'a', baseline: true, labels: [], seed: 7, status: 'done', output: { url: '/a.png' } },
                { id: 'b', labels: [{ label: 'Steps', valueLabel: '30' }], seed: 7, status: 'running' },
            ]));
            return { ok: true, count: 1, outputs: [{ url: '/a.png' }] };
        },
    });
    await view.root.byClass('unbake-detail-run').dispatch('click', {});
    await settle();
    const boxes = view.root.allByClass('unbake-detail-cell');
    assert.equal(boxes.length, 2, '升目が出ていない');
    // **基準の1枚が判る**（何と比べているのかを見失わない）。
    assert.equal(boxes[0].getAttribute('data-baseline'), 'true');
    assert.match(boxes[1].byClass('unbake-detail-cell-label').textContent, /Steps: 30/);
    assert.ok(push, '進捗の口を渡していない');
});

test('落ちた升目に理由を残す', async () => {
    const view = open({
        onRun: async (changes, plan, onProgress) => {
            onProgress(job([{ id: 'a', labels: [], status: 'failed', error: 'queue is busy' }]));
            return { ok: false, error: 'queue is busy' };
        },
    });
    await view.root.byClass('unbake-detail-run').dispatch('click', {});
    await settle();
    // **件数だけでは次の一手が決まらない。**
    assert.match(view.root.byClass('unbake-detail-cell-error').textContent, /queue is busy/);
});

test('回っている間だけ止める口を出す', async () => {
    const stopped = [];
    let release = null;
    const view = open({
        onStop: () => stopped.push(true),
        onRun: () => new Promise(resolve => { release = () => resolve({ ok: true, count: 0, outputs: [] }); }),
    });
    assert.equal(view.root.byClass('unbake-detail-stop').style.display, 'none', '回る前から出ている');
    view.root.byClass('unbake-detail-run').dispatch('click', {});
    await settle();
    const stop = view.root.byClass('unbake-detail-stop');
    assert.equal(stop.style.display, '', '回っているのに止める口が無い');
    stop.dispatch('click', {});
    assert.deepEqual(stopped, [true]);
    release();
    await settle();
    assert.equal(view.root.byClass('unbake-detail-stop').style.display, 'none', '終わっても残っている');
});

test('升目1枚ずつでも保存できる', async () => {
    const captured = [];
    const view = open({
        onCapture: async (list) => { captured.push(list); return { ok: true, count: list.length }; },
        onRun: async (changes, plan, onProgress) => {
            onProgress(job([
                { id: 'a', labels: [], status: 'done', output: { url: '/a.png', filename: 'a.png' } },
                { id: 'b', labels: [], status: 'done', output: { url: '/b.png', filename: 'b.png' } },
            ]));
            return { ok: true, count: 2, outputs: [{ filename: 'a.png' }, { filename: 'b.png' }] };
        },
    });
    await view.root.byClass('unbake-detail-run').dispatch('click', {});
    await settle();
    // **振った中で良かった1枚だけを書庫へ入れたい**、が普通。
    const saves = view.root.allByClass('unbake-detail-cell-save');
    assert.equal(saves.length, 2, '升目ごとの保存が無い');
    await saves[1].dispatch('click', {});
    await settle();
    assert.deepEqual(captured, [[{ url: '/b.png', filename: 'b.png' }]], '押した升目だけを渡していない');
});

test('前の回の升目を残さない', async () => {
    let cells = [{ id: 'a', labels: [], status: 'done', output: { url: '/a.png' } }];
    const view = open({
        onRun: async (changes, plan, onProgress) => {
            if (cells.length) onProgress(job(cells));
            return { ok: true, count: cells.length, outputs: [] };
        },
    });
    await view.root.byClass('unbake-detail-run').dispatch('click', {});
    await settle();
    assert.equal(view.root.allByClass('unbake-detail-cell').length, 1);
    // **どれが今出したものか判らなくなる。** 進捗が1度も来ない回
    //（材料が揃わず即座に落ちた等）でも、前の回は消えていること。
    cells = [];
    await view.root.byClass('unbake-detail-run').dispatch('click', {});
    await settle();
    assert.equal(view.root.allByClass('unbake-detail-cell').length, 0, '前の回が残っている');
});

test('材料が無ければ、押せない理由を字で出す', () => {
    setLocale('en');
    const view = open({ onRun: null });
    assert.equal(view.root.byClass('unbake-detail-run').disabled, true);
    // **押せないボタンだけでは、壊れているのか出せないのか読めない。**
    assert.ok(view.root.byClass('unbake-detail-status').textContent.length > 0, '理由が出ていない');
});

test('出した絵を押すと、元画像と並びで開く（ホイールで往復できる）', async () => {
    // **元は押した1枚だけを渡していた。** 元画像を見るには拡大を閉じて
    // 上へ戻り、送り直す必要があった（2026-08-22 利用者の指摘）。
    const opened = [];
    const view = open({
        onEnlarge: (url, list, index) => opened.push({ url, list, index }),
        onRun: async (changes, plan, onProgress) => {
            onProgress({ cells: [
                { id: 'a', labels: [], status: 'done', output: { url: '/made-a.png' } },
                { id: 'b', labels: [{ label: 'Steps', valueLabel: '30' }], status: 'done', output: { url: '/made-b.png' } },
            ] });
            return { ok: true, count: 2, outputs: [] };
        },
    });
    await view.root.byClass('unbake-detail-run').dispatch('click', {});
    await settle();
    const images = view.root.allByClass('unbake-detail-cell-image');
    images[1].dispatch('click', {});

    const call = opened.at(-1);
    // **先頭は必ず元画像。** ホイールを1つ戻せばそのまま見比べられる。
    assert.equal(call.list[0].url, RECORD.previewUrl, '元画像が先頭に来ていない');
    assert.deepEqual(call.list.map(item => item.url),
        [RECORD.previewUrl, '/made-a.png', '/made-b.png']);
    // 押した1枚から始まる（開いた瞬間に別の絵が出ない）。
    assert.equal(call.index, 2);
    assert.equal(call.url, '/made-b.png');
});

test('元画像を持たない記録では、出した絵だけを並べる', async () => {
    const opened = [];
    const view = createDetailView({
        documentRef: fakeDocument(),
        record: { id: 'n', title: 'no source', previewUrl: null },
        outputs: [],
        recipe: { gen_params: { prompt: 'a', seed: 1 } },
        onEnlarge: (url, list, index) => opened.push({ url, list, index }),
        onRun: async (changes, plan, onProgress) => {
            onProgress({ cells: [{ id: 'a', labels: [], status: 'done', output: { url: '/made.png' } }] });
            return { ok: true, count: 1, outputs: [] };
        },
    });
    await view.root.byClass('unbake-detail-run').dispatch('click', {});
    await settle();
    view.root.byClass('unbake-detail-cell-image').dispatch('click', {});
    // **空の枠を作らない。**
    assert.deepEqual(opened.at(-1).list.map(i => i.url), ['/made.png']);
    assert.equal(opened.at(-1).index, 0);
});

// --- 組めないことは押す前に言う（2026-08-23 利用者の報告）-------------------
//
// 「プロンプトだけ変えて出す」を押すと、待たされた末に
// 「再現に必要なチェックポイント情報がありません」と出ていた。
// **理由は開いた時点で判っている**（記録にモデルの情報が無い）。
//
// **代理の印で塞がない。** 実データ350件で測ると、判定の `norecord` は
// 組めない8件を全部含むが**組める20件も巻き込む**——それで押せなくすると、
// 出せる記録が出せなくなる。組めるかは組んでみれば判る。

test('組めない記録では、押す前に理由が出る', () => {
    const view = open({
        onRun: async () => ({ ok: true }),
        runBlockedReason: 'no checkpoint information',
    });
    const run = view.root.byClass('unbake-detail-run');
    assert.ok(run, '出すボタンが無い');
    assert.equal(run.disabled, true, '組めないのに押せる');
    assert.match(view.root.text, /no checkpoint information/, '理由が出ていない');
});

test('組める記録は、今までどおり押せる', () => {
    const view = open({ onRun: async () => ({ ok: true }) });
    assert.equal(view.root.byClass('unbake-detail-run').disabled, false,
        '組めるのに押せない');
});

test('理由が空文字なら塞がない（「判らない」と「組めない」を混ぜない）', () => {
    // 口が落ちただけで出せなくすると、原因の判らない行き止まりになる。
    const view = open({ onRun: async () => ({ ok: true }), runBlockedReason: '' });
    assert.equal(view.root.byClass('unbake-detail-run').disabled, false,
        '理由が無いのに押せなくしている');
});
