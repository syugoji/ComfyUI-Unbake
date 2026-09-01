/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **入れ物を読むこと自体が例外になる環境で、拡張ごと死なせない**
 * （2026-08-31・監査 I-20260831-10）。
 *
 * `localStorage` は「無い」だけではなく **`localStorage` と書いた瞬間に投げる**
 * ことがある——Chrome の「すべての Cookie とサイトデータをブロック」、および
 * `allow-same-origin` の無い `iframe` に ComfyUI を埋めた場合。DOM の仕様どおりの
 * 挙動で、投げるのは getter そのものなので `?? null` では受けられない。
 *
 * **落ち方が最悪の形になる。** `installComfyHost()` は `registerUnbake(app)` の中で
 * 呼ばれ、その `registerUnbake` は `web/unbake.js` の**最上位で try 無しに**呼ばれる。
 * つまりモジュール評価ごと失敗して `registerExtension` に一度も到達せず、
 * **サイドバーのタブもコマンドも出ない**。同ファイルが「静かに何も出ないのが
 * 最悪の落ち方なので、必ず理由を残す」と書いている、まさにその形になる。
 *
 * `web/core/storage.js` も `environment.js` も「入れ物が無いなら揮発へ倒す」ように
 * 作ってあるのに、**その手前で落ちていた**のが欠陥の本体である。
 *
 * 対照を2本置く——明示的に `storage: null` を渡した場合と、普通に読める環境。
 * 片方だけだと「投げなくなった」と「経路ごと消した」が見分けられない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installComfyHost } from '../web/host/comfyHost.js';

/** `localStorage` の getter が投げる環境を作る。**必ず元へ戻す。** */
function withDeniedStorage(body) {
    const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
    const previous = had ? Object.getOwnPropertyDescriptor(globalThis, 'localStorage') : null;
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get() {
            const error = new Error('Access is denied for this document.');
            error.name = 'SecurityError';
            throw error;
        },
    });
    try {
        return body();
    } finally {
        if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
        else delete globalThis.localStorage;
    }
}

test('入れ物の読み取りが投げる環境でも、host の据え付けは通る', () => {
    withDeniedStorage(() => {
        // **引数無しで呼ぶ**（`web/unbake.js:252` の実機と同じ経路）。
        const installed = installComfyHost();
        // 投げないだけでは足りない。**揮発へ倒れている**ことまで見る。
        assert.equal(installed.storage, null,
            '読めない入れ物を掴んだまま返している（後で保存のたびに投げる）');
        assert.equal(typeof installed.request, 'function', '呼び口が作られていない');
    });
});

test('対照: 明示的に storage を渡した場合はその値を使う', () => {
    withDeniedStorage(() => {
        const box = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
        const installed = installComfyHost({ storage: box });
        assert.equal(installed.storage, box,
            '渡した入れ物を捨てている＝逃げ道を潰している');
    });
});

test('対照: 普通に読める環境では、その入れ物をそのまま使う', () => {
    const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
    const previous = had ? Object.getOwnPropertyDescriptor(globalThis, 'localStorage') : null;
    const box = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: box });
    try {
        const installed = installComfyHost();
        assert.equal(installed.storage, box,
            '読める入れ物を捨てている＝保存が丸ごと効かなくなる');
    } finally {
        if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
        else delete globalThis.localStorage;
    }
});
