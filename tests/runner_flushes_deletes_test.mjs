/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **投げる前に、消すと言った絵を本当に消す**——実行器を作るどの口からでも（2026-08-29）。
 *
 * ## 症状
 *
 * 利用者の報告（3度目）: 「出た絵を消したあとに再現ボタンを押すと**消す絵との
 * 比較画面が表示され**、**消えてからも比較画面が表示されます**」。
 *
 * ## 成り立ち
 *
 * 消す口は押した瞬間には消さず、**12秒の猶予**を置く。その間、絵は
 * **ディスクにも実行器の索引にも生きている**。
 *
 * そして `SweepRunner.run()` の `reuseExisting` は **既定が true**。
 * 実行器は「この条件はもう出ている」と読み、**投げずに、消しかけの絵を返す**。
 * 12秒後にファイルだけが消えるので、画面には**死んだ絵を指した比較**が残る
 * ——「消えてからも比較画面が表示されます」はこの形。
 *
 * ## なぜ2度直しても再発したか
 *
 * 流し切る処理を**呼び手ごとに書いていた**からである。
 *
 *     reproduceOne()      … 入っていた（2026-08-27）
 *     runBatch()          … 入っていた（2026-08-27）
 *     openMadeOrQueue()   … 漏れていた（2026-08-29 に足した）
 *     runOneWithChanges() … **漏れていた**（詳細の面の実行ボタン・これ）
 *
 * 呼び手は増える。だから**作る側**を1本にした——`makeRunner()` を通さない
 * 実行器は作れない。この検査は、その1本が働いていることを見る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createUnbakePanel } from '../web/panel/panel.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale } from '../web/i18n/index.js';

setLocale('ja');

const OUTPUT = { filename: 'civitai_a_00006_.png', subfolder: '' };
const RECORD = { id: 'a', libraryId: 'a', title: 'A', recipe: { id: 'a', gen_params: { seed: 1 } } };

async function settle(times = 10) {
    for (let i = 0; i < times; i += 1) await new Promise(r => setTimeout(r, 0));
}

/**
 * 偽のディスクを1枚持ったパネル。**実行器が走った時点のディスクの中身**を
 * 記録するので、「消す前に投げたか／消してから投げたか」が外から見える。
 */
function mount() {
    const doc = fakeDocument();
    const node = doc.createElement('div');
    node.ownerDocument = doc;
    const disk = new Set([`/${OUTPUT.filename}`]);
    /** 実行器が run() に入った時点でディスクに何枚在ったか。 */
    const seenAtRun = [];
    const panel = createUnbakePanel(node, {
        documentRef: doc,
        mode: 'sidebar',
        width: 1200,
        loadRecord: async () => ({
            gen_params: { seed: 1, prompt: 'a' },
            checkpoint: { file_name: 'c.safetensors' },
            loras: [],
        }),
        deleteOutputIo: async ({ filename, subfolder }) => {
            disk.delete(`${subfolder}/${filename}`);
            return { ok: true };
        },
        makeSweepRunner: () => ({
            inputsReady: Promise.resolve(),
            requireEmptyQueue: async () => {},
            run: async () => { seenAtRun.push(disk.size); return { cells: [] }; },
        }),
    });
    panel.setRecords([RECORD]);
    return { doc, panel, disk, seenAtRun };
}

test('詳細の面の実行ボタンも、投げる前に消す約束を流す', async () => {
    const { panel, disk, seenAtRun } = mount();
    await panel.deleteOutputLater(OUTPUT, RECORD);
    assert.equal(disk.size, 1, '押した瞬間に消えている（猶予が働いていない）');

    // 詳細の面を開いて、その面の実行ボタンを押す（利用者が踏む道そのもの）。
    await panel.openDetail(RECORD);
    await settle();
    const run = panel.root.find(n => String(n.className || '') === 'unbake-detail-run');
    assert.ok(run, '詳細の面に実行ボタンが無い');
    assert.equal(run.disabled, false, '実行ボタンが押せない状態のまま（材料が足りない）');
    run.dispatch('click', {});
    await settle();

    assert.deepEqual(
        seenAtRun, [0],
        `投げた時点で消しかけの絵が残っている（実行器が「もう出ている」と読む）: ${JSON.stringify(seenAtRun)}`,
    );
    assert.equal(disk.size, 0, '実行のあとも消えていない');
});

test('消す約束が無いときは、余計に待たない', async () => {
    // **対照。** 何もしていないのに流す実装だと、上の検査は素通りする。
    const { panel, seenAtRun } = mount();
    await panel.openDetail(RECORD);
    await settle();
    panel.root.find(n => String(n.className || '') === 'unbake-detail-run').dispatch('click', {});
    await settle();
    assert.deepEqual(seenAtRun, [1], '消していないのにディスクが減っている');
});
