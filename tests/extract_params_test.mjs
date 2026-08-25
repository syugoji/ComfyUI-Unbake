/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 出た絵から設定を読み取って、**開いている欄へ戻す**経路
 * （利用者の要望・2026-08-24。「新しい記録として増やす」ではなく「流し込む」を選んだ）。
 *
 * ここで押さえるのは、放っておくと**静かに壊れる**4つ:
 *
 *  1. **境界で形を揃えているか。** 記録の形のまま読むと `gen_params` が無く、
 *     直下の `positive` しか拾えないので **seed も steps も空**で戻る。
 *     同じ食い違いを既に4回踏んでいるので、**5回目をここで止める。**
 *  2. **空で上書きしないか。** 読めなかった項目まで書くと、
 *     「読めなかった」が「消してよい」に化けて、手で書いた本文が消える。
 *  3. **流し込んだ値が計画に届くか。** 欄へ代入するだけでは `changes` が動かず、
 *     **画面だけ変わって投入は古い値のまま**になる。
 *  4. **元画像には口を出さないか。** 元画像はいま開いている記録そのものなので、
 *     押しても何も変わらない口が1つ増えるだけになる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import {
    extractParamsFromBytes, fillableParams, paramsOf,
} from '../web/core/extractedParams.js';
import { createDetailView } from '../web/panel/detailView.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale } from '../web/i18n/index.js';

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/** 最小の PNG を組み立てる（tEXt チャンクを好きなだけ入れる）。 */
function makePng(textChunks = {}) {
    const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
    const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) >>> 0 : 0);
        return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 0;
    parts.push(chunk('IHDR', ihdr));
    for (const [key, value] of Object.entries(textChunks)) {
        parts.push(chunk('tEXt', Buffer.concat([
            Buffer.from(key, 'latin1'), Buffer.from([0]), Buffer.from(value, 'utf8'),
        ])));
    }
    parts.push(chunk('IEND', Buffer.alloc(0)));
    return Buffer.concat(parts);
}

/** ComfyUI 自身が焼くのは `prompt`（`comfy_prompt` ではない）。 */
const GRAPH = JSON.stringify({
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'anima.safetensors' } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: 'a fox in the snow' } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: 'blurry' } },
    4: { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1216, batch_size: 1 } },
    5: {
        class_type: 'KSampler',
        inputs: {
            seed: 12345, steps: 30, cfg: 5.5,
            sampler_name: 'euler_ancestral', scheduler: 'karras',
            positive: ['2', 0], negative: ['3', 0],
        },
    },
});

// --- 1. 境界で形が揃っているか ---------------------------------------------

test('出た絵から seed・steps・大きさまで取れる（記録の形のまま読むと空になる所）', () => {
    const result = extractParamsFromBytes(makePng({ prompt: GRAPH }), { kind: 'comfy_output' });
    assert.equal(result.ok, true, result.reason);
    // **ここが4回踏んだ食い違いの再発点。** `toRecipeShape()` を外すと
    // `gen_params` が無くなり、下の3行が undefined になる。
    assert.equal(result.params.seed, 12345, 'seed が取れていない（形を揃えていない）');
    assert.equal(result.params.steps, 30, 'steps が取れていない（形を揃えていない）');
    assert.equal(result.params.cfg_scale, 5.5, 'cfg が取れていない（記録は `cfg`、レシピは `cfg_scale`）');
    assert.equal(result.params.size, '832x1216', '大きさが組み立てられていない');
    assert.equal(result.params.prompt, 'a fox in the snow');
    assert.equal(result.params.sampler, 'euler_ancestral');
    // 抜き出した本体も返す（記録として保存し直したくなったときに取り直さない）。
    assert.ok(result.recipe?.gen_params, 'レシピの形を返していない');
});

test('読めない絵は、読めたふりをせずに理由を返す', () => {
    const result = extractParamsFromBytes(Buffer.from('not a png'), {});
    assert.equal(result.ok, false);
    assert.ok(result.reason, '理由が空（何が起きたか判らない）');
    assert.deepEqual(result.params, {});
});

test('読めたが設定を持たない絵は「読めた・0項目」で返る（成功と混ぜない）', () => {
    const result = extractParamsFromBytes(makePng({ prompt: '{}' }), {});
    // 読むこと自体は成功しているので `ok` は真。**流し込む物が在るかは別の数**で見る。
    assert.equal(Object.keys(result.params).length, 0, '空の絵から項目が生えている');
});

// --- 2. 空で上書きしないか ---------------------------------------------------

test('空・null は落とし、0 は残す', () => {
    const kept = fillableParams({
        prompt: '', negative_prompt: '   ', sampler: null, size: undefined,
        seed: 0, cfg_scale: 0, steps: 20,
    });
    assert.deepEqual(Object.keys(kept).sort(), ['cfg_scale', 'seed', 'steps']);
    // 0 を「空」と読むと、**seed 0 の絵から seed だけ戻らない**（一番気づきにくい形）。
    assert.equal(kept.seed, 0);
    assert.equal(kept.cfg_scale, 0);
});

test('paramsOf はレシピの形を優先し、無ければ記録の直下を読む', () => {
    assert.equal(paramsOf({ positive: 'y' }, { gen_params: { prompt: 'x' } }).prompt, 'x');
    assert.equal(paramsOf({ positive: 'y' }, null).prompt, 'y');
});

// --- 3・4. 面へ流し込むところ ------------------------------------------------

const RECORD = { id: 'a', libraryId: 'a', title: 'rec', previewUrl: '/unbake/record-preview?id=a' };
const OUTPUTS = [{ url: '/api/view?filename=new.png', differenceLabel: 'seed 2' }];

function open(options = {}) {
    setLocale('en');
    return createDetailView({
        documentRef: fakeDocument(), record: RECORD, outputs: OUTPUTS,
        recipe: { gen_params: { prompt: 'a cat', negative_prompt: 'blurry', seed: 7, steps: 20 } },
        ...options,
    });
}

test('流し込んだ値は欄だけでなく `changes` にも入る（計画へ届く）', () => {
    const view = open({ onExtractParams: async () => ({ ok: true, params: {} }) });
    const applied = view.applyParams({ seed: 12345, steps: 30 });
    assert.deepEqual(applied, { matched: 2, changed: 2 });
    // **`sync()` を通していないと、ここが空のまま**になる
    // ——画面には出ているのに、投入されるのは古い seed。
    assert.equal(view.changes.seed, '12345', '流し込んだ seed が計画に届いていない');
    assert.equal(view.changes.steps, '30');
});

test('取れなかった項目で欄を空にしない', () => {
    const view = open({ onExtractParams: async () => ({ ok: true, params: {} }) });
    const applied = view.applyParams({ seed: 999, prompt: '', sampler: null });
    assert.equal(applied.matched, 1, '空の項目まで数えている');
    // プロンプトは触っていないので `changes` に現れない（＝元の本文が残っている）。
    assert.equal(view.changes.prompt, undefined, '空で上書きして本文を消した');
});

test('同じ絵を2度読んでも「0項目」に見せない（matched と changed を分ける）', () => {
    const view = open({ onExtractParams: async () => ({ ok: true, params: {} }) });
    view.applyParams({ seed: 12345 });
    const again = view.applyParams({ seed: 12345 });
    assert.deepEqual(again, { matched: 1, changed: 0 }, '2度目が「何も無かった」になる');
});

test('読み取りの口は「出た絵」にだけ出る（元画像には出さない）', () => {
    const view = open({ onExtractParams: async () => ({ ok: true, params: {} }) });
    const button = view.root.byClass('unbake-detail-extract');
    assert.ok(button, '読み取りのボタンが無い');
    // 先頭は元画像。ここで押せると、押しても何も変わらない口になる。
    assert.equal(view.index, 0);
    assert.equal(button.style.display, 'none', '元画像でも押せてしまう');
    view.show(1);
    assert.equal(button.style.display, '', '出た絵で押せない');
});

test('口が渡されていなければ、ボタンは最初から出ない', () => {
    const view = open();
    view.show(1);
    assert.equal(view.root.byClass('unbake-detail-extract').style.display, 'none');
});

test('押すと読み取り、欄へ流し込み、件数を報せる', async () => {
    const seen = [];
    const view = open({
        onExtractParams: async (item) => {
            seen.push(item.url);
            return { ok: true, params: { seed: 4242, steps: 42 } };
        },
    });
    view.show(1);
    await view.root.byClass('unbake-detail-extract').dispatch('click', {});
    await settle();
    assert.deepEqual(seen, ['/api/view?filename=new.png'], '見ている絵を渡していない');
    assert.equal(view.changes.seed, '4242');
    const status = view.root.byClass('unbake-detail-status').text;
    assert.match(status, /2/, '流し込んだ件数を報せていない');
});

test('読めなかったときは、理由を出して欄を触らない', async () => {
    const view = open({ onExtractParams: async () => ({ ok: false, reason: 'no metadata' }) });
    view.show(1);
    await view.root.byClass('unbake-detail-extract').dispatch('click', {});
    await settle();
    assert.deepEqual(view.changes, {}, '読めていないのに欄を書き換えた');
    assert.match(view.root.byClass('unbake-detail-status').text, /no metadata/);
});

test('口が投げても面は死なず、理由が出る', async () => {
    const view = open({ onExtractParams: async () => { throw new Error('boom'); } });
    view.show(1);
    await view.root.byClass('unbake-detail-extract').dispatch('click', {});
    await settle();
    assert.match(view.root.byClass('unbake-detail-status').text, /boom/);
    // 押し直せること（投げたまま押せなくなると、直っても操作できない）。
    assert.equal(view.root.byClass('unbake-detail-extract').disabled, false);
});
