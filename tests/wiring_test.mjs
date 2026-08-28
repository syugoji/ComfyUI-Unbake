/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 工程0 — **断線を繋いだことを、繋がっていない状態が赤くなる形で固定する。**
 *
 * ここで固定するのは3本の断線で、どれも**壊れていても既存の検査は全部緑**だった:
 *
 *  1. **一覧 → 全画面.** `loadLibrary()` の呼び手はサイドバーの `render()` の中に
 *     1箇所しか無く、コマンドから開いた全画面は**常に0件**だった。
 *     既存の検査は2つの器を**構造の文字列**で比べていたので、
 *     **両方が空でも通っていた**——空の器2つは構造が同一である。
 *     ここでは**件数**で比べ、さらに**0件そのものを赤にする**。
 *  2. **一覧 → Sweep.** 既定のサイドバー幅は compact になり、CSS が Sweep 列を
 *     消していた。`querySelectorAll()` は隠れた要素も数えるので、
 *     DOM を見る検査では捕まらない。ここでは**CSS の規則そのもの**を見る。
 *  3. **ディスク → 画面.** 要約が12項目しか返さず、利用者が既に払った手作業
 *     （お気に入り・ライセンス・NSFW格付け）が画面へ届いていなかった。
 *     Python 側は `python_library_test.mjs`、写す側はここで見る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { libraryRowToRecord, registerUnbake } from '../web/unbake.js';
import { LOCK_META_NAME } from '../web/core/darkReaderLock.js';
import { createUnbakePanel } from '../web/panel/panel.js';
import { fakeDocument } from './fake_dom.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** マイクロタスクと `setTimeout(0)` の両方を1回ずつ流す。 */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * 器の幅を、**既定のサイドバー幅（実測 297px）**に固定する。
 *
 * `render()` は描くたびに `getBoundingClientRect()` で測り直す（実機で
 * `ResizeObserver` も `requestAnimationFrame` も空振りした経験からの仕掛け）。
 * 偽 DOM はそこで常に 900 を返すので、`setWidth()` だけでは**次の描画で戻る**。
 * 測る先そのものを差し替えないと、狭い器を再現したことにならない。
 */
function narrowTo(panel, width = 297) {
    panel.root.getBoundingClientRect = () => ({ width, height: 600 });
    panel.setWidth(width);
    return panel;
}

/** ComfyUI の `app` の最小のダブル。 */
function fakeApp() {
    const state = { extensions: [], tabs: [] };
    return {
        state,
        registerExtension(extension) { state.extensions.push(extension); },
        extensionManager: { registerSidebarTab: (tab) => state.tabs.push(tab) },
        ui: { settings: { getSettingValue: () => 'en' } },
    };
}

/**
 * `/unbake/records` のダブルを大域 `fetch` へ据える。
 *
 * **`installComfyHost()` は引数無しで呼ばれる**（実機と同じ経路）ので、
 * 差し替え口はここしか無い。返した配列は**呼ばれた URL を全部持つ**ので、
 * 「2回取っていない」を件数で言える。
 */
function stubRecordsEndpoint(rows, settings = null) {
    const calls = [];
    const previous = globalThis.fetch;
    globalThis.fetch = async (input) => {
        const url = String(input);
        calls.push(url);
        if (settings && url.startsWith('/unbake/settings')) {
            return { ok: true, status: 200, json: async () => ({ settings }) };
        }
        if (url.startsWith('/unbake/records')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    records: rows,
                    total: rows.length,
                    offset: 0,
                    errors: [],
                    sourceDirs: ['/fixture'],
                    outputDir: '',
                }),
            };
        }
        return { ok: false, status: 404, json: async () => ({}) };
    };
    calls.restore = () => { globalThis.fetch = previous; };
    return calls;
}

const rowsOf = (count) => Array.from({ length: count }, (_, i) => ({
    id: `rec-${i}`, title: `Record ${i}`, checkpoint: 'ck.safetensors',
    modified: 1000 - i, has_graph: false, preview: false,
}));

/** サイドバーを描いて、書庫が届くまで待つ。 */
async function mountSidebar(rows, settings = null) {
    const calls = stubRecordsEndpoint(rows, settings);
    const doc = fakeDocument();
    const app = fakeApp();
    const handle = registerUnbake(app, { documentRef: doc });
    await app.state.extensions[0].setup();
    const el = doc.createElement('div');
    const sidebar = app.state.tabs[0].render(el);
    await handle.whenLibraryReady();
    await settle();
    return { calls, doc, app, handle, sidebar };
}

// --- 断線1: 一覧 → 全画面 -------------------------------------------------

test('全画面はサイドバーと同じ件数の記録を持って開く（構造ではなく件数で比べる）', async () => {
    const { calls, app, sidebar } = await mountSidebar(rowsOf(20));
    try {
        assert.equal(sidebar.getRecords().length, 20, 'サイドバーに書庫が届いていない');

        const command = app.state.extensions[0].commands.find(c => c.id === 'Unbake.OpenFullscreen');
        const view = command.function();

        // **0件どうしを「一致」と読ませない。** これが元の検査の穴だった。
        assert.ok(view.panel.getRecords().length > 0,
            '全画面が0件で開いている（断線したままでも構造の比較なら通ってしまう）');
        assert.equal(view.panel.getRecords().length, sidebar.getRecords().length);
        view.close();
    } finally { calls.restore(); }
});

test('全画面を開いても書庫を取り直さない（応答は実測 226.3 KiB）', async () => {
    const { calls, app, sidebar } = await mountSidebar(rowsOf(5));
    try {
        const command = app.state.extensions[0].commands.find(c => c.id === 'Unbake.OpenFullscreen');
        command.function().close();
        command.function().close();
        await settle();
        const fetched = calls.filter(url => url.startsWith('/unbake/records'));
        assert.equal(fetched.length, 1,
            `書庫を ${fetched.length} 回取っている（器の数だけ取ってはいけない）`);
        assert.equal(sidebar.getRecords().length, 5);
    } finally { calls.restore(); }
});

test('全画面は、手持ちをそのまま受け取る（落とし込み分が消えない）', async () => {
    // **見たいのは、開いた全画面が手持ちをそのまま受け取るか。**
    // 元は「残り N 件」の口から開いていたが、行数の上限ごと 2026-08-25 に
    // 撤去したので、見出しの全画面ボタンから開く（行き先は同じ）。
    const { calls, doc, sidebar } = await mountSidebar(rowsOf(20));
    try {
        // 既定のサイドバー幅（実測 297px）と同じ密度にする。
        narrowTo(sidebar);
        assert.equal(sidebar.density, 'compact');

        // 書庫に無い記録を1件足す（落とし込みで入ってくるのがこれ）。
        sidebar.setRecords([
            { id: 'dropped', title: 'dropped png', verdict: 'reproducible' },
            ...sidebar.getRecords(),
        ]);
        assert.equal(sidebar.getRecords().length, 21);

        const open = sidebar.root.byClass('unbake-fullscreen-open');
        assert.ok(open, '全画面を開く口が無い');
        open.dispatch('click', {});
        await settle();

        const shell = doc.body.children.find(node => node.id === 'unbake-fullscreen');
        assert.ok(shell, '全画面の器が作られていない');
        const opened = shell.byClass('unbake-root');
        assert.ok(opened, '全画面にパネルが描かれていない');
        // **取り直すと 20 に戻る。** 21 であることが「手渡した」ことの証拠。
        //
        // **器は表とタイルの両方がありうる**（既定はタイル・2026-08-28 以降は
        // タイル表示のとき表を組まない）。数えたいのは件数なので、
        // 出ている方を数える——**器の違いでこの検査が落ちる意味は無い。**
        const rows = opened.allByClass('unbake-table')[0]
            ?.findAll(n => n.tagName === 'TR').length ?? 0;
        const tiles = opened.allByClass('unbake-tile')
            .filter(node => node.className === 'unbake-tile').length;
        const shown = Math.max(rows, tiles);
        assert.ok(shown >= 21,
            `全画面が ${shown} 件しか描いていない（取り直して落とし込み分が消えている）`);
    } finally { calls.restore(); }
});

// --- 断線2: 一覧 → Sweep --------------------------------------------------

/** compact のときに `display:none` される要素の一覧を CSS から読む。 */
function compactHiddenSelectors(css) {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const out = [];
    for (const match of clean.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        if (!/display\s*:\s*none/.test(match[2])) continue;
        for (const part of match[1].split(',')) {
            if (!part.includes('[data-density="compact"]')) continue;
            out.push(part.trim().split(/\s+/).at(-1));
        }
    }
    return out;
}

test('狭い器でも Sweep 列を CSS で消していない（DOM ではなく規則を見る）', () => {
    const css = readFileSync(join(ROOT, 'web/panel/theme.css'), 'utf8');
    const hidden = compactHiddenSelectors(css);

    assert.ok(!hidden.includes('.unbake-col-sweep'),
        '狭い器で Sweep 列を消している（既定のサイドバー幅では一覧が行き止まりになる）');

    // **検出器が生きていることを確かめる。** 消している列が1つも見つからなければ、
    // この検査は何も見ていないのに緑になる（沈黙する検査は合格に見える）。
    assert.ok(hidden.includes('.unbake-col-model'),
        '検出器が何も拾っていない（正規表現が CSS の形と合っていない）');
});

// **この検査は「見えている」を証明しない。** 実測（変異を入れて確かめた）:
// compact で Sweep 列を `display:none` へ戻しても、**この検査は緑のまま**だった。
// 偽 DOM も `querySelectorAll()` も隠れた要素を数えるので、見え方はここでは測れない。
// 見え方を担保するのは上の CSS の検査と、実機で `getBoundingClientRect().width > 0`
// を見ること。ここが押さえるのは「行ごとにセルを組み立ててはいる」だけ。
test('狭い器でも Sweep のセルを行ごとに組み立てている（見えているかは測っていない）', () => {
    const doc = fakeDocument();
    const el = doc.createElement('div');
    const panel = narrowTo(createUnbakePanel(el, {
        documentRef: doc, width: 297, makeSweepRunner: () => ({}),
        // **表示は表**（Sweep の列を数える検査）。面の既定はタイル。
        display: { listView: 'table' },
    }));
    panel.setRecords(rowsOf(3).map(libraryRowToRecord).map(r => ({ ...r, libraryId: r.id })));
    assert.equal(panel.density, 'compact');
    const cells = panel.root.allByClass('unbake-col-sweep');
    // 見出し1 ＋ 行3。
    assert.equal(cells.length, 4, `Sweep のセルが ${cells.length} 個しか無い`);
    panel.destroy();
});

// --- 断線3: ディスク → 画面 -----------------------------------------------

test('要約が持っている手作業の値を、記録へ写し落とさない', () => {
    const record = libraryRowToRecord({
        id: 'rec-1', title: 'T', checkpoint: 'ck', preview: true,
        base_model: 'SDXL', lora_count: 3, modified: 1755000000,
        has_graph: true, has_ui_graph: true,
        favorite: true,
        license: '全構成が画像販売可（Image/Sell・解決0）',
        commercial_ok: 'YES',
        license_source_url: 'https://example.invalid/x',
        license_checked_at: '2026-08-14',
        preview_nsfw_level: 16,
    });

    // 元から落ちていた3つ。
    assert.equal(record.baseModel, 'SDXL');
    assert.equal(record.loraCount, 3);
    assert.equal(record.modified, 1755000000);

    // 今回足した5つ。
    assert.equal(record.favorite, true);
    assert.equal(record.commercialOk, 'YES');
    assert.equal(record.licenseSourceUrl, 'https://example.invalid/x');
    assert.equal(record.licenseCheckedAt, '2026-08-14');
    assert.equal(record.nsfwLevel, 16);

    // API グラフと UI グラフは別の列（OR で潰さない）。
    assert.equal(record.hasGraph, true);
    assert.equal(record.hasUiGraph, true);
});

test('格付けの無い記録を「安全」に化けさせない（未格付けは null のまま）', () => {
    const record = libraryRowToRecord({ id: 'rec-2', title: 'T' });
    assert.equal(record.nsfwLevel, null, '未格付けが 0（安全と判定された）に丸められている');
    assert.equal(record.favorite, false);
    assert.equal(record.licenseCheckedAt, null);
    assert.equal(record.hasUiGraph, false);
});

test('判定日を持たない商用可否を作らない（値と日付は必ず対で写す）', () => {
    const row = { id: 'rec-3', title: 'T', commercial_ok: 'NO', license_checked_at: '2026-08-14' };
    const record = libraryRowToRecord(row);
    assert.ok(record.commercialOk && record.licenseCheckedAt,
        '商用可否だけが写り、いつの分類かが読めない形になっている');
});

// --- 順番待ちが宿主のキューを見に行く口（2026-08-24）------------------------

test('宿主のキューを読む口が、面まで繋がっている', async () => {
    // **口を渡し忘れても、面の検査は全部緑のまま通る**（ダブルを自分で渡すので）。
    // 渡っていなければ機能は製品の中で死んでいるのに、誰も赤くならない
    // ——実際に変異で確かめたら、名前を変えても1件も落ちなかった。
    const { readFile } = await import('node:fs/promises');
    const entry = await readFile(join(ROOT, 'web/unbake.js'), 'utf8');
    assert.match(entry, /^\s*async hostQueue\(\) \{/m,
        '宿主のキューを読む口が入口に無い（面は永久に待たない）');
    assert.match(entry, /fetch\('\/queue'/, 'キューの実物を読んでいない');

    const panel = await readFile(join(ROOT, 'web/panel/panel.js'), 'utf8');
    assert.match(panel, /^\s*hostQueue = null,/m, '面が口を受け取っていない');
    assert.match(panel, /await waitForHostQueue\(key\)/, '順番待ちが口を使っていない');
});

// --- サイドバーのアイコン（2026-08-22 利用者の指示）--------------------------

test('アイコンは専用の印で、絵はリポジトリに在る', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(join(ROOT, 'web/unbake.js'), 'utf8');
    // **`pi pi-images` は並びの他の面と同じ絵だった**——どれが Unbake か判らない。
    assert.doesNotMatch(source, /icon:\s*'pi /, '汎用のアイコンへ戻っている');
    assert.match(source, /icon:\s*'unbake-icon'/, '専用の印を指していない');

    /*
     * **見るのはマスク用の方**（2026-08-29 に役割を入れ替えた）。
     *
     * `icon.svg` は Registry のカードが指している URL で、**指し先は提出時に
     * 焼き込まれて動かせない**。だからその URL が返す中身をカード用（板つき）に
     * して、`mask-image` として当てる silhouette は `icon-mask.svg` へ移した。
     * 下の「自分の色を持たない」はマスクの条件なので、こちらへ当てる。
     */
    const svg = await readFile(join(ROOT, 'web/icon-mask.svg'), 'utf8');
    assert.match(svg, /<svg[^>]*viewBox="0 0 24 24"/, '大きさの基準が無い');

    // **形は3度変えている**（枠＋帯 → 帯を傾ける → ↺＋行 → 割れる卵）。
    // 絵柄そのものは好みで変わるので、**ここでは絵柄を固定しない**——
    // 代わりに、**16px で使えるための条件**だけを見る。
    //
    // 6案を実寸で並べて判ったのは「輪郭が閉じていて、内側に細い隙間を
    // 持たない形が強い」ということだった。**残しているのは結論だけで、
    // 候補そのものは配布物に入れていない**（作業用の素材なので）。

    // **自分の色を持たない。** `currentColor` に乗せるので、黒以外を塗ると
    // マスクにしたときの見え方が読めなくなる。
    // **先読みで弾かず、拾ってから外す。** 読みやすい方を採る
    //（否定先読みは、境界の扱いを1文字読み違えるだけで通ってしまう）。
    const allowed = new Set(['none', '#000']);
    const colours = [...svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)]
        .map(m => m[1])
        .filter(value => !allowed.has(value));
    assert.deepEqual(colours, [], `色を持っている: ${colours.join(' / ')}`);
    assert.doesNotMatch(svg, /<style/, '面の外から色を持ち込んでいる');

    // **形の数を絞る。** 増やすほど 16px で潰れる（実測で判った唯一の条件）。
    const shapes = (svg.match(/<(?:path|rect|circle|ellipse|polygon|line)\b/g) || []).length;
    assert.ok(shapes >= 1, '描く形が無い');
    assert.ok(shapes <= 6, `形が多すぎる（${shapes}）——16px で潰れる`);

    const css = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');
    // **色は `currentColor` から。** 背景画像だと1色に固定され、選択中と
    // 非選択で宿主が変える字の色に付いていけない。
    assert.match(css, /\.unbake-icon\s*\{[^}]*background-color:\s*currentColor/,
        '色が字の色に乗っていない');
    assert.match(css, /\.unbake-icon\s*\{[^}]*mask-image/, 'マスクで当てていない');
});

test('面より先に style を入れる（最初の一瞬だけ空白にしない）', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(join(ROOT, 'web/unbake.js'), 'utf8');
    // **呼び出しの形で探す。** ただの名前だと、冒頭の説明書きに当たる
    // （`registerSidebarTab` はこのファイルに2度出る）。
    const at = source.indexOf('registerSidebarTab?.(');
    assert.ok(at > 0, '登録している場所を見つけられない＝走査が壊れている');
    const before = source.slice(Math.max(0, at - 600), at);
    // 宿主はタブのボタンを登録した時点で描く。
    assert.match(before, /ensureStyle\(/, 'アイコンの規則が間に合わない');
});

// --- 保存する本体の選び方（2026-08-22 利用者の報告）--------------------------

test('本体を別に持たない記録も保存できる（落として作った分）', async () => {
    const { recordSaveBody } = await import('../web/unbake.js');

    // 書庫の記録は本体を別に持つ——**要約から復元すると項目が落ちる**ので、
    // 在るならそちらを採る。
    const withRecipe = recordSaveBody({
        id: 'a', title: '要約', verdict: 'blocked',
        recipe: { id: 'a', title: '本体', gen_params: { seed: 1 } },
    });
    assert.equal(withRecipe.title, '本体', '要約の方を送っている');
    assert.equal(withRecipe.verdict, undefined, '画面だけの値を焼き込んでいる');

    // **取り込みで作った記録は、記録そのものが本体。** ここで断ると
    // 保存できず、絵も出ず、消せず、名前も付かない（`no-recipe` の報告）。
    const dropped = recordSaveBody({
        id: 'b', title: 'civitai_123', gen_params: { seed: 7 },
        loras: [{ file_name: 'x' }], origin: { kind: 'civitai', url: 'https://civitai.com/images/123' },
        verdict: 'approximate', previewUrl: '/unbake/record-preview?id=b', loraCount: 1,
    });
    assert.equal(dropped.id, 'b');
    assert.equal(dropped.gen_params.seed, 7, '本体の値が落ちている');
    assert.deepEqual(dropped.origin.kind, 'civitai', '出典が落ちている');
    // **毎回作り直せる値は書かない。** 焼き込むと古い値がディスクに残る。
    for (const key of ['verdict', 'previewUrl', 'loraCount']) {
        assert.equal(dropped[key], undefined, `${key} を焼き込んでいる`);
    }
});

test('書くものが無ければ、書かないと言う', async () => {
    const { recordSaveBody } = await import('../web/unbake.js');
    assert.equal(recordSaveBody(null), null);
    assert.equal(recordSaveBody('x'), null);
    // **画面だけの値しか無い記録は、書いても意味が無い。**
    assert.equal(recordSaveBody({ verdict: 'blocked', previewUrl: '/p' }), null);
});

// --- 外部への問い合わせの本数（2026-08-24 利用者の指示）---------------------

test('外部への問い合わせは、一度に流す本数を絞る', async () => {
    // 版IDの数だけ同時に投げていた（実測: 中央値5・最大12 per レシピ）。
    // **相手の上限はこちらでは決められない**ので、速さはこちらで決める。
    const { mapWithLimit } = await import('../web/unbake.js');
    let running = 0;
    let peak = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    const out = await mapWithLimit(items, 3, async (value) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return value * 2;
    });
    assert.ok(peak <= 3, `同時に ${peak} 本流れている`);
    // **絞っても取りこぼさない。** 並びも入力どおり。
    assert.deepEqual(out, items.map(value => value * 2));
    // 検出器が生きているか——上限を広げれば peak も上がるはず。
    let peak2 = 0;
    let live = 0;
    await mapWithLimit(items, 8, async () => {
        live += 1; peak2 = Math.max(peak2, live);
        await new Promise((resolve) => setTimeout(resolve, 5));
        live -= 1;
    });
    assert.ok(peak2 > 3, `上限を広げても ${peak2} 本しか流れない（検査が効いていない）`);
});

test('取り込みが使う本数が、上限つきの回し方を通っている', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(join(ROOT, 'web/unbake.js'), 'utf8');
    assert.match(source, /mapWithLimit\(ids, CIVITAI_CONCURRENCY,/,
        '版IDの解決が上限つきの回し方を通っていない');
    assert.doesNotMatch(source, /Promise\.all\(ids\.map/,
        '数だけ同時に投げる書き方へ戻っている');
});

test('縮める上限が、設定から組み立てまで繋がっている', async () => {
    // **口が1つでも欠けると、設定は在るのに効かない。**
    // 面の検査はダブルを自分で渡すので、**繋がっていなくても緑のまま通る。**
    const { readFile } = await import('node:fs/promises');
    const settings = await readFile(join(ROOT, 'unbake/settings.py'), 'utf8');
    const entry = await readFile(join(ROOT, 'web/unbake.js'), 'utf8');
    const panel = await readFile(join(ROOT, 'web/panel/panel.js'), 'utf8');
    const runner = await readFile(join(ROOT, 'web/core/sweepRunner.js'), 'utf8');
    const sweep = await readFile(join(ROOT, 'web/core/recipeSweep.js'), 'utf8');
    const builder = await readFile(join(ROOT, 'web/core/recipeWorkflowBuilder.js'), 'utf8');

    assert.match(settings, /"replay_max_megapixels":/, 'Python 側に項目が無い');
    assert.match(entry, /replayMaxMegapixels: settings\?\.replay_max_megapixels/, '入口が面へ渡していない');
    assert.match(entry, /maxReplayPixels: Math\.max\(0, Number\(options\.maxReplayMegapixels\)/,
        '入口が実行器へ渡していない');
    assert.match(panel, /makeSweepRunner\(target, \{ maxReplayMegapixels: replayMaxMegapixels \}\)/,
        '面が実行器へ渡していない');
    assert.match(runner, /maxReplayPixels: this\.maxReplayPixels,/, '実行器が計画へ渡していない');
    assert.match(sweep, /maxReplayPixels: options\.maxReplayPixels,/, '計画が組み立てへ渡していない');
    assert.match(builder, /capReplayPixels\(prompt, options\?\.maxReplayPixels, warnings\)/,
        '組み立てが上限を見ていない');
});

test('重ねて出す指定が、設定から器まで繋がっている', async () => {
    // **面の検査だけでは足りない。** 検査は人形の器へ入れるので、
    // 本物の登録（`registerSidebarTab`）から呼ばれていなくても緑のまま通る
    // ——実際、幅の話は3回とも「直した」と言いながら実機で直っていなかった。
    const { readFile } = await import('node:fs/promises');
    const settings = await readFile(join(ROOT, 'unbake/settings.py'), 'utf8');
    const entry = await readFile(join(ROOT, 'web/unbake.js'), 'utf8');
    const view = await readFile(join(ROOT, 'web/panel/settingsView.js'), 'utf8');

    assert.match(settings, /"sidebar_overlay":/, 'Python 側に入切が無い');
    assert.match(settings, /"sidebar_width":/, 'Python 側に幅が無い');
    assert.match(entry, /sidebarOverlay: settings\?\.sidebar_overlay !== false/, '入口が入切を読んでいない');
    assert.match(entry, /sidebarWidth: settings\?\.sidebar_width/, '入口が幅を読んでいない');
    assert.match(entry, /installSidebarOverlay\(el, \{/, '登録から器へ手を入れていない');
    assert.match(entry, /enabled: displaySettings\?\.sidebarOverlay !== false/, '入切を渡していない');
    assert.match(entry, /width: displaySettings\?\.sidebarWidth/, '幅を渡していない');
    // **設定画面から切れること。** 宿主全体の見え方を変えるので、戻す口が要る。
    assert.match(view, /key: 'sidebar_overlay'/, '設定画面に入切が無い');
    assert.match(view, /key: 'sidebar_width'/, '設定画面に幅が無い');
    // **掴んだ幅が保存へ繋がっていること**（2026-08-25 利用者の指摘）。
    // 重ねた瞬間に宿主の仕切りは効かなくなるので、ここが欠けると
    // **幅を変える口が画面から1つも無くなる**。
    assert.match(entry, /onWidth: \(px\) =>/, '掴んだ幅の行き先が無い');
    assert.match(entry, /writeUnbakeSettings\(\{ sidebar_width: px \}\)/, '掴んだ幅を保存していない');
});

test('画面の作りが、設定から面まで繋がっている', async () => {
    // **面の検査だけでは足りない。** 検査は人形へ直接渡すので、
    // 入口（`unbake.js`）が設定を読んでいなくても緑のまま通る。
    const { readFile } = await import('node:fs/promises');
    const settings = await readFile(join(ROOT, 'unbake/settings.py'), 'utf8');
    const entry = await readFile(join(ROOT, 'web/unbake.js'), 'utf8');
    const view = await readFile(join(ROOT, 'web/panel/settingsView.js'), 'utf8');
    const panel = await readFile(join(ROOT, 'web/panel/panel.js'), 'utf8');

    assert.match(settings, /"ui_skin": "classic"/, 'Python 側の既定がテーマ1でない');
    assert.match(entry, /uiSkin: settings\?\.ui_skin/, '入口が設定を読んでいない');
    assert.match(panel, /applySkin\(doc, uiSkin\)/, '面が紙を出し入れしていない');
    assert.match(panel, /'data-skin': uiSkin/, '面が作りを属性へ出していない');
    // **設定画面から戻せること。** 戻す口が無い見た目の変更は、事故と同じ。
    assert.match(view, /key: 'ui_skin'/, '設定画面に切り替えが無い');
});

test('面を開く前でも、外の印がテーマに揃う', async () => {
    // **ツール列の印は面の外に居る。** 面を作るときにだけ当てていると、
    // **一度も開いていない間はテーマ1のまま**で、利用者からは
    // 「アイコンが変わらない」に見える（2026-08-25 実機）。
    const { readFile } = await import('node:fs/promises');
    const entry = await readFile(join(ROOT, 'web/unbake.js'), 'utf8');
    const skin = await readFile(join(ROOT, 'web/panel/skin.js'), 'utf8');

    // 設定を読んだ時点で当てていること。
    assert.match(entry, /applySkin\(documentRef, settings\?\.uiSkin\)/,
        '設定を読んだ時点で外の印を当てていない');
    // 当てる先が文書の根であること（面の中ではない）。
    assert.match(skin, /documentElement/, '外の印を文書の根へ置いていない');
    assert.match(skin, /data-unbake-skin/, '外の印の名前が違う');
});

test('設定を保存したら、控えを新しくして開いている面すべてへ流す', async () => {
    // **後から作る面は控えを読む。** 古いままだと、テーマを変えた後に
    // 全画面を開いた瞬間に**紙も外の印も巻き戻る**（2026-08-25 実測:
    // 保存値 kitchen / 画面と印 vinyl）。面が2つ開いているときも同じで、
    // 紙は文書に1枚しか無いので**片方だけ新しい**状態を作らない。
    const { readFile } = await import('node:fs/promises');
    const entry = await readFile(join(ROOT, 'web/unbake.js'), 'utf8');

    // 対応表は1箇所（読むときと書いた後で別々に組まない）。
    assert.match(entry, /function toDisplaySettings\(settings\)/, '対応表を切り出していない');
    assert.match(entry, /return toDisplaySettings\(settings\);/, '読むときに対応表を使っていない');
    // 保存の後で控えを更新している。
    assert.match(entry, /Object\.assign\(displaySettings, fresh\)/, '保存の後で控えを更新していない');
    // 開いている面すべてへ流している。
    assert.match(entry, /for \(const panel of openPanels\) panel\.applyDisplay\?\.\(patch\)/,
        '開いている面へ流していない');
});

// --- 断線: 保存したのに、読み直すまで効かない（2026-08-25 利用者の指示）------
//
// > 「チェックポイントごとにまとめる」を OFF にしたあと再読み込みが必要になった
//
// 面の側は `applyDisplay` で当て直しているが、**文書に効く設定はそこを通らない**。
// Dark Reader の錠は `<meta>` に効くので、読み込み時に1回当てたきりだった
// ——同じ「保存はできるのに変わらない」が、面の外でも起きていた。

test('Dark Reader の錠は、保存した時点で当たり直す（読み直さなくてよい）', async () => {
    const settings = {
        record_source_dirs: [], record_output_dir: '',
        lora_manager_base_url: '', raindrop_collection_id: '',
        disable_dark_reader: true,
    };
    const calls = stubRecordsEndpoint(rowsOf(2), settings);
    try {
        const doc = fakeDocument();
        const app = fakeApp();
        const handle = registerUnbake(app, { documentRef: doc });
        await app.state.extensions[0].setup();
        const sidebar = app.state.tabs[0].render(doc.createElement('div'));
        await handle.whenLibraryReady();
        await settle();

        const lock = () => doc.head.findAll(node => node.getAttribute?.('name') === LOCK_META_NAME);
        assert.equal(lock().length, 1, '前提（既定で錠が当たっている）が崩れている');

        sidebar.openSettings();
        const view = sidebar.settingsView;
        await view.loaded;
        settings.disable_dark_reader = false;      // 応答も新しい値を返す
        await view.save({ disable_dark_reader: false });
        await settle();
        assert.equal(lock().length, 0, '切っても錠が残っている（読み直しが要る）');

        settings.disable_dark_reader = true;
        await view.save({ disable_dark_reader: true });
        await settle();
        assert.equal(lock().length, 1, '入れ直しても錠が当たらない');
    } finally { calls.restore(); }
});
