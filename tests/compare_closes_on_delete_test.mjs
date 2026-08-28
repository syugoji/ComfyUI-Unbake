/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **消えた絵を映している見比べは畳む**（2026-08-29 利用者の報告
 * 「……**消えてからも比較画面が表示されます**」）。
 *
 * ## 成り立ち
 *
 * 消す口は押した瞬間には消さず、**12秒の猶予**を置く。だから
 * **消すと言った後も、しばらくは絵が開ける**——その間に見比べが開くことは在るし、
 * 開いたまま猶予が切れることも在る。
 *
 * そのとき箱は残り、中の `<img>` だけが**死んだ URL**を指す。見ている人には
 * 「消したはずのものが、まだ画面に出ている」としか見えない。
 *
 * **名前で照合する。** URL には鮮度の印（`_ub=`）が付くので、URL の等値では当たらない
 * ——ここを等値で書くと、検査は通るのに実機では畳まれない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createUnbakePanel } from '../web/panel/panel.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale } from '../web/i18n/index.js';
import { outputImageUrl } from '../web/core/outputUrl.js';

setLocale('ja');

const OUTPUT = { filename: 'civitai_a_00006_.png', subfolder: '', modified: 1756400000, size: 10 };
const RECORD = { id: 'a', libraryId: 'a', title: 'A', recipe: { id: 'a', gen_params: { seed: 1 } } };

async function settle(times = 8) {
    for (let i = 0; i < times; i += 1) await new Promise(r => setTimeout(r, 0));
}

function mount(deleteResult = { ok: true }) {
    const doc = fakeDocument();
    const node = doc.createElement('div');
    node.ownerDocument = doc;
    const panel = createUnbakePanel(node, {
        documentRef: doc,
        mode: 'sidebar',
        width: 1200,
        loadFreshOutputs: async () => [{ ...OUTPUT, url: outputImageUrl(OUTPUT) }],
        deleteOutputIo: async () => deleteResult,
        makeSweepRunner: () => ({
            inputsReady: Promise.resolve(),
            requireEmptyQueue: async () => {},
            run: async () => ({ cells: [] }),
        }),
    });
    panel.setRecords([RECORD]);
    return { doc, panel };
}

const compareBox = (panel) => panel.root.find(n => String(n.className || '') === 'unbake-compare');
const replayButton = (panel) =>
    panel.root.findAll(n => String(n.className || '').includes('unbake-act-replay'))[0];

test('見比べを開いた後にその絵が消えたら、箱を畳む', async () => {
    const { panel } = mount();
    // ▶ の単押しで、今在る絵が見比べに出る。
    replayButton(panel).dispatch('click', {});
    await settle();
    assert.ok(compareBox(panel), '在る絵の見比べが開いていない（前提が崩れている）');

    // 消す約束をして、猶予を流し切る（＝実際に消える）。
    await panel.deleteOutputLater(OUTPUT, RECORD);
    await panel.flushPendingDeletes();
    await settle();

    assert.equal(
        compareBox(panel), null,
        '消えた絵を映したまま見比べが残っている（死んだ URL の箱）',
    );
});

test('別の絵が消えても、見ている見比べは畳まない', async () => {
    // **対照。** 何が消えても畳む実装だと、上の検査は素通りする。
    const { panel } = mount();
    replayButton(panel).dispatch('click', {});
    await settle();
    assert.ok(compareBox(panel), '前提が崩れている');

    await panel.deleteOutputLater({ filename: 'other_00001_.png', subfolder: '' }, RECORD);
    await panel.flushPendingDeletes();
    await settle();

    assert.ok(compareBox(panel), '関係の無い絵を消しただけで見比べが閉じた');
});

test('置き場が違う同名の絵では畳まない', async () => {
    const { panel } = mount();
    replayButton(panel).dispatch('click', {});
    await settle();
    await panel.deleteOutputLater({ filename: OUTPUT.filename, subfolder: 'sub' }, RECORD);
    await panel.flushPendingDeletes();
    await settle();
    assert.ok(compareBox(panel), '置き場を見ずに同じ絵として畳んでいる');
});

test('消せなかったときは畳まない（まだ在るので）', async () => {
    const { panel } = mount({ ok: false, error: 'busy' });
    replayButton(panel).dispatch('click', {});
    await settle();
    await panel.deleteOutputLater(OUTPUT, RECORD);
    await panel.flushPendingDeletes();
    await settle();
    assert.ok(compareBox(panel), '消せていないのに畳んでいる（在る絵を隠した）');
});
