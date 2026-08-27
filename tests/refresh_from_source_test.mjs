/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **出典から読み直す**（2026-08-26 利用者の指示・実機検証で必要になった）。
 *
 * 古い記録は `checkpoint` が名前だけで版IDを持たない。**版IDが無いと落とせない**
 * ので、実機では 44件が「落とせません」で止まっていた。出典の URL は記録が
 * 持っているので、そこから読み直せば付く。
 *
 * あわせて、取り込み直後の記録が判定を貰えなかった件も固定する——判定表は
 * `libraryId` を持つ記録しか見ないのに、取り込み直後は `id` しか無かった。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUnbakePanel } from '../web/panel/panel.js';
import { createSettingsView } from '../web/panel/settingsView.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale, t } from '../web/i18n/index.js';

setLocale('ja');

test('取り込んだ記録に書庫の id が付く（付かないと判定が計算されない）', async () => {
    // **判定表は `libraryId` を持つ記録しか見ない**（`run()` が絞り、
    // `loadRecord` も無ければ読まない）。取り込み直後は `id` しか無いので、
    // ここで付けないと**判定が一度も計算されないまま**「再現不可」で止まる
    // ——実機の `civitai_139981506` がまさにこれだった。
    const seen = [];
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc,
        ingest: async () => ({ records: [{ id: '139981506', title: 'x' }], errors: [] }),
        recordsIo: { save: async () => ({ ok: true, id: '139981506' }),
                     reload: async () => [] },
        verdictFor: async (records) => { seen.push(...records); },
    });
    await panel.ingestRouted({ route: 'civitai', imageId: '139981506' });
    const stored = panel.getRecords()[0];
    assert.equal(stored?.libraryId, '139981506',
        '書庫の id が付いていない（判定が永久に計算されない）');
});

test('置き換えたときも、書庫の id が付く', async () => {
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc,
        ingest: async () => ({ records: [{ id: '1', title: 'x' }], errors: [] }),
        recordsIo: {
            save: async (record, options) => (options?.replace
                ? { ok: true, id: '1', replaced: true }
                : { ok: false, error: 'already saved', id: '1' }),
            reload: async () => [],
        },
        verdictFor: async () => {},
    });
    await panel.ingestRouted({ route: 'civitai', imageId: '1' });
    assert.equal(panel.getRecords()[0]?.libraryId, '1');
});

// --- 設定のボタン -----------------------------------------------------------

test('口が渡っていなければ、押せないボタンを出さない', () => {
    const doc = fakeDocument();
    const view = createSettingsView({
        documentRef: doc, read: async () => ({}), write: async () => ({ ok: true }),
    });
    assert.equal(view.root.text.includes(t('settings.refreshFromSource')), false,
        '押しても何も起きないボタンを出している');
});

test('押すと読み直し、件数を出す', async () => {
    const doc = fakeDocument();
    let called = 0;
    const view = createSettingsView({
        documentRef: doc, read: async () => ({}), write: async () => ({ ok: true }),
        refreshFromSource: async ({ onProgress }) => {
            called += 1;
            onProgress?.({ at: 1, total: 2 });
            return { total: 2, refreshed: 1, skipped: 1, failed: 0 };
        },
    });
    const button = view.root.findAll(node => node.textContent === t('settings.refreshFromSource'))[0];
    assert.ok(button, '読み直しのボタンが無い');
    await button.dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(called, 1);
    // **何も起きなかったことも言う。** 黙ると押せていないのか判らない。
    assert.match(view.root.text, /読み直し 1 件/, `結果が出ていない: ${view.root.text.slice(-200)}`);
});

test('止める口が在り、始めるまでは押せない', () => {
    const doc = fakeDocument();
    const view = createSettingsView({
        documentRef: doc, read: async () => ({}), write: async () => ({ ok: true }),
        refreshFromSource: async () => ({ total: 0, refreshed: 0, skipped: 0, failed: 0 }),
    });
    const stop = view.root.findAll(
        node => node.textContent === t('settings.refreshFromSource.stop'))[0];
    assert.ok(stop, '止める口が無い（始めたら終わるまで待つしかない）');
    assert.equal(stop.disabled, true, '走っていないのに押せる');
});

// --- 出典が空を返したとき（2026-08-26 実機）--------------------------------

import { hasVersionEvidence } from '../web/core/recordShape.js';

test('版IDも hash も無ければ、書く価値のある結果ではない', () => {
    /*
     * **実機で 9件が空で塗り潰された。** Civitai は画像そのものは返すが
     * `meta` を持たないことがあり（実測 345件中 9件）、その空を
     * `replace: true` で書いていた——チェックポイントも LoRA も生成条件も
     * 消え、「落とせば試せる」に出ていたものが一覧から消えた。
     *
     * 読み直す前の問い（「もう版IDが在るなら読み直さない」）と、
     * **書く前の問い**（「読み直しても版IDが取れないなら書かない」）は
     * 同じ判断で、後者だけが無かった。
     */
    // 実物の形（`53290457` を読み直した結果）。
    const empty = { checkpoint: null, loras: [], embeddings: [],
                    gen_params: { prompt: '', seed: null } };
    assert.equal(hasVersionEvidence(empty), false, '空を「書く価値がある」と言っている');
});

test('版IDか hash が1つでもあれば、書く価値がある', () => {
    assert.equal(hasVersionEvidence({ checkpoint: { modelVersionId: 3072332 } }), true);
    assert.equal(hasVersionEvidence({ checkpoint: { hash: 'EB4DD8C612' } }), true);
    assert.equal(hasVersionEvidence({ checkpoint: null, loras: [{ modelVersionId: 1 }] }), true);
    assert.equal(hasVersionEvidence({ embeddings: [{ lookupSha256: 'ab' }] }), true);
});

test('名前しか無い記録は、まだ書く価値が無い', () => {
    // **これが読み直しの対象。** 名前だけでは落とす先が決まらない。
    assert.equal(hasVersionEvidence({ checkpoint: { file_name: 'x.safetensors' }, loras: [] }), false);
});

test('形が壊れていても落ちない', () => {
    for (const bad of [null, undefined, {}, { loras: null }, { checkpoint: 'name' }]) {
        assert.equal(hasVersionEvidence(bad), false, JSON.stringify(bad));
    }
});

test('結果の文言に「出典に情報が無かった」が在る', () => {
    // **黙って飛ばさない。** 9件が空だったことは、押した人が知るべき事実。
    const said = t('settings.refreshFromSource.done',
                   { refreshed: 1, skipped: 2, empty: 9, failed: 0 });
    assert.match(said, /9/, `空の件数を出していない: ${said}`);
    assert.doesNotMatch(said, /\{empty\}/, '差し込めていない');
});
