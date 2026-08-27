/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **「出た絵」を、触った1枚だけ書き換える**（2026-08-26 利用者の指示）。
 *
 * 索引は開いたときに1度組んだきり**一度も更新していなかった**。だから
 * 新しく出した絵は「出た絵」に出ず、消した絵も消えない——どちらも
 * **再読み込みでしか直らなかった**。
 *
 * **全部組み直さない。** 実測で初回の走査は 24往復・1,334ms かかる。
 * 1枚出しただけでそれを回すのは、待たせるためだけの往復になる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUnbakePanel } from '../web/panel/panel.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale } from '../web/i18n/index.js';

setLocale('ja');

const record = { id: '1', libraryId: '1', title: 'r1', verdict: 'reproducible' };

function mount(io = {}) {
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc,
        loadRecord: async () => ({ gen_params: { seed: 1, prompt: 'a' },
                                   checkpoint: { file_name: 'c.safetensors' }, loras: [] }),
        ...io,
    });
    panel.setRecords([record]);
    return panel;
}

test('出したその場で索引へ足す', async () => {
    const noted = [];
    const panel = mount({
        makeSweepRunner: () => ({
            run: async () => ({ cells: [{ signature: 's',
                output: { url: '/view?x', filename: 'out_1.png', subfolder: '' } }] }),
        }),
        variantsIo: { note: (id, outputs) => noted.push({ id, outputs }) },
    });
    const button = panel.root.findAll(n => n.className === 'unbake-act unbake-act-replay')[0];
    assert.ok(button, '再生の口が無い');
    await button.dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(noted.length, 1, '出したのに索引へ足していない');
    assert.equal(noted[0].id, '1');
    assert.equal(noted[0].outputs[0]?.filename, 'out_1.png');
});

test('消えたら索引からも落とす', async () => {
    const forgotten = [];
    const panel = mount({
        deleteOutputIo: async () => ({ ok: true }),
        variantsIo: { forget: (what) => forgotten.push(what) },
    });
    // **猶予つきなので流し切る。** 面を閉じたときと同じ道。
    await panel.deleteOutputLater({ filename: 'out_1.png', subfolder: 'sub' }, record);
    panel.flushPendingDeletes();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(forgotten, [{ filename: 'out_1.png', subfolder: 'sub' }],
        '消したのに索引へ残している');
});

test('消せなかったときは索引から落とさない', async () => {
    // **消えていないのに一覧から消すと、在るのに見えない絵ができる。**
    const forgotten = [];
    const panel = mount({
        deleteOutputIo: async () => ({ ok: false, error: 'だめ' }),
        variantsIo: { forget: (what) => forgotten.push(what) },
    });
    await panel.deleteOutputLater({ filename: 'out_2.png', subfolder: '' }, record);
    panel.flushPendingDeletes();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(forgotten, [], '消せていないのに索引から落としている');
});

// --- 走者の索引（2026-08-26 実機）--------------------------------------------

test('消した絵を、走者の索引からも落とす', async () => {
    /*
     * 索引は `localStorage` に残るので、**ファイルを消しても控えは生き残る**。
     * すると次の再現で「もう出ている」と判断され、**死んだ URL を指したまま
     * 1枚も作らない**——利用者からは「再現できませんでした」に見える。
     * 実機では消した `hshi_00001_.png` がまさにこれだった。
     *
     * **ディスクの走査では直らない。** 消えたものは出てこないので、
     * 索引の側から落とすしかない。
     */
    const { SweepRunner } = await import('../web/core/sweepRunner.js');
    const { installEnvironment, resetEnvironment } = await import('../web/core/environment.js');
    // **環境の入れ物を据える。** 据えないと揮発の受け皿へ落ちるので、
    // 用意した控えを1件も見ないまま「0件落とした」になる（実際にそうなった）。
    const store = new Map();
    installEnvironment({
        // **口は要る**（据える側が形を弾く）。ここでは使わない。
        request: (url) => Promise.reject(new Error('使わない: ' + url)),
        storage: {
            getItem: key => (store.has(key) ? store.get(key) : null),
            setItem: (key, value) => store.set(key, String(value)),
            removeItem: key => store.delete(key),
        },
    });
    store.set('unbake.sweep.outputs', JSON.stringify({
        sigA: { url: '/view?a', filename: 'hshi_00001_.png', subfolder: '' },
        sigB: { url: '/view?b', filename: 'keep.png', subfolder: '' },
        sigC: { url: '/view?c', filename: 'hshi_00001_.png', subfolder: 'other' },
    }));

    const dropped = SweepRunner.forgetOutputFile({ filename: 'hshi_00001_.png', subfolder: '' });
    assert.equal(dropped, 1, '落とした件数が違う');
    const left = JSON.parse(store.get('unbake.sweep.outputs'));
    assert.equal(left.sigA, undefined, '消した絵が索引に残っている');
    assert.ok(left.sigB, '関係の無い絵まで落としている');
    // **名前だけで落とさない。** 別のフォルダに同じ名前が在りうる。
    assert.ok(left.sigC, 'フォルダが違うものまで落としている');
    resetEnvironment();
});

test('消したら、走者の索引へも頼む', async () => {
    const asked = [];
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc,
        deleteOutputIo: async () => ({ ok: true }),
        forgetRunnerOutput: (what) => asked.push(what),
    });
    panel.setRecords([record]);
    await panel.deleteOutputLater({ filename: 'hshi_00001_.png', subfolder: '' }, record);
    panel.flushPendingDeletes();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(asked, [{ filename: 'hshi_00001_.png', subfolder: '' }],
        '走者の索引へ頼んでいない');
});

test('消せなかったときは、走者の索引も触らない', async () => {
    const asked = [];
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc,
        deleteOutputIo: async () => ({ ok: false, error: 'だめ' }),
        forgetRunnerOutput: (what) => asked.push(what),
    });
    panel.setRecords([record]);
    await panel.deleteOutputLater({ filename: 'x.png', subfolder: '' }, record);
    panel.flushPendingDeletes();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(asked, [], '消えていないのに索引から落としている');
});

test('控えの絵が消えていたら、作り直す（存在しない画像と見比べない）', async () => {
    /*
     * 実機（2026-08-26）。手元の入れ物の索引は**ファイルを消しても残る**ので、
     * 「もう出ている」と判断され**1枚も作らず、存在しない画像と見比べて**いた。
     *
     * **ディスク由来（`source: 'disk'`）は確かめない**（走査したその場の真実）。
     * **確かめられなければ捨てない**（口が無いだけで作り直すと、出ている絵を
     * もう一度作ることになる）。
     */
    const { SweepRunner } = await import('../web/core/sweepRunner.js');
    const asked = [];
    /*
     * **実物の作りで組む**（2026-08-26 実機で判明）。
     *
     * 元は `Object.create(prototype)` に `request` を**自前の関数**として
     * 置いていた。実物の `request` は**クラスのメソッド**なので、
     * `const request = this.request` で外して呼ぶと中の `this` が消え、
     * `TypeError` が飛んで下の `catch` に飲まれる——**検算が一度も働かない**。
     * 作り物が自前の関数だったせいで、その形が検査から見えなかった。
     *
     * 構築時に渡す `request` は `injectedRequest` に入り、**メソッド越しに**
     * 呼ばれる。こうしないと実物と同じ道を通らない。
     */
    const runner = new SweepRunner({
        objectInfo: {},
        request: async (url, init) => {
            asked.push({ url, method: init?.method });
            return { ok: false, status: 404 };
        },
    });
    const outputs = {
        gone: { url: '/api/view?filename=hshi_00001_.png', filename: 'hshi_00001_.png', subfolder: '' },
        onDisk: { url: '/api/view?filename=alive.png', filename: 'alive.png', subfolder: '', source: 'disk' },
    };
    const got = await runner.verifyReusable(outputs, ['gone', 'onDisk']);
    assert.equal(got.gone, undefined, '消えた絵をまだ使おうとしている');
    assert.ok(got.onDisk, 'ディスク由来まで捨てている');
    // **ディスク由来は確かめない。** 往復の無駄。
    assert.equal(asked.length, 1, `確かめる回数が違う: ${asked.length}`);
    assert.equal(asked[0].method, 'HEAD', '中身まで取りに行っている');
});

test('確かめられなければ捨てない', async () => {
    // **口が無い・繋がらないだけで作り直すと、出ている絵をもう一度作る。**
    const { SweepRunner } = await import('../web/core/sweepRunner.js');
    const runner = new SweepRunner({
        objectInfo: {}, request: async () => { throw new Error('繋がらない'); },
    });
    const outputs = { a: { url: '/api/view?x', filename: 'x.png', subfolder: '' } };
    const got = await runner.verifyReusable(outputs, ['a']);
    assert.ok(got.a, '確かめられないだけで捨てている');
});

test('404 以外では捨てない', async () => {
    const { SweepRunner } = await import('../web/core/sweepRunner.js');
    const runner = new SweepRunner({ objectInfo: {}, request: async () => ({ ok: false, status: 503 }) });
    const outputs = { a: { url: '/api/view?x', filename: 'x.png', subfolder: '' } };
    const got = await runner.verifyReusable(outputs, ['a']);
    assert.ok(got.a, '一時的な失敗で捨てている');
});
