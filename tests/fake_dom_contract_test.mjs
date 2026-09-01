/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **［人形の契約］ダブルがブラウザより寛容だと、その差の分だけ検査が嘘になる**
 * （2026-08-31・監査 I-20260831-17, I-20260831-07）。
 *
 * `fake_dom.mjs` は SELECT についてこの教訓を既に書いていて、選択肢に無い値を
 * 弾くようにしてある。**同じ教訓が2箇所へ適用されていなかった。**
 *
 * 1. `focus()` が `isConnected` しか見ない。本物は「**焦点を取れる要素**」
 *    （`tabindex` を持つか、本来 focusable な札）でなければ何も起きない。
 *    変異で確定: `web/panel/panel.js` の面の根から `tabindex` を消しても
 *    **1,534件が緑のまま**（無変異と1件も違わない）だった。
 *
 * 2. `value` の setter が range の `min`/`max` でクランプしない。本物の
 *    `<input type="range">` は範囲外の値を丸める。丸めないので、下限 0 の
 *    スライダーへ `-0.7` を入れる検査が**偽DOM上だけ素通り**し、実機では
 *    `0` へ潰れる差を一度も捕まえられない。
 *
 * **人形を厳しくすると、それに寄りかかっていた検査が赤くなる。** それが本来の姿で、
 * 赤くなった検査は「守っていたつもりの物を守っていなかった」印になる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fakeDocument } from './fake_dom.mjs';

test('［人形の契約］焦点は、焦点を取れる要素にしか当たらない', () => {
    const doc = fakeDocument();
    const root = doc.createElement('div');
    doc.body.append(root);

    // 素の `<div>` は焦点を取れない（本物と同じ）。
    root.focus();
    assert.notEqual(doc.activeElement, root,
        'tabindex の無い div へ焦点が当たっている＝本物より寛容');

    // `tabindex` を付ければ取れる。
    root.setAttribute('tabindex', '0');
    root.focus();
    assert.equal(doc.activeElement, root, 'tabindex を付けても焦点が当たらない');
});

test('［人形の契約］本来 focusable な札は tabindex 無しでも焦点を取れる', () => {
    const doc = fakeDocument();
    for (const tag of ['button', 'input', 'select', 'textarea', 'a']) {
        const node = doc.createElement(tag);
        doc.body.append(node);
        node.focus();
        assert.equal(doc.activeElement, node, `${tag} が焦点を取れていない`);
    }
});

test('［人形の契約］外れた箱は、focusable でも焦点を取れない', () => {
    const doc = fakeDocument();
    const button = doc.createElement('button');   // 付けない
    button.focus();
    assert.notEqual(doc.activeElement, button, '書類に付いていないのに焦点が当たっている');
});

test('［人形の契約］range は min/max で丸める', () => {
    const doc = fakeDocument();
    const slider = doc.createElement('input');
    slider.setAttribute('type', 'range');
    slider.setAttribute('min', '0');
    slider.setAttribute('max', '2');

    slider.value = '-0.7';
    assert.equal(slider.value, '0', '下限より小さい値が素通りしている（本物は丸める）');

    slider.value = '5';
    assert.equal(slider.value, '2', '上限より大きい値が素通りしている');

    slider.value = '1.35';
    assert.equal(slider.value, '1.35', '範囲内の値まで動かしている');
});

test('［人形の契約］range 以外は丸めない', () => {
    // **対照。** 範囲を持たない入力まで丸めると、別の検査が静かに壊れる。
    const doc = fakeDocument();
    const text = doc.createElement('input');
    text.setAttribute('type', 'text');
    text.setAttribute('min', '0');
    text.value = '-0.7';
    assert.equal(text.value, '-0.7', 'text まで丸めている');

    const bare = doc.createElement('input');
    bare.setAttribute('type', 'range');   // min/max を宣言していない
    bare.value = '-0.7';
    assert.equal(bare.value, '-0.7', '範囲の宣言が無いのに丸めている');
});

/*
 * 以下2件は `D-20260831-01`（枠から落とした候補の選別）で拾ったもの。
 * **人形の穴は今回2件とも実害だった**（`-17` の `focus` ・ `-07` の range）ので、
 * 「今は製品側に該当コードが無い」を理由に残さない——**書き方を変えた瞬間に
 * 検査が嘘になる**穴である。
 */

test('［人形の契約］setAttribute("value") が、選択肢の検査を迂回しない', () => {
    // `I-20260831-52`: `rawValue` を直に書いていたので、SELECT の選択肢検査
    // （このファイルが既に持っている教訓）を素通りできた。
    const doc = fakeDocument();
    const select = doc.createElement('select');
    const option = doc.createElement('option');
    option.setAttribute('value', 'a');
    select.append(option);
    doc.body.append(select);

    select.setAttribute('value', 'b');
    assert.notEqual(select.value, 'b',
        '選択肢に無い値が setAttribute から入っている＝本物より寛容');

    select.setAttribute('value', 'a');
    assert.equal(select.value, 'a', '選択肢に在る値まで弾いている');
});

test('［人形の契約］setAttribute("value") が、range の丸めも通る', () => {
    const doc = fakeDocument();
    const slider = doc.createElement('input');
    slider.setAttribute('type', 'range');
    slider.setAttribute('min', '0');
    slider.setAttribute('max', '2');

    slider.setAttribute('value', '-0.7');
    assert.equal(slider.value, '0', '範囲外の値が setAttribute から素通りしている');
});

test('［人形の契約］id は、どちらの書き方でも両方の経路から見える', () => {
    // `I-20260831-53`: `getElementById` は `node.id`、`querySelector('#…')` は
    // `getAttribute('id')` を見ていて、**同じ要素を別々の経路で探していた**。
    const doc = fakeDocument();

    const byProperty = doc.createElement('div');
    byProperty.id = 'alpha';
    doc.body.append(byProperty);

    const byAttribute = doc.createElement('div');
    byAttribute.setAttribute('id', 'beta');
    doc.body.append(byAttribute);

    assert.equal(doc.getElementById('alpha'), byProperty, '.id = で付けた器が getElementById から見えない');
    assert.equal(doc.querySelector('#alpha'), byProperty, '.id = で付けた器が querySelector から見えない');
    assert.equal(doc.getElementById('beta'), byAttribute, 'setAttribute で付けた器が getElementById から見えない');
    assert.equal(doc.querySelector('#beta'), byAttribute, 'setAttribute で付けた器が querySelector から見えない');

    // 属性としても読める（本物と同じ写し）。
    assert.equal(byProperty.getAttribute('id'), 'alpha');
    assert.equal(byAttribute.id, 'beta');
});

/*
 * 3. `replaceChildren()` が、外した子の `parentNode` を切っていなかった
 *    （2026-09-01・走査16周目）。`remove()` は前から切っていたので、
 *    **片方だけ本物と違って**いた。`isConnected` は親を辿って本文に着くかを
 *    見るので、外れた要素が「画面に居る」と答え続ける。
 *
 *    実測（一覧を31回描き直した panel の釦）:
 *      人形が寛容なとき: 620個ぜんぶ live ← 溜まっていることが見えない
 *      本物と同じとき:   live 20 / dead 600
 */

test('［人形の契約］replaceChildren で外した子は、画面から居なくなる', () => {
    const doc = fakeDocument();
    const box = doc.createElement('div');
    doc.body.append(box);

    const first = doc.createElement('span');
    box.append(first);
    assert.equal(first.isConnected, true, '付けた子が画面に居ない（前提が崩れている）');

    const second = doc.createElement('span');
    box.replaceChildren(second);

    assert.equal(second.isConnected, true, '差し替えた子が画面に居ない');
    assert.equal(first.isConnected, false,
        '外した子が「画面に居る」と答えている＝本物より寛容'
        + ' — 外れた要素を捨てているかを測る検査が、この差の分だけ嘘になる');
    assert.equal(first.parentNode, null, '外した子が親を握ったままになっている');
});

test('［人形の契約］remove() も同じ（前から切れていた側）', () => {
    const doc = fakeDocument();
    const box = doc.createElement('div');
    doc.body.append(box);
    const child = doc.createElement('span');
    box.append(child);
    child.remove();
    assert.equal(child.isConnected, false);
    assert.equal(box.children.length, 0);
});
