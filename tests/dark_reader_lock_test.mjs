/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * Dark Reader へ「このページは自前で暗い」と伝える錠。
 *
 * **CSS では直せない種類の不具合**への対処なので、検査もここでしか押さえられない。
 * 実測（2026-08-24・利用者の Vivaldi）: 後ろ布は `rgba(8,5,3,0.18)` の指定に対して
 * `rgb(74,81,83)`、箱は `#212124` に対して `rgb(30,32,33)` が返っていた。
 * **指定していない色が返る＝ページの外から書き換えられている。**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    LOCK_META_NAME, applyDarkReaderLock, lockDarkReader, unlockDarkReader,
} from '../web/core/darkReaderLock.js';

/** `head` を持つ最小の文書。**querySelector は名前で引けるだけでよい。** */
function fakeDoc({ withHead = true } = {}) {
    const metas = [];
    const head = {
        children: metas,
        append(node) { metas.push(node); node.parent = head; },
    };
    return {
        head: withHead ? head : null,
        createElement: () => ({
            attributes: {},
            setAttribute(k, v) { this.attributes[k] = String(v); },
            getAttribute(k) { return this.attributes[k] ?? null; },
            remove() {
                const at = metas.indexOf(this);
                if (at >= 0) metas.splice(at, 1);
            },
        }),
        querySelector: (sel) => {
            const want = /name="([^"]+)"/.exec(sel)?.[1];
            return metas.find(m => m.getAttribute('name') === want) || null;
        },
        metas,
    };
}

test('錠を掛けると、Dark Reader が見る目印が置かれる', () => {
    const doc = fakeDoc();
    assert.equal(lockDarkReader(doc), 'added');
    assert.equal(doc.metas.length, 1);
    // **名前が命。** Dark Reader は値を見ないので、名前を間違えると黙って効かない。
    assert.equal(doc.metas[0].getAttribute('name'), LOCK_META_NAME);
    assert.equal(LOCK_META_NAME, 'darkreader-lock');
});

test('二度掛けても増えない', () => {
    const doc = fakeDoc();
    lockDarkReader(doc);
    assert.equal(lockDarkReader(doc), 'already');
    assert.equal(doc.metas.length, 1, '重ねて足して文書を汚している');
});

test('外すと消える（設定を切ったら次の再読み込みを待たせない）', () => {
    const doc = fakeDoc();
    lockDarkReader(doc);
    assert.equal(unlockDarkReader(doc), 'removed');
    assert.equal(doc.metas.length, 0);
    assert.equal(unlockDarkReader(doc), 'absent', '無いものを消したことにしている');
});

test('設定の値で掛け外しが決まる（既定は掛ける）', () => {
    const doc = fakeDoc();
    applyDarkReaderLock(undefined, doc);
    assert.equal(doc.metas.length, 1, '既定で掛かっていない');
    applyDarkReaderLock(false, doc);
    assert.equal(doc.metas.length, 0, '切っても外れない');
    applyDarkReaderLock(true, doc);
    assert.equal(doc.metas.length, 1);
});

test('`head` が無くても落とさない', () => {
    // **拡張の登録はここで止まってよい話ではない。**
    // 宿主の形が想定と違っても、面が出ないより「錠が掛からない」だけのほうがよい。
    assert.equal(lockDarkReader(fakeDoc({ withHead: false })), 'unavailable');
    assert.equal(lockDarkReader(null), 'unavailable');
    assert.equal(unlockDarkReader(null), 'unavailable');
});
