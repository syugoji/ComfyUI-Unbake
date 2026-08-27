/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **コードを読んで見つけた欠陥**（2026-08-26 / 利用者の指示による精査）。
 *
 * どれも「実装した」「検査が通った」の両方が真なのに動いていない形。
 * 機械の走査（矛盾の検出・変異検査）では出ず、**読んで初めて判った**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createUnbakePanel } from '../web/panel/panel.js';
import { createDetailView } from '../web/panel/detailView.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale, t } from '../web/i18n/index.js';

setLocale('ja');

// --- ① 取り込み直しで判定が更新されない -------------------------------------

test('取り込み直しでも、判定を掛け直す', async () => {
    /*
     * 同じ id をもう一度取り込むと、保存は `already saved` を返す。すると
     * 画面側の `saved` が 0 のままで、**読み直しが丸ごと飛ぶ**——読み直しが
     * 判定の控えを捨てているので、飛ぶと**古い判定が残ったまま**になり、
     * 「不足モデルが無い」と表示され続ける（利用者が最初に報告した形）。
     *
     * `verdictFor` はその対策として `unbake.js` に在ったが、**画面が受け取って
     * いなかった**——渡した側は直したつもりで、一度も呼ばれていなかった。
     */
    const asked = [];
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc,
        ingest: async () => ({ records: [{ id: 'x', libraryId: 'x', title: 'x' }], errors: [] }),
        recordsIo: {
            // **「もう在る」を返す**（取り込み直しで普通に起きる）。
            save: async () => ({ ok: false, error: 'already saved', id: 'x' }),
            reload: async () => { throw new Error('読み直しは走らないはず'); },
        },
        verdictFor: async (records) => { asked.push(records.map(r => r.id)); },
    });

    await panel.ingestRouted({ route: 'url', url: 'https://civitai.com/images/1' });
    assert.deepEqual(asked, [['x']],
        '取り込み直しで判定を掛け直していない（古い判定が残る）');
});

test('新しく保存できたときは、読み直しの方に任せる', async () => {
    // **二重に掛けない。** 読み直しが控えを捨てて掛け直すので、
    // ここで更に掛けると 350件ぶん余計に組み直すことになる。
    const asked = [];
    let reloaded = 0;
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc,
        ingest: async () => ({ records: [{ id: 'y', libraryId: 'y', title: 'y' }], errors: [] }),
        recordsIo: {
            save: async () => ({ ok: true, id: 'y' }),
            reload: async () => { reloaded += 1; return [{ id: 'y', libraryId: 'y', title: 'y' }]; },
        },
        verdictFor: async (records) => { asked.push(records.map(r => r.id)); },
    });

    await panel.ingestRouted({ route: 'url', url: 'https://civitai.com/images/2' });
    assert.equal(reloaded, 1, '保存できたのに読み直していない');
    assert.deepEqual(asked, [], '読み直しと二重に掛けている');
});

// --- ② 英語の文言で分類していた ---------------------------------------------

test('落とし込みの分類が、英語の文言に依らない', () => {
    // 元は `error` が `"already there"` で始まるかを見ていた。**文言を1文字
    // 変えるか訳した瞬間、件数が黙って「失敗」へ移る。**
    const source = readFileSync(new URL('../web/panel/panel.js', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('const runOne ='), source.indexOf('const worker ='));
    assert.ok(body.length > 200, '落とし込みの本文を読めていない');
    assert.doesNotMatch(body, /error\s*\|\|\s*''\)\.startsWith\(/,
        '応答の文言で分類している（種類＝code で見ること）');
    assert.match(body, /code\s*\|\|\s*''\)\s*===\s*'already'/, '種類で見ていない');
});

// --- ③ 取り出したのに画面へ出ない条件 ---------------------------------------

test('元の絵の条件（VAE・Hires・ADetailer・拡大器）が詳細に出る', () => {
    /*
     * `civitaiClient.js` のコメントは「画面は既に出す用意ができていた」と
     * 書いていたが、根拠にした `recipeReferenceInfo.js` は**孤児**。
     * つまり `vae` も `hires_*` も**記録には在るのに、どこにも出ていなかった**。
     */
    const doc = fakeDocument();
    const view = createDetailView({
        documentRef: doc,
        record: {
            id: '1', title: 'x',
            generation_metadata: { upscalers: ['DAT_x4.pth'] },
            gen_params: {
                prompt: 'a', vae: 'flux_ae.safetensors',
                hires_upscaler: 'R-ESRGAN', distilled_cfg_scale: '4.6',
                adetailer_model: 'face_yolov8n.pt',
            },
        },
    });
    const text = view.root.text;
    for (const needle of ['flux_ae.safetensors', 'R-ESRGAN', '4.6', 'face_yolov8n.pt', 'DAT_x4.pth']) {
        assert.ok(text.includes(needle), `詳細に出ていない: ${needle}`);
    }
    assert.ok(text.includes(t('detail.reference')), '見出しが出ていない');
});

test('条件が無い記録に、空の控えを出さない', () => {
    const doc = fakeDocument();
    const view = createDetailView({
        documentRef: doc,
        record: { id: '2', title: 'y', gen_params: { prompt: 'a' } },
    });
    assert.equal(view.root.byClass('unbake-detail-reference'), null,
        '中身が無いのに枠だけ出している');
});

// --- 土台のモデル名の食い違い（2026-08-26 実機）------------------------------

test('記録の baseModel（キャメル）を base_model へ揃える', async () => {
    /*
     * 記録は `baseModel`、レシピは `base_model` で持つ。組み立て側は
     * **スネークしか見ていない**ので、キャメルで持つ記録は系統が判らず、
     * UNet 構成にならない。
     *
     * 実機の `civitai_139981506` がこれだった。`anima_aestheticV11` を
     * `models/unet/` へ正しく落とし、ComfyUI の `UNETLoader` の一覧にも
     * 出ているのに、**`CheckpointLoaderSimple` の一覧を探しに行くので
     * 「未導入」のまま**——落としても永久に直らない形。
     */
    const { toRecipeShape } = await import('../web/core/recordShape.js');
    const shaped = toRecipeShape({
        id: '1', baseModel: 'Anima',
        checkpoint: 'anima_aestheticV11.safetensors', loras: [], seed: 1,
    });
    assert.equal(shaped.base_model, 'Anima', '系統が読めない（UNet 構成にならない）');
});

test('既に base_model を持つ記録を書き換えない', async () => {
    const { toRecipeShape } = await import('../web/core/recordShape.js');
    const shaped = toRecipeShape({
        id: '2', base_model: 'SDXL 1.0', baseModel: 'なにか別のもの',
        gen_params: { prompt: 'a' }, checkpoint: { file_name: 'x' },
    });
    assert.equal(shaped.base_model, 'SDXL 1.0', 'レシピ側の値を上書きしている');
});

test('系統が判れば UNet 構成で組む', async () => {
    // **これが要点。** 系統が読めれば `UNETLoader` を出し、
    // `models/unet` の一覧を探しに行く。
    const { toRecipeShape } = await import('../web/core/recordShape.js');
    const { buildRecipeWorkflow } = await import('../web/core/recipeWorkflowBuilder.js');
    const shaped = toRecipeShape({
        id: '3', baseModel: 'Anima', seed: 1, steps: 20, cfg: 5,
        width: 512, height: 512, positive: 'a', negative: '',
        checkpoint: 'anima_aestheticV11.safetensors', loras: [],
    });
    const built = buildRecipeWorkflow(shaped, { objectInfo: {}, embeddings: [] });
    const graph = built?.prompt || built?.workflow || built;
    const classes = Object.values(graph || {})
        .map(node => node?.class_type).filter(Boolean);
    assert.ok(classes.includes('UNETLoader'),
        `UNet 構成になっていない: ${classes.join(', ')}`);
});
