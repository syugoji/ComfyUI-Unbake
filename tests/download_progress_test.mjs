/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **落としている間の姿**（2026-08-26 利用者の報告）。
 *
 *   - 「止める」がずっと並んでいて邪魔（落としている間しか要らない）
 *   - 何バイト落ちたのか判らない（並列にしたら1本ぶんしか見えなくなった）
 *   - 絞り込みで隠れている記録が対象外なのに、そう書いていない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUnbakePanel } from '../web/panel/panel.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale } from '../web/i18n/index.js';

setLocale('ja');

const rec = (id, extra = {}) => ({ id, libraryId: id, title: `r${id}`, verdict: 'reproducible', ...extra });
const withMissing = (id, versionId) => rec(id, {
    verdict: 'blocked',
    missing: { models: [], resources: [{ type: 'lora', name: `m${versionId}`, versionId, modelId: null, isDeleted: false }] },
});

/**
 * 内訳の面で「落とす」を押す（2026-08-26 から、構えて押し直す形ではなく
 * **内訳を並べて選ばせる面**が出る）。返るのは落とし終わりの結果。
 */
function confirmPick(panel) {
    const go = panel.root.byClass('unbake-confirm-go');
    assert.ok(go, `内訳の面が出ていない: ${panel.root.text.slice(-260)}`);
    return go.dispatch('click', {});
}

function mount(records, io = {}) {
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), { documentRef: doc, ...io });
    panel.setRecords(records);
    return panel;
}

test('「止める」は落としている間だけ見える', () => {
    const panel = mount([rec('a')], { downloadIo: { start: async () => ({ ok: true }) } });
    const box = panel.root.byClass('unbake-download-panel');
    assert.ok(box, '進み具合の欄が無い');
    // **走っていない間は出さない。** 空の欄が場所を取る。
    assert.equal(box.style.display, 'none', '走っていないのに出ている');
    // 選択の帯からは外れていること（元はここに並んでいて邪魔だった）。
    const bar = panel.root.byClass('unbake-selection');
    assert.equal(bar.text.includes('止める'), false, '選択の帯に「止める」が残っている');
});

test('進み具合はバーと数字で出て、走り終わると畳まれる', async () => {
    const states = [
        { state: 'running', running: [{ versionId: '1', bytes: 50 }, { versionId: '2', bytes: 30 }],
          runningCount: 2, doneBytes: 80, totalBytes: 200 },
    ];
    const panel = mount([withMissing('a', '111')], {
        downloadIo: {
            // **少し待たせる。** すぐ終わると欄が出る前に畳まれてしまい、
            // 「出ていない」のか「出て消えた」のか区別が付かない検査になる。
            start: async () => {
                await new Promise(resolve => setTimeout(resolve, 40));
                return { ok: true, path: 'x' };
            },
            plan: async () => ({ ok: true, unknown: 0, bytes: 200, items: [] }),
            state: async () => states[0],
        },
    });
    await panel.downloadMissing();
    const run = confirmPick(panel);
    await new Promise(resolve => setTimeout(resolve, 15));
    const box = panel.root.byClass('unbake-download-panel');
    const fill = panel.root.byClass('unbake-download-fill');
    assert.equal(box.style.display, '', '落としているのに出ていない');
    assert.equal(fill.style.width, '40%', `バーが進んでいない: ${fill.style.width}`);
    assert.match(panel.root.byClass('unbake-download-text').textContent, /2 本/,
        '同時に何本走っているか出ていない');
    await run;
    assert.equal(box.style.display, 'none', '走り終わっても欄が残っている');
});

test('総量が判らないときは、バーを動かさない', async () => {
    const panel = mount([withMissing('a', '111')], {
        downloadIo: {
            start: async () => {
                await new Promise(resolve => setTimeout(resolve, 40));
                return { ok: true, path: 'x' };
            },
            plan: async () => ({ ok: true, unknown: 1, bytes: 0, items: [] }),
            // **`Content-Length` を返さない相手が居る。**
            state: async () => ({ state: 'running', running: [{ versionId: '1', bytes: 10 }],
                                  runningCount: 1, doneBytes: 10, totalBytes: null }),
        },
    });
    await panel.downloadMissing();
    const run = confirmPick(panel);
    await new Promise(resolve => setTimeout(resolve, 15));
    const bar = panel.root.byClass('unbake-download-bar');
    // **動かすと、進んでいない時に進んで見える。**
    assert.equal(bar.getAttribute('data-unknown'), 'true', '判らないのに割合を出している');
    assert.match(panel.root.byClass('unbake-download-text').textContent, /不明/,
        '総量が不明だと言っていない');
    await run;
});

test('絞り込みで外れた件数を言う', async () => {
    // **なぜ候補が少ないのか、読み取る手掛かりが要る**——実機で候補は 16件
    // あったのに画面には 6件しか出ず、理由が判らなかった。
    const panel = mount([withMissing('a', '111'), rec('b'), rec('c')], {
        downloadIo: {
            start: async () => ({ ok: true }),
            plan: async () => ({ ok: true, unknown: 0, bytes: 1, items: [] }),
        },
    });
    // `reproducible` を隠す絞り込みを掛ける代わりに、1件だけ選ぶ。
    const boxes = panel.root.allByClass('unbake-pick');
    boxes[0].checked = true;
    await boxes[0].dispatch('click', {});
    await panel.downloadMissing();
    assert.match(panel.root.text, /2 件は絞り込みや選択の外/,
        `対象外の件数を言っていない: ${panel.root.text.slice(-300)}`);
});

// --- 落とした後（2026-08-26 実機）-------------------------------------------

test('落とし終わったら、判定を材料ごと掛け直す', async () => {
    /*
     * **実機で踏んだ。** 落とし終わっても何も掛け直していなかったので、
     * 判定は「再現不可」のまま、`/object_info` の控えも落とす前のまま
     * ——ファイルは正しい場所に在り ComfyUI も認識しているのに、
     * **利用者から見ると「落としたのに何も変わらない」。**
     */
    const calls = [];
    const panel = mount([withMissing('a', '111')], {
        downloadIo: {
            start: async () => ({ ok: true, path: 'x' }),
            plan: async () => ({ ok: true, unknown: 0, bytes: 1, items: [] }),
        },
        verdictFor: async (records, options) => {
            calls.push({ count: records.length, fresh: options?.fresh === true });
        },
    });
    await panel.downloadMissing();
    await confirmPick(panel);
    assert.match(panel.root.text, /1 件を取得/,
        `落ちたことを言っていない: ${panel.root.text.slice(-260)}`);
    assert.equal(calls.length, 1, '落としたのに掛け直していない');
    // **材料ごと。** 控えたままだと導入済み一覧が古く、「未導入」のまま。
    assert.equal(calls[0].fresh, true, '材料の控えを捨てていない');
});

test('1件も落ちなかったときは掛け直さない', async () => {
    // **無駄に 351件を組み直さない。**
    const calls = [];
    const panel = mount([withMissing('a', '111')], {
        downloadIo: {
            start: async () => ({ ok: false, code: 'already', error: 'already there: x' }),
            plan: async () => ({ ok: true, unknown: 0, bytes: 1, items: [] }),
        },
        verdictFor: async () => { calls.push(1); },
    });
    await panel.downloadMissing();
    await confirmPick(panel);
    assert.deepEqual(calls, [], '何も落ちていないのに掛け直している');
});

// --- 狭い帯でもはみ出さない（2026-08-28 利用者の報告）----------------------

test('落としている間の帯は、狭い幅でも全部見える', async () => {
    /*
     * **「サイドバーを広げないと全体が出ない」**（実機の報告）。
     *
     * 実測（利用者の幅 **490px**・日本語の進捗文）:
     *
     *     器 488px に対して中身 534px  → はみ出し 46px
     *     「止める」の右端 534.5px      → 器の右端 490px を 44.5px 超えている
     *
     * 原因は字の側。`flex: none` と `white-space: nowrap` で**縮みも
     * 折り返しもしない**ので、400px 近い進捗文がそのまま器を押し広げ、
     * 一番外側にある「止める」を追い出していた。
     *
     * 直後の実測: はみ出し **0**、高さは 78.8px → 58.4px。300px まで狭めても
     * はみ出さない。
     */
    const { readFile } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const css = await readFile(join(root, 'web/panel/theme.css'), 'utf8');

    /*
     * **注記を落としてから見る。** ここは3度目の同じ穴——注記に
     * 「`flex: none` だった」と書いてあるので、素の本文を見ると
     * **直したのに直っていないと判定する**（実際そうなって落ちた）。
     */
    const block = (selector) => {
        const head = `
${selector} {`;
        const at = css.indexOf(head);
        assert.notEqual(at, -1, `規則が無い（改名を見逃している）: ${selector}`);
        let body = css.slice(at + head.length, css.indexOf('}', at));
        for (;;) {
            const from = body.indexOf('/*');
            if (from === -1) break;
            const to = body.indexOf('*/', from);
            if (to === -1) break;
            body = body.slice(0, from) + body.slice(to + 2);
        }
        return body;
    };

    const panel = block('.unbake-download-panel');
    assert.match(panel, /flex-wrap:\s*wrap/,
        '帯が折り返さない。入り切らない分が器の外へ出て、押せなくなる');

    const text = block('.unbake-download-text');
    assert.doesNotMatch(text, /flex:\s*none/,
        '進捗文が縮まない（これが器を押し広げていた）');
    assert.match(text, /min-width:\s*0/,
        'flex の既定（min-width: auto）のままだと、折り返しを許しても縮まない');
    assert.doesNotMatch(text, /white-space:\s*nowrap/,
        '進捗文が1行のままだと、折り返しても意味が無い');
    // **桁は揃えたまま。** 数字が動くと、目で追えなくなる。
    assert.match(text, /font-variant-numeric:\s*tabular-nums/, '桁揃えを落としている');
});
