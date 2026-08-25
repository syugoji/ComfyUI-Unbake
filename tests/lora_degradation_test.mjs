/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 実機で報告された8巡目（2026-08-21）。
 *
 *   ㉔ テーマ・判定の色を変えても画面が変わらない
 *   ㉕ 説明文に `**` が見えている
 *   ㉖ 11件が「不足」だが、ある程度似た絵は出せるはず
 *
 * **㉖ が判定の誤り。** 組み立ての側は**手元に無い LoRA を鎖から外して組める**
 * （`dropUnavailableLoras`）のに、判定は checkpoint と同じ「致命」に積んでいた。
 * 外して出た絵は元と同じにはならないが、**似た絵は出る**——それが「近似」の意味。
 * 実データ346件で「不足」は **51 → 42** に減り、指摘の11件のうち9件が「近似」になった
 * （残る2件は**チェックポイントが無い**ので、似た絵も出ない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeRecipeReplayCapability } from '../web/core/recipeReplayCapability.js';
import { createUnbakePanel } from '../web/panel/panel.js';
import { createSettingsView } from '../web/panel/settingsView.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale } from '../web/i18n/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const OBJECT_INFO = {
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [['base.safetensors']] } } },
    LoraLoader: {
        input: {
            required: {
                model: ['MODEL'], clip: ['CLIP'],
                lora_name: [['installed.safetensors']],
                strength_model: ['FLOAT'], strength_clip: ['FLOAT'],
            },
        },
    },
    CLIPTextEncode: { input: { required: { text: ['STRING'], clip: ['CLIP'] } } },
    KSampler: { input: { required: {} } },
    EmptyLatentImage: { input: { required: {} } },
    VAEDecode: { input: { required: {} } },
    // **出力ノードだと名乗らせる。** 判定はここを見て「絵が出る経路」を辿る
    // ——`output_node` を落とすと「画像出力がありません」で全部が致命になる。
    SaveImage: { input: { required: {} }, output_node: true },
    PreviewImage: { input: { required: {} }, output_node: true },
};

const judge = (recipe) => analyzeRecipeReplayCapability(recipe, {
    objectInfo: OBJECT_INFO,
    knownModelCatalog: { models: [], installed: [], unavailable: 'test' },
    probeAvailability: false,
});

const baseRecipe = (extra = {}) => ({
    id: 'rec-1',
    title: 'Civitai_Recipe_1',
    checkpoint: { file_name: 'base.safetensors', name: 'Base', hash: 'abc' },
    // **絵の中身がプロンプトに書いてある。** LoRA を外しても真っ白にはならない。
    gen_params: {
        prompt: 'a girl standing in a sunlit room, detailed background',
        negative_prompt: 'low quality',
        seed: 1, steps: 20, cfg_scale: 7, sampler: 'euler', size: '832x1216',
    },
    loras: [],
    ...extra,
});

// --- ㉖ LoRA の欠品は「近似」 -------------------------------------------------

test('手元に無い LoRA は、致命ではなく近似にする', async () => {
    setLocale('ja');
    const capability = await judge(baseRecipe({
        loras: [{ file_name: 'gone.safetensors', name: 'Gone', modelVersionId: 111, inLibrary: false, strength: 0.8 }],
    }));
    // **外して組めるものは「不足」ではない。** 組み立ての側が鎖から外せる。
    assert.notEqual(capability.level, 'unavailable',
        `外せる LoRA で止めている: ${JSON.stringify(capability.reasons)}`);
    // **黙って外さない。** 何が抜けたかは理由に出る。
    assert.ok((capability.reasons || []).some(r => r.includes('Gone') || r.includes('gone')),
        `外したことを言っていない: ${JSON.stringify(capability.reasons)}`);
    // 落とす導線のために、不足そのものは残る。
    assert.ok((capability.missing?.resources || []).some(r => String(r.versionId) === '111'));
});

test('配布が終わった LoRA でも近似にする（外せることは変わらない）', async () => {
    setLocale('ja');
    const capability = await judge(baseRecipe({
        loras: [{ file_name: 'dead.safetensors', name: 'Dead', modelVersionId: 222, isDeleted: true, strength: 0.7 }],
    }));
    assert.notEqual(capability.level, 'unavailable');
});

test('チェックポイントが無ければ、今までどおり致命（土台が無い）', async () => {
    setLocale('ja');
    const capability = await judge(baseRecipe({
        checkpoint: { file_name: 'missing-base.safetensors', name: 'Missing', inLibrary: false },
    }));
    assert.equal(capability.level, 'unavailable',
        'チェックポイントが無いのに再現できることにしている');
});

test('プロンプトが LoRA タグだけなら、今も致命（外すと真っ白になる）', async () => {
    setLocale('ja');
    // **ここを緩めていないこと。** LoRA を外して似た絵が出るのは、
    // 絵の中身がプロンプトに書いてあるときだけ。
    const capability = await judge(baseRecipe({
        gen_params: { prompt: '<lora:gone:0.8>', seed: 1, steps: 20, cfg_scale: 7, sampler: 'euler' },
        loras: [{ file_name: 'gone.safetensors', name: 'Gone', inLibrary: false, strength: 0.8 }],
    }));
    assert.equal(capability.level, 'unavailable',
        'LoRA タグだけのプロンプトを通している（真っ白な絵が出る）');
});

test('グラフが指す未導入 LoRA も近似にする（鎖から外して組める）', async () => {
    setLocale('ja');
    const capability = await judge(baseRecipe({
        comfy_prompt: {
            1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'base.safetensors' } },
            2: {
                class_type: 'LoraLoader',
                inputs: {
                    model: [1, 0], clip: [1, 1], lora_name: 'not-installed.safetensors',
                    strength_model: 0.8, strength_clip: 0.8,
                },
            },
            3: { class_type: 'CLIPTextEncode', inputs: { text: 'a girl in a room', clip: [2, 1] } },
            4: { class_type: 'CLIPTextEncode', inputs: { text: 'low quality', clip: [2, 1] } },
            5: { class_type: 'EmptyLatentImage', inputs: {} },
            6: { class_type: 'KSampler', inputs: { model: [2, 0], positive: [3, 0], negative: [4, 0], latent_image: [5, 0] } },
            7: { class_type: 'VAEDecode', inputs: { samples: [6, 0], vae: [1, 2] } },
            8: { class_type: 'SaveImage', inputs: { images: [7, 0] } },
        },
    }));
    assert.notEqual(capability.level, 'unavailable',
        `外せる LoRA で止めている: ${JSON.stringify(capability.reasons)}`);
});

// --- ㉕ 画面に記法を出さない ---------------------------------------------------

test('文言に Markdown の強調が混ざっていない', async () => {
    // **`**太字**` は画面にそのまま出る。** 文言は素の字で書く
    // ——実測（2026-08-21）で12言語 39件が `**` を抱えたまま画面に出ていた。
    const dir = join(ROOT, 'web/i18n/locales');
    const offenders = [];
    for (const file of await readdir(dir)) {
        if (!file.endsWith('.js')) continue;
        const raw = await readFile(join(dir, file), 'utf8');
        for (const match of raw.matchAll(/^\s*"([^"]+)":\s*"(.*)",$/gm)) {
            if (/\*\*|__/.test(match[2])) offenders.push(`${file} / ${match[1]}`);
        }
    }
    assert.deepEqual(offenders, [], `画面へ記法が出る文言がある: ${offenders.slice(0, 3).join(' / ')}`);

    // **検出器が生きていること。** 見つからなければ緑、の形なので。
    assert.match('    "a.b": "これは**太字**です",', /^\s*"([^"]+)":\s*"(.*\*\*.*)",$/m);
});

// --- ㉔ 保存した設定が、その場で効く -------------------------------------------

test('テーマと判定の色は、保存した時点で画面へ効く', async () => {
    setLocale('en');
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), { documentRef: doc });
    // 既定は宿主に合わせる（2026-08-22 利用者の指示で `amber` から変えた）。
    assert.equal(panel.root.getAttribute('data-theme'), 'host');
    assert.equal(panel.root.getAttribute('data-palette'), 'default');

    // **面を作り直さずに当たること。** どちらも CSS なので属性の書き換えで足りる。
    panel.applyDisplay({ theme: 'paper', verdict_palette: 'deuteranopia' });
    assert.equal(panel.root.getAttribute('data-theme'), 'paper');
    assert.equal(panel.root.getAttribute('data-palette'), 'deuteranopia');

    // 知らない値は無視する（設定側が既定へ戻すので、画面が勝手に化けない）。
    panel.applyDisplay({ theme: 'nope' });
    assert.equal(panel.root.getAttribute('data-theme'), 'paper');
});

test('設定の面は、保存したことを呼び手へ伝える', async () => {
    setLocale('en');
    const doc = fakeDocument();
    const saved = [];
    const view = createSettingsView({
        documentRef: doc,
        read: async () => ({ settings: {} }),
        write: async (patch) => ({ settings: patch }),
        onSaved: (patch) => saved.push(patch),
    });
    await view.loaded;
    await view.save({ theme: 'moss' });
    assert.deepEqual(saved, [{ theme: 'moss' }],
        '保存しても呼び手へ伝えていない（画面が変わらない）');
});

test('タイルの大きさも、保存した時点で効く', () => {
    setLocale('en');
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc, display: { listView: 'tiles' },
    });
    panel.setRecords([{ id: 'a', libraryId: 'a', title: 'Civitai_Recipe_1', verdict: 'reproducible' }]);
    panel.applyDisplay({ tile_size: 2 });
    assert.equal(panel.root.byClass('unbake-tiles').getAttribute('data-size'), '2');
    assert.equal(panel.root.byClass('unbake-view-columns').value, '2');
});

test('言語を変えていない保存では、面を組み直さない', async () => {
    setLocale('en');
    const doc = fakeDocument();
    const rebuilds = [];
    const view = createSettingsView({
        documentRef: doc,
        read: async () => ({ settings: { language: 'ja', theme: 'amber' } }),
        write: async (patch) => ({ settings: patch }),
        onLanguageChange: (code) => rebuilds.push(code),
    });
    await view.loaded;

    // **保存はフォーム全体を送る**ので、言語は変えていなくても patch に入る。
    // それで組み直していたせいで、同じ保存で変えたテーマが元へ戻っていた
    // （実機で「テーマを変えても変化が無い」と言われたのがこれ）。
    await view.save({ language: 'ja', theme: 'moss' });
    assert.deepEqual(rebuilds, [], '言語が同じなのに組み直している');

    // 本当に変えたときは組み直す。
    await view.save({ language: 'en' });
    assert.deepEqual(rebuilds, ['en']);
});

// --- 同名が2箇所に在るものを「不足」と言わない（2026-08-23 利用者の報告）-----
//
// **実データで8件が該当した。** 同じファイルが下位フォルダと直下の両方に在ると、
// 「候補がちょうど1つ」の条件から外れて**不足**と出ていた——そして落とそうと
// すると「既にある」と言われる。押すたびに3つ目の複製を作りに行く形だった。
//
//   Illustrious\poses\finger_frame_il_d16.safetensors  ← 元から在る
//   finger_frame_il_d16.safetensors                     ← 直下（過去の取得が作った）
//
// 実測（2026-08-23・導入済み LoRA 490本）: 同名が複数在るのは 8件で、
// **利用者の「8 件は既存」と一致した。**

const DUPLICATED = {
    ...OBJECT_INFO,
    LoraLoader: {
        input: {
            required: {
                model: ['MODEL'], clip: ['CLIP'],
                lora_name: [[
                    'Illustrious\poses\dup.safetensors',
                    'dup.safetensors',
                    'installed.safetensors',
                ]],
                strength_model: ['FLOAT'], strength_clip: ['FLOAT'],
            },
        },
    },
};

test('同じ名前が2箇所に在るモデルを「不足」と言わない', async () => {
    setLocale('ja');
    const capability = await analyzeRecipeReplayCapability(
        baseRecipe({ loras: [{ file_name: 'dup.safetensors', name: 'Dup', strength: 0.8 }] }),
        { objectInfo: DUPLICATED, knownModelCatalog: { models: [], installed: [], unavailable: 'test' },
          probeAvailability: false });

    const missing = (capability.missing?.models || []).map(m => m.name);
    assert.deepEqual(missing.filter(n => String(n).includes('dup')), [],
        '同名が2箇所に在るだけで不足と言っている');
    assert.ok(!(capability.reasons || []).some(r => String(r).includes('dup.safetensors')),
        `不足として理由に出している: ${JSON.stringify(capability.reasons)}`);
});

test('本当に無いものは、今までどおり不足のまま', async () => {
    setLocale('ja');
    // **緩めすぎていないこと。** 同名が在るかどうかと、在るかどうかは別。
    const capability = await analyzeRecipeReplayCapability(
        baseRecipe({ loras: [{ file_name: 'nowhere.safetensors', name: 'Nowhere', modelVersionId: 9, strength: 0.8 }] }),
        { objectInfo: DUPLICATED, knownModelCatalog: { models: [], installed: [], unavailable: 'test' },
          probeAvailability: false });
    assert.ok((capability.reasons || []).some(r => String(r).toLowerCase().includes('nowhere')),
        '本当に無いものまで在ることにしている');
});

test('綴りが違っても、同名が2箇所に在るだけなら不足と言わない', async () => {
    setLocale('ja');
    // **効いているのは「茎」の経路。** 記録が拡張子なしで持っていると
    // 完全一致もファイル名一致も外れ、茎で2件当たって不足になっていた。
    for (const asked of ['dup', 'poses/dup.safetensors']) {
        const capability = await analyzeRecipeReplayCapability(
            baseRecipe({ loras: [{ file_name: asked, name: 'Dup', strength: 0.8 }] }),
            { objectInfo: DUPLICATED,
              knownModelCatalog: { models: [], installed: [], unavailable: 'test' },
              probeAvailability: false });
        assert.ok(!(capability.reasons || []).some(r => String(r).includes(asked)),
            `${asked}: 同名が2箇所に在るだけで不足と言っている`
            + ` — ${JSON.stringify(capability.reasons)}`);
    }
});

test('どれを使ったかは、同じ入力なら毎回同じ', async () => {
    setLocale('ja');
    // **決め打ちで再現できること。** 実行するたびに別のファイルを選ぶと、
    // 「昨日は出たのに今日は出ない」という一番読みにくい形で壊れる。
    const run = () => analyzeRecipeReplayCapability(
        baseRecipe({ loras: [{ file_name: 'dup', name: 'Dup', strength: 0.8 }] }),
        { objectInfo: DUPLICATED,
          knownModelCatalog: { models: [], installed: [], unavailable: 'test' },
          probeAvailability: false });
    const [a, b] = await Promise.all([run(), run()]);
    assert.deepEqual(a.reasons, b.reasons, '選び方が実行ごとに変わっている');
    assert.deepEqual(a.missing, b.missing);
});

// --- 台帳の「手元に無い」を、置き場と突き合わせる（2026-08-23 利用者の報告）---
//
// `inLibrary` は**上流の台帳が持つ印**で、ComfyUI に何が入っているかは見ていない。
// 台帳に無くても置き場には在る、が普通に起きる——実測で「不足」として並んだ8件は
// **全部ディスクに在り**、落とそうとすると「既にある」と言われていた。
// 押すたびに複製を作り、その複製が次は名前を曖昧にする、という悪循環だった。

/** 置き場の区切り。**字で書かない**——道具を通すと消えることがある。 */
const SEP = String.fromCharCode(92);

const WITH_EMBEDDINGS = {
    ...OBJECT_INFO,
    LoraLoader: {
        input: {
            required: {
                model: ['MODEL'], clip: ['CLIP'],
                lora_name: [['Illustrious' + SEP + 'poses' + SEP + 'onDisk.safetensors', 'installed.safetensors']],
                strength_model: ['FLOAT'], strength_clip: ['FLOAT'],
            },
        },
    },
};

const judgeWith = (recipe, embeddings = []) => analyzeRecipeReplayCapability(recipe, {
    objectInfo: WITH_EMBEDDINGS,
    embeddings,
    knownModelCatalog: { models: [], installed: [], unavailable: 'test' },
    probeAvailability: false,
});

test('台帳が「手元に無い」と言っても、置き場に在れば不足にしない', async () => {
    setLocale('ja');
    const capability = await judgeWith(baseRecipe({
        // 記録は平たい名前で持つ。置き場では下位フォルダに在る。
        loras: [{ file_name: 'onDisk.safetensors', name: 'OnDisk', modelVersionId: 55,
                  inLibrary: false, strength: 0.8 }],
    }));
    assert.deepEqual((capability.missing?.resources || []).map(r => r.name), [],
        'ディスクに在るものを不足として並べている（押すたびに複製を作る）');
});

test('埋め込みは別の置き場に居る（そこも見る）', async () => {
    setLocale('ja');
    // **種別は当てにならない。** 実データの `NEGATIVE_HANDS.safetensors` は
    // 埋め込みとして在るのに、記録の側に種別が無く LoRA としてしか探して
    // いなかったので「不足」のまま残った。置き場を問わず探す。
    //
    // 置き場の一覧は**拡張子を持たない**（`/api/embeddings` の実測）。
    const capability = await judgeWith(baseRecipe({
        loras: [{ file_name: 'NEG_HANDS.safetensors', name: 'Neg', modelVersionId: 66,
                  inLibrary: false, strength: 0.8 }],
    }), ['NEG_HANDS', 'Pony' + SEP + 'concept' + SEP + 'NEG_HANDS']);
    assert.deepEqual((capability.missing?.resources || []).map(r => r.name), [],
        '埋め込みの置き場を見ていない');
});

test('本当に無いものは、今までどおり不足に並ぶ', async () => {
    setLocale('ja');
    // **緩めすぎていないこと。** 置き場を見るようにしたぶん、ここが要る。
    const capability = await judgeWith(baseRecipe({
        loras: [{ file_name: 'definitely_not_here_xyz.safetensors', name: 'Gone',
                  modelVersionId: 77, inLibrary: false, strength: 0.8 }],
    }));
    assert.deepEqual((capability.missing?.resources || []).map(r => r.name),
        ['definitely_not_here_xyz.safetensors'], '本当に無いものまで在ることにしている');
});
