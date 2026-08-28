/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 画面側の端（`D-20260828-01` 群E の JS 側）。
 *
 * - **E5**: 軸の別々の値が同じ組み上がりへ潰れると、2つの升が同じ1枚を指す
 * - **E6**: × で外した升が、実行器には届かず結局投入される
 * - **E7**: `inflate` に出力の上限が無く、圧縮爆弾で画面が無応答になる
 * - **E8**: Esc が確認の面に届かず、**後ろの選択だけが消える**
 * - **E9**: サイドバーへの登録が `?.` で無音失敗する
 *
 * どれも**赤くならない壊れ方**をする。E5 は「N件中N件が比較できる」と言い続け、
 * E6 はタイルが `skipped` に見えたまま GPU を使い、E9 は起動ログが正常なまま
 * ボタンだけが無い。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { inflateRaw, MAX_INFLATED_BYTES } from '../web/core/inflate.js';
import { createConfirmView } from '../web/panel/confirmView.js';
import { SweepRunner } from '../web/core/sweepRunner.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale } from '../web/i18n/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
setLocale('ja');

// --- E7 展開の上限 -----------------------------------------------------------

test('展開の出力に上限がある（圧縮爆弾で面ごと持っていかれない）', () => {
    /*
     * 読んでいるのは**利用者が拾ってきた画像**なので、悪意ある1枚は普通に届く。
     * zTXt に高圧縮のデータを仕込むと、同期関数のままメインスレッドが数GBまで
     * 確保し、ComfyUI のページ全体が無応答になる。
     */
    assert.ok(MAX_INFLATED_BYTES > 0, '上限が無い');

    // **本物の圧縮爆弾を小さく作る。** 同じ1バイトを100,000個——入り口は
    // 100バイト程度で、出口は100,000バイト。
    const bomb = deflateRawSync(Buffer.alloc(100_000, 65));
    assert.ok(bomb.length < 1000, `入力が小さくない: ${bomb.length}`);

    // 上限を付けなければ、今までどおり展開できる。
    assert.equal(inflateRaw(new Uint8Array(bomb)).length, 100_000, '普通の展開が壊れている');

    // **上限を超えたら投げる。** 確保してから気づくのでは遅い。
    assert.throws(
        () => inflateRaw(new Uint8Array(bomb), { limit: 1024 }),
        /exceeds/,
        '上限を超えても伸ばし続けている',
    );
});

// --- E8 Esc が届く -----------------------------------------------------------

test('Esc が確認の面に届く（後ろの選択だけを消さない）', async () => {
    /*
     * `keydown` は**焦点から上へしか伝わらない**。この面は `tabindex` を持たず
     * `.focus()` も呼ばれていなかったので、受け口に永久に届かなかった
     * ——代わりに面の側の `keydown`（選択の解除）が走り、
     * **取り消せない削除の確認が開いたまま、後ろの選択だけが消える。**
     */
    const doc = fakeDocument();
    let closed = 0;
    const view = createConfirmView({
        documentRef: doc, title: 'x', files: [], onConfirm: async () => ({ ok: true }),
        onClose: () => { closed += 1; },
    });
    assert.equal(view.root.getAttribute('tabindex'), '-1', '焦点を受け取れない箱のまま');

    await view.root.dispatch('keydown', { key: 'Escape', stopPropagation() {} });
    assert.equal(closed, 1, '面の上で押した Esc が届いていない');

    // **焦点が外に在っても効く。** 面の別の場所を押すと焦点は出ていく。
    await doc.dispatch('keydown', { key: 'Escape', stopPropagation() {} });
    assert.equal(closed, 2, '外で押した Esc が届いていない');

    // 閉じたら聞き手を残さない（次の面を勝手に閉じる）。
    view.destroy();
    await doc.dispatch('keydown', { key: 'Escape', stopPropagation() {} });
    assert.equal(closed, 2, '閉じた面が Esc を拾い続けている');
});

// --- E6 × が実行器へ届く ------------------------------------------------------

test('× で外した升は、実行器の実体にも印が付く', () => {
    /*
     * 画面が持っているのは `onUpdate` が渡した**写し**（`clone()`）。
     * そちらの `status` を書き換えても実行器には届かないので、タイルは即
     * `skipped` に見えるのに**順番が来ると投入されて GPU を使い**、
     * 次の更新で `completed` に戻る。
     */
    const runner = new SweepRunner({});
    runner.currentJob = {
        cells: [{ id: 'a', status: 'pending' }, { id: 'b', status: 'pending' }],
    };
    runner.persist = () => {};
    let emitted = 0;
    runner.onUpdate = () => { emitted += 1; };

    assert.equal(runner.dropCell('a'), true, '実体へ書けていない');
    assert.equal(runner.currentJob.cells[0].status, 'skipped');
    assert.equal(runner.currentJob.cells[1].status, 'pending', '関係の無い升まで外している');
    assert.ok(emitted > 0, '外したことを画面へ伝えていない');

    // 済んだ升は外せない（外せると「出た絵」を消したように見える）。
    runner.currentJob.cells[1].status = 'completed';
    assert.equal(runner.dropCell('b'), false, '済んだ升を外している');
    assert.equal(runner.currentJob.cells[1].status, 'completed');
});

test('走る前に外した升も覚えている', () => {
    // 計画を見ている段階には実体がまだ無い。**id だけ覚えておく。**
    const runner = new SweepRunner({});
    assert.equal(runner.dropCell('later'), false, '実体が無いのに書けたと言っている');
    assert.ok(runner.droppedCells.has('later'), '覚えていない（走らせると投入される）');
});

// --- E5 同じ組み上がりの升を通さない -------------------------------------------

test('同じ絵になる升を「比較できる」と言わない', async () => {
    /*
     * 軸の値が違っても、組み上がりが同じになることがある（範囲外がクランプされる・
     * 効かない組み合わせで無視される）。潰れると signature が一致し、実行側は
     * 「もう出ている」と読んで片方を回さない——**別ラベルの2タイルが同じ1枚を指す。**
     * それでも画面は「N件中N件が比較できる」と言い続ける。
     */
    const source = await readFile(join(ROOT, 'web/core/recipeSweep.js'), 'utf8');
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.match(stripped, /build the same graph/,
        '同じ組み上がりの升を素通ししている');
    assert.match(stripped, /seen\.set\(cell\.signature/,
        'signature の重なりを見ていない');
});

// --- E9 サイドバー登録の失敗を黙らない ------------------------------------------

test('サイドバーへ登録できなかったら理由を出す', async () => {
    /*
     * 元は `app.extensionManager?.registerSidebarTab?.({...})` の1行で、
     * **両方の `?.` が無音で外れる**。frontend が名前を変えただけで、
     * 起動ログは正常・`/api/extensions` に全ファイルが載る・コマンドパレットも
     * 出るのに**サイドバーにボタンだけが無い**。
     */
    const { registerUnbake } = await import('../web/unbake.js');
    const { t } = await import('../web/i18n/index.js');
    const doc = fakeDocument();
    const errors = [];
    const before = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    try {
        const app = {
            registerExtension(extension) { app.extension = extension; },
            // **`extensionManager` が居ない**（改名・移動された想定）。
            ui: { settings: { getSettingValue: () => 'ja' } },
        };
        registerUnbake(app, { documentRef: doc });
        await app.extension.setup();
    } finally {
        console.error = before;
    }
    assert.ok(errors.some(line => line.includes(t('host.noSidebarTab'))),
        `登録できなかったのに黙っている: ${JSON.stringify(errors)}`);
});
