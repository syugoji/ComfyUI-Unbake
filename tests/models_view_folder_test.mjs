/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **チェックポイントは `checkpoints` に在るとは限らない**（2026-08-26 実機）。
 *
 * Anima / Krea 2 / Z-Image のように **UNet 単体で配られる**モデルは
 * `models/diffusion_models` に入る。使用モデルの面は `checkpoints` 決め打ちで
 * 引いていたので、実在する 13.1 GB の `krea2Turbo_v10.safetensors` に対して
 * **「この環境には入っていません」**と出ていた——在る物を無いと言い、
 * 消す口も押せないままになる。
 *
 * 実測（`/unbake/model-delete-plan`）:
 *   kind=checkpoints      → state: none（見つからない）
 *   kind=diffusion_models → ok: true, matches: [Krea 2\\base model\\krea2Turbo_v10.safetensors]
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModelsView, modelsOf } from '../web/panel/modelsView.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale } from '../web/i18n/index.js';

setLocale('ja');

const record = { id: '1', libraryId: '1', title: 'civitai_139164303' };
const recipe = {
    checkpoint: { file_name: 'krea2Turbo_v10.safetensors' },
    loras: [{ file_name: 'style.safetensors' }],
};

/** `checkpoints` では見つからず、`diffusion_models` でだけ見つかる宿主。 */
function hostWhereCheckpointLivesInDiffusionModels() {
    const asked = [];
    return {
        asked,
        io: {
            plan: async (kind, name) => {
                asked.push(`${kind}:${name}`);
                if (kind === 'diffusion_models' && name === 'krea2Turbo_v10.safetensors') {
                    return { ok: true, state: 'one', bytes: 13_100_000_000,
                             files: ['a'], matches: ['Krea 2/base model/krea2Turbo_v10.safetensors'],
                             usage: { count: 2 } };
                }
                if (kind === 'loras') {
                    return { ok: true, state: 'one', bytes: 1, files: ['b'], usage: { count: 1 } };
                }
                return { ok: false, state: 'none', matches: [], bytes: 0, usage: { count: 0 } };
            },
            usage: async () => ({ ok: true, count: 0 }),
            remove: async () => ({ ok: true }),
        },
    };
}

function mount(host) {
    const doc = fakeDocument();
    return createModelsView({
        documentRef: doc, record, recipe, io: host.io,
        onClose: () => {}, onDelete: () => {},
    });
}

test('引き直す置き場を持っている', () => {
    const entries = modelsOf(record, recipe);
    const checkpoint = entries.find(item => item.role === 'checkpoint');
    assert.ok(checkpoint, 'チェックポイントの行が無い');
    assert.equal(checkpoint.kind, 'checkpoints', '最初に引く置き場が違う');
    assert.ok((checkpoint.altKinds || []).includes('diffusion_models'),
        `UNet 単体の置き場を候補に持っていない: ${JSON.stringify(checkpoint.altKinds)}`);
    // **LoRA は引き直さない。** 置き場は1つしかない。
    const lora = entries.find(item => item.role === 'lora');
    assert.deepEqual(lora.altKinds || [], [], 'LoRA まで引き直そうとしている');
});

test('checkpoints で外れたら diffusion_models で引き直す', async () => {
    const host = hostWhereCheckpointLivesInDiffusionModels();
    const view = mount(host);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.ok(host.asked.includes('checkpoints:krea2Turbo_v10.safetensors'), '最初の置き場を引いていない');
    assert.ok(host.asked.includes('diffusion_models:krea2Turbo_v10.safetensors'),
        `引き直していない: ${host.asked.join(' / ')}`);
    assert.doesNotMatch(view.root.text, /この環境には入っていません/,
        `在る物を無いと言っている: ${view.root.text.slice(0, 200)}`);
    assert.match(view.root.text, /13\.1 GB|12\.2 GB/, `大きさが出ていない: ${view.root.text.slice(0, 200)}`);
});

test('当たった置き場を覚える（消すときも同じ所を向く）', async () => {
    /*
     * **引き直した先で消す。** 覚えないと、消す段でまた外れた置き場を叩き、
     * 「入っているのに消せない」になる。
     */
    const host = hostWhereCheckpointLivesInDiffusionModels();
    const doc = fakeDocument();
    const asked = [];
    const view = createModelsView({
        documentRef: doc, record, recipe, io: host.io,
        onClose: () => {},
        onDelete: (entry) => { asked.push(entry.kind); },
    });
    await new Promise(resolve => setTimeout(resolve, 60));
    const button = view.root.findAll(node => node.textContent === '消す' && !node.disabled)[0];
    assert.ok(button, `押せる「消す」が無い: ${view.root.text.slice(0, 200)}`);
    await button.dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(asked.includes('diffusion_models'),
        `外れた置き場のまま消そうとしている: ${asked.join(' / ')}`);
});

test('どこにも無ければ、今までどおり「入っていません」', async () => {
    // **全部を当たりにしない。** 本当に無いときは無いと言う。
    const doc = fakeDocument();
    const view = createModelsView({
        documentRef: doc, record, recipe,
        io: {
            plan: async () => ({ ok: false, state: 'none', matches: [], bytes: 0, usage: { count: 0 } }),
            usage: async () => ({ ok: true, count: 0 }),
            remove: async () => ({ ok: true }),
        },
        onClose: () => {}, onDelete: () => {},
    });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.match(view.root.text, /この環境には入っていません/, '無いのに無いと言っていない');
});
