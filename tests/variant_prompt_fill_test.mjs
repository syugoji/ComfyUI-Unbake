/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **あとから出した絵の条件も読む。ただし同じ絵は二度読まない**
 * （2026-08-31・監査 I-20260831-20）。
 *
 * `fillVariantPrompts` は記録 id を一度 `promptsFilled` へ入れると、以後
 * **まるごと帰る**。再現や Sweep で新しく足された絵は `raw` を持たない
 * （`sweepRunner` が作る出力は `filename` / `subfolder` / `url` だけ）ので、
 * その絵の条件は**永久に読まれない**——`variantsView` の
 * `conditionsFromPrompt(output?.raw?.prompt)` が `null` を返し、
 * **新しい絵のカードだけ「差を読めませんでした」になる。**
 * ページを読み込み直すまで直らない。
 *
 * **ただし Set を外すだけでは駄目。** 探索便は「この Set は往復を減らす役に
 * 立っていない」と書いていたが、**それは誤り**だった（反証側が指摘）。
 * `prompt` を持たない画像（ディスク由来・A1111 出力）に対しては、
 * 同じ記録を開き直すたびの再取得を確かに抑えている——実測で3回開いて往復1回。
 *
 * 欠陥の本体は「**id 単位で覆っているのに、索引は id 単位で後から増える**」こと。
 * だから覚えるのは**絵の単位**にする。同じ絵は二度読まず、新しい絵は読む。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * `web/unbake.js` の `fillVariantPrompts` を、原文のまま切り出して起こす。
 *
 * **模写しない。** 模写すると、直したのは写しの方で実物は壊れたまま、
 * という形になる（この監査で何度も見た型）。
 */
async function loadImplementation() {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const source = await readFile(join(root, 'web/unbake.js'), 'utf8');

    // **目印は「覚えている入れ物の宣言」から。** 名前が変わったら赤くなるが、
    // それは正しい——切り出す位置が動いたことに気づけないと、**実物を測って
    // いないのに緑**という一番悪い形になる。
    const start = source.indexOf('    const promptsAsked');
    const end = source.indexOf('    async function loadVariants');
    assert.ok(start > 0 && end > start, '切り出しの目印が見つからない（実装が動いた）');
    const body = source.slice(start, end);
    assert.match(body, /fillVariantPrompts/, '切り出した所に本体が入っていない');

    const factory = new Function('readOutputRaw', `${body}\nreturn { fillVariantPrompts };`);
    return factory;
}

/** 何回サーバへ行ったか、何を聞いたかを数える。 */
function recorder(answers = {}) {
    const calls = [];
    const readOutputRaw = async (items) => {
        calls.push(items.map(item => String(item.filename)));
        const raw = {};
        for (const item of items) {
            const key = `${item.subfolder || ''}/${item.filename}`;
            if (answers[item.filename]) raw[key] = { prompt: answers[item.filename] };
        }
        return { raw };
    };
    return { calls, readOutputRaw };
}

const out = (filename) => ({ filename, subfolder: '' });

test('あとから足された絵の条件も読む', async () => {
    const factory = await loadImplementation();
    const { calls, readOutputRaw } = recorder({ 'a.png': '{"1":{}}', 'b.png': '{"2":{}}' });
    const { fillVariantPrompts } = factory(readOutputRaw);

    const outputs = [out('a.png')];
    await fillVariantPrompts('rec-1', outputs);
    assert.ok(outputs[0].raw?.prompt, '最初の絵が読めていない（前提が崩れている）');

    // 再現／Sweep が新しい絵を索引へ足した（`raw` を持たない）。
    outputs.push(out('b.png'));
    await fillVariantPrompts('rec-1', outputs);

    assert.ok(outputs[1].raw?.prompt,
        `あとから足された絵の条件が永久に読まれない: ${JSON.stringify(calls)}`);
});

test('同じ絵は二度読まない（往復を増やさない）', async () => {
    const factory = await loadImplementation();
    const { calls, readOutputRaw } = recorder({});   // どれも prompt を持たない
    const { fillVariantPrompts } = factory(readOutputRaw);

    const outputs = [out('a.png'), out('b.png')];
    await fillVariantPrompts('rec-1', outputs);
    await fillVariantPrompts('rec-1', outputs);
    await fillVariantPrompts('rec-1', outputs);

    assert.equal(calls.length, 1,
        `同じ絵を何度も聞きに行っている（${calls.length}往復）: ${JSON.stringify(calls)}`);
});

test('新しい絵だけを聞く（既に読めた分は聞き直さない）', async () => {
    const factory = await loadImplementation();
    const { calls, readOutputRaw } = recorder({ 'a.png': '{"1":{}}', 'b.png': '{"2":{}}' });
    const { fillVariantPrompts } = factory(readOutputRaw);

    const outputs = [out('a.png')];
    await fillVariantPrompts('rec-1', outputs);
    outputs.push(out('b.png'));
    await fillVariantPrompts('rec-1', outputs);

    assert.deepEqual(calls, [['a.png'], ['b.png']],
        `聞き直しが増えている: ${JSON.stringify(calls)}`);
});

test('対照: 記録が違えば別に数える', async () => {
    const factory = await loadImplementation();
    const { calls, readOutputRaw } = recorder({});
    const { fillVariantPrompts } = factory(readOutputRaw);

    await fillVariantPrompts('rec-1', [out('a.png')]);
    await fillVariantPrompts('rec-2', [out('a.png')]);
    assert.equal(calls.length, 2, '別の記録の絵まで「読んだ」と数えている');
});
