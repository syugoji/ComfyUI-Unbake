/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **選んでからの右クリック**（2026-08-26 利用者の指示）。
 *
 * 一覧の操作は上の帯にしか無く、選ぶたびに目を上へ戻す必要があった。
 * ここで見るのは「品書きが出る」ことではなく、**出た品書きが実際に効く**こと
 * ——押しても何も起きない項目は、無いより悪い。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUnbakePanel } from '../web/panel/panel.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale } from '../web/i18n/index.js';

setLocale('ja');

const rec = (id) => ({
    id, libraryId: id, savedId: id, title: `Civitai_Recipe_${id}`,
    verdict: 'reproducible', checkpoint: 'a.safetensors',
});

function mount(records, io = {}) {
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), {
        documentRef: doc,
        // **確認を切って測る。** 確認の面まで通すと、測っているのが
        // 品書きなのか確認の面なのか判らなくなる。
        // **表示は表**（下の検査が行を見る）。面の既定はタイル。
        display: { confirmBeforeDelete: false, listView: 'table' },
        ...io,
    });
    panel.setRecords(records);
    return panel;
}

/** 右クリックを受ける口（表の行）。 */
const rowsOf = (panel) => panel.root.findAll(
    node => node.tagName === 'TR' && node.listeners?.has('contextmenu'));
const tiles = (panel) => panel.root.allByClass('unbake-tile')
    .filter(node => node.className === 'unbake-tile');
const menuItems = (panel) => panel.root.allByClass('unbake-context-item')
    .map(node => node.textContent);

test('右クリックで品書きが出る', async () => {
    const panel = mount([rec('1'), rec('2')]);
    const row = rowsOf(panel)[0];
    assert.ok(row, '右クリックを受ける口が一覧に無い');
    await row.dispatch('contextmenu', { clientX: 10, clientY: 20, preventDefault() {} });
    assert.ok(menuItems(panel).length >= 1, '品書きが出ていない');
    assert.ok(menuItems(panel).some(text => text.includes('削除')), 'まとめて削除が無い');
});

// --- 献立の入れ替え（2026-08-26 利用者の指示）------------------------------

test('外した3つは、もう出さない', async () => {
    /*
     * どれも**同じ場所への入口が別に在る**ので外した:
     *   不足モデルを落とす … 選択の帯に同じ口
     *   お気に入り        … 各行に☆
     *   選択を解除        … 帯の「解除」
     */
    const panel = mount([rec('1')], {
        downloadIo: { start: async () => ({ ok: true }) },
        modelsIo: { plan: async () => ({ ok: true, files: [] }) },
        batchIo: {},
    });
    await rowsOf(panel)[0].dispatch('contextmenu', { clientX: 0, clientY: 0, preventDefault() {} });
    const items = menuItems(panel).join(' / ');
    for (const gone of ['不足モデルを落とす', 'お気に入り', '選択を解除']) {
        assert.ok(!items.includes(gone), `外したはずの項目が出ている: ${gone}（${items}）`);
    }
});

test('使用モデルの削除が、その1件の面を開く', async () => {
    // **`openModels` は書いてあったが、画面から呼ぶ道が1本も無かった**
    //（到達性の棚卸しで判明）。ここが唯一の入口になる。
    let asked = null;
    const panel = mount([rec('1'), rec('2')], {
        modelsIo: {
            plan: async () => ({ ok: true, files: [], bytes: 0 }),
            usage: async () => ({ ok: true, records: [] }),
            remove: async () => ({ ok: true }),
        },
        loadRecord: async (id) => { asked = String(id); return { gen_params: {}, loras: [] }; },
    });
    await rowsOf(panel)[1].dispatch('contextmenu', { clientX: 0, clientY: 0, preventDefault() {} });
    const button = panel.root.allByClass('unbake-context-item')
        .find(node => node.textContent.includes('使用モデル'));
    assert.ok(button, `使用モデルの口が無い: ${menuItems(panel).join(' / ')}`);
    // **右クリックした1件が相手。** 選択の件数とは関係が無いことを説明に書く。
    assert.match(button.getAttribute('title') || '', /選んでいる件数とは関係ありません/,
        '選択と関係が無いことを言っていない');
    await button.dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(asked, '2', `右クリックした件を開いていない: ${asked}`);
    assert.ok(panel.root.byClass('unbake-models'), '使用モデルの面が開いていない');
});

test('口が無ければ、使用モデルの項目を出さない', async () => {
    // **押しても何も起きない口を置かない。**
    const panel = mount([rec('1')]);
    await rowsOf(panel)[0].dispatch('contextmenu', { clientX: 0, clientY: 0, preventDefault() {} });
    assert.ok(!menuItems(panel).some(text => text.includes('使用モデル')),
        '口が無いのに項目を出している');
});

test('再現が、選んだ件数ぶんを1件ずつ流す', async () => {
    /*
     * **「再現」は ▶ と同じ意味。** 最初は帯の「まとめて出す」へ繋いだが、
     * あちらは**種を振る**道で、実測すると1件あたり3枚出た
     *（`civitai_137676446_00002〜00004`）。同じ語で違う動きにしない。
     */
    const runs = [];
    const panel = mount([rec('1'), rec('2'), rec('3')], {
        loadRecord: async (id) => { runs.push(String(id)); return { gen_params: { seed: 1 }, loras: [] }; },
        makeSweepRunner: () => ({ run: async () => ({ cells: [] }) }),
        loadVariants: async () => ({ outputs: [] }),
        loadFreshOutputs: async () => [],
    });
    const boxes = panel.root.allByClass('unbake-pick');
    for (const box of boxes.slice(0, 2)) { box.checked = true; await box.dispatch('click', {}); }
    await rowsOf(panel)[0].dispatch('contextmenu', { clientX: 0, clientY: 0, preventDefault() {} });
    const button = panel.root.allByClass('unbake-context-item')
        .find(node => node.textContent.includes('再現'));
    assert.ok(button, `再現の口が無い: ${menuItems(panel).join(' / ')}`);
    assert.match(button.textContent, /2 件/, `件数が出ていない: ${button.textContent}`);
    await button.dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 60));
    // **選んだ2件が、それぞれ1回ずつ流れる。**
    assert.deepEqual(runs.sort(), ['1', '2'], `流れた顔ぶれが違う: ${runs.join(' / ')}`);
});

test('書庫から取り直せなければ、再現の項目を出さない', async () => {
    // **▶ と同じ条件。** 取り直せないと再現できないので、押せない口になる。
    const panel = mount([rec('1')]);
    await rowsOf(panel)[0].dispatch('contextmenu', { clientX: 0, clientY: 0, preventDefault() {} });
    assert.ok(!menuItems(panel).some(text => text.includes('再現')),
        '取り直せないのに項目を出している');
});

test('選んでいないものを右クリックすると、それだけが選ばれる', async () => {
    const panel = mount([rec('1'), rec('2'), rec('3')]);
    const rows = rowsOf(panel);
    assert.equal(rows.length, 3);
    await rows[1].dispatch('contextmenu', { clientX: 0, clientY: 0, preventDefault() {} });
    // **見ている物と操作する物を一致させる。** ここがずれると、
    // 画面外の選択を消すことになる。
    assert.match(menuItems(panel)[0], /1 件/, `選択が1件になっていない: ${menuItems(panel)[0]}`);
});

test('まとめて削除が、選んだ件数ぶん実際に消す', async () => {
    const removed = [];
    const panel = mount([rec('1'), rec('2'), rec('3')], {
        recordsIo: { remove: async (id) => { removed.push(String(id)); return { ok: true }; } },
    });
    // 2件だけ選ぶ。
    const boxes = panel.root.allByClass('unbake-pick');
    boxes[0].checked = true; boxes[0].setAttribute('data-checked', 'true');
    await boxes[0].dispatch('click', {});
    const boxes2 = panel.root.allByClass('unbake-pick');
    boxes2[1].checked = true; boxes2[1].setAttribute('data-checked', 'true');
    await boxes2[1].dispatch('click', {});

    const rows = rowsOf(panel);
    await rows[0].dispatch('contextmenu', { clientX: 0, clientY: 0, preventDefault() {} });
    const del = panel.root.allByClass('unbake-context-item')
        .find(node => node.textContent.includes('削除'));
    assert.ok(del, 'まとめて削除の項目が無い');
    await del.dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 0));

    // **押した結果を見る。** 品書きが出ることだけを見ていると、
    // 配線が外れても緑のままになる。
    assert.deepEqual(removed.sort(), ['1', '2'], `消した相手が違う: ${removed}`);
});

test('Escape で品書きだけが畳まれる（選択は残る）', async () => {
    const panel = mount([rec('1'), rec('2')]);
    const rows = rowsOf(panel);
    await rows[0].dispatch('contextmenu', { clientX: 0, clientY: 0, preventDefault() {} });
    assert.ok(menuItems(panel).length > 0);
    await panel.root.dispatch('keydown', {
        key: 'Escape', preventDefault() {}, stopPropagation() {},
    });
    assert.equal(menuItems(panel).length, 0, '品書きが残っている');
    // **選択まで消さない。** 消すと、畳んだだけのつもりが操作対象を失う。
    const chosen = rowsOf(panel).filter(node => node.getAttribute('data-selected') === 'true');
    assert.equal(chosen.length, 1, 'Escape が選択まで消している');
});

// --- まとめて押しても、投げるのは1件ずつ（2026-08-26 実機）------------------

test('まとめて再現しても、同時に走るのは1件だけ', async () => {
    /*
     * **実機で ComfyUI に2件同時に居た。**
     *
     *   3.5秒 走り 1 ・待ち 1   ← 記録3件を右クリックから再現
     *
     * 近道（走っている裏で押されたら、既に絵が在るなら待たせない）は
     * 実行器を直に呼ぶ。実行器は「投げる直前にキューが空か」を見るので、
     * **1件目の投入がまだ着いていない隙に2件目も通る**——同じ拍で何件も
     * 押されると競走になる。
     *
     * 絵の対応は壊れないが、**「1件ずつしか投げない」という約束が破れる**。
     */
    let running = 0;
    let peak = 0;
    const order = [];
    const panel = mount([rec('1'), rec('2'), rec('3')], {
        loadRecord: async (id) => ({ id, gen_params: { seed: 1 }, loras: [] }),
        makeSweepRunner: (record) => ({
            run: async () => {
                running += 1;
                peak = Math.max(peak, running);
                order.push(String(record?.id ?? ''));
                await new Promise(resolve => setTimeout(resolve, 25));
                running -= 1;
                return { cells: [] };
            },
        }),
        loadVariants: async () => ({ outputs: [] }),
        loadFreshOutputs: async () => [],
    });
    const boxes = panel.root.allByClass('unbake-pick');
    for (const box of boxes) { box.checked = true; await box.dispatch('click', {}); }
    await rowsOf(panel)[0].dispatch('contextmenu', { clientX: 0, clientY: 0, preventDefault() {} });
    await panel.root.allByClass('unbake-context-item')
        .find(node => node.textContent.includes('再現')).dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(peak, 1, `同時に ${peak} 件走った（1件ずつのはず）`);
    assert.equal(order.length, 3, `流れた件数が違う: ${order.join(' / ')}`);
});

test('まとめて押した分は、待っている姿が見える', async () => {
    // **⏸ が一度も出ないと、待っていることが誰にも見えない。**
    const panel = mount([rec('1'), rec('2'), rec('3')], {
        loadRecord: async (id) => ({ id, gen_params: { seed: 1 }, loras: [] }),
        makeSweepRunner: () => ({
            run: async () => { await new Promise(r => setTimeout(r, 40)); return { cells: [] }; },
        }),
        loadVariants: async () => ({ outputs: [] }),
        loadFreshOutputs: async () => [],
    });
    const boxes = panel.root.allByClass('unbake-pick');
    for (const box of boxes) { box.checked = true; await box.dispatch('click', {}); }
    await rowsOf(panel)[0].dispatch('contextmenu', { clientX: 0, clientY: 0, preventDefault() {} });
    panel.root.allByClass('unbake-context-item')
        .find(node => node.textContent.includes('再現')).dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 10));
    const marks = panel.root.findAll(n => n.className === 'unbake-act unbake-act-replay')
        .map(n => n.textContent);
    const waiting = marks.filter(m => m === '⏸').length;
    assert.ok(waiting >= 1, `待っている姿が出ていない: ${marks.join(' ')}`);
});

/*
 * **まとめての再現は、取り消しにならない**（2026-08-27 実機
 * 「複数選択からの右クリックメニューの再現が機能しない」）。
 *
 * ▶ は同じ的を押し直すので「もう一度押す＝並びから外す」で読める。
 * **品書きの「選んだ N 件を再現」は別の的で、しかも N 件をまとめて相手にする**
 * ——並んでいる分が混じっていると、その分だけが黙って取り消され、
 * 押した人からは「再現しろと言ったのに始まらない」に見える。
 */
test('まとめての再現を2度押しても、並んだ分が取り消されない', async () => {
    const runs = [];
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const panel = mount([rec('1'), rec('2'), rec('3')], {
        loadRecord: async (id) => { runs.push(String(id)); return { gen_params: { seed: 1 }, loras: [] }; },
        // 1件目を握ったままにして、**2件目3件目が並んでいる状態**を作る。
        makeSweepRunner: () => ({ run: async () => { await held; return { cells: [] }; } }),
        loadVariants: async () => ({ outputs: [] }),
        loadFreshOutputs: async () => [],
    });
    const boxes = panel.root.allByClass('unbake-pick');
    for (const box of boxes) { box.checked = true; await box.dispatch('click', {}); }

    const fire = async () => {
        await rowsOf(panel)[0].dispatch('contextmenu', { clientX: 0, clientY: 0, preventDefault() {} });
        const button = panel.root.allByClass('unbake-context-item')
            .find(node => node.textContent.includes('再現'));
        assert.ok(button, '再現の口が無い');
        await button.dispatch('click', {});
        await new Promise(resolve => setTimeout(resolve, 20));
    };

    await fire();
    // 1件目が握られている間に、**もう一度まとめて再現を押す。**
    await fire();
    release();
    await new Promise(resolve => setTimeout(resolve, 80));

    // **3件とも1回ずつ流れる。** 取り消されていたら顔ぶれが欠け、
    // 二重に並んでいたら同じ id が2回出る。
    assert.deepEqual(runs.sort(), ['1', '2', '3'],
        `2度押しで顔ぶれが変わった: ${runs.join(' / ')}`);
});

// --- 一括だけは飛ばさない（2026-08-27 利用者の指示）------------------------

test('選んだ N 件の再現は、絵が在っても飛ばさない', async () => {
    /*
     * **単押しと一括で意味が違う。**
     *
     *     ▶ の単押し        … 「見せて。無ければ作って」→ 絵が在るなら並びに入れない
     *     選んだ N 件を再現 … 「必ず作って」          → **絵が在っても飛ばさない**
     *
     * 飛ばすと *「再現しろと言ったのに何件かが黙って抜ける」* になる。
     * ここは**3件とも絵を持っている**状態で流し、**3件とも走る**ことを数える。
     */
    const ran = [];
    const panel = mount([rec('1'), rec('2'), rec('3')], {
        loadRecord: async (id) => ({ id, gen_params: { seed: 1 }, loras: [] }),
        // **全件が既に絵を持っている**——単押しなら1件も並ばない状況。
        loadFreshOutputs: async (record) => [{ url: `/api/view?filename=${record.id}.png` }],
        loadVariants: async (record) => ({ outputs: [{ url: `/api/view?filename=${record.id}.png` }] }),
        makeSweepRunner: () => ({
            run: async (options) => {
                ran.push(String(options?.record?.id ?? '?'));
                return { cells: [] };
            },
        }),
    });
    for (const box of panel.root.allByClass('unbake-pick')) {
        box.checked = true;
        await box.dispatch('click', {});
    }
    await rowsOf(panel)[0].dispatch('contextmenu', { clientX: 0, clientY: 0, preventDefault() {} });
    panel.root.allByClass('unbake-context-item')
        .find(node => node.textContent.includes('再現')).dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual(ran.slice().sort(), ['1', '2', '3'],
        `絵が在る記録が飛ばされた（走ったのは ${ran.join(' / ') || 'なし'}）`);
});
