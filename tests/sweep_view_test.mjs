/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * Sweep の**面**の検査。
 *
 * `panel_mount_test.mjs` と同じ最小 DOM を使う。ここで固定するのは、
 * **画面の順序がそのまま主張になっている**という設計そのもの:
 *
 *  - かけられない記録には**押せないボタンでなく理由**が出る
 *  - **検査を通らなければ1件も投げない**（間違った比較を先に見せない）
 *  - 検査に落ちたら、動いてしまった入力の名前がそのまま出る
 *  - 面は**同じ器の中で**一覧と差し替わる（別の窓を開かない）
 *  - 自動採点をしないことが画面に書いてある
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

import { installEnvironment } from '../web/core/environment.js';
import { resetMemoryStorage } from '../web/core/storage.js';
import { setLocale } from '../web/i18n/index.js';
import { createSweepView } from '../web/panel/sweepView.js';
import { createUnbakePanel } from '../web/panel/panel.js';
import { SweepRunner } from '../web/core/sweepRunner.js';

import { FakeNode, fakeDocument } from './fake_dom.mjs';

// --- 材料 ----------------------------------------------------------------

function install() {
    resetMemoryStorage();
    const map = new Map();
    installEnvironment({
        request: async (_input) => ({ ok: true, status: 200, json: async () => ({}) }),
        storage: {
            getItem: k => (map.has(k) ? map.get(k) : null),
            setItem: (k, v) => { map.set(k, String(v)); },
            removeItem: k => { map.delete(k); },
        },
    });
}

const RECIPE = {
    id: 'rec-1',
    title: 'A record',
    gen_params: { seed: 42, cfg_scale: 7, steps: 20, prompt: 'a girl' },
    loras: [{ modelName: 'Foo', modelVersionId: 1, strength: 0.8 }],
};
/** レシピ由来の記録（`recipe` を持つ＝Sweep にかけられる）。 */
const SWEEPABLE = { id: 'rec-1', title: 'A record', verdict: 'reproducible', recipe: RECIPE };
/** 捕捉した記録（グラフはあるがレシピの形を持たない）。 */
const CAPTURED = { id: 'cap-1', title: 'A capture', verdict: 'reproducible', prompt: { 3: {} } };

function stubRunner({ planCells = 4, planThrows = null, onRun = null } = {}) {
    const runner = new SweepRunner({
        objectInfo: {},
        request: async (_input) => ({ ok: true, status: 200, json: async () => ({}) }),
        plan: () => {
            if (planThrows) throw new Error(planThrows);
            return {
                cells: Array.from({ length: planCells }, (_, i) => ({
                    id: `cell-${i + 1}`, signature: `s${i + 1}`, seed: i, baseline: i === 0,
                    labels: [{ axis: 'a', label: 'A', value: i, valueLabel: String(i), baseline: i === 0 }],
                    status: 'pending', recipe: {}, workflow: { prompt: {} },
                })),
                baselineId: 'cell-1',
            };
        },
    });
    if (onRun) runner.run = onRun;
    return runner;
}

// --- 検査 ----------------------------------------------------------------

test('回し方の選択肢に、訳の無い項目が出ない', async () => {
    /*
     * `MODE_CODES` は手書きの対応表で、`SWEEP_MODES` へ1つ足して**ここへ足し忘れる**と
     * `t(undefined)` になり、選択肢に `[undefined]` が出る。今は4つとも行が在るので
     * 実害は無いが、**足した本人が画面を開くまで気づけない**形なので機械に見させる。
     */
    const { SWEEP_MODES } = await import('../web/core/recipeSweep.js');
    const source = await readFile(join(ROOT, 'web/panel/sweepView.js'), 'utf8');
    const block = /const MODE_CODES = \{([\s\S]*?)\n\};/.exec(source);
    assert.ok(block, '回し方の対応表が読めない（走査が壊れている）');
    const mapped = [...block[1].matchAll(/^\s*([a-z_]+):/gm)].map(m => m[1]);
    assert.ok(SWEEP_MODES.length >= 4, `回し方が ${SWEEP_MODES.length} 個しか無い`);
    const missing = SWEEP_MODES.filter(mode => !mapped.includes(mode));
    assert.deepEqual(missing, [],
        '中核に在る回し方の訳が無い（選択肢に `[undefined]` が出る）');
    // **対照**: 対応表にだけ在る幽霊も置かない。
    const ghosts = mapped.filter(mode => !SWEEP_MODES.includes(mode));
    assert.deepEqual(ghosts, [], '中核に無い回し方が対応表に残っている');
});

test('かけられない記録には、押せないボタンでなく理由が出る', () => {
    install();
    setLocale('en');
    const view = createSweepView({ documentRef: fakeDocument(), record: CAPTURED });
    assert.equal(view.available, false);
    assert.equal(view.reason, 'no-recipe-payload');
    const message = view.root.byClass('unbake-sweep-unavailable');
    assert.ok(message, '理由が出ていない');
    assert.match(message.textContent, /LoRA Manager recipe/);
    // 操作の口を一切出さない（押せないボタンは「壊れている」と読まれる）。
    assert.equal(view.root.byClass('unbake-sweep-run'), null);
});

test('「回す」だけで回せる（検査は中で済ませる）', async () => {
    install();
    setLocale('en');
    const submitted = [];
    const runner = stubRunner({ onRun: async (options) => { submitted.push(options); return { cells: [] }; } });
    const view = createSweepView({ documentRef: fakeDocument(), record: SWEEPABLE, runner });

    // **押させる順番を増やさない。** 検査は投げる前に必ず通すが、それはこちらの都合で、
    // 押す人にとっては「回す」までが1つの操作（2026-08-21 に変えた）。
    assert.equal(view.available, true);
    assert.equal(view.root.byClass('unbake-sweep-run').disabled, false, '検査を先に押させている');

    await view.run();
    assert.equal(submitted.length, 1, '検査を通していないので投げていない');
    // 検査そのものは通っている（計画ができている）。
    assert.ok(view.plan, '検査を通さずに投げた');
});

test('検査に通るとセル数と見積もりが出る', () => {
    install();
    setLocale('en');
    const view = createSweepView({
        documentRef: fakeDocument(), record: SWEEPABLE, runner: stubRunner({ planCells: 6 }),
    });
    view.check();
    const status = view.root.byClass('unbake-sweep-status');
    assert.match(status.textContent, /6 cells/);
    assert.match(status.textContent, /Nothing but the declared axes changes/);
    // 検査だけでセルが並ぶ（回す前に何を回すかが見える）。
    assert.equal(view.root.allByClass('unbake-sweep-cell').length, 6);
});

test('検査に落ちたら、動いてしまった入力の名前がそのまま出る（そして1件も投げない）', async () => {
    install();
    setLocale('en');
    const view = createSweepView({
        documentRef: fakeDocument(),
        record: SWEEPABLE,
        runner: stubRunner({ planThrows: 'Sweep changed unintended graph inputs: 5.inputs.cfg' }),
    });
    assert.equal(view.check(), null);
    assert.match(view.root.byClass('unbake-sweep-status').textContent, /5\.inputs\.cfg/);
    assert.equal(view.root.allByClass('unbake-sweep-cell').length, 0);

    // **検査に落ちたら1件も投げない。** ボタンが押せるかどうかではなく、
    // **投げないこと**がこの決めごとの中身（押せる押せないは見た目の話）。
    const submitted = [];
    const runner = stubRunner({
        planThrows: 'Sweep changed unintended graph inputs: 5.inputs.cfg',
        onRun: async (options) => { submitted.push(options); return { cells: [] }; },
    });
    const strict = createSweepView({ documentRef: fakeDocument(), record: SWEEPABLE, runner });
    await strict.run();
    assert.deepEqual(submitted, [], '検査に落ちたのに投げている');
});

test('基準のセルに画像が無ければ、そう言う（何と比べるのかが無い）', async () => {
    install();
    setLocale('en');
    const view = createSweepView({
        documentRef: fakeDocument(),
        record: SWEEPABLE,
        runner: stubRunner({
            onRun: async ({ onUpdate }) => {
                const job = {
                    status: 'completed',
                    cells: [
                        { id: 'cell-1', baseline: true, status: 'failed', labels: [], error: 'x' },
                        { id: 'cell-2', baseline: false, status: 'completed', labels: [], output: { url: '/api/view?a' } },
                    ],
                };
                onUpdate?.(job);
                return job;
            },
        }),
    });
    await view.run();
    const summary = view.root.byClass('unbake-sweep-summary');
    assert.equal(summary.getAttribute('data-baseline'), 'missing');
    assert.match(summary.textContent, /nothing to compare against/);
});

test('基準のセルには印が付く', async () => {
    install();
    setLocale('en');
    const view = createSweepView({
        documentRef: fakeDocument(), record: SWEEPABLE, runner: stubRunner({ planCells: 3 }),
    });
    view.check();
    const cells = view.root.allByClass('unbake-sweep-cell');
    assert.deepEqual(cells.map(c => c.getAttribute('data-baseline')), ['true', 'false', 'false']);
    assert.equal(view.root.allByClass('unbake-sweep-badge').length, 1);
});

test('セルに順位も点数も付けない（決めごとは画面の文字ではなく、ここが守る）', async () => {
    install();
    setLocale('en');
    const view = createSweepView({
        documentRef: fakeDocument(), record: SWEEPABLE, runner: stubRunner(),
    });

    // **画面の一文は外した（2026-08-20）。** 「勝ちは人が選びます。Unbake はセルに
    // 順位を付けません——自動採点は、あなたが見ようとしていたものを先に決めて
    // しまいます。」は**次に実装する人へ向けた注意**で、絵を見比べに来た人には
    // 何を言っているのか分からなかった（実機でそう言われた）。
    //
    // **決めごと自体は消していない。** 画面に書いてあることが守らせていたのではなく、
    // ここが守る——順位・点数・並べ替えの語が実装に無いことを見る。
    const source = await readFile(join(ROOT, 'web/panel/sweepView.js'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const banned of [/\bscore\b/i, /\brank(ing|ed)?\b/i, /bestCell|winner|topPick/]) {
        assert.doesNotMatch(code, banned, `セルを採点する仕掛けが入っている: ${banned}`);
    }
    // 検出器が生きていること。
    assert.match('const score = 1;', /\bscore\b/i);

    // 画面にも順位の数字は出ていない。
    assert.doesNotMatch(view.root.text, /#1\b|1st\b/);
});

test('出たセルを記録として取り込める（Sweep → 記録 の輪）', async () => {
    install();
    setLocale('en');
    const captured = [];
    const view = createSweepView({
        documentRef: fakeDocument(),
        record: SWEEPABLE,
        runner: stubRunner({
            onRun: async ({ onUpdate }) => {
                const job = {
                    status: 'completed',
                    cells: [{
                        id: 'cell-1', baseline: true, status: 'completed', labels: [],
                        output: { url: '/api/view?filename=a.png', filename: 'a.png' },
                    }],
                };
                onUpdate?.(job);
                return job;
            },
        }),
        onCapture: (cell) => { captured.push(cell.output.url); },
    });
    await view.run();
    const button = view.root.byClass('unbake-sweep-capture');
    assert.ok(button, '取り込みの口が出ていない');
    await button.dispatch('click');
    assert.deepEqual(captured, ['/api/view?filename=a.png']);
});

// --- 一覧との差し替え ----------------------------------------------------

test('かけられない記録には、その理由が一覧に出る', () => {
    install();
    setLocale('en');
    const doc = fakeDocument();
    const host = new FakeNode('div', doc);
    const panel = createUnbakePanel(host, {
        documentRef: doc, width: 900, makeSweepRunner: () => stubRunner(),
        // **器を名指しする**（2026-08-28・既定がタイルへ変わったため）。
        display: { listView: 'table' },
    });
    panel.setRecords([SWEEPABLE, CAPTURED]);
    // **行にアイコンは置かない**（2026-08-22 利用者の指示）——入口は絵を押す詳細だけ。
    // ただし**かけられない理由は一覧に残す**。押せる口が無いぶん、
    // 「なぜこの記録では出せないのか」を開く前に読めないと判らなくなる。
    assert.equal(panel.root.allByClass('unbake-sweep-open').length, 0, '行にアイコンが残っている');
    assert.equal(panel.root.allByClass('unbake-variants-open').length, 0, '行にアイコンが残っている');
    assert.equal(panel.root.allByClass('unbake-act-models').length, 0, '行にアイコンが残っている');
    const na = panel.root.allByClass('unbake-sweep-na');
    assert.equal(na.length, 1, 'かけられない1件だけに印が付いていない');
    assert.match(na[0].getAttribute('title'), /LoRA Manager recipe/, '理由が読めない');
});

test('詳細は同じ器の中に重なる（別の窓を開かない）', async () => {
    install();
    setLocale('en');
    const doc = fakeDocument();
    const host = new FakeNode('div', doc);
    const panel = createUnbakePanel(host, {
        documentRef: doc, width: 900, makeSweepRunner: () => stubRunner(),
    });
    panel.setRecords([SWEEPABLE]);

    // **「振る」のタブは畳んだ**（2026-08-22 利用者の指示）。守っているのは
    // 「**別の窓を開かない**」——中身は今までどおり同じ器の中に描かれる。
    await panel.openDetail(panel.getRecords()[0]);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(panel.detailView, '詳細が開いていない');
    assert.ok(panel.root.byClass('unbake-detail-run'), '同じ器の中に描かれていない');
    assert.equal(panel.root.byClass('unbake-sweep'), null, '畳んだはずの面が残っている');
    // **一覧は隠れない**（2026-08-22 に重ねる形へ変えた）。後ろが見えたままなので、
    // 今どのレコードを触っているのかが作業中も画面に残る。
    // **隠れていないこと**を見る（`''` と「一度も触っていない」を区別しない——
    // どちらも「隠していない」で、そこが本題）。
    assert.notEqual(panel.root.byClass('unbake-body').style.display, 'none',
        '重ねる形にしたのに一覧を隠している');
    assert.equal(doc.body.children.length, 0, '別の窓を開いている');

    // 周りを押すと閉じ、一覧はそのまま。
    const backdrop = panel.root.byClass('unbake-detail-backdrop');
    backdrop.dispatch('click', { target: backdrop });
    assert.equal(panel.detailView, null, '周りを押しても閉じない');
    assert.ok(panel.root.byClass('unbake-body'), '一覧へ戻っていない');
    assert.equal(panel.root.byClass('unbake-detail-run'), null, '閉じたのに中身が残っている');
});

test('材料が無ければ、押せない理由を字で出す', async () => {
    install();
    setLocale('en');
    const doc = fakeDocument();
    const host = new FakeNode('div', doc);
    const panel = createUnbakePanel(host, { documentRef: doc, width: 900, makeSweepRunner: null });
    panel.setRecords([SWEEPABLE]);
    // **押せないボタンだけでは、壊れているのか出せないのか読めない。**
    // 「振る」のタブを畳んだとき、この約束は詳細の側へ移した（2026-08-22）。
    await panel.openDetail(panel.getRecords()[0]);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(panel.sweepView, null, '材料が無いのに面を作っている');
    assert.equal(panel.root.byClass('unbake-detail-run').disabled, true, '押せてしまう');
    assert.match(panel.root.byClass('unbake-detail-status').text, /did not supply the material/,
        '押せない理由が出ていない');
});

test('回し方の選択肢が、中核の受ける回し方と1つも欠けずに揃っている', async () => {
    install();
    setLocale('en');
    const { SWEEP_MODES } = await import('../web/core/recipeSweep.js');
    const view = createSweepView({
        documentRef: fakeDocument(), record: SWEEPABLE, runner: stubRunner(),
    });
    const options = view.root.byClass('unbake-sweep-mode')
        .children.map(child => child.getAttribute('value'));
    // **写して2箇所に置かない。** 中核に足した回し方が面に出ていないと、
    // 雛形が選べないだけでなく `select.value` が空文字へ落ちて
    // 「Unsupported sweep mode」になる（実機で踏んだ）。
    assert.deepEqual(options, [...SWEEP_MODES], '面の選択肢が中核とずれている');
});

test('seed だけの雛形を選ぶと、回し方が実際に seeds_only になる', () => {
    install();
    setLocale('en');
    const view = createSweepView({
        documentRef: fakeDocument(), record: SWEEPABLE, runner: stubRunner(),
    });
    // 既定は先頭＝seed だけ。
    assert.equal(view.root.byClass('unbake-sweep-mode').value, 'seeds_only',
        '選択肢に無い値を入れて空文字へ落ちている');
    const template = view.readTemplate();
    assert.equal(template.mode, 'seeds_only');
    assert.deepEqual(template.axes, []);
    assert.equal(template.seeds.length, 4);
});
