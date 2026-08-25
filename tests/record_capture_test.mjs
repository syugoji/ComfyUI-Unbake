/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 画像1枚から Generation Record を組む経路（**捕捉**）。
 *
 * 実データ（ComfyUI の出力）は `UNBAKE_OUTPUT_DIR` を渡したときだけ当てる。
 * 渡さないときは、**その場で組み立てた PNG** で判定式を固定する
 * ——合成だけだと本物の癖（Python が書く `NaN` など）を取り逃がすので、
 * **両方置く。**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { parseJsonLoose, readPngText } from '../web/core/pngText.js';
import {
    RECORD_STAMP_KEY,
    attachBuiltWorkflow,
    buildGenerationRecord,
    buildRecordFromRecipe,
    markUnbuildable,
    summarizePrompt,
} from '../web/core/generationRecord.js';
import { buildRecipeWorkflow } from '../web/core/recipeWorkflowBuilder.js';

/** 最小の PNG を組み立てる（tEXt チャンクを好きなだけ入れる）。 */
function makePng(textChunks = {}, { corrupt = false } = {}) {
    const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
    const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(corrupt && type === 'tEXt' ? data.length + 9999 : data.length);
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

const PROMPT = JSON.stringify({
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'Pony\\style\\anima.safetensors' } },
    2: { class_type: 'LoraLoader', inputs: { lora_name: 'detail.safetensors', strength_model: 0.7 } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: 'a fox in the snow' } },
    4: { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1216, batch_size: 1 } },
    5: {
        class_type: 'KSampler',
        inputs: { seed: 12345, steps: 30, cfg: 5.5, sampler_name: 'euler_ancestral', scheduler: 'karras' },
    },
});

test('PNG の tEXt を読める', () => {
    const parsed = readPngText(makePng({ prompt: PROMPT, note: 'ほげ' }));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.text.note, 'ほげ', 'UTF-8 が壊れている');
    assert.equal(parsed.unsupported.length, 0);
});

test('PNG でないものを PNG として読まない', () => {
    const parsed = readPngText(Buffer.from('これは PNG ではない'));
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, 'not-png');
});

test('長さが壊れていたら止まる（でたらめな位置を鍵にしない）', () => {
    const parsed = readPngText(makePng({ prompt: PROMPT }, { corrupt: true }));
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, 'truncated');
});

test('Python が書く NaN を含む JSON を読める（直したことも残す）', () => {
    // **実測で1枚踏んだ。** `prompt` が3,328文字きちんと在るのに JSON.parse が落ち、
    // **グラフが目の前にあるのに「メタが無い」扱い**で blocked へ落ちていた。
    const withNaN = '{"a": {"changed": NaN}, "b": 1, "c": "NaN という文字列"}';
    const loose = parseJsonLoose(withNaN);
    assert.equal(loose.repaired, true, '直せていない');
    assert.equal(loose.value.a.changed, null);
    assert.equal(loose.value.b, 1);
    assert.equal(loose.value.c, 'NaN という文字列', '文字列の中の NaN を壊している');

    // 直す必要が無いものを「直した」と言わない。
    assert.equal(parseJsonLoose('{"a":1}').repaired, false);
    // 直しても解けないものは諦める（黙って部分的な値を作らない）。
    assert.equal(parseJsonLoose('{"a": NaN').value, null);
});

test('API 形式のグラフから要点を抜ける', () => {
    const s = summarizePrompt(JSON.parse(PROMPT));
    assert.equal(s.checkpoint, 'Pony\\style\\anima.safetensors');
    assert.deepEqual(s.loras, [{ name: 'detail.safetensors', strength: 0.7 }]);
    assert.equal(s.seed, 12345);
    assert.equal(s.steps, 30);
    assert.equal(s.cfg, 5.5);
    assert.equal(s.sampler, 'euler_ancestral');
    assert.equal(s.scheduler, 'karras');
    assert.equal(s.width, 832);
    assert.equal(s.height, 1216);
    assert.equal(s.positive, 'a fox in the snow');
});

test('正負は並び順ではなく、サンプラーの線で決める', () => {
    // **負の側が先に並ぶグラフで、正負が入れ替わっていた。**
    // しかも負の側は**どのグラフでも取れていなかった**ので、記録の
    // 負のプロンプトは全件が空だった（2026-08-24 実機 `ComfyUI_00444_`）。
    // 同じ種・同じ設定なのに絵が変わり、どこが違うのかも読めない。
    const graph = {
        // わざと**負を先に**置く（本物の並びもこうなり得る）。
        '1': { class_type: 'CLIPTextEncode', inputs: { text: 'lowres, worst quality' } },
        '2': { class_type: 'CLIPTextEncode', inputs: { text: 'a fox in the snow' } },
        '3': {
            class_type: 'KSampler',
            inputs: { seed: 7, steps: 20, cfg: 5, sampler_name: 'euler', scheduler: 'normal',
                positive: ['2', 0], negative: ['1', 0] },
        },
    };
    const s = summarizePrompt(graph);
    assert.equal(s.positive, 'a fox in the snow', '並び順で正を決めている');
    assert.equal(s.negative, 'lowres, worst quality', '負を抜けていない');
});

test('線が辿れないときは並び順へ落ちるが、正負に同じ文字を入れない', () => {
    const graph = {
        '1': { class_type: 'CLIPTextEncode', inputs: { text: 'a fox in the snow' } },
        '2': { class_type: 'CLIPTextEncode', inputs: { text: 'lowres' } },
        // 線を持たないサンプラー（古い形・壊れた記録）。
        '3': { class_type: 'KSampler', inputs: { seed: 7, steps: 20, cfg: 5 } },
    };
    const s = summarizePrompt(graph);
    assert.equal(s.positive, 'a fox in the snow');
    assert.equal(s.negative, 'lowres');
    assert.notEqual(s.positive, s.negative, '正負に同じ文字が入っている');
});

test('ComfyUI の出力から Generation Record を組める', () => {
    const built = buildGenerationRecord(makePng({ prompt: PROMPT }), {
        kind: 'comfy_output', filename: 'Base_1_00001_.png', url: '/api/view?filename=x', subfolder: '',
    });
    assert.equal(built.ok, true);
    assert.equal(built.record.verdict, 'reproducible');
    assert.equal(built.record.origin.kind, 'comfy_output');
    assert.equal(built.record.title, 'Base_1_00001_');
    assert.equal(built.record.provenance.hasPrompt, true);
});

test('旧い刻印も新しい刻印も読む（過去の出力を捨てない）', () => {
    // 書くときは `unbake_` だが、手元の出力3,084枚は旧い鍵で刻まれている。
    const legacy = buildGenerationRecord(makePng({
        prompt: PROMPT,
        lora_manager_recipe: JSON.stringify({ schema: 'lora-manager.recipe-reference', recipe_id: 'abc' }),
    }), { filename: 'x.png' });
    assert.equal(legacy.record.reference.recipeId, 'abc');
    assert.equal(legacy.record.provenance.stampKey, 'lora_manager_recipe');

    const current = buildGenerationRecord(makePng({
        prompt: PROMPT,
        [RECORD_STAMP_KEY]: JSON.stringify({ schema: 'unbake.generation-record', recipe_id: 'def' }),
    }), { filename: 'y.png' });
    assert.equal(current.record.reference.recipeId, 'def');
    assert.equal(current.record.provenance.stampKey, RECORD_STAMP_KEY);
    // **外向きの鍵に上流の製品名を入れない**（決定④）。
    assert.doesNotMatch(RECORD_STAMP_KEY, /lora[_-]?manager/i);
});

test('記録が無い画像は「無い」と言う（空の記録を作らない）', () => {
    const built = buildGenerationRecord(makePng({}), { filename: 'plain.png' });
    assert.equal(built.ok, false);
    assert.equal(built.reason, 'no-metadata');
    assert.equal(built.record, null);
});

test('実データの出力すべてから記録を組める（--outputs / UNBAKE_OUTPUT_DIR）', (t) => {
    const i = process.argv.indexOf('--outputs');
    const dir = i >= 0 ? process.argv[i + 1] : process.env.UNBAKE_OUTPUT_DIR;
    if (!dir || !fs.existsSync(dir)) {
        t.skip('ComfyUI の出力ディレクトリが指定されていない（UNBAKE_OUTPUT_DIR）');
        return;
    }
    const files = fs.readdirSync(dir).filter(name => name.endsWith('.png'));
    assert.ok(files.length > 0, '出力が0件＝走査が壊れている');
    const failures = [];
    const verdicts = {};
    for (const name of files) {
        const built = buildGenerationRecord(fs.readFileSync(path.join(dir, name)), {
            kind: 'comfy_output', filename: name,
        });
        if (!built.ok) { failures.push(`${name}: ${built.reason}`); continue; }
        verdicts[built.record.verdict] = (verdicts[built.record.verdict] || 0) + 1;
    }
    assert.deepEqual(failures.slice(0, 5), [], `記録を組めない出力がある（${failures.length}件）`);
    assert.equal(verdicts.blocked ?? 0, 0, 'グラフが埋まっているのに blocked になっている出力がある');
});

// --- レシピ（＝再現の経路） -------------------------------------------------

test('レシピはグラフを持っていなければ「未組立」であって「不足」ではない', () => {
    // **最初これを逆に作った。** レシピに `comfy_prompt` があると思い込み、
    // 無いものを blocked にしていた。**実測（手元346件）で持っているのは48件（14%）だけ。**
    // 「まだ組んでいない」を「再現できない」と混ぜると、86%が理由もなく捨てられる。
    const bare = buildRecordFromRecipe(
        { id: 'r1', title: 'T', checkpoint: { name: 'X' }, loras: [{ file_name: 'a.safetensors', weight: 0.8 }] },
        { filename: 'r1.recipe.json' },
    );
    assert.equal(bare.ok, true);
    assert.equal(bare.record.needsBuild, true);
    assert.equal(bare.record.verdict, 'pending', '組む前から不足扱いにしている');
    assert.deepEqual(bare.record.loras, [{ name: 'a.safetensors', strength: 0.8 }]);

    const withGraph = buildRecordFromRecipe(
        { id: 'r2', title: 'U', comfy_prompt: JSON.parse(PROMPT) },
        { filename: 'r2.recipe.json' },
    );
    assert.equal(withGraph.record.needsBuild, false);
    assert.equal(withGraph.record.verdict, 'reproducible');
});

test('組んだグラフを結び付けると判定が決まる', () => {
    const record = buildRecordFromRecipe({ id: 'r', title: 'T' }, { filename: 'r.recipe.json' }).record;
    const next = attachBuiltWorkflow(record, { prompt: JSON.parse(PROMPT) });
    assert.equal(next.needsBuild, false);
    assert.equal(next.verdict, 'reproducible');
    assert.equal(next.checkpoint, 'Pony\\style\\anima.safetensors');
    assert.equal(record.verdict, 'pending', '元の記録を書き換えている');
});

test('組めないレシピは理由つきで畳む（握り潰さない）', () => {
    const record = buildRecordFromRecipe({ id: 'r', title: 'T' }, { filename: 'r.recipe.json' }).record;
    const blocked = markUnbuildable(record, new Error('再現に必要なチェックポイント情報がありません。'));
    assert.equal(blocked.verdict, 'blocked');
    assert.match(blocked.blockedReason, /チェックポイント/);
});

test('実データのレシピが、組んだうえで判定まで到達する（UNBAKE_RECIPES_DIR）', (t) => {
    const i = process.argv.indexOf('--recipes');
    const dir = i >= 0 ? process.argv[i + 1] : process.env.UNBAKE_RECIPES_DIR;
    if (!dir || !fs.existsSync(dir)) { t.skip('レシピの置き場が指定されていない'); return; }
    const files = fs.readdirSync(dir).filter(n => n.endsWith('.recipe.json'));
    assert.ok(files.length > 0);
    const tally = {};
    let needed = 0;
    for (const name of files) {
        let recipe;
        try { recipe = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
        let record = buildRecordFromRecipe(recipe, { filename: name }).record;
        if (record.needsBuild) {
            needed += 1;
            try { record = attachBuiltWorkflow(record, buildRecipeWorkflow(recipe)); }
            catch (error) { record = markUnbuildable(record, error); }
        }
        tally[record.verdict] = (tally[record.verdict] || 0) + 1;
    }
    // **組む必要があるものが大半である**ことを固定する。ここが1桁に落ちたら、
    // レシピの形が変わったか読めていないかのどちらかで、どちらも黙って進む種類の壊れ方。
    assert.ok(needed > files.length * 0.5, `組む必要があったのが ${needed}/${files.length} しかない`);
    assert.equal(tally.pending ?? 0, 0, '組まないまま残っている記録がある');
    assert.ok((tally.reproducible ?? 0) > 0, '1件も再現可にならない＝組み立てが壊れている');
});
