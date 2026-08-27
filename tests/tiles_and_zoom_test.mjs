/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 実機で報告された2巡目（2026-08-20）。
 *
 *   ⑦ `Seed only (nothing else changes)` のような長い選択肢が見切れる
 *   ⑧ 絵をタイルで並べたい。列数（1〜3）を自分で決めたい
 *   ⑨ 記録の名前を、出す絵の名前と揃えたい
 *   ⑩ 絵を押すと**詳細**が開き、そこから窓いっぱいの拡大へ進む（2026-08-22 に変えた）
 *
 * **⑧はモード型の設定に見えるが、密度ではない。** 表とタイルは同じ記録・同じ
 * 絞り込み・同じ並びを描き、変わるのは並べ方だけ。密度は今までどおり器の幅が決める
 * （`display_policy_test.mjs` の「モードを足さない」がそこを見張り続けている）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** 改行1文字。**正規表現リテラルを書かない**（道具が通ると壊れることがある）。 */
const NEWLINE = String.fromCharCode(10);
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { baseModelBadge, createUnbakePanel, displayName } from '../web/panel/panel.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale, t } from '../web/i18n/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const rec = (id, extra = {}) => ({
    id, libraryId: id, title: `Civitai_Recipe_${id}`, verdict: 'reproducible',
    previewUrl: `/unbake/record-preview?id=${id}`, ...extra,
});

function mount(records, display = null, io = {}) {
    const doc = fakeDocument();
    const panel = createUnbakePanel(doc.createElement('div'), { documentRef: doc, display, ...io });
    panel.setRecords(records);
    return panel;
}

const tilesOf = (panel) => panel.root.allByClass('unbake-tile')
    .filter(node => node.className === 'unbake-tile');

// --- ⑨ 名前を揃える ---------------------------------------------------------

test('記録の名前が、出す絵の名前と同じ規則になる', () => {
    // 上流が付けた題は `Civitai_Recipe_137337754`、こちらが出す絵は
    // `civitai_137337754_00001_.png`。**同じものが2つの名前を持っていた**ので、
    // 出力フォルダと一覧の突き合わせに毎回読み替えが要った。
    assert.equal(displayName({ title: 'Civitai_Recipe_137337754' }), 'civitai_137337754');
    assert.equal(displayName({ title: 'Recipe_Civitai_Recipe_47986787' }), 'civitai_47986787');
    // **落とすところが無ければ元の題を残す。** `record_<id>` に化けさせない。
    assert.equal(displayName({ title: 'my local png', id: 'abc' }), 'my local png');
    assert.equal(displayName({ id: 'abc' }), 'abc');
});

test('一覧は新しい名前で出し、元の題は吹き出しと絞り込みに残る', () => {
    setLocale('en');
    const panel = mount([rec('137337754')]);
    const cell = panel.root.find(n => n.tagName === 'TD' && n.className === 'unbake-col-title');
    assert.equal(cell.textContent, 'civitai_137337754');

    // 行の吹き出しには**上流の画面で見た題**が残る（探すときの手掛かり）。
    const row = cell.parentNode;
    assert.equal(row.getAttribute('title'), 'Civitai_Recipe_137337754');

    // **どちらの名前でも引ける。**
    const search = panel.root.byClass('unbake-search');
    const rows = () => panel.root.findAll(n => n.tagName === 'TR' && n.parentNode?.tagName === 'TBODY').length;
    search.value = 'civitai_137337754';
    search.dispatch('input', {});
    assert.equal(rows(), 1, '新しい名前で引けない');
    search.value = 'civitai_recipe_137337754';
    search.dispatch('input', {});
    assert.equal(rows(), 1, '元の題で引けない');
});

// --- ⑧ タイル ---------------------------------------------------------------

test('タイルで並べられ、表と同じ記録が出る', () => {
    setLocale('en');
    const records = Array.from({ length: 7 }, (_, i) => rec(String(i)));
    const panel = mount(records, { listView: 'tiles' });
    assert.equal(tilesOf(panel).length, 7);
    // **表は隠れているだけで、消えていない**（同じ記録を2つの器で描く）。
    assert.equal(panel.root.byClass('unbake-table').style.display, 'none');
    assert.notEqual(panel.root.byClass('unbake-tiles').style.display, 'none');
});

test('切り替えは一覧の手元でできる（設定を開かせない）', () => {
    setLocale('en');
    const panel = mount([rec('1'), rec('2')]);
    const toggle = panel.root.byClass('unbake-view-toggle');
    assert.ok(toggle, '見せ方の切替が無い');
    // **既定はタイル**（2026-08-28 利用者の指示）。この道具で最初にすることは
    // 「どの記録を再現するか選ぶ」で、選ぶ手掛かりは絵の方にある。
    assert.equal(tilesOf(panel).length, 2, '既定がタイルになっていない');

    toggle.dispatch('click', {});
    assert.equal(tilesOf(panel).length, 0, '表へ切り替わっていない');
    toggle.dispatch('click', {});
    assert.equal(tilesOf(panel).length, 2, 'タイルへ戻せない');
});

test('既定は面と宿主の両方で「タイル」', async () => {
    /*
     * **2箇所ある。** `unbake/settings.py` が宿主の既定で、`panel.js` は
     * 宿主の設定がまだ届いていない一瞬に使う後退先。**片方だけ直すと、
     * 開いた最初の一瞬だけ別の器で描かれる**（気づきにくい形で残る）。
     */
    const { readFile } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');

    const py = await readFile(join(root, 'unbake/settings.py'), 'utf8');
    assert.match(py, /"list_view":\s*"tiles"/, '宿主の既定が表のまま');

    const js = await readFile(join(root, 'web/panel/panel.js'), 'utf8');
    const at = js.indexOf('let listView = LIST_VIEWS.has(');
    assert.notEqual(at, -1, '後退先が見つからない（改名を見逃している）');
    const line = js.slice(at, js.indexOf(';', at));
    assert.ok(line.includes("'tiles'"), `面の後退先が表のまま: ${line}`);
});

test('絞り込みはどちらの器でも同じに効く', () => {
    setLocale('en');
    const panel = mount([rec('1'), rec('2', { verdict: 'blocked' })], { listView: 'tiles' });
    assert.equal(tilesOf(panel).length, 2);
    // 判定のチップで1つ落とす。
    const chip = panel.root.findAll(n => n.className === 'unbake-chip')
        .find(n => n.getAttribute('data-verdict') === 'blocked');
    chip.dispatch('click', {});
    assert.equal(tilesOf(panel).length, 1, 'タイルに絞り込みが効いていない');
});

test('カードの大きさを選べて、器へ伝わる', () => {
    setLocale('en');
    // **列数ではなく大きさ**（2026-08-21 に変えた）。列数で固定すると、
    // 全画面で横に広げたときに右が余る——実機でそう報告された。
    const panel = mount([rec('1')], { listView: 'tiles', tileSize: 3 });
    const grid = panel.root.byClass('unbake-tiles');
    assert.equal(grid.getAttribute('data-size'), '3');

    const select = panel.root.byClass('unbake-view-columns');
    assert.deepEqual([...select.children].map(o => o.getAttribute('value')), ['0', '1', '2', '3', '4']);
    select.value = '2';
    select.dispatch('change', {});
    assert.equal(grid.getAttribute('data-size'), '2');
    // 0 は「幅に合わせる」。**選択肢から消さない**（既定へ戻せなくなる）。
    select.value = '0';
    select.dispatch('change', {});
    assert.equal(grid.getAttribute('data-size'), '0');
});

test('大きさは段ごとに決まり、1 が最大（列は幅に応じて増える）', async () => {
    const css = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');
    const widths = [];
    for (const n of [1, 2, 3, 4]) {
        const rule = css.match(new RegExp(
            `\\.unbake-tiles\\[data-size="${n}"\\][^{]*\\{([^}]*)\\}`));
        assert.ok(rule, `${n} 段の指定が無い`);
        // **列数で固定しない。** `auto-fill` が入るだけ列を作るので、
        // 広い画面では列が増えて右が余らない。
        assert.match(rule[1], /repeat\(auto-fill/, `${n} 段が列数を固定している`);
        const width = Number(rule[1].match(/min\(100%,\s*(\d+)px\)/)?.[1]);
        assert.ok(width > 0, `${n} 段の目安の幅が読めない`);
        widths.push(width);
    }
    // **1 が最大**で、段が進むほど小さくなる。
    for (let i = 1; i < widths.length; i += 1) {
        assert.ok(widths[i] < widths[i - 1],
            `段が進んでも小さくなっていない: ${widths.join(' > ')}`);
    }
});

test('見せ方と大きさは保存され、次に開いたときも残る', () => {
    setLocale('en');
    const written = [];
    const panel = mount([rec('1')], null, {
        settingsIo: { read: async () => ({}), write: async (patch) => { written.push(patch); return { settings: patch }; } },
    });
    // **既定はタイル**なので、1度目の切替で表になる（2026-08-28）。
    panel.root.byClass('unbake-view-toggle').dispatch('click', {});
    assert.deepEqual(written, [{ list_view: 'table', tile_size: 0 }]);

    // 大きさの口はタイルのときにだけ在るので、タイルへ戻してから触る。
    panel.root.byClass('unbake-view-toggle').dispatch('click', {});
    const select = panel.root.byClass('unbake-view-columns');
    select.value = '3';
    select.dispatch('change', {});
    assert.deepEqual(written.at(-1), { list_view: 'tiles', tile_size: 3 });
});

// --- ⑩ 押して拡大、押して閉じる ---------------------------------------------

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('絵を押すと詳細が開き、そこから拡大へ進む（2026-08-22 に変えた）', async () => {
    // **元は「押したら拡大、もう一度押したら閉じる」だった。**
    // 利用者の指摘で変えた——「拡大だけでは情報が不足しています」。
    // 大きくしても、どのモデルで・どのプロンプトで出したのかが見えないので
    // 次の一手が決まらない。**詳細を先に出し、絵を押すとそこから拡大へ進む。**
    setLocale('en');
    const panel = mount([rec('42')]);
    const thumb = panel.root.byClass('unbake-thumb');
    assert.equal(thumb.getAttribute('data-zoom'), 'true', '押せる絵になっていない');

    thumb.dispatch('click', {});
    await settle();
    const detail = panel.root.byClass('unbake-detail');
    assert.ok(detail, '詳細が開かない');
    assert.equal(panel.root.byClass('unbake-compare'), null, '拡大がいきなり開いている');
    // **何の絵かを字でも出す**（絵だけだと、どの記録か判らなくなる）。
    assert.match(detail.byClass('unbake-detail-title').textContent, /civitai_42/);
    // **元画像は原寸を先に当てる**（2026-08-22 利用者の指示）。手元の参照画像は
    // LoRA Manager が置いたサムネイル（実測 480x701）で、生成画像（832x1216）と
    // 並べると元画像だけが甘い。
    const stage = detail.byClass('unbake-detail-image');
    assert.equal(stage.getAttribute('src'), '/unbake/record-original?id=42');
    // **取れなかったら黙ってサムネイルへ戻す。** 取れないことは普通に起きる
    // （消された・年齢制限・鍵が要る）ので、壊れた絵を出さない。
    stage.dispatch('error', {});
    assert.equal(stage.getAttribute('src'), '/unbake/record-preview?id=42',
        '原寸が取れなくても、手元の1枚へ戻らない');
    // **戻すのは一度だけ**（無限に取り直さない）。
    stage.dispatch('error', {});
    assert.equal(stage.getAttribute('src'), '/unbake/record-preview?id=42');

    // **絵を押すと拡大へ進む**（閉じるのではない）。
    detail.byClass('unbake-detail-image').dispatch('click', {});
    await settle();
    assert.ok(panel.root.byClass('unbake-compare'), '詳細から拡大へ進めない');

    // **周りを押すと詳細が閉じる。** 中を押しても閉じない。
    const backdrop = panel.root.byClass('unbake-detail-backdrop');
    backdrop.dispatch('click', { target: detail });
    assert.ok(panel.root.byClass('unbake-detail'), '中を押したら閉じてしまう');
    backdrop.dispatch('click', { target: backdrop });
    assert.equal(panel.root.byClass('unbake-detail'), null, '周りを押しても閉じない');
});

test('詳細は同時に2つ開かない', async () => {
    setLocale('en');
    const panel = mount([rec('1'), rec('2')]);
    const thumbs = panel.root.allByClass('unbake-thumb');
    thumbs[0].dispatch('click', {});
    await settle();
    thumbs[1].dispatch('click', {});
    await settle();
    assert.equal(panel.root.allByClass('unbake-detail').length, 1);
    assert.match(panel.root.byClass('unbake-detail-title').textContent, /civitai_2/);
});

test('タイルの絵も押せる', async () => {
    setLocale('en');
    const panel = mount([rec('7')], { listView: 'tiles' });
    const image = panel.root.byClass('unbake-tile-image');
    assert.equal(image.getAttribute('data-zoom'), 'true');
    image.dispatch('click', {});
    await settle();
    assert.ok(panel.root.byClass('unbake-detail'), 'タイルから詳細を開けない');
});

test('面を畳むと詳細も拡大も閉じる（見えない器が残らない）', async () => {
    setLocale('en');
    const panel = mount([rec('1')]);
    panel.root.byClass('unbake-thumb').dispatch('click', {});
    await settle();
    assert.ok(panel.root.byClass('unbake-detail'));
    panel.root.byClass('unbake-detail-image').dispatch('click', {});
    await settle();
    assert.ok(panel.root.byClass('unbake-compare'));
    panel.destroy();
    assert.equal(panel.root.byClass('unbake-detail'), null, '詳細が置き去りになっている');
    assert.equal(panel.root.byClass('unbake-compare'), null, '拡大が置き去りになっている');
});

// --- ⑦ 長い選択肢が見切れる --------------------------------------------------

test('Sweep の操作が、自分の文字の入る幅を持つ', async () => {
    // 実測（432px のサイドバー）: 3つを1行へ並べていたので1つ132px になり、
    // `Seed only (nothing else changes)`（235px 要る）が省略記号で切れていた
    // ——**選択肢の字が読めない選択肢は選べない。**
    const css = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');
    const block = css.match(/\.unbake-sweep-controls\s*\{([^}]*)\}/);
    assert.ok(block, 'Sweep の操作の規則が無い');
    assert.match(block[1], /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,/,
        '器に入らないときへ折り返していない');
    // **`minmax(18em, …)` と書くと、狭い器で切れる代わりに横へ溢れる。**
    assert.doesNotMatch(block[1], /minmax\(\s*\d+em/, '器より広い最小幅を要求している');

    // 幅を `flex-basis` で決めていたのが原因なので、そこへ戻っていないこと。
    const sizing = css.match(/\.unbake-sweep-controls select,[\s\S]*?\{([^}]*)\}/);
    assert.doesNotMatch(sizing[1], /flex:\s*1 1 8em/, '狭い基準幅へ戻っている');
});

test('長い選択肢の文言が、実際に長い（検査が空回りしていない）', () => {
    setLocale('en');
    // 文言そのものが短くなったら、この検査は何も見ていないことになる。
    const text = t('sweep.template.seedsOnly');
    assert.ok(text.length >= 20, `雛形の文言が短すぎる: ${text}`);
});

// --- タイルの作り（2026-08-20・「もっと洗練を」を受けて組み直した）---------

test('絵が器いっぱいで、字は絵の上へ重なる', async () => {
    setLocale('en');
    const panel = mount([rec('1')], { listView: 'tiles' });
    const tile = panel.root.byClass('unbake-tile');
    // 絵・上の帯・下の帯・操作が、**同じ枠の中に重なっている**こと。
    const kinds = tile.children.map(n => n.className.split(' ')[0]);
    assert.deepEqual(kinds, ['unbake-tile-media', 'unbake-tile-head', 'unbake-tile-foot', 'unbake-tile-actions']);

    const css = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');
    // 元は絵・名前・判定・ボタンを縦に積んでいたので、3列だと絵が半分以下だった。
    assert.match(css, /\.unbake-tile\s*\{[^}]*aspect-ratio/, '枠の比率を決めていない');
    assert.match(css, /\.unbake-tile-image\s*\{[^}]*object-fit:\s*cover/, '絵が器を埋めていない');
    // 上下の帯と操作は**同じ規則**で絵の上へ重ねている（3つ並べて1つの規則）。
    const overlay = [...css.matchAll(/([^{}]*)\{([^}]*)\}/g)]
        .find(([, selector, body]) => /position:\s*absolute/.test(body)
            && ['head', 'foot', 'actions'].every(part => selector.includes(`.unbake-tile-${part}`)));
    assert.ok(overlay, '上の帯・下の帯・操作が絵の上に重なっていない');
});

test('名前は数字を強く出す（見分けに効くのは数字の側）', () => {
    setLocale('en');
    const panel = mount([rec('79689199')], { listView: 'tiles' });
    const name = panel.root.byClass('unbake-tile-name');
    assert.equal(name.text.replace(/\s+/g, ''), 'civitai_79689199');
    assert.equal(name.byClass('unbake-tile-name-prefix').textContent, 'civitai_');
    assert.equal(name.byClass('unbake-tile-name-id').textContent, '79689199');
});

test('判定はタイルでも消えない（この道具の主語だから）', () => {
    setLocale('en');
    const panel = mount([rec('1', { verdict: 'blocked' })], { listView: 'tiles' });
    const tile = panel.root.byClass('unbake-tile');
    assert.equal(tile.getAttribute('data-verdict'), 'blocked');
    // 2026-08-20 に外した色帯（`.unbake-verdict`）は戻していない。
    // 2026-08-22 に足したのは**印の列に並ぶ字**で、別のもの。
    assert.equal(tile.byClass('unbake-verdict'), null, '外したはずの色帯が残っている');
    // **色だけにしない。** 手を打つ側は字でも出る。
    const mark = tile.findAll(n => n.getAttribute?.('data-mark') === 'verdict')[0];
    assert.ok(mark, '出せない記録なのに字が出ていない');
    assert.match(mark.textContent, /cannot/i);
    assert.match(tile.getAttribute('aria-label'), /CANNOT/i);
    assert.match(tile.getAttribute('title'), /CANNOT/i);
});

test('数えられる印だけ出す（0 のときは出さない）', () => {
    setLocale('en');
    const withLoras = mount([rec('1', { loraCount: 6 })], { listView: 'tiles' }).root;
    const mark = withLoras.byClass('unbake-tile-mark');
    assert.ok(mark.textContent.includes('6'), `LoRA の数が出ていない: ${mark.textContent}`);

    const none = mount([rec('2', { loraCount: 0 })], { listView: 'tiles' }).root;
    assert.equal(none.byClass('unbake-tile-mark'), null, '0 件の印を出している');
});

test('タイルにチェックポイントを出さない（2026-08-23 利用者の指示）', () => {
    // 元は「無ければ行ごと出さない」だった。**在っても出さない**へ変えた
    // ——絵の上に2行あると帯が厚くなるうえ、名前は切らずに出す決めなので
    // 2行目まで足すと絵が隠れる。モデルは詳細と表で見られる。
    setLocale('en');
    const withModel = mount([rec('1', { checkpoint: 'x/anima_v10.safetensors' })], { listView: 'tiles' }).root;
    assert.equal(withModel.byClass('unbake-tile-meta'), null, 'タイルにモデル名を出している');
    // **名前は残る。** 突き合わせに使うのはこちら。
    assert.ok(withModel.byClass('unbake-tile-name'), '名前まで消している');

    // 表には在ること（**消したのはタイルだけ**——見る場所を全部塞がない）。
    const table = mount([rec('1', { checkpoint: 'x/anima_v10.safetensors' })], { listView: 'table' }).root;
    assert.equal(table.allByClass('unbake-col-model').at(-1).textContent, 'anima_v10.safetensors',
        '表からも消している');
});

test('系統の札を出す（実データで出た値を短くする）', () => {
    setLocale('en');
    // **実データ350件で数えた値**（2026-08-23）: Illustrious 207 / Pony 70 /
    // Flux.1 D 17 / Anima 11 / SD 1.5 7 / NoobAI 6 …
    const cases = [
        ['Illustrious', 'IL'],
        ['Pony', 'PONY'],
        ['Flux.1 D', 'F1D'],
        ['SD 1.5', 'SD1.5'],
        ['NoobAI', 'NAI'],
        ['SDXL 1.0', 'SDXL'],
    ];
    for (const [value, want] of cases) {
        assert.equal(baseModelBadge(value), want, `${value} の札が違う`);
    }
    // **知らない名前も出す。** 落とすと「対応していない」ではなく
    // 「この記録には無い」と読まれる。
    assert.equal(baseModelBadge('Wan Video 14B i2v 480p'), 'WANVIDEO');
    assert.equal(baseModelBadge('Krea 2'), 'KREA');
    // 無いものは無い（空の札を出さない）。
    assert.equal(baseModelBadge(null), '');
    assert.equal(baseModelBadge('   '), '');
});

test('タイルの左上は、触っていない間は系統・触ったら選ぶ口', () => {
    setLocale('en');
    // **元はチェックボックスが常時ここに在り、ホバーするとこの帯ごと
    // 消えていた**ので、近づくと的が逃げていた（2026-08-23 利用者の指示）。
    const root = mount([rec('1', { baseModel: 'Illustrious' })], { listView: 'tiles' }).root;

    const head = root.byClass('unbake-tile-head');
    assert.ok(head, '頭の帯が無い');
    assert.equal(root.byClass('unbake-tile-base').textContent, 'IL', '系統の札が出ていない');
    // 頭の帯に選ぶ口を置かない（ホバーで消える場所なので）。
    assert.deepEqual(head.allByClass('unbake-pick'), [], '消える帯の中に選ぶ口が残っている');

    // 触っている間だけ出る列に在ること。
    assert.equal(root.byClass('unbake-tile-actions').allByClass('unbake-pick').length, 1,
        '選ぶ口がどこにも無い');
});

test('操作が hover だけに閉じていない（触る画面とキーボードから届く）', async () => {
    // **hover を唯一の入口にすると、触る画面とキーボードからは永久に届かない。**
    // 上流のカードは hover でしか出さないので、そこは真似ない。
    const css = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');
    assert.match(css, /\.unbake-tile:focus-within \.unbake-tile-actions/,
        'focus では出てこない（キーボードから届かない）');
    assert.match(css, /@media \(hover: none\)[^}]*\{[^}]*\.unbake-tile-actions/,
        'hover の無い画面で出てこない');
    // **順序から外さない。** `display: none` / `visibility: hidden` で消すと
    // tab の順序から落ちて、focus で出す仕掛けごと死ぬ。
    // **隠している規則そのもの**を見る。`.unbake-tile-actions` は複数の規則に
    // 出てくるので、セレクタ名だけで拾うと別の規則（重ね方）を読んでしまう。
    const hiding = [...css.matchAll(/([^{}]*)\{([^}]*)\}/g)]
        .filter(([, selector, body]) => selector.includes('.unbake-tile-actions')
            && /opacity|display|visibility/.test(body));
    assert.ok(hiding.length > 0, '隠す指定が無い＝検査が空回りしている');
    const hidden = hiding.find(([, , body]) => /opacity:\s*0\s*;/.test(body));
    assert.ok(hidden, '隠す指定が opacity ではない');
    for (const [, selector, body] of hiding) {
        assert.doesNotMatch(body, /display:\s*none|visibility:\s*hidden/,
            `tab の順序から外れる消し方をしている: ${selector.trim()}`);
    }

    setLocale('en');
    // 書庫の記録は本体を後から取りに行くので、`loadRecord` が在って初めて
    // Sweep のボタンが出る（無ければ「かけられない」印になる）。
    const panel = mount([rec('1')], { listView: 'tiles' }, { loadRecord: async () => ({}) });
    const actions = panel.root.byClass('unbake-tile-actions');
    assert.ok(actions.find(n => n.tagName === 'BUTTON'), '操作が要素として存在しない');
});

test('動きを減らす設定を尊重する', async () => {
    const css = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)[^}]*\{[^}]*\.unbake-tile/,
        '動きを減らす設定を見ていない');
});

// --- 並び替え（2026-08-22 利用者の指示で画面へ出した）------------------------

test('並び替えの鍵と向きが画面から選べる', async () => {
    setLocale('en');
    const written = [];
    const panel = mount([
        rec('a', { title: 'B', modified: 100 }),
        rec('b', { title: 'A', modified: 300 }),
        rec('c', { title: 'C', modified: 200 }),
    ], { listView: 'table' }, {
        settingsIo: { read: async () => ({ settings: {} }), write: async (p) => { written.push(p); return {}; } },
    });
    const order = () => panel.root.allByClass('unbake-tile-name-id').map(n => n.textContent);

    const select = panel.root.byClass('unbake-sort-key');
    const direction = panel.root.byClass('unbake-sort-direction');
    assert.ok(select, '並び替えの選択口が画面に無い');
    assert.ok(direction, '向きを変える口が画面に無い');

    // **既定は日付の自然な順（新しい順）。**
    assert.equal(select.value, 'modified');
    assert.equal(direction.getAttribute('data-descending'), 'false');

    // 名前で並べ替える。
    select.value = 'title';
    await select.dispatch('change');
    assert.deepEqual(written.at(-1), { sort_key: 'title', sort_descending: false },
        '選んだ並びを保存していない');

    // **向きを反転できる。** 元は鍵ごとに決め打ちで、古い順が言えなかった。
    await direction.dispatch('click');
    assert.equal(direction.getAttribute('data-descending'), 'true');
    assert.deepEqual(written.at(-1), { sort_key: 'title', sort_descending: true });
});

test('向きを反転しても、同点の解き方は変えない（並びが揺れない）', () => {
    setLocale('en');
    // 同じ日付を3件——主の鍵では差が付かないので、id で決まる。
    const same = [rec('c', { modified: 5 }), rec('a', { modified: 5 }), rec('b', { modified: 5 })];
    const asc = mount(same, { listView: 'table' });
    const ids = () => asc.root.allByClass('unbake-tile-name-id').map(n => n.textContent);
    const before = ids();
    asc.root.byClass('unbake-sort-direction').dispatch('click');
    // **同点は反転しない。** ここも反転すると、押すたびに並びが入れ替わって
    // 「壊れている」ように見える（主の鍵だけを反転する）。
    assert.deepEqual(ids(), before, '同点の並びまで反転している');
});

test('設定から並びを変えても、その場で効く', () => {
    setLocale('en');
    const panel = mount([rec('a', { title: 'B' }), rec('b', { title: 'A' })], { listView: 'table' });
    assert.equal(panel.root.byClass('unbake-sort-key').value, 'modified');
    panel.applyDisplay({ sort_key: 'title', sort_descending: true });
    assert.equal(panel.root.byClass('unbake-sort-key').value, 'title', '設定から変えても画面が古いまま');
    assert.equal(panel.root.byClass('unbake-sort-direction').getAttribute('data-descending'), 'true');
    // 知らない鍵は無視する（画面が勝手に化けない）。
    panel.applyDisplay({ sort_key: 'nope' });
    assert.equal(panel.root.byClass('unbake-sort-key').value, 'title');
});

// --- 商用可否（2026-08-22 利用者の指摘）--------------------------------------

test('商用可否は右下に、Yes / No の2語で出す', () => {
    setLocale('en');
    // 元は「不可だけを印の列に出す」だった。**場所を分けた**ので両方出せる
    // ——判定は左上・商用可否は右下と決めれば、位置そのものが見出しになる
    // （2026-08-23 利用者の指示）。
    const panel = mount([
        rec('a', { commercialOk: 'YES', licenseCheckedAt: '2026-08-14' }),
        rec('b', { commercialOk: 'NO', licenseCheckedAt: '2026-08-14' }),
        // **判定日の無い値は出さない。** 出典の無い可否は、出さないより悪い。
        rec('c', { commercialOk: 'NO', licenseCheckedAt: null }),
        rec('d'),
    ], { listView: 'tiles' });

    const badges = panel.root.allByClass('unbake-tile-commercial');
    assert.equal(badges.length, 2, '可を落としている／日付の無い値まで出している');
    assert.deepEqual(badges.map(b => b.getAttribute('data-commercial')), ['YES', 'NO']);
    assert.deepEqual(badges.map(b => b.textContent), ['Yes', 'No'], '2語で出していない');

    // **判定と同じ列に置かない。** 位置で見分けさせるのがこの変更の全部。
    assert.deepEqual(
        panel.root.allByClass('unbake-tile-mark').filter(m => m.getAttribute('data-mark') === 'commercial'),
        [], '印の列に商用可否が残っている');

    // 判定日と免許は札の吹き出しに在る（落とすと「調べていない」と読まれる）。
    assert.match(badges[0].getAttribute('title'), /2026-08-14/, '判定日が吹き出しから消えている');
});

// --- 「落とせば試せる」と「初めから無理」を分ける（2026-08-23 利用者の指示）---
//
// 判定器は既に区別しているのに、画面へ渡すところで落としていたので、
// 一覧では同じ「再現不可」に見えていた。**実データでは前者29件・後者27件で、
// 打つ手が真逆**（前者は落とせばよい／後者は追いかけるだけ無駄）。

test('落とせば試せる記録は、初めから無理な記録と別の印になる', () => {
    setLocale('en');
    const panel = mount([
        rec('a', { verdict: 'blocked', verdictBlocker: 'downloadable' }),
        rec('b', { verdict: 'blocked', verdictBlocker: 'norecord' }),
    ], { listView: 'tiles' });

    const marks = panel.root.allByClass('unbake-tile-mark')
        .filter(m => m.getAttribute('data-mark') === 'verdict');
    assert.equal(marks.length, 2);
    assert.equal(marks[0].getAttribute('data-blocker'), 'downloadable');
    assert.notEqual(marks[0].textContent, marks[1].textContent,
        '同じ語で並んでいる（見分けが付かない）');
    assert.match(marks[0].textContent, /download/i, '落とせば試せることを言っていない');
});

test('落とせば試せる印には、別の色を当てる規則が在る', async () => {
    // 色は補助（字でも分かる）だが、**同じ赤で並べない**のがこの変更の要点。
    const css = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');
    assert.match(css, /\[data-blocker="downloadable"\][^}]*background:\s*var\(--unbake-accent\)/,
        '落とせば試せる印が「初めから無理」と同じ色のまま');
});

// --- 帯を崩さない（2026-08-23 利用者の指示）---------------------------------

test('長い結果は帯ではなく、浮かせた1行に出す', () => {
    setLocale('en');
    const panel = mount([rec('1')], { listView: 'tiles' });
    // **帯はボタンの並び。** 文の置き場ではない（伸びると並びが崩れた）。
    assert.equal(panel.root.byClass('unbake-download-progress'), null,
        '帯の中に文の欄が残っている');
    assert.ok(panel.root.byClass('unbake-toast'), '浮かせた1行が無い');
    assert.equal(panel.root.byClass('unbake-toast').getAttribute('data-open'), 'false',
        '何も起きていないのに出ている');
});

test('浮かせた1行は操作を止めない', async () => {
    const css = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');
    // **選び名は最後の行で見る。** 直前のコメントまで拾ってしまうため。
    const rule = [...css.matchAll(/([^{}]*)\{([^}]*)\}/g)]
        .find(([, selector]) => selector.trim().split(NEWLINE).pop().trim() === '.unbake-toast');
    assert.ok(rule, '`.unbake-toast` の規則が無い');

    // **中断しないことの中身を、性質で見る**（2026-08-23 に書き直した）。
    // 元は `pointer-events: none` を直に見ていたが、それだと**文字を選べない**
    // ——読めても写せないので、利用者は画面写真を撮って渡す羽目になった。
    //
    // 押し返してよいのは**この箱の中だけ**。中断とは「面を覆うこと」なので、
    // 覆いが無く・隅に居て・大きさが中身なりであることを見る。
    assert.doesNotMatch(css, /\.unbake-toast-backdrop/, '覆いを作っている');
    assert.match(rule[2], /position:\s*absolute/, '面の流れに割り込んでいる');
    assert.match(rule[2], /inset-block-end/, '隅に居ない');
    assert.match(rule[2], /max-inline-size:\s*fit-content/, '中身より大きく広がる');
    // 出ていない間は押し返さないこと（**見えないものが的にならない**）。
    const hidden = [...css.matchAll(/([^{}]*)\{([^}]*)\}/g)]
        .find(([, selector]) => selector.trim().split(NEWLINE).pop().trim()
            === '.unbake-toast[data-open="false"]');
    assert.ok(hidden, '出ていないときの規則が無い');
    assert.match(hidden[2], /pointer-events:\s*none/, '見えないのに押し返している');
});

// --- 落とす範囲を語で示す（2026-08-23 利用者の指示）-------------------------

test('未選択のときは「全ての不足モデルを落とす」と書く', () => {
    setLocale('en');
    const panel = mount([rec('1'), rec('2')], { listView: 'tiles' }, {
        downloadIo: { start: async () => ({ ok: true }), state: async () => ({}) },
    });
    const button = panel.root.byClass('unbake-download-missing');
    assert.match(button.textContent, /all/i, '未選択なのに範囲を言っていない');

    // 選んだら、その分だけが対象——語も戻る。
    panel.root.allByClass('unbake-pick')[0].checked = true;
    panel.root.allByClass('unbake-pick')[0].setAttribute('data-checked', 'true');
    panel.root.allByClass('unbake-pick')[0].dispatch('click', {});
    assert.doesNotMatch(button.textContent, /all/i, '選んだのに「全て」と言っている');
});

test('浮かせた1行は面の中に閉じる（宿主の操作盤へ出ない）', async () => {
    // **`.unbake-root` に基準が無いと、絶対配置は宿主側の器を基準にする**
    // ——実際に ComfyUI の操作盤の上へ出た（2026-08-23 利用者の報告・画面写真つき）。
    const css = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...stripped.matchAll(/([^{}]*)\{([^}]*)\}/g)];
    const rootBody = rules
        .filter(([, selector]) => selector.trim().split(NEWLINE).pop().trim() === '.unbake-root')
        .map(([, , body]) => body).join(' ');
    assert.match(rootBody, /position:\s*relative/,
        '面に基準が無い（浮かせたものが宿主側へ出る）');

    // **右下は宿主の操作盤が居る場所。** 面の中に収まっていても目の上で重なる。
    const toastBody = rules
        .filter(([, selector]) => selector.trim().split(NEWLINE).pop().trim() === '.unbake-toast')
        .map(([, , body]) => body).join(' ');
    assert.match(toastBody, /inset-inline-start:\s*10px/, '左下に寄せていない');
    assert.match(toastBody, /margin-inline-end:\s*auto/, '右へ押し出したままになっている');
});

/*
 * **選んでいる最中は、押すと選択に足す**（2026-08-27 利用者の指示）。
 *
 * 複数選びたいとき、的は左上の小さな四角1つだけだった。**絵はタイルの
 * ほとんどを占めているのに、押すと詳細が開いて選ぶ流れが切れる**——
 * 選び直すには面を閉じて、また小さな四角を狙うことになる。
 *
 * **1件も選んでいない時は今までどおり詳細。** ここを常に選択にすると、
 * 一番よく使う「絵を押して中身を見る」が押せなくなる。
 * つまり**選択が0件かどうかが、そのまま作法の切り替えになる**。
 */
test('何も選んでいなければ、絵を押すと今までどおり詳細が開く', async () => {
    setLocale('ja');
    const panel = mount([rec('1'), rec('2')], { listView: 'tiles' });
    panel.root.byClass('unbake-tile-image').dispatch('click', {});
    await settle();
    assert.ok(panel.root.byClass('unbake-detail'), '詳細が開かない');
    assert.deepEqual(panel.selected, [], '押しただけで選ばれている');
});

test('1件でも選んでいれば、絵を押すと選択に足す（詳細は開かない）', async () => {
    setLocale('ja');
    const panel = mount([rec('1'), rec('2'), rec('3')], { listView: 'tiles' });
    const box = panel.root.allByClass('unbake-pick')[0];
    box.checked = true;
    await box.dispatch('click', {});
    assert.deepEqual(panel.selected, ['1'], '選ぶ口が効いていない');

    // 2件目の**絵**を押す。
    const images = panel.root.allByClass('unbake-tile-image');
    await images[1].dispatch('click', {});
    await settle();
    assert.deepEqual(panel.selected.sort(), ['1', '2'], '絵を押しても選択に足されない');
    assert.equal(panel.root.byClass('unbake-detail'), null,
        '選んでいる最中なのに詳細が開いた（選ぶ流れが切れる）');

    // **もう一度押せば外れる。** 足すだけだと、間違えた分を戻せない。
    await panel.root.allByClass('unbake-tile-image')[1].dispatch('click', {});
    await settle();
    assert.deepEqual(panel.selected, ['1'], '押し直しても外れない');
});

test('絵以外（名前や札）を押しても、選んでいる最中なら選択に足す', async () => {
    setLocale('ja');
    const panel = mount([rec('1'), rec('2')], { listView: 'tiles' });
    const box = panel.root.allByClass('unbake-pick')[0];
    box.checked = true;
    await box.dispatch('click', {});

    // タイルそのもの（絵の外側）を押す。
    await tilesOf(panel)[1].dispatch('click', {});
    await settle();
    assert.deepEqual(panel.selected.sort(), ['1', '2'],
        '同じタイルなのに、押した場所で反応が変わっている');
});

test('選ぶ口を押しても、タイルへ伝わって裏返らない', async () => {
    // **伝わると、入れた直後に外れる**（本物の DOM は上へ伝える）。
    setLocale('ja');
    const panel = mount([rec('1'), rec('2')], { listView: 'tiles' });
    const boxes = panel.root.allByClass('unbake-pick');
    let bubbled = 0;
    await boxes[0].dispatch('click', { stopPropagation: () => { bubbled += 1; } });
    assert.equal(bubbled, 1, '選ぶ口が伝播を止めていない');
});
