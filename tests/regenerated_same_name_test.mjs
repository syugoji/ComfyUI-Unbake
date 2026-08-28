/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **同じ名前で作り直された絵を、古い方で上書きしない**（2026-08-29）。
 *
 * ## 症状
 *
 * 利用者の報告: 「**再度生成した後に表示が前の画像**だったりします」。
 *
 * ## 成り立ち
 *
 * **ComfyUI は消して空いた番号を再利用する。** `_00006_` を消して作り直すと、
 * 新しい絵の名前も `_00006_` になる。つまり **同じ名前は同じ絵を意味しない。**
 *
 * 手元の索引（「出た絵」の一覧が読む）は、出た絵を足すとき
 * **名前が同じなら「もう在る」として捨てていた**。結果、索引には
 * **古い項目（古い mtime・古い大きさ）が残り続ける**。
 * 一覧はその項目から URL を組むので、**前の絵を出し続ける。**
 *
 * ## なぜ URL の直しだけでは足りないか
 *
 * URL には鮮度の印（`modified` と `size` から作る）を載せてある
 * （`core/outputUrl.js`）。だが**印を載せる素材そのものが古い**なら、
 * 出来上がる URL も古いままになる。**組み立て器は正しく、渡す値が古かった。**
 * だからこの検査は URL の検査（`stale_output_image_test.mjs`）とは別に要る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { forgetOutput, noteOutputs, outputKey } from '../web/core/variantIndex.js';
import { outputImageUrl } from '../web/core/outputUrl.js';

const NAME = 'civitai_137684933_00006_.png';
const BEFORE = { filename: NAME, subfolder: '', modified: 1756400000.5, size: 1327543 };
const AFTER = { filename: NAME, subfolder: '', modified: 1756400900.25, size: 1328607 };

test('同じ名前で作り直したら、新しい方が索引に残る', () => {
    const index = new Map([['r1', [BEFORE]]]);
    assert.equal(noteOutputs(index, 'r1', [AFTER]), true, '書き換えたと言っていない');
    const list = index.get('r1');
    assert.equal(list.length, 1, '同じ場所の絵が2つに増えている');
    assert.equal(list[0].modified, AFTER.modified, '古い方が残っている＝前の絵が出続ける');
    assert.equal(list[0].size, AFTER.size);
});

test('索引が新しくなれば、一覧の URL も変わる', () => {
    // **この検査が症状そのもの。** 索引が古いままだと URL も古いままになる。
    const index = new Map([['r1', [BEFORE]]]);
    const before = outputImageUrl(index.get('r1')[0]);
    noteOutputs(index, 'r1', [AFTER]);
    const after = outputImageUrl(index.get('r1')[0]);
    assert.notEqual(before, after, '作り直したのに、一覧が同じ URL を出している');
});

test('新しい場所の絵は先頭へ足す（並びは新しい順）', () => {
    const index = new Map([['r1', [BEFORE]]]);
    const other = { filename: 'civitai_137684933_00007_.png', subfolder: '', modified: 2, size: 2 };
    noteOutputs(index, 'r1', [other]);
    assert.deepEqual(
        index.get('r1').map(outputKey),
        ['/civitai_137684933_00007_.png', `/${NAME}`],
        '新しい絵が先頭に来ていない',
    );
});

test('置き換えのときは並びを動かさない', () => {
    // 差し替えるたびに順番が跳ねると、見ている側が追えなくなる。
    const first = { filename: 'a.png', subfolder: '', modified: 3, size: 3 };
    const index = new Map([['r1', [first, BEFORE]]]);
    noteOutputs(index, 'r1', [AFTER]);
    assert.deepEqual(index.get('r1').map(outputKey), ['/a.png', `/${NAME}`], '並びが動いた');
});

test('置き場が違えば別の絵として足す', () => {
    const index = new Map([['r1', [BEFORE]]]);
    noteOutputs(index, 'r1', [{ ...AFTER, subfolder: 'sub' }]);
    assert.equal(index.get('r1').length, 2, '置き場を見ずに同じ絵として潰している');
});

test('同じ投入に同じ場所が2回来たら、後の方を採る', () => {
    const index = new Map([['r1', []]]);
    noteOutputs(index, 'r1', [BEFORE, AFTER]);
    assert.equal(index.get('r1').length, 1, '同じ場所の絵が2つ入った');
    assert.equal(index.get('r1')[0].modified, AFTER.modified, '先に来た方を採っている');
});

test('変わらないものを入れ直しても、書き換えたと言わない', () => {
    // **対照。** 何を入れても true を返す実装だと、上の検査は全部素通りする。
    const index = new Map([['r1', [BEFORE]]]);
    assert.equal(noteOutputs(index, 'r1', []), false, '空を入れて書き換えたと言っている');
    assert.equal(noteOutputs(index, 'r1', [{ subfolder: '' }]), false, '名前の無い項目を入れている');
    assert.equal(noteOutputs(new Map(), '', [AFTER]), false, '記録idが無いのに書き換えている');
});

test('消した絵は、どの記録からも落ちる', () => {
    const index = new Map([['r1', [BEFORE]], ['r2', [BEFORE]]]);
    assert.equal(forgetOutput(index, { filename: NAME }), true);
    assert.equal(index.get('r1').length, 0);
    assert.equal(index.get('r2').length, 0);
});

test('消えていない絵は落とさない', () => {
    // **対照。** 何でも落とす実装だと、上の検査は素通りする。
    const index = new Map([['r1', [BEFORE]]]);
    assert.equal(forgetOutput(index, { filename: 'other.png' }), false, '別の絵を落としている');
    assert.equal(forgetOutput(index, { filename: NAME, subfolder: 'sub' }), false, '置き場を見ていない');
    assert.equal(index.get('r1').length, 1);
});
