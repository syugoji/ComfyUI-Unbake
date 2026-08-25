/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 工程2 — **バリアントを差分で見せる**（裁定③）ための土台。
 *
 * ここで固定するのは4つ。
 *
 *  1. **抽出器は1本。** 記録から作った条件と、画像から作った条件が同じ形になること
 *  2. **刻印 > 指紋。** 印が在るときは指紋を使わない（証拠の強さを混ぜない）
 *  3. **「持っていない」を「違う」と数えない。** 空欄は未知として飛ばす
 *  4. **同点なら帰属しない。** どれか1つを選ぶと、理由が無いのに断定することになる
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    conditionsFromPrompt, conditionsFromRecord, describeDifference,
    FINGERPRINT_BLIND_SPOTS, FINGERPRINT_FIELDS, fingerprintOf, normalizeModelName,
} from '../web/core/outputFingerprint.js';
import {
    attributeOutput, attributeOutputs, indexRecords, MATCH_KEYS, MIN_AGREEMENT, stampedRecordId,
} from '../web/core/outputAttribution.js';
import { CATALOGS, DEFAULT_LOCALE, setLocale } from '../web/i18n/index.js';

/** 実行された API グラフの最小形。 */
const graph = ({ ckpt = 'base.safetensors', lora = 'charA.safetensors', steps = 20,
    cfg = 7, sampler = 'dpmpp_2m', scheduler = 'karras', seed = 42,
    positive = 'a girl', negative = 'bad hands', width = 1024, height = 1024 } = {}) => ({
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
    2: { class_type: 'LoraLoader', inputs: { lora_name: lora, strength_model: 0.8, model: [1, 0] } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: [2, 1] } },
    4: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: [2, 1] } },
    5: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    6: {
        class_type: 'KSampler',
        inputs: {
            seed, steps, cfg, sampler_name: sampler, scheduler, denoise: 1,
            model: [2, 0], positive: [3, 0], negative: [4, 0], latent_image: [5, 0],
        },
    },
});

const record = (overrides = {}) => ({
    id: 'rec-a',
    checkpoint: { file_name: 'base.safetensors' },
    loras: [{ file_name: 'charA.safetensors', strength_model: 0.8 }],
    gen_params: {
        prompt: 'a girl', negative_prompt: 'bad hands', seed: 42,
        steps: 20, cfg_scale: 7, sampler: 'DPM++ 2M Karras', size: '1024x1024',
    },
    ...overrides,
});

// --- 1. 抽出器は1本 --------------------------------------------------------

test('記録から作った条件と、画像から作った条件が同じ形になる', () => {
    const fromImage = conditionsFromPrompt(JSON.stringify(graph()));
    const fromRecord = conditionsFromRecord(record());
    assert.ok(fromImage && fromRecord);
    for (const field of FINGERPRINT_FIELDS) {
        assert.equal(
            JSON.stringify(fromImage[field.key]), JSON.stringify(fromRecord[field.key]),
            `${field.key} が食い違う: 画像=${JSON.stringify(fromImage[field.key])} / 記録=${JSON.stringify(fromRecord[field.key])}`,
        );
    }
    assert.equal(fingerprintOf(fromImage), fingerprintOf(fromRecord));
});

test('サンプラーの表記の違いを、対象の違いと取り違えない', () => {
    // 記録は A1111 の表記、画像は ComfyUI の内部名。素朴に比べると
    // 実データで一致率 16.0% しか出ない——**測り方の違いを対象の違いと読む。**
    const fromRecord = conditionsFromRecord(record());
    assert.equal(fromRecord.sampler, 'dpmpp_2m');
    assert.equal(conditionsFromPrompt(JSON.stringify(graph())).sampler, 'dpmpp_2m');
});

test('寸法は記録の size からも読む（width/height だけを見ない）', () => {
    // 実データ346件のうち `size` を持つのは241件、`width` は0件。
    // `width` だけ見ていたので寸法の一致率は **0.0%** だった。
    assert.equal(conditionsFromRecord(record()).size, '1024x1024');
    assert.equal(conditionsFromRecord(record({
        gen_params: { ...record().gen_params, size: '848 × 1232' },
    })).size, '848x1232');
});

test('モデル名はフォルダと拡張子を落として比べる', () => {
    assert.equal(normalizeModelName('Illustrious\\anime\\Foo_v1.safetensors'), 'foo_v1');
    assert.equal(normalizeModelName('foo_v1'), 'foo_v1');
    assert.equal(normalizeModelName(''), '');
});

test('LoRA の並び順で指紋が変わらない', () => {
    const a = conditionsFromRecord(record({
        loras: [{ file_name: 'b.safetensors' }, { file_name: 'a.safetensors' }],
    }));
    const b = conditionsFromRecord(record({
        loras: [{ file_name: 'a.safetensors' }, { file_name: 'b.safetensors' }],
    }));
    assert.equal(fingerprintOf(a), fingerprintOf(b));
});

test('読めないものから空の条件を作らない', () => {
    // 空を返すと「条件が同じ」に見えて、全部が同じ絵として畳まれる。
    assert.equal(conditionsFromPrompt(''), null);
    assert.equal(conditionsFromPrompt('not json'), null);
    assert.equal(conditionsFromPrompt('{}'), null);
    assert.equal(conditionsFromRecord(null), null);
});

// --- 2. 刻印 > 指紋 --------------------------------------------------------

test('印が在るときは指紋を使わない', () => {
    const indexed = indexRecords([record()]);
    const stamped = attributeOutput({
        raw: {
            prompt: JSON.stringify(graph({ ckpt: 'totally-different.safetensors' })),
            unbake_sweep: JSON.stringify({ schema: 'unbake.sweep', record_id: 'rec-stamped' }),
        },
    }, indexed);
    assert.equal(stamped.evidence, 'stamped');
    assert.equal(stamped.recordId, 'rec-stamped', '印より指紋を優先している');
});

test('印の鍵の名前が3つとも違っても読める', () => {
    // JS は `unbake_sweep` / `record_id`、フォークは `lora_manager_recipe` / `recipe_id`。
    assert.equal(stampedRecordId({
        unbake_sweep: JSON.stringify({ schema: 'unbake.sweep', record_id: 'A' }),
    }), 'A');
    assert.equal(stampedRecordId({
        lora_manager_recipe: JSON.stringify({ recipe_id: 'B' }),
    }), 'B');
    assert.equal(stampedRecordId({ prompt: '{}' }), null);
    assert.equal(stampedRecordId({ unbake_sweep: 'not json' }), null);
});

// --- 3. 空欄は未知 ---------------------------------------------------------

test('記録が持っていない項目を、不一致として数えない', () => {
    // 実データで記録は寸法を241/346件、scheduler を88/346件しか持たない。
    // 空欄を不一致にすると、**記録が薄いほど帰属できなくなる**。
    const thin = record({
        gen_params: { prompt: 'a girl', steps: 20, cfg_scale: 7, sampler: 'DPM++ 2M Karras' },
    });
    const result = attributeOutput({ raw: { prompt: JSON.stringify(graph()) } }, indexRecords([thin]));
    assert.equal(result.evidence, 'inferred', `薄い記録に帰属できていない: ${JSON.stringify(result)}`);
    assert.equal(result.recordId, 'rec-a');
    // 比べられた本数も返る（何を根拠にした帰属かが読める）。
    assert.ok(result.compared >= 4, `比べた本数が返っていない: ${result.compared}`);
});

test('比べられる項目が足りなければ帰属しない', () => {
    const almostEmpty = { id: 'rec-thin', gen_params: { prompt: 'a girl' } };
    const result = attributeOutput(
        { raw: { prompt: JSON.stringify(graph()) } },
        indexRecords([almostEmpty]),
    );
    assert.equal(result.evidence, 'none');
    assert.equal(result.recordId, null);
});

// --- 4. 同点なら帰属しない --------------------------------------------------

test('同じ条件の記録が2つあれば、どちらにも帰属しない', () => {
    const indexed = indexRecords([record({ id: 'rec-a' }), record({ id: 'rec-b' })]);
    const result = attributeOutput({ raw: { prompt: JSON.stringify(graph()) } }, indexed);
    assert.equal(result.recordId, null, '理由が無いのに片方を選んでいる');
    assert.equal(result.evidence, 'none');
    assert.ok(result.tied >= 2, `同点の件数が返っていない: ${result.tied}`);
});

test('内訳を必ず返す（推定が何枚かが読める）', () => {
    const outputs = [
        { raw: { prompt: JSON.stringify(graph()) } },
        { raw: { lora_manager_recipe: JSON.stringify({ recipe_id: 'rec-a' }) } },
        { raw: {} },
    ];
    const { byRecord, tally } = attributeOutputs(outputs, [record()]);
    assert.equal(tally.total, 3);
    assert.equal(tally.stamped, 1);
    assert.equal(tally.inferred, 1);
    assert.equal(tally.none, 1);
    assert.equal(tally.unreadable, 1);
    assert.equal(byRecord.get('rec-a').length, 2);
    // 1件ずつに、どちらの証拠で来たかが付いている。
    const kinds = byRecord.get('rec-a').map(item => item.attribution.evidence).sort();
    assert.deepEqual(kinds, ['inferred', 'stamped']);
});

// --- 差分ラベル（裁定③） ---------------------------------------------------

test('ラベルは基準との差だけから出る', () => {
    const baseline = conditionsFromPrompt(JSON.stringify(graph()));
    const other = conditionsFromPrompt(JSON.stringify(graph({ width: 1280, height: 1856, steps: 28 })));
    const diff = describeDifference(baseline, other);
    const keys = diff.map(item => item.key).sort();
    assert.deepEqual(keys, ['size', 'steps']);
    const size = diff.find(item => item.key === 'size');
    assert.equal(size.from, '1024x1024');
    assert.equal(size.to, '1280x1856');
});

test('seed は既定で「違い」に数えない（Sweep が振る軸そのもの）', () => {
    const baseline = conditionsFromPrompt(JSON.stringify(graph({ seed: 1 })));
    const other = conditionsFromPrompt(JSON.stringify(graph({ seed: 2 })));
    assert.deepEqual(describeDifference(baseline, other), []);
    assert.deepEqual(describeDifference(baseline, other, { includeSeed: true }).map(d => d.key), ['seed']);
});

test('指紋が見ている項目と、見ていないものが、鍵として全部そろっている', () => {
    // **「差が無い」は強い主張。** 検出可能範囲とセットで画面へ出せるよう、
    // 一覧はカタログに在る鍵で持つ（`[core.…]` が画面に出ないこと）。
    setLocale(DEFAULT_LOCALE);
    const catalogue = CATALOGS[DEFAULT_LOCALE];
    assert.ok(FINGERPRINT_FIELDS.length >= 8, '見ている項目が少なすぎる＝一覧が壊れている');
    for (const field of FINGERPRINT_FIELDS) {
        assert.ok(Object.hasOwn(catalogue, field.label), `カタログに ${field.label} が無い`);
    }
    for (const code of FINGERPRINT_BLIND_SPOTS) {
        assert.ok(Object.hasOwn(catalogue, code), `カタログに ${code} が無い`);
    }
    // **比較に使う項目は、見ている項目より狭い。**
    // seed（振る軸）と size / scheduler（正しい対でも食い違う）を外している
    // ——外した2本は差分ラベルには使うので、`FINGERPRINT_FIELDS` からは消さない。
    assert.deepEqual([...MATCH_KEYS].sort(),
        ['cfg', 'checkpoint', 'loras', 'negative', 'positive', 'sampler', 'steps']);
    for (const key of ['seed', 'size', 'scheduler']) {
        assert.ok(FINGERPRINT_FIELDS.some(f => f.key === key), key + ' を見る項目から消している');
        assert.ok(!MATCH_KEYS.includes(key), key + ' を照合に使っている');
    }
    assert.equal(MIN_AGREEMENT, 0.7);
});

// --- 土台のモデル（2026-08-22 利用者の報告）----------------------------------
//
// `Civitai_Recipe_115941302`（ntdmixvpredv1.5）へ、`waiillustrioussdxl_v140` で
// 出た絵が7枚ぶら下がっていた。**原因は2つ重なっていた:**
//
//   1. 記録が `{modelName, type}` しか持たず、**名前を読み落として空**になる
//   2. 空は「未知」として比較から外れるので、**一番強い手掛かりが消えたまま**
//      残りの項目だけで一致率 0.75 を出していた

test('`modelName` しか無い記録でも、土台のモデルを読む', () => {
    const conditions = conditionsFromRecord(record({
        checkpoint: { modelName: 'ntdmixvpredv1.5', type: 'checkpoint' },
    }));
    assert.ok(conditions, '条件を組めていない');
    assert.match(String(conditions.checkpoint), /ntdmixvpredv1\.5/, '土台のモデルが空のまま');
    // 索引の行にも載ること（載っていないと突き合わせで飛ばされる）。
    const [entry] = indexRecords([record({
        id: 'ntd', checkpoint: { modelName: 'ntdmixvpredv1.5' },
    })]);
    assert.ok(entry.row.some(cell => /ntdmixvpredv1\.5/.test(cell)), '索引の行に載っていない');
});

test('土台のモデルが食い違う絵は、ほかが合っていても帰属しない', () => {
    // **ほかの項目は全部同じ**にしておく——ここを見ないと必ず通る。
    const indexed = indexRecords([record({ id: 'ntd', checkpoint: { file_name: 'ntdmix.safetensors' } })]);
    const same = attributeOutput({ raw: { prompt: JSON.stringify(graph({ ckpt: 'ntdmix.safetensors' })) } }, indexed);
    assert.equal(same.recordId, 'ntd', '同じ土台なのに帰属していない');

    const other = attributeOutput({ raw: { prompt: JSON.stringify(graph({ ckpt: 'waiillustrious.safetensors' })) } }, indexed);
    assert.equal(other.recordId, null, '土台が違うのに帰属している');
    assert.equal(other.evidence, 'none');
});

test('土台のモデルを持っていない記録は、今までどおり比べる（落とさない）', () => {
    // **空は「未知」。** ここで落とすと、名前を持たない記録が全部帰属できなくなる
    // ——`MIN_COMPARED` と「同点なら帰属しない」で守るのが元の設計。
    const indexed = indexRecords([record({ id: 'noname', checkpoint: null })]);
    const found = attributeOutput({ raw: { prompt: JSON.stringify(graph()) } }, indexed);
    assert.equal(found.recordId, 'noname', '土台が空なだけで帰属できなくなっている');
});

test('刻印が在れば、土台が違っても帰属は刻印に従う', () => {
    // **刻印 > 指紋。** 実際に回した記録が焼かれているので、条件の食い違いより強い。
    const indexed = indexRecords([record({ id: 'ntd', checkpoint: { file_name: 'ntdmix.safetensors' } })]);
    const found = attributeOutput({
        raw: {
            unbake_sweep: JSON.stringify({ record_id: 'ntd' }),
            prompt: JSON.stringify(graph({ ckpt: 'totally_other.safetensors' })),
        },
    }, indexed);
    assert.equal(found.recordId, 'ntd', '刻印より指紋を優先している');
    assert.equal(found.evidence, 'stamped');
});
