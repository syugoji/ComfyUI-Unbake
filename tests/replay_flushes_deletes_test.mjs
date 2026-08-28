/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **消すと言った絵を、再現の前に本当に消す**——▶ の単押しでも（2026-08-29）。
 *
 * ## 症状
 *
 * 利用者の報告: 「レコードの出た絵の削除を行った後**再現すると比較画像が
 * 表示される**」。消したはずの絵が、そのまま見比べに出てくる。
 *
 * ## 成り立ち
 *
 * 消す口は**押した瞬間には消さない**。12秒の猶予を置いて「元に戻す」を
 * 押せるようにしてある（`DELETE_GRACE_MS`）。その猶予のあいだ、絵は
 * **ディスクにも索引にも生きている**。
 *
 * ▶ の単押しは「絵が在るなら作らずに開く」約束なので（2026-08-27 利用者の指示）、
 * 猶予の中で押すと **まだ消えていない絵を見つけて、それを開いて終わる**
 * ——押した人には「削除したのに、その絵が比較で出てくる」と見える。
 *
 * ## なぜ前の修正で直らなかったか
 *
 * 同じ理由は**既に見つかっていて**、`reproduceOne()` と `runBatch()` には
 * `await flushPendingDeletes()` が入っている（2026-08-27）。
 * **▶ の単押しだけが漏れていた**——そして単押しが一番よく使われる口である。
 *
 * 「猶予の中で押すか外で押すかで結果が変わる」ので、**同じ操作が日によって
 * 違う結果を返す**ように見えていた点も、`reproduceOne` の注記と同じ形。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createUnbakePanel } from '../web/panel/panel.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale } from '../web/i18n/index.js';

setLocale('ja');

const OUTPUT = { filename: 'civitai_a_00006_.png', subfolder: '' };

async function settle(times = 8) {
    for (let i = 0; i < times; i += 1) await new Promise(r => setTimeout(r, 0));
}

/**
 * 偽のディスクを1枚持ったパネル。**消したら本当に消える**ようにしてあり、
 * `loadFreshOutputs` はそのときのディスクの中身を返す（サーバの数え直しと同じ形）。
 */
function mount() {
    const doc = fakeDocument();
    const node = doc.createElement('div');
    node.ownerDocument = doc;
    const disk = new Set([`/${OUTPUT.filename}`]);
    const order = [];
    const ran = [];
    const panel = createUnbakePanel(node, {
        documentRef: doc,
        mode: 'sidebar',
        width: 1200,
        loadFreshOutputs: async () => {
            order.push('read');
            return [...disk].map(key => ({
                url: `/api/view?filename=${key.slice(1)}`,
                filename: key.slice(1),
                subfolder: '',
            }));
        },
        deleteOutputIo: async ({ filename, subfolder }) => {
            order.push('delete');
            disk.delete(`${subfolder}/${filename}`);
            return { ok: true };
        },
        makeSweepRunner: () => ({
            inputsReady: Promise.resolve(),
            requireEmptyQueue: async () => {},
            run: async (options) => { ran.push(options?.record?.id ?? '?'); return { cells: [] }; },
        }),
    });
    panel.setRecords([{ id: 'a', title: 'A', recipe: { id: 'a', gen_params: { seed: 1 } } }]);
    return { doc, panel, disk, order, ran };
}

const replayButton = (panel) =>
    panel.root.findAll(n => String(n.className || '').includes('unbake-act-replay'))[0];

const compareBox = (panel) =>
    panel.root.find(n => String(n.className || '') === 'unbake-compare');

test('猶予の中で再現を押したら、まず消してから読む', async () => {
    const { panel, disk, order } = mount();
    // 消すと言った（**まだ消えていない**——ここが猶予）。
    await panel.deleteOutputLater(OUTPUT, { id: 'a' });
    assert.equal(disk.size, 1, '押した瞬間に消えてしまっている（戻せない）');

    replayButton(panel).dispatch('click', {});
    await settle();

    assert.equal(disk.size, 0, '再現を押したのに、消すと言った絵が残っている');
    assert.equal(
        order[0], 'delete',
        `消す前に読んでいる（消した絵を見つけて開いてしまう）: ${JSON.stringify(order)}`,
    );
});

test('猶予の中で再現を押したら、消した絵を見比べに出さない', async () => {
    const { panel } = mount();
    await panel.deleteOutputLater(OUTPUT, { id: 'a' });
    replayButton(panel).dispatch('click', {});
    await settle();
    assert.equal(
        compareBox(panel), null,
        '消したはずの絵が見比べに出ている（利用者の報告そのもの）',
    );
});

test('消した後は作りに行く（開いて終わりにしない）', async () => {
    const { panel, ran } = mount();
    await panel.deleteOutputLater(OUTPUT, { id: 'a' });
    replayButton(panel).dispatch('click', {});
    await settle();
    assert.deepEqual(ran, ['a'], '絵が無くなったのに作りに行っていない');
});

test('消していないなら、今までどおり在る絵を開く', async () => {
    // **対照。** 上の3件が「常に作りに行く」形で通ってしまわないことを見る。
    const { panel, ran } = mount();
    replayButton(panel).dispatch('click', {});
    await settle();
    assert.ok(compareBox(panel), '在る絵を開かなくなっている（単押しの約束を壊した）');
    assert.deepEqual(ran, [], '在る絵が在るのに作りに行っている（単押しの約束を壊した）');
});
