/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * **走査14周目（2026-09-01）で見つけた、画面側の4件。**
 *
 * どれも「押した人には成功に見えるが、最後の一歩が起きていない」形である。
 *
 *   ①（詳細）計画の失敗を消す印が、**立てる場所が無くて生涯 false** だった
 *   ②（Sweep）見本を当てる行が **scope に無い名前**を引いていて毎回投げていた
 *   ③（Sweep）見本の待ち行列を**捌き直す所が無く**、13件目から先が居座っていた
 *   ④（Sweep）「足す」が**基準と同じ値でも押せて**、押しても何も起きなかった
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDetailView } from '../web/panel/detailView.js';
import { createSweepView } from '../web/panel/sweepView.js';
import { installEnvironment } from '../web/core/environment.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale } from '../web/i18n/index.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- ① 詳細: 直したのに「多すぎる」が消えない ------------------------------

function detailWithCounts() {
    const doc = fakeDocument();
    const view = createDetailView({
        documentRef: doc,
        record: { id: 'r1', previewUrl: '/p.png', gen_params: { steps: 20, cfg_scale: 7, seed: 1 } },
        onRun: async () => ({ ok: true, outputs: [] }),
    });
    return {
        view,
        status: view.root.byClass('unbake-detail-status'),
        run: view.root.byClass('unbake-detail-run'),
        counts: view.root.allByClass('unbake-detail-count'),
    };
}

test('上限を超えた後で減らしたら、「多すぎる」の文言が消える', () => {
    setLocale('en');
    const { status, run, counts } = detailWithCounts();
    // seed 8本 × steps 8本 = 64（上限は24）。
    counts[0].value = '8'; counts[0].dispatch('input');
    counts[1].value = '8'; counts[1].dispatch('input');
    assert.match(status.textContent, /64/, '上限超えの理由が出ていない');
    assert.equal(run.disabled, true);

    // 直す（8枚＝上限内）。
    counts[1].value = '1'; counts[1].dispatch('input');
    assert.equal(run.disabled, false, '直したのに押せないままになっている');
    assert.equal(
        status.textContent, '',
        `直したのに叱られ続けている: ${JSON.stringify(status.textContent)}`
        + ` — ボタンは ${JSON.stringify(run.textContent)} と言っている`,
    );
});

test('[対照] 上限を超えている間は、理由を消さない', () => {
    setLocale('en');
    const { status, counts } = detailWithCounts();
    counts[0].value = '8'; counts[0].dispatch('input');
    counts[1].value = '8'; counts[1].dispatch('input');
    // まだ足りない（8 × 4 = 32 > 24）。
    counts[1].value = '4'; counts[1].dispatch('input');
    assert.match(status.textContent, /32/, '減らした後の枚数で言い直していない');
});

test('[対照] 計画の失敗でない文言（保存の結果など）は消さない', async () => {
    setLocale('en');
    const { view, status, counts } = detailWithCounts();
    // 出して保存する経路を通さずに、面の外から同じ位置へ書く場面を作る。
    // ここでは「取り出し」の結果が入っている状態を模す。
    status.textContent = 'kept 3 images';
    // 触っても消えない（印が立っていないので）。
    counts[0].value = '2'; counts[0].dispatch('input');
    assert.equal(status.textContent, 'kept 3 images', '関係のない結果まで消している');
    view.destroy();
});

// --- ②③ Sweep: 見本の取り直し ----------------------------------------------

const OBJECT_INFO = (count) => ({
    LoraLoader: {
        input: {
            required: {
                lora_name: [[
                    'charA.safetensors',
                    ...Array.from({ length: count }, (_, i) => `alt${String(i).padStart(2, '0')}.safetensors`),
                ]],
            },
        },
    },
});

const RECIPE = {
    id: 'rec-1', title: 'T', checkpoint: { file_name: 'base.safetensors' },
    comfy_prompt: { 1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'base.safetensors' } } },
    gen_params: { prompt: 'a', seed: 12, steps: 20, cfg_scale: 7, sampler: 'euler' },
    loras: [{ file_name: 'charA.safetensors', name: 'A', modelVersionId: 111, strength: 0.8 }],
};

/** 差し替えの軸を開いた Sweep の面。**見本の器が並んだ状態**で返す。 */
function mountSwapPicker(alternates) {
    const doc = fakeDocument();
    const view = createSweepView({
        documentRef: doc,
        record: { id: 'rec-1', recipe: RECIPE, displayName: 'x' },
        runner: { objectInfo: OBJECT_INFO(alternates) },
    });
    const select = view.root.byClass('unbake-sweep-template');
    const swap = [...select.children].find(option => /^Swap/i.test(option.textContent || ''));
    assert.ok(swap, '差し替えの雛形が出ていない（この検査の前提が崩れている）');
    select.value = swap.getAttribute('value');
    select.dispatch('change');
    return { view, cards: view.root.allByClass('unbake-sweep-pick') };
}

test('見本が取れたら、その絵を描き直す（投げて終わらない）', async () => {
    setLocale('en');
    const posted = [];
    installEnvironment({
        request: async (url, init) => {
            const body = JSON.parse(init.body);
            posted.push(body.names);
            return { json: async () => ({ items: body.names.map(name => ({ name, ok: true })) }) };
        },
    });
    const { view, cards } = mountSwapPicker(1);
    const card = cards.find(item => item.getAttribute('data-baseline') === 'false');
    const image = card.byClass('unbake-sweep-pick-image');
    const before = image.getAttribute('src');

    const rejections = [];
    const onReject = (error) => rejections.push(error);
    process.on('unhandledRejection', onReject);
    image.dispatch('error');
    await sleep(700);
    process.off('unhandledRejection', onReject);

    assert.deepEqual(rejections.map(error => error?.message), [],
        '返事を絵へ当てる所で投げている（問い合わせは通っているのに見本が出ない）');
    assert.equal(posted.length, 1, '取りに行っていない');
    assert.notEqual(image.getAttribute('src'), before, '取れたのに絵を描き直していない');
    view.destroy();
});

test('13件目から先も取りに行く（待ち行列を捌き直す）', async () => {
    setLocale('en');
    const posted = [];
    installEnvironment({
        request: async (url, init) => {
            const body = JSON.parse(init.body);
            posted.push(body.names.length);
            return { json: async () => ({ items: body.names.map(name => ({ name, ok: true })) }) };
        },
    });
    // 基準1つ ＋ 差し替え候補20件。
    const { view, cards } = mountSwapPicker(20);
    const others = cards.filter(item => item.getAttribute('data-baseline') === 'false');
    assert.equal(others.length, 20, '候補が20件並んでいない（前提が崩れている）');
    for (const item of others) item.byClass('unbake-sweep-pick-image').dispatch('error');

    await sleep(1500);
    assert.deepEqual(posted, [12, 8],
        `12件ずつ捌けていない（送った束: ${JSON.stringify(posted)}）`
        + ' — 1束で止まると、13件目から先は二度と取りに行かれない');
    view.destroy();
});

test('上限に当たったぶんは、待ってから取り直す', async () => {
    setLocale('en');
    const posted = [];
    installEnvironment({
        request: async (url, init) => {
            const body = JSON.parse(init.body);
            posted.push([...body.names]);
            // 1回目だけ「待て」と返す。
            const limited = posted.length === 1;
            return {
                json: async () => ({
                    items: body.names.map(name => (limited
                        ? { name, ok: false, rateLimited: true, retryAfter: 0.4 }
                        : { name, ok: true })),
                }),
            };
        },
    });
    const { view, cards } = mountSwapPicker(2);
    const others = cards.filter(item => item.getAttribute('data-baseline') === 'false');
    for (const item of others) item.byClass('unbake-sweep-pick-image').dispatch('error');

    await sleep(1600);
    assert.equal(posted.length, 2,
        '上限で戻した名前を誰も捌いていない（戻す側だけ在って、捌く側が無い）');
    assert.deepEqual(posted[1].sort(), posted[0].sort(), '戻したのと違う名前を取りに行っている');
    view.destroy();
});

test('面を閉じたら、待ち行列も止まる', async () => {
    setLocale('en');
    const posted = [];
    installEnvironment({
        request: async (url, init) => {
            posted.push(JSON.parse(init.body).names.length);
            return { json: async () => ({ items: [] }) };
        },
    });
    const { view, cards } = mountSwapPicker(20);
    for (const item of cards) item.byClass('unbake-sweep-pick-image').dispatch('error');
    view.destroy();
    await sleep(900);
    assert.deepEqual(posted, [], '閉じた面が取りに行き続けている');
});

// --- ④ Sweep: 基準と同じ値なのに「足す」が押せる ---------------------------

/** 強度の軸（スライダー）を開いた Sweep の面。 */
function mountStrengthPicker() {
    const doc = fakeDocument();
    const view = createSweepView({
        documentRef: doc,
        record: { id: 'rec-1', recipe: RECIPE, displayName: 'x' },
        runner: { objectInfo: {} },
    });
    const select = view.root.byClass('unbake-sweep-template');
    const strength = [...select.children].find(o => /^LoRA strength \(/.test(o.textContent || ''));
    assert.ok(strength, '強度の雛形が出ていない（この検査の前提が崩れている）');
    select.value = strength.getAttribute('value');
    select.dispatch('change');
    return {
        view,
        slider: view.root.byClass('unbake-sweep-slider'),
        add: view.root.byClass('unbake-sweep-add'),
        chips: () => view.root.allByClass('unbake-sweep-chip').length,
    };
}

test('基準と同じ値のときは「足す」を押せない（押しても何も起きない口を作らない）', () => {
    setLocale('en');
    const { view, slider, add, chips } = mountStrengthPicker();
    // 開いた直後。`syncButtons()` がここまでに走っている。
    assert.equal(slider.value, '0.8', '基準が入っていない（前提が崩れている）');
    const before = chips();
    assert.equal(add.disabled, true,
        '基準と同じ値なのに押せる — 押しても増えない口が開いた瞬間から出ている');
    add.dispatch('click');
    assert.equal(chips(), before, '押して何も起きないことの裏取り');
    view.destroy();
});

test('[対照] 基準から動かせば「足す」は押せて、実際に増える', () => {
    setLocale('en');
    const { view, slider, add, chips } = mountStrengthPicker();
    const before = chips();
    slider.value = '1.2';
    slider.dispatch('input');
    assert.equal(add.disabled, false, '動かしたのに押せない');
    add.dispatch('click');
    assert.equal(chips(), before + 1, '押したのに増えていない');
    // 足した後は同じ値をもう一度足せない。
    assert.equal(add.disabled, true, '同じ値を2回足せてしまう');
    view.destroy();
});
