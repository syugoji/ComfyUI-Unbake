/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **2026-08-27 実機の報告**（どちらも「見比べ」の面）。
 *
 * ---
 *
 * **① 単押しと一括で、意味を分ける**（利用者の指示・2026-08-27）。
 *
 *     ▶ の単押し        … 「見せて。無ければ作って」→ **絵が在るなら並びに入れない**
 *     選んだ N 件を再現 … 「必ず作って」          → **絵が在っても飛ばさない**
 *
 * 経緯: 行列は**1件ずつしか流さない**ので（2本走らせると確認の面を奪い合い、
 * 前の1本の返事が永久に返らず行列ごと止まる）、既に絵が在るだけの記録も
 * 前の1件の後ろで ⏸ のまま待っていた——**押しても何も起きない**に見えた。
 * 一度は「並べたまま、今在る絵をその場で開く」で塞いだが、利用者から
 * **「絵が出た後も待機状態なのはおかしい」**と指摘され、上の形に落ち着いた。
 *
 * **一括だけは絶対に飛ばさない。** 飛ばすと
 * *「再現しろと言ったのに何件かが黙って抜ける」*になる
 * ——`enqueueReplay` の注記が名指しで避けている形そのもの。
 * その見張りは `context_menu_test.mjs` が持つ（品書きから実際に流して数える）。
 *
 * **`reproduceOne()` は呼ばない。** 読んで開くだけなので、投げも確認もせず、
 * 行列の約束（1件ずつ）に触れない。
 *
 * ---
 *
 * **② 見比べで、元画像の方だけが小さい。**
 *
 * 実測（窓 1402×1274・左右の列とも 683.8px）:
 *
 *     生成 832×1216 → 683.8×999.4（列いっぱいまで伸びた）
 *     元   480×701  → **480×701（伸びない）**
 *
 * `max-inline-size: 100%` は**上限**なので、列より小さい絵は原寸で止まる。
 * 1枚で見るときの規則は 2026-08-22 に同じ理由で直してあり、
 * **左右に並べるときだけ直っていなかった。**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createUnbakePanel } from '../web/panel/panel.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale, t } from '../web/i18n/index.js';

setLocale('ja');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const rec = (id) => ({ id, title: id.toUpperCase(), recipe: { id, gen_params: { seed: 1 } } });

/** 何度か手番を回す（`await` の連鎖を進めるだけ）。 */
async function settle(times = 6) {
    for (let i = 0; i < times; i += 1) await new Promise(r => setTimeout(r, 0));
}

/**
 * @param {Record<string, Array<{url: string}>|Promise<Array<{url: string}>>>} outputs
 */
function mount(outputs = {}, { hold = new Promise(() => {}), display = {}, cells = [] } = {}) {
    const doc = fakeDocument();
    const node = doc.createElement('div');
    node.ownerDocument = doc;
    // 既定は**止まったまま返らない**——1件目を「走り続けている」状態に固定する。
    const ran = [];
    const panel = createUnbakePanel(node, {
        documentRef: doc, mode: 'sidebar', width: 1200, display,
        loadFreshOutputs: async (record) => outputs[record?.id] || [],
        makeSweepRunner: () => ({
            inputsReady: hold,
            requireEmptyQueue: async () => {},
            run: async (options) => { ran.push(options?.record?.id ?? '?'); return { cells }; },
        }),
    });
    panel.setRecords(['a', 'b', 'c'].map(rec));
    return { doc, panel, ran };
}

const replayButtons = (panel) =>
    panel.root.findAll(n => String(n.className || '').includes('unbake-act-replay'));

const compareSrcs = (panel) => {
    const box = panel.root.find(n => String(n.className || '') === 'unbake-compare');
    if (!box) return null;
    const walk = (node, out = []) => {
        out.push(node);
        for (const child of node.children || []) walk(child, out);
        return out;
    };
    return walk(box)
        .filter(n => String(n.className || '').includes('unbake-compare-image'))
        .map(n => n.getAttribute('src'))
        .filter(Boolean)
        // **控えを外して比べる。** `openCompare` は同じ URL の古い中身が出るのを
        // 避けるため `_ub=<時刻>` を足す（2026-08-27 の別の修正）。
        // 付いたまま等値で比べると、**中身は正しいのに毎回落ちる**検査になる。
        .map(url => url.replace(/[?&]_ub=[^&]*/, ''));
};

// --- ① 待たされている間も、今在る絵は開く ----------------------------------

test('走っている裏で押した記録は、今在る絵をその場で開く', async () => {
    const { panel } = mount({ b: [{ url: '/api/view?filename=b_1.png' }] });
    const buttons = replayButtons(panel);
    buttons[0].dispatch('click', {});          // A が走り出して返ってこない
    await settle();
    buttons[1].dispatch('click', {});          // B は行列で待つ
    await settle();
    const srcs = compareSrcs(panel);
    assert.ok(srcs, '既に絵が在るのに見比べが出ない（押しても何も起きないに見える）');
    assert.ok(srcs.includes('/api/view?filename=b_1.png'),
        `押した記録の絵が出ていない: ${JSON.stringify(srcs)}`);
});

test('単押しは、絵が在るなら並びに入れない', async () => {
    // **利用者の指示**（2026-08-27）。見せたら終わり——⏸ を残さない。
    const { panel } = mount({ b: [{ url: '/api/view?filename=b_1.png' }] });
    const buttons = replayButtons(panel);
    buttons[0].dispatch('click', {});
    await settle();
    buttons[1].dispatch('click', {});
    await settle();
    const again = replayButtons(panel)[1];
    assert.equal(again.getAttribute('data-held'), 'false',
        '絵を見せたのに待ちの札が残っている（終わったのに止まって見える）');
    assert.equal(again.getAttribute('data-busy'), 'false', '走っている札が付いている');
});

test('単押しでも、絵が無いなら並びに入る', async () => {
    // **「見せて」だけの口にしない。** 無い時は今までどおり作る。
    const { panel } = mount({});
    const buttons = replayButtons(panel);
    buttons[0].dispatch('click', {});
    await settle();
    buttons[1].dispatch('click', {});
    await settle();
    assert.equal(replayButtons(panel)[1].getAttribute('data-held'), 'true',
        '絵が無いのに並ばない（押しても何も起きない）');
});

test('絵が無いなら黙る（前に出ていた見比べを畳まない）', async () => {
    /*
     * **畳むと、たった今出た前の1件の絵が消える。** 2026-08-27 に一度
     * 「始めるときに畳む」で直そうとして戻した所と同じ穴なので、ここでも掘らない。
     */
    const { panel } = mount({ b: [{ url: '/api/view?filename=b_1.png' }] });
    const buttons = replayButtons(panel);
    buttons[0].dispatch('click', {});
    await settle();
    buttons[1].dispatch('click', {});
    await settle();
    assert.ok(compareSrcs(panel), '前提が崩れている（B の見比べが出ていない）');
    replayButtons(panel)[2].dispatch('click', {});   // C は絵を持たない
    await settle();
    const srcs = compareSrcs(panel);
    assert.ok(srcs && srcs.includes('/api/view?filename=b_1.png'),
        `絵の無い記録を押したら、前の見比べまで消えた: ${JSON.stringify(srcs)}`);
});

test('遅れて届いた分で、後から押した記録の絵を上書きしない', async () => {
    // **読みに行くのは非同期。** 先に押した方が遅れて返ると、
    // **画面には後から押した記録が出ているのに、中身は前の記録**になる。
    let releaseB;
    const slowB = new Promise((r) => { releaseB = r; });
    const { panel } = mount({
        b: slowB,
        c: [{ url: '/api/view?filename=c_1.png' }],
    });
    const buttons = replayButtons(panel);
    buttons[0].dispatch('click', {});
    await settle();
    buttons[1].dispatch('click', {});          // B（遅い）
    buttons[2].dispatch('click', {});          // C（速い）
    await settle();
    assert.deepEqual(compareSrcs(panel), ['/api/view?filename=c_1.png'],
        '後から押した C が出ていない（この検査が空振りしている）');
    releaseB([{ url: '/api/view?filename=b_1.png' }]);
    await settle();
    assert.deepEqual(compareSrcs(panel), ['/api/view?filename=c_1.png'],
        '遅れて返った B が、見ている C の絵を差し替えた');
});

// --- ② 左右に並べたとき、どちらも列いっぱいまで伸びる ----------------------

test('見比べの絵は、左右に並べても列いっぱいまで伸びる', async () => {
    const css = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');
    const head = `
.unbake-compare-image {`;
    const at = css.indexOf(head);
    assert.notEqual(at, -1, '見比べの絵の規則が見つからない（改名を見逃している）');
    const body = css.slice(at + head.length, css.indexOf('}', at));
    /*
     * **`max-inline-size` だけでは足りない。** 上限なので、列より小さい絵は
     * 原寸で止まる（実測: 元 480px / 生成 683.8px）。
     * **`inline-size` そのもの**を要求する。
     */
    const width = /(?:^|[;{\s])inline-size:\s*([^;]+);/.exec(body);
    assert.ok(width, '横幅を決めていない（小さい絵が原寸で止まり、片方だけ小さく見える）');
    assert.equal(width[1].trim(), '100%', `列いっぱいまで伸びない: ${width[1]}`);
    /*
     * **高さは列の残りから取る。** 幅だけ揃えても、**比率の違う組では
     * 高さが割れる**——実測（窓 1000×560・生成 832×1216 と 元 512×512）:
     *
     *     flex あり → 両方 483×520
     *     flex なし → 生成 483×520 ／ **元 483×483**
     *
     * （**「`calc` だとはみ出す」は書きかけて取り消した。** 対照を測ったら
     * はみ出しは 0 で、確かめていない主張だった。）
     */
    assert.match(body, /flex:\s*1\s+1\s/, '比率の違う組で、絵の高さが割れる');
    assert.match(body, /object-fit:\s*contain/, '比率を保っていない');
});

test('1枚で見るときの規則と、扱いが揃っている', async () => {
    // **片方だけ直す形にしない**——2026-08-22 に1枚側だけを直した結果、
    // 左右に並べたときの同じ欠陥が5日間残った。
    const css = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');
    const head = `
.unbake-compare-pair[data-single="true"] .unbake-compare-image {`;
    const at = css.indexOf(head);
    assert.notEqual(at, -1, '1枚で見るときの規則が見つからない');
    const body = css.slice(at + head.length, css.indexOf('}', at));
    assert.match(body, /(?:^|[;{\s])inline-size:\s*100%/,
        '1枚側が列いっぱいまで伸びない（左右側と扱いが食い違う）');
});

// --- 待っている札が「終わったのに止まっている」に見えないこと ----------------

test('今在る絵だと札に書き、作り直し方も書く', async () => {
    /*
     * **2026-08-27 利用者の報告**「比較画像が表示された後も再生待機状態と
     * なっているようです」。待っているのは正しい（下の検査で確かめる）が、
     * **絵が出たのに ⏸ のまま**なので「終わったのに止まっている」に見えた。
     * 直せるのは**説明が画面に無いこと**の方。
     */
    const { panel } = mount({ b: [{ url: '/api/view?filename=b_1.png' }] });
    const buttons = replayButtons(panel);
    buttons[0].dispatch('click', {});
    await settle();
    buttons[1].dispatch('click', {});
    await settle();
    const box = panel.root.find(n => String(n.className || '') === 'unbake-compare');
    assert.ok(box, '見比べが出ていない（この検査が空振りしている）');
    const captions = [];
    const walk = (node) => {
        if (String(node.className || '').includes('unbake-compare-caption')) {
            captions.push(String(node.textContent || ''));
        }
        for (const child of node.children || []) walk(child);
    };
    walk(box);
    assert.ok(captions.includes(t('replay.alreadyMade')),
        `今在る絵だと書いていない: ${JSON.stringify(captions)}`);
    assert.ok(!captions.includes(t('replay.result')),
        '作り直した絵と同じ札を出している（作っていないのに作ったと読める）');
});

test('前の1件が終われば、待っていた記録もちゃんと走る', async () => {
    /*
     * **「止まっている」ではないことを、実際に走らせて確かめる。**
     * 札の文言だけ直して、裏で本当に詰まっていたら意味が無い。
     */
    let release;
    const hold = new Promise((r) => { release = r; });
    // **b は絵を持たない**——単押しで並ぶのはこちらだけになった。
    const { panel, ran } = mount({}, { hold });
    const buttons = replayButtons(panel);
    buttons[0].dispatch('click', {});
    await settle();
    buttons[1].dispatch('click', {});
    await settle();
    assert.deepEqual(ran, [], '1件目がまだ走り終わっていない前提が崩れている');
    release();
    await settle(40);
    assert.deepEqual(ran, ['a', 'b'], `待っていた分が走っていない: ${JSON.stringify(ran)}`);
    const after = replayButtons(panel)[1];
    assert.equal(after.getAttribute('data-held'), 'false', '走り終わっても待ちの札が残っている');
    assert.equal(after.getAttribute('data-busy'), 'false', '走り終わっても走っている札が残っている');
});

test('やめたいときは、もう一度 ▶ で並びから外れる', async () => {
    // **外す道は要る。** 「見るだけのつもりだった」が普通に起きるので、
    // 並びに残す設計にする以上、取りやめの口が無いと閉じ込めになる。
    const { panel } = mount({});   // 絵が無いので並ぶ
    const buttons = replayButtons(panel);
    buttons[0].dispatch('click', {});
    await settle();
    buttons[1].dispatch('click', {});
    await settle();
    assert.equal(replayButtons(panel)[1].getAttribute('data-held'), 'true', '並んでいない');
    replayButtons(panel)[1].dispatch('click', {});
    await settle();
    assert.equal(replayButtons(panel)[1].getAttribute('data-held'), 'false',
        'もう一度押しても並びから外れない（見るだけにできない）');
});

test('素早く2度押しても、並ぶのは1回だけ', async () => {
    /*
     * **絵が在るかを読みに行くのは非同期。** 2度目が「まだ並んでいない」うちに
     * 通ると、**同じ記録が二重に並んで2回走る**（`heldRecords` の見張りは、
     * 1度目が返るまで真にならない）。
     */
    const { panel, ran } = mount({}, { hold: Promise.resolve() });
    const button = replayButtons(panel)[1];
    button.dispatch('click', {});
    button.dispatch('click', {});
    await settle(40);
    assert.deepEqual(ran, ['b'], `同じ記録が二重に走った: ${JSON.stringify(ran)}`);
});

// --- 見比べを開かない設定（2026-08-28 利用者の指示）------------------------

const toastOf = (panel) => {
    const node = panel.root.find(n => String(n.className || '').includes('unbake-toast'));
    return node && node.getAttribute('data-open') === 'true' ? String(node.textContent || '') : '';
};

test('切ってあると、既に絵が在る記録の ▶ で見比べを開かず、下へ一言出す', async () => {
    const { panel } = mount(
        { b: [{ url: '/api/view?filename=b_1.png' }] },
        { display: { showCompare: false } },
    );
    const buttons = replayButtons(panel);
    buttons[0].dispatch('click', {});
    await settle();
    buttons[1].dispatch('click', {});
    await settle();
    assert.equal(compareSrcs(panel), null, '切ってあるのに見比べが開いた');
    assert.equal(toastOf(panel), t('replay.alreadyMade.quiet'),
        `下に一言出ていない: ${JSON.stringify(toastOf(panel))}`);
});

test('切ってあっても、絵が無ければ今までどおり並ぶ', async () => {
    // **設定は「開くか」だけ**——再現するかどうかには触らない。
    const { panel } = mount({}, { display: { showCompare: false } });
    const buttons = replayButtons(panel);
    buttons[0].dispatch('click', {});
    await settle();
    buttons[1].dispatch('click', {});
    await settle();
    assert.equal(replayButtons(panel)[1].getAttribute('data-held'), 'true',
        '設定を切ったら再現まで止まった');
});

test('既定では開く（設定を足しても、何も言わない人の見え方は変わらない）', async () => {
    const { panel } = mount({ b: [{ url: '/api/view?filename=b_1.png' }] });
    const buttons = replayButtons(panel);
    buttons[0].dispatch('click', {});
    await settle();
    buttons[1].dispatch('click', {});
    await settle();
    assert.ok(compareSrcs(panel), '既定で見比べが開かなくなっている');
});

test('切っても、絵を押して開く道は残る', async () => {
    /*
     * **設定で塞ぐのは「勝手に開く」だけ。** 押した人が今それを見たいと
     * 言っている道まで塞ぐと、**拡大して見る手段が丸ごと消える**。
     */
    const { panel } = mount({}, { display: { showCompare: false } });
    const shown = panel.openLightbox
        ? panel.openLightbox('/api/view?filename=x.png', 'x')
        : null;
    if (!shown) {
        // 面から呼べないなら、せめて設定が `openCompare` 自体を止めていないことを見る。
        const { readFile } = await import('node:fs/promises');
        const src = await readFile(join(ROOT, 'web/panel/panel.js'), 'utf8');
        const at = src.indexOf('function openCompare(record');
        const body = src.slice(at, at + 900);
        assert.ok(!body.includes('showCompare'),
            '設定が「絵を押して開く」まで塞いでいる');
        return;
    }
    assert.ok(compareSrcs(panel), '絵を押しても開かなくなっている');
});

test('切ってあるときは、本当に作った回も見比べを開かない（件数は言う）', async () => {
    /*
     * **「勝手に開かない」は、作った回にも効く。** 作った回だけ開いてしまうと、
     * 設定を切った意味が半分になる（一番よく開くのがこの回）。
     * **黙るわけではない**——「再現しました（N 枚）」は元から下に出る。
     */
    const { panel } = mount({}, {
        hold: Promise.resolve(),
        display: { showCompare: false },
        cells: [{ id: 'c1', status: 'completed', output: { url: '/api/view?filename=new.png' } }],
    });
    replayButtons(panel)[1].dispatch('click', {});
    await settle(40);
    assert.equal(compareSrcs(panel), null, '切ってあるのに、作った回で見比べが開いた');
    assert.equal(toastOf(panel), t('replay.done', { n: 1 }),
        `件数を言っていない: ${JSON.stringify(toastOf(panel))}`);
});

test('既定なら、作った回は見比べが開く', async () => {
    const { panel } = mount({}, {
        hold: Promise.resolve(),
        cells: [{ id: 'c1', status: 'completed', output: { url: '/api/view?filename=new.png' } }],
    });
    replayButtons(panel)[1].dispatch('click', {});
    await settle(40);
    assert.ok(compareSrcs(panel), '既定で見比べが開かなくなっている');
});

// --- 設定が画面まで届いているか（鎖を1本ずつ見る）--------------------------

test('見比べの設定は、既定値から画面まで鎖が繋がっている', async () => {
    /*
     * **どれか1本切れても、設定は「在るのに効かない／出てこない」になる。**
     * 変異で確かめたところ、鎖の3本（Python の既定値・設定欄・宿主の受け渡し）は
     * **どれを切っても検査が緑のまま**だった——**動きだけを見ていると、
     * 口が画面から消えたことに気づけない**（この面が前に踏んだ穴と同じ形）。
     */
    const { readFile } = await import('node:fs/promises');
    const read = (rel) => readFile(join(ROOT, rel), 'utf8');
    const KEY = 'show_compare';

    const py = await read('unbake/settings.py');
    assert.ok(py.includes(`"${KEY}"`), `既定値が無い（保存しても次に読めない）: ${KEY}`);

    const view = await read('web/panel/settingsView.js');
    assert.ok(view.includes(`key: '${KEY}'`), `設定の面に欄が無い（切り替えられない）: ${KEY}`);

    const host = await read('web/unbake.js');
    assert.ok(host.includes(`settings?.${KEY}`),
        `宿主が読み出していない（保存しても面へ届かない）: ${KEY}`);
    assert.ok(host.includes('showCompare:'), '宿主が面へ渡していない');

    const panel = await read('web/panel/panel.js');
    assert.ok(panel.includes('display?.showCompare'), '面が受け取っていない');

    // **訳が無いと、欄は出るのに名前が鍵のまま出る。**
    const { LOCALE_META, setLocale: pick, t: tr } = await import('../web/i18n/index.js');
    for (const locale of Object.keys(LOCALE_META || {})) {
        pick(locale);
        for (const key of ['settings.showCompare', 'settings.showCompare.help']) {
            assert.notEqual(tr(key), key, `${locale}: ${key} が無い`);
        }
    }
    pick('ja');
});

test('設定を切り替えたら、その場で効く（読み直さなくてよい）', async () => {
    /*
     * **文字列で見張らない。** 一度 `panel.js` に `next.show_compare` が
     * 在ることだけを見ていたが、**追随の分岐を潰しても本文に同じ語が残る**ので
     * 緑のままだった（変異で判明）。**実際に切り替えて、振る舞いで見る。**
     */
    const { panel } = mount({ b: [{ url: '/api/view?filename=b_1.png' }] });
    const press = async () => {
        const buttons = replayButtons(panel);
        buttons[1].dispatch('click', {});
        await settle();
    };
    await press();
    assert.ok(compareSrcs(panel), '既定で開いていない（この検査が空振りしている）');

    panel.applyDisplay({ show_compare: false });
    // 開いている面を畳んでから測り直す（残っていると「開いた」と読める）。
    const box = panel.root.find(n => String(n.className || '') === 'unbake-compare');
    box?.dispatch?.('click', {});
    assert.equal(compareSrcs(panel), null, '前提が崩れている（畳めていない）');
    await press();
    assert.equal(compareSrcs(panel), null, '切り替えても、まだ開く');
    assert.equal(toastOf(panel), t('replay.alreadyMade.quiet'), '下に一言出ていない');
});
