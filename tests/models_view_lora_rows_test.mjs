/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **同じ LoRA を2行に割らない／効かないスライダーを出さない**
 * （2026-08-31・監査 I-20260831-19）。
 *
 * `modelsOf` の重複判定は `${kind}:${name.toLowerCase()}` で、**茎で比べていない**。
 * 同ファイル :194 の注記は「`push` が茎で重複を弾くので、一覧に在るものは
 * 二重に出ない」と書いているが、**`stemOf` は呼ばれていなかった**。
 * 一覧側が拡張子付き（`charA.safetensors`）でプロンプトのタグが拡張子なし
 * （`<lora:charA:0.8>`）だと、同じ LoRA が2行出る。
 *
 * **実測: 自分の ComfyUI 出力4,904枚のうち12枚・重複行27本が今日この状態。**
 * 原因は `generationRecord.js` が `inputs.lora_name`（拡張子つき）をそのまま
 * 名前にするので、**プロンプトのタグとは必ず食い違う**こと。
 *
 * 悪いのは行が増えることだけではない。**重複行のスライダーは再現に効かない。**
 * `recipeLoraOverrides.js` の `loraKey` は、版IDを持たないプロンプト由来の行に
 * `f<拡張子なし名>` を作るが、`applyLoraOverrides` は `record.loras` を走査する
 * ので一覧側の鍵（`v<versionId>` か `i<index>`）としか照合しない。
 * **保存も読み戻しも成功し、再現時だけ黙って無視される。**
 *
 * 対照つきで確認済み（修正前）:
 *   一覧由来 `charA.safetensors` → 鍵 `v12345` → 0.8 が 0.2 へ（効く）
 *   タグ由来 `charA`             → 鍵 `fchara` → 0.8 のまま（★効かない）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { modelsOf } from '../web/panel/modelsView.js';

const recipeWithBoth = () => ({
    id: 'civitai_1',
    checkpoint: 'base.safetensors',
    loras: [{ file_name: 'charA.safetensors', modelVersionId: 12345, strength_model: 0.8 }],
    gen_params: { prompt: 'girl <lora:charA:0.8> smiling' },
});

const loraRows = (record, recipe) => modelsOf(record, recipe).filter(row => row.role === 'lora');

test('一覧とプロンプトが同じ LoRA を指していたら、1行にまとめる', () => {
    const rows = loraRows({ id: 'civitai_1' }, recipeWithBoth());
    assert.equal(rows.length, 1,
        `同じ LoRA が ${rows.length} 行に割れている: ${JSON.stringify(rows.map(r => r.name))}`);
    // **残すのは一覧側**（版IDを持っていて、上書きが実際に効く方）。
    assert.equal(rows[0].source?.modelVersionId, 12345,
        '版IDを持たない方を残している（そちらの上書きは再現に効かない）');
});

test('版番号のところで切らない（茎の取り方を間違えない）', () => {
    // `stemOf` が「最後の `.` から後ろ」を落とす作りだと、ここで別物になる。
    const rows = loraRows({ id: 'r' }, {
        id: 'r',
        loras: [
            { file_name: 'ink-style_A3.1_XL.safetensors', modelVersionId: 1, strength_model: 1 },
            { file_name: 'ink-style_A3.2_XL.safetensors', modelVersionId: 2, strength_model: 1 },
        ],
        gen_params: { prompt: 'x' },
    });
    assert.equal(rows.length, 2, '別の版を同じ LoRA とみなして潰している');
});

test('一覧に相手が居ないタグの行には、効かないスライダーを出さない', () => {
    // **プロンプトにだけ在る LoRA。** `record.loras` に相手が居ないので、
    // 上書きは `applyLoraOverrides` に一度も届かない。
    const rows = loraRows({ id: 'r' }, {
        id: 'r',
        loras: [{ file_name: 'listed.safetensors', modelVersionId: 7, strength_model: 1 }],
        gen_params: { prompt: 'x <lora:orphan:0.5>' },
    });
    const orphan = rows.find(row => /orphan/i.test(row.name));
    assert.ok(orphan, 'プロンプト由来の行そのものが消えている（見えなくするのは行き過ぎ）');
    assert.equal(orphan.overridable, false,
        '効かないスライダーを出す印のままになっている');

    const listed = rows.find(row => /listed/i.test(row.name));
    assert.equal(listed.overridable, true, '効く行まで触れなくしている');
});

test('対照: 一覧だけの記録は、今までどおり1行ずつ出て触れる', () => {
    const rows = loraRows({ id: 'r' }, {
        id: 'r',
        loras: [
            { file_name: 'a.safetensors', modelVersionId: 1, strength_model: 0.8 },
            { file_name: 'b.safetensors', modelVersionId: 2, strength_model: 0.5 },
        ],
        gen_params: { prompt: 'no tags here' },
    });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(row => row.overridable), [true, true]);
});
