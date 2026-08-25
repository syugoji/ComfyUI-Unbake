/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 実機で報告された3巡目（2026-08-20）。
 *
 *   ⑪ タイルの字が読み取りにくい（判定は色だけで足りるのでは）
 *   ⑫ Sweep で LoRA も差し替えたい
 *   ⑬ Sweep の画面が直感的でない（選びにくい・押すまで何が起きるか判らない）
 *   ⑭ Sweep の画面の下が余っている
 *
 * **⑬の中身は2つだった。** 差し替える相手を**名前だけで選ばせていた**ことと、
 * **押すまで何枚出るか判らなかった**こと。どちらも「情報が無い」ではなく
 * 「持っている情報を出していない」だったので、画面へ出す配線を足した。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createUnbakePanel } from '../web/panel/panel.js';
import { createSweepView } from '../web/panel/sweepView.js';
import { buildBuiltinSweepTemplates } from '../web/core/sweepAxes.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale, t } from '../web/i18n/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const OBJECT_INFO = {
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [['base.safetensors', 'other.safetensors']] } } },
    LoraLoader: { input: { required: { lora_name: [[
        'charA.safetensors', 'charB.safetensors', 'charC.safetensors', 'styleX.safetensors',
    ]] } } },
};

const recipeWithLoras = () => ({
    id: 'rec-1',
    title: 'Civitai_Recipe_85789450',
    checkpoint: { file_name: 'base.safetensors' },
    comfy_prompt: {
        1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'base.safetensors' } },
    },
    gen_params: { prompt: 'a girl', seed: 12, steps: 20, cfg_scale: 7, sampler: 'euler' },
    loras: [
        { file_name: 'charA.safetensors', name: 'Char A', modelVersionId: 111, strength: 0.8 },
        { file_name: 'charB.safetensors', name: 'Char B', modelVersionId: 222, strength: 1 },
    ],
});

function mountSweep(recipe, { objectInfo = OBJECT_INFO } = {}) {
    const doc = fakeDocument();
    const view = createSweepView({
        documentRef: doc,
        // 面が受け取るのは**記録**で、中身のレシピは `recipe` に入っている
        // （`sweepableRecord()` がそこを見る）。
        record: {
            id: recipe.id, recipe,
            displayName: 'civitai_85789450', previewUrl: '/unbake/record-preview?id=rec-1',
        },
        runner: { objectInfo },
    });
    return view;
}

// --- ⑫ LoRA を差し替えられる ------------------------------------------------

test('記録が指す LoRA すべてに、差し替えの雛形が出る', () => {
    setLocale('en');
    const templates = buildBuiltinSweepTemplates(recipeWithLoras(), { objectInfo: OBJECT_INFO });
    const swaps = templates.filter(item => item.axes?.[0]?.kind === 'lora_swap');
    // **元は先頭1本だけ**で、しかも同系統の候補が手元に在るときしか出なかった。
    assert.equal(swaps.length, 2, `差し替えの雛形が ${swaps.length} 本しか出ていない`);
    assert.deepEqual(swaps.map(item => item.axes[0].target), ['111', '222']);
});

test('似た名前の候補が無くても、差し替えは選べる', () => {
    setLocale('en');
    // 手元に同系統が1つも無い場合（名前が全く似ていない）。
    const objectInfo = {
        LoraLoader: { input: { required: { lora_name: [['zzz_unrelated.safetensors']] } } },
    };
    const templates = buildBuiltinSweepTemplates(recipeWithLoras(), { objectInfo });
    const swaps = templates.filter(item => item.axes?.[0]?.kind === 'lora_swap');
    assert.equal(swaps.length, 2, '似た名前が無いだけで差し替えを消している');
    // 基準（今使っているもの）は必ず入っている。
    assert.equal(swaps[0].axes[0].values.filter(v => v.baseline).length, 1);
});

// --- ⑬ 絵で選ぶ -------------------------------------------------------------

test('差し替える相手を、見本の絵で選べる', () => {
    setLocale('en');
    const view = mountSweep(recipeWithLoras());
    const select = view.root.byClass('unbake-sweep-template');
    const option = [...select.children].find(o => o.getAttribute('value')?.startsWith('builtin-lora-swap'));
    assert.ok(option, '差し替えの雛形が選べない');
    select.value = option.getAttribute('value');
    select.dispatch('change', {});

    const cards = view.root.allByClass('unbake-sweep-pick');
    // 導入済み4本ぶん（基準1 + 相手3）。
    assert.equal(cards.length, 4, `候補が ${cards.length} 件しか出ていない`);
    for (const card of cards) {
        const image = card.find(n => n.tagName === 'IMG');
        assert.ok(image, '見本の絵を出していない');
        assert.match(image.getAttribute('src'), /^\/unbake\/model-preview\?kind=loras&name=/,
            '見本の引き先が違う');
    }
});

test('基準は外せない（比べる土台が動かない）', () => {
    setLocale('en');
    const view = mountSweep(recipeWithLoras());
    const select = view.root.byClass('unbake-sweep-template');
    select.value = [...select.children].find(o => o.getAttribute('value')?.startsWith('builtin-lora-swap')).getAttribute('value');
    select.dispatch('change', {});

    const baseline = view.root.allByClass('unbake-sweep-pick')
        .find(card => card.getAttribute('data-baseline') === 'true');
    assert.ok(baseline, '基準が印されていない');
    assert.equal(baseline.getAttribute('data-on'), 'true');
    baseline.dispatch('click', {});
    assert.equal(baseline.getAttribute('data-on'), 'true', '基準を外せてしまう');

    // 読み取った値には、基準がちょうど1つ在る。
    const template = view.readTemplate();
    const values = template.axes[0].values;
    assert.equal(values.filter(v => v.baseline).length, 1);
    assert.equal(values.find(v => v.baseline).value, 'charA.safetensors');
});

test('押して選ぶと、その場で枚数が変わる', () => {
    setLocale('en');
    const view = mountSweep(recipeWithLoras());
    const select = view.root.byClass('unbake-sweep-template');
    select.value = [...select.children].find(o => o.getAttribute('value')?.startsWith('builtin-lora-swap')).getAttribute('value');
    select.dispatch('change', {});

    const plan = view.root.byClass('unbake-sweep-plan');
    assert.ok(plan, '何枚出るかを出していない');
    const before = view.readTemplate().axes[0].values.length;

    const other = view.root.allByClass('unbake-sweep-pick')
        .find(card => card.getAttribute('data-baseline') !== 'true' && card.getAttribute('data-on') === 'false');
    other.dispatch('click', {});
    assert.equal(view.readTemplate().axes[0].values.length, before + 1, '選んでも値が増えていない');
    assert.equal(other.getAttribute('aria-pressed'), 'true');

    other.dispatch('click', {});
    assert.equal(view.readTemplate().axes[0].values.length, before, '選び直しで外せない');
});

test('数の軸はスライダーで触る（見本の絵は出さない）', () => {
    setLocale('en');
    const view = mountSweep(recipeWithLoras());
    const select = view.root.byClass('unbake-sweep-template');
    const cfg = [...select.children].find(o => o.getAttribute('value') === 'builtin-cfg-steps');
    select.value = cfg.getAttribute('value');
    select.dispatch('change', {});
    // 数は絵にならないので、見本の一覧は出さない。
    assert.equal(view.root.byClass('unbake-sweep-pick'), null, '数の軸まで絵で選ばせている');
    // **代わりにスライダー。** 元は `ラベル = 値` を手で書かせていた（2026-08-20 に変えた）。
    const sliders = view.root.allByClass('unbake-sweep-slider');
    assert.equal(sliders.length, 2, `スライダーが ${sliders.length} 本しか出ていない`);
    assert.equal(sliders[0].getAttribute('type'), 'range');
});

test('スライダーで値を足すと、その場で枚数が増える', () => {
    setLocale('en');
    const view = mountSweep(recipeWithLoras());
    const select = view.root.byClass('unbake-sweep-template');
    const lora = [...select.children].find(o => o.getAttribute('value') === 'builtin-lora-1');
    select.value = lora.getAttribute('value');
    select.dispatch('change', {});

    const before = view.readTemplate().axes[0].values.length;
    const slider = view.root.byClass('unbake-sweep-slider');
    slider.value = '1.35';
    slider.dispatch('input', {});
    view.root.byClass('unbake-sweep-add').dispatch('click', {});
    const after = view.readTemplate().axes[0].values;
    assert.equal(after.length, before + 1, '足しても値が増えていない');
    assert.ok(after.some(item => Number(item.value) === 1.35), `足した値が入っていない: ${JSON.stringify(after)}`);
    // **基準は1つのまま。** 足したのは比べる相手で、土台は動かない。
    assert.equal(after.filter(item => item.baseline).length, 1);
});

test('基準と同じ値は足せない（同じものを2回組まない）', () => {
    setLocale('en');
    const view = mountSweep(recipeWithLoras());
    const select = view.root.byClass('unbake-sweep-template');
    select.value = [...select.children].find(o => o.getAttribute('value') === 'builtin-lora-1').getAttribute('value');
    select.dispatch('change', {});

    const values = view.readTemplate().axes[0].values;
    const baseline = values.find(item => item.baseline);
    const before = values.length;
    const slider = view.root.byClass('unbake-sweep-slider');
    slider.value = String(baseline.value);
    slider.dispatch('input', {});
    view.root.byClass('unbake-sweep-add').dispatch('click', {});
    assert.equal(view.readTemplate().axes[0].values.length, before, '基準と同じ値を足している');
});

test('導入済みが判らないうちは、字で書かせる（待たせない）', () => {
    setLocale('en');
    // `/object_info` はまだ届いていない。
    const view = mountSweep(recipeWithLoras(), { objectInfo: null });
    assert.equal(view.root.byClass('unbake-sweep-pick'), null,
        '候補が判らないのに絵で選ばせている');
});

// --- ⑬ 押す前に何枚出るか ----------------------------------------------------

test('押す前に、何枚出るかが出る', () => {
    setLocale('en');
    const view = mountSweep(recipeWithLoras());
    const plan = view.root.byClass('unbake-sweep-plan');
    assert.equal(plan.getAttribute('data-state'), 'ok');
    // 既定の雛形は seed 4本。
    assert.match(plan.textContent, /4/, `枚数が出ていない: ${plan.textContent}`);
});

test('数え方は、実際に展開する関数から取る（画面で掛け算し直さない）', async () => {
    // 掛け算をここで書き直すと、本物の展開と食い違ったときに**画面のほうが嘘をつく**。
    const source = await readFile(join(ROOT, 'web/panel/sweepView.js'), 'utf8');
    assert.match(source, /expandSweepTemplate\(template\)\.length/, '展開する関数から数えていない');
});

// --- ⑭ 下の余白 -------------------------------------------------------------

test('結果の場所に、比べる相手（元の1枚）が最初から出る', () => {
    setLocale('en');
    const view = mountSweep(recipeWithLoras());
    const empty = view.root.byClass('unbake-sweep-grid-empty');
    assert.ok(empty, '結果の場所が無い');
    const image = empty.find(n => n.tagName === 'IMG');
    assert.ok(image, '元の1枚を出していない');
    assert.equal(image.getAttribute('src'), '/unbake/record-preview?id=rec-1');
});

test('余る高さは結果へ渡す（下に空箱を残さない）', async () => {
    const css = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');
    assert.match(css, /\.unbake-sweep-results\s*\{[^}]*flex:\s*1 1 auto/,
        '余る高さを結果へ渡していない');
    assert.match(css, /\.unbake-sweep\s*\{[^}]*min-block-size:\s*100%/,
        '面が器の高さを使い切っていない');
    // 選ぶ器が画面を占領しない（何百件でも高さは変わらない）。
    assert.match(css, /\.unbake-sweep-picker-grid\s*\{[^}]*max-block-size/,
        '候補の一覧に高さの上限が無い');
});

// --- ⑪ タイルの字 -----------------------------------------------------------

test('タイルの判定は、手を打つ側にだけ字で出す（2026-08-22 に決め直した）', () => {
    // **元は「色だけ・字は読み上げに残す」だった。** 実機で「色で見分けにくい」と
    // 言われて測ったところ、実データ346件の **81.3% が同じ値**で、
    // 2.4px の帯で三段を見分けさせるのは無理があった。
    //
    // 全部に字を出すと一覧が字で埋まるので、出すのは**手を打つ必要がある側**だけ
    // ——「再現性 高」は何もしなくてよいので、**印が無いことがそのまま印**になる。
    setLocale('en');
    const doc = fakeDocument();
    const mountTiles = (verdict) => {
        const panel = createUnbakePanel(doc.createElement('div'), {
            documentRef: doc, display: { listView: 'tiles' },
        });
        panel.setRecords([{ id: 'a', libraryId: 'a', title: 'Civitai_Recipe_1', verdict }]);
        return panel.root.byClass('unbake-tile');
    };

    const mid = mountTiles('approximate');
    assert.equal(mid.getAttribute('data-verdict'), 'approximate');
    assert.ok(mid.getAttribute('aria-label'), '読み上げ用の語が無い');
    assert.ok(mid.getAttribute('title'), '吹き出し用の語が無い');
    // **語は「度合い」で言う。** 「再現できる」と言い切らない
    // ——材料が揃っていても同じ絵が出る保証ではない（利用者の指摘・2026-08-22）。
    assert.match(mid.getAttribute('aria-label'), /MEDIUM/i);
    const midMark = mid.findAll(n => n.getAttribute?.('data-mark') === 'verdict')[0];
    assert.ok(midMark, '手を打つ側なのに字が出ていない');
    assert.match(midMark.textContent, /medium/i);

    // **上の段には出さない。** 静かなことが「何もしなくてよい」の合図になる。
    const top = mountTiles('reproducible');
    assert.equal(top.findAll(n => n.getAttribute?.('data-mark') === 'verdict').length, 0,
        '上の段にも字を出している（一覧が字で埋まる）');
    assert.match(top.getAttribute('aria-label'), /HIGH/i);

    // 出せない側も字が出る。
    const no = mountTiles('blocked');
    assert.match(no.findAll(n => n.getAttribute?.('data-mark') === 'verdict')[0].textContent, /cannot/i);
});

test('タイルの判定の印は、色だけに頼らない（字と枠の両方）', async () => {
    const css = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');
    // 印そのものは字を持つ（`verdictShort()`）。CSS 側は**枠と字の色**を足すだけで、
    // 色を消しても字が残る形であること——色覚と画面設定に依存させない。
    const mark = css.match(/\.unbake-tile-mark\[data-mark="verdict"\]\s*\{([^}]*)\}/);
    assert.ok(mark, 'タイルの判定の印の規則が無い');
    assert.match(mark[1], /border:/, '枠を持たせていない（色を切ると消える）');
    for (const verdict of ['approximate', 'blocked']) {
        const rule = css.match(new RegExp(`data-mark="verdict"\\]\\[data-verdict="${verdict}"\\]\\s*\\{([^}]*)\\}`));
        assert.ok(rule, `${verdict} の色が無い`);
        assert.match(rule[1], /color:/, `${verdict} の字の色が無い`);
    }
    // 表のほうは字のまま（同じ記録を2つの器で描いていて、字は消えていない）。
    const table = css.match(/\n\.unbake-verdict\s*\{([^}]*)\}/);
    assert.doesNotMatch(table[1], /display:\s*none/, '表からも字を消している');
});

test('名前は地の文の大きさで出す（読ませたいのは名前）', async () => {
    const css = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8');
    const name = css.match(/\.unbake-tile-name\s*\{([^}]*)\}/)[1];
    // **数字を直に書かない。** 大きさは1箇所（`--unbake-font`）で決める
    // ——器ごとに px を書くと、字を大きくするたびに全部を探し直すことになる。
    assert.match(name, /font-size:\s*var\(--unbake-font\)/, `名前の大きさを直書きしている: ${name}`);
    const base = Number(css.match(/--unbake-font:\s*(\d+)px/)?.[1]);
    assert.ok(base >= 13, `地の文が ${base}px しかない（実機で「小さすぎる」と言われた）`);
});

test('使わない回し方では、seed の欄を出さない', () => {
    setLocale('en');
    // 直積（seed 固定）は seed を振らないので、この欄は**常に空**だった。
    // 空の入力欄が黙って居座ると、「ここに何か書くべきか」を毎回考えさせる。
    const view = mountSweep(recipeWithLoras());
    const seeds = view.root.byClass('unbake-sweep-seeds');
    const mode = view.root.byClass('unbake-sweep-mode');

    mode.value = 'cartesian';
    mode.dispatch('change', {});
    assert.equal(seeds.style.display, 'none', '使わない seed の欄を出している');

    mode.value = 'seeds_only';
    mode.dispatch('change', {});
    assert.notEqual(seeds.style.display, 'none', '使う回し方で seed の欄が消えている');
});
