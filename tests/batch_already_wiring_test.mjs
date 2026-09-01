/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **到達しない内訳を、利用者に読ませない**（`I-20260831-55`）。
 *
 * 束の完了メッセージは「飛ばした内訳」を4つ並べていたが、そのうち
 * **「既に絵がある N 件」は構造的に必ず 0** だった——`skipped.alreadyDone` は
 * `stampedSignatures` と `wantedSignaturesOf` の**両方が関数のとき**にしか
 * 増えないのに、`web/unbake.js` は両方 `null` で固定している。
 *
 * **これは未配線ではなく仕様である。** 同じ場所に
 * 「**「出ている」の判断は刻印だけ。推定で回し直しを止めると、
 * 「出したはずの絵が無い」が起きる**」という決定が書いてある。
 *
 * だから**片方を直しても意味が無い**。ここで留めるのは**両者の対応**——
 * 署名を渡していない間は数を出さない、渡すようになったら出す。
 * どちらを動かしても、片方だけでは赤くなる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 束の絞り込みへ、刻印の署名を渡しているか。 */
async function signaturesWired() {
    const entry = await readFile(join(ROOT, 'web/unbake.js'), 'utf8');
    const nulled = /stampedSignatures:\s*null/.test(entry)
        && /wantedSignaturesOf:\s*null/.test(entry);
    return !nulled;
}

test('刻印の署名を渡していない間は、「既に絵がある」を数として出さない', async () => {
    const wired = await signaturesWired();
    const localesDir = join(ROOT, 'web/i18n/locales');
    const files = (await readdir(localesDir)).filter(name => name.endsWith('.js'));
    assert.equal(files.length, 12, `言語の数が変わっている（${files.length}）`);

    const carrying = [];
    for (const name of files) {
        const text = await readFile(join(localesDir, name), 'utf8');
        const line = text.split(/\r?\n/).find(entry => entry.includes('"batch.done"'));
        assert.ok(line, `${name}: batch.done が無い`);
        if (line.includes('{already}')) carrying.push(name);
    }

    if (wired) {
        assert.equal(carrying.length, 12,
            '署名を渡すようになったのに、数を出していない言語がある: '
            + files.filter(name => !carrying.includes(name)).join(', '));
    } else {
        assert.deepEqual(carrying, [],
            '署名を渡していないので必ず 0 なのに、「既に絵がある{already}件」を出している: '
            + carrying.join(', '));
    }
});

test('文言が求める差し込みを、呼び手が全部渡している', async () => {
    /*
     * **文言と呼び手のずれは、片方だけ直すと残る。** 渡していない差し込みは
     * `{already}` のまま画面へ出るので（`t()` は値の無い差し込みを残す）、
     * 消し忘れると「既に絵がある{already}件」と表示される。
     */
    const panel = await readFile(join(ROOT, 'web/panel/panel.js'), 'utf8');
    const call = panel.match(/t\('batch\.done',\s*{([\s\S]*?)}\)/);
    assert.ok(call, 'batch.done の呼び手を拾えていない');
    const passed = new Set(
        [...call[1].matchAll(/^\s*(\w+)\s*:/gm)].map(m => m[1])
    );
    assert.ok(passed.size >= 4, `呼び手の引数を拾えていない: ${[...passed]}`);

    const en = await readFile(join(ROOT, 'web/i18n/locales/en.js'), 'utf8');
    const line = en.split(/\r?\n/).find(entry => entry.includes('"batch.done"'));
    const wanted = new Set([...line.matchAll(/\{(\w+)\}/g)].map(m => m[1]));
    assert.ok(wanted.size >= 4, `文言の差し込みを拾えていない: ${[...wanted]}`);

    assert.deepEqual([...wanted].sort(), [...passed].sort(),
        '文言が求める差し込みと、呼び手が渡す値が食い違っている');
});
