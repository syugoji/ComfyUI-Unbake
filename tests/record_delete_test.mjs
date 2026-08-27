/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 保存・削除の**画面側**（2026-08-21 ユーザー指示）。
 *
 * ここで押さえるのは、**間違えると取り返しがつかない**ものだけ:
 *
 * 1. 取り込んだら**残る**（残せなかったら理由が出る・取り込みは続く）
 * 2. 消す前に**何が消えるかを列挙**し、巻き添えの件数と**数えた範囲**を出す
 * 3. LoRA Manager が書いた記録を消すときは、**向こうには残って見える**と伝える
 * 4. 名前が2つに当たったモデルは**押せない**
 * 5. 「やめる」で戻れる・消したあとは押し直せない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createUnbakePanel } from '../web/panel/panel.js';
import { createConfirmView, sizeText } from '../web/panel/confirmView.js';
import { createModelsView, lorasInPrompt, modelsOf, stemOf, strengthOf } from '../web/panel/modelsView.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale, t } from '../web/i18n/index.js';

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function recordOf(id, extra = {}) {
    return {
        id,
        title: `Record ${id}`,
        verdict: 'reproducible',
        checkpoint: 'shared_ckpt',
        loras: [{ file_name: 'some_lora', strength: 1 }],
        recipe: { id, title: `Record ${id}`, loras: [] },
        origin: { kind: 'civitai', url: `https://civitai.red/images/${id}` },
        ...extra,
    };
}

function mount({
    ingest, recordsIo = null, modelsIo = null, settingsIo = null, display = null,
    makeSweepRunner = null, loadInstalledModels = null, loadRecord = null, loadVariants = null,
    canBuild = null,
} = {}) {
    const documentRef = fakeDocument();
    const panel = createUnbakePanel(documentRef.createElement('div'), {
        documentRef, ingest, recordsIo, modelsIo, settingsIo,
        // **既定は表**（2026-08-28）。渡された display は必ず勝つ。
        display: { listView: 'table', ...(display || {}) },
        makeSweepRunner, loadInstalledModels, loadRecord, loadVariants, canBuild,
    });
    return { documentRef, panel };
}

// --- 取り込んだら残す -------------------------------------------------------

test('取り込んだ記録をディスクへ残す（再読み込みで消えない）', async () => {
    const saved = [];
    const { panel } = mount({
        ingest: async () => ({ records: [recordOf('a'), recordOf('b')], errors: [] }),
        recordsIo: {
            save: async (record) => { saved.push(record.id); return { ok: true, id: record.id }; },
            remove: async () => ({ ok: true }),
        },
    });
    await panel.handleDrop({ getData: () => 'https://civitai.red/images/1' });
    assert.deepEqual(saved, ['a', 'b'], '取り込んだのに残していない');
    assert.equal(panel.getRecords().length, 2);
});

test('残せなかったことを、取り込めなかったことと混ぜない', async () => {
    const { panel } = mount({
        ingest: async () => ({ records: [recordOf('c')], errors: [] }),
        recordsIo: {
            save: async () => ({ ok: false, error: 'disk full' }),
            remove: async () => ({ ok: true }),
        },
    });
    await panel.handleDrop({ getData: () => 'https://civitai.red/images/1' });
    // **取り込みは続く。** 残せないことは、取り込めないことではない。
    assert.equal(panel.getRecords().length, 1, '保存に失敗したら取り込みごと落ちている');
    const log = panel.root.byClass('unbake-log').text;
    assert.match(log, /disk full/, '落ちた理由が画面に出ていない');
});

test('「もう在る」を失敗として出さない（取り込み直しで普通に起きる）', async () => {
    const { panel } = mount({
        ingest: async () => ({ records: [recordOf('d')], errors: [] }),
        recordsIo: {
            save: async () => ({ ok: false, error: 'already saved', id: 'd' }),
            remove: async () => ({ ok: true }),
        },
    });
    await panel.handleDrop({ getData: () => 'https://civitai.red/images/1' });
    const log = panel.root.byClass('unbake-log').text;
    assert.doesNotMatch(log, /already saved/, '「もう在る」を失敗として出している');
});

test('保存の口が無い版では、取り込みだけして黙って落ちない', async () => {
    const { panel } = mount({
        ingest: async () => ({ records: [recordOf('e')], errors: [] }),
        recordsIo: null,
    });
    await panel.handleDrop({ getData: () => 'https://civitai.red/images/1' });
    assert.equal(panel.getRecords().length, 1);
});

// --- 記録を消す -------------------------------------------------------------

test('消す前に確認の面が出て、取り消せないことを字で言う', async () => {
    const { panel } = mount({
        ingest: async () => ({ records: [], errors: [] }),
        recordsIo: { save: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    });
    panel.setRecords([recordOf('f')]);
    const view = panel.confirmDeleteRecord(panel.getRecords()[0]);
    assert.ok(view, '確認の面が開いていない');
    assert.ok(panel.root.byClass('unbake-confirm-danger'), '取り消せないことを書いていない');
    // **「やめる」が在ること。** 逃げ道の無い確認にしない。
    assert.ok(panel.root.byClass('unbake-confirm-cancel'));
});

test('LoRA Manager が書いた記録は、向こうに残って見えることを伝える', async () => {
    const { panel } = mount({
        ingest: async () => ({ records: [], errors: [] }),
        recordsIo: { save: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    });
    panel.setRecords([recordOf('g', { owner: 'lora-manager', libraryId: 'g' })]);
    panel.confirmDeleteRecord(panel.getRecords()[0]);
    const warnings = panel.root.allByClass('unbake-confirm-warning').map(n => n.textContent).join(' ');
    assert.match(warnings, /LoRA Manager/, '向こうの一覧に残ることを伝えていない');
});

test('消したら一覧と選択から外れる', async () => {
    const { panel } = mount({
        ingest: async () => ({ records: [], errors: [] }),
        recordsIo: {
            save: async () => ({ ok: true }),
            remove: async () => ({ ok: true, removed: ['h.unbake.json', 'h.webp'] }),
        },
    });
    panel.setRecords([recordOf('h'), recordOf('i')]);
    panel.selectAllShown();
    panel.confirmDeleteRecord(panel.getRecords().find(r => r.id === 'h'));
    await panel.root.byClass('unbake-confirm-go').dispatch('click');
    await settle();
    assert.deepEqual(panel.getRecords().map(r => r.id), ['i'], '消した記録が一覧に残っている');
    assert.ok(!panel.selected.includes('h'), '消した記録が選択に残っている');
    // **消したものを1件ずつ出す。**
    assert.match(panel.root.byClass('unbake-confirm').text, /h\.webp/, '対の画像が出ていない');
});

test('消せなかったら、押し直せる形で理由を出す', async () => {
    const { panel } = mount({
        ingest: async () => ({ records: [], errors: [] }),
        recordsIo: {
            save: async () => ({ ok: true }),
            remove: async () => ({ ok: false, error: 'refusing to delete outside the configured folders' }),
        },
    });
    panel.setRecords([recordOf('j')]);
    panel.confirmDeleteRecord(panel.getRecords()[0]);
    const go = panel.root.byClass('unbake-confirm-go');
    await go.dispatch('click');
    await settle();
    assert.equal(panel.getRecords().length, 1, '消えていないのに一覧から外している');
    assert.match(panel.root.byClass('unbake-confirm').text, /refusing to delete/);
    assert.equal(go.disabled, false, '押し直せない');
});

// --- 使っているモデル -------------------------------------------------------

test('記録が使っているモデルを、種別つきで拾う', () => {
    // **消す口が要るのは種別と名前。** ここは今までどおり厳密に見る
    //（2026-08-22 に `index`/`source` が増えたので、見る場所を絞った）。
    const identity = entries => entries.map(({ kind, name, role }) => ({ kind, name, role }));
    assert.deepEqual(identity(modelsOf(recordOf('k'))), [
        { kind: 'checkpoints', name: 'shared_ckpt', role: 'checkpoint' },
        { kind: 'loras', name: 'some_lora', role: 'lora' },
    ]);
    // 本体（オブジェクトの checkpoint）でも同じ形になる。
    assert.deepEqual(identity(modelsOf({}, { checkpoint: { file_name: 'ck.safetensors', name: '表示名' }, loras: [] })),
        [{ kind: 'checkpoints', name: 'ck.safetensors', role: 'checkpoint' }]);
    // 同じ名前を2度数えない。
    assert.equal(modelsOf({}, { loras: [{ file_name: 'x' }, { name: 'X' }] }).length, 1);
});

test('強度を読むために、元の資源を落とさない', () => {
    // **名前だけ返すと、行のスライダーが初期値を出せない。** 強度は記録の側に在る。
    const [lora] = modelsOf({}, { loras: [{ file_name: 'w', strength_model: 0.65 }] });
    assert.equal(strengthOf(lora.source), 0.65, '記録の強度が読めていない');
});

test('書いていない強度は 1 で、0 と書いてある強度は 0', () => {
    // **この2つを混ぜると LoRA が黙って効かなくなる。**
    assert.equal(strengthOf({}), 1, '無いものを 0 に丸めている');
    assert.equal(strengthOf(null), 1, '資源が無いのに 0 にしている');
    assert.equal(strengthOf({ strength_model: 0 }), 0, '書いてある 0 を 1 に上書きしている');
    // 綴りが違っても拾う（記録によって key が違う）。
    assert.equal(strengthOf({ weight: 1.2 }), 1.2);
});

// --- 強度のスライダー（2026-08-22 利用者の指示）------------------------------
//
// 「軸」を宣言してから回す形をやめ、**モデルの行で直に動かす**ようにした。
//
// **口はここに置く。** 詳細の作り付けの帯（`detailView.js`）にも同じモデルが
// 並んでいるが、あちらは呼び手がこの面を差すと**丸ごと出ない**。実機で
// `modelRows: 0` を踏んだので、描かれる側で固定する。

function openStrength({
    stored = null,
    storedName = null,
    installed = null,
    loras = [{ file_name: 'w', strength_model: 0.4 }],
} = {}) {
    const saved = [];
    const swaps = [];
    const counts = [];
    const asked = [];
    const alts = [];
    const opened = [];
    const view = createModelsView({
        documentRef: fakeDocument(),
        record: { id: 'r1', checkpoint: 'ck', loras },
        io: {
            plan: async (kind, name) => { asked.push(`${kind}:${name}`); return { ok: true, state: 'none', matches: [] }; },
            remove: async () => ({ ok: true }),
        },
        onDelete: () => {},
        loraStrengthOf: () => stored,
        onLoraStrength: (lora, index, value) => saved.push({ name: lora?.file_name, index, value }),
        onStrengthCount: (count) => counts.push(count),
        modelNameOf: () => storedName,
        onModelName: installed
            ? (source, index, role, name) => swaps.push({ role, index, name, from: source?.file_name ?? source })
            : null,
        loadInstalled: installed ? async (kind) => installed[kind] || [] : null,
        onAlternates: (target, values, label, role) => alts.push({ target, values, label, role }),
        // **絵で選ぶ面は呼び手が出す。** ここでは開かれた中身だけを捕まえる。
        onOpenPicker: (request) => { opened.push(request); },
    });
    /** 面を開いて1つ選ぶ（利用者が絵を押したのと同じ）。 */
    const pick = (name) => {
        const request = opened.at(-1);
        assert.ok(request, '選ぶ面が開かれていない');
        request.onPick(name);
    };
    return {
        view, saved, swaps, counts, asked, alts, opened, pick,
        slider: view.root.byClass('unbake-models-strength'),
        loraRow: () => view.root.allByClass('unbake-models-row')
            .find(item => item.getAttribute('data-role') === 'lora'),
    };
}

test('強度のつまみは、記録の値から始まる', () => {
    assert.equal(openStrength().slider.value, '0.4', '記録の強度から始まっていない');
    // **書いていない強度は 1。** 0 に丸めると、その LoRA が黙って効かなくなる。
    assert.equal(openStrength({ loras: [{ file_name: 'w' }] }).slider.value, '1',
        '書いていない強度を 1 で始めていない');
});

test('前に指した強度があれば、そこから始まる', () => {
    // **開き直すたびに戻ると、指した意味が無い。**
    const { view, slider } = openStrength({ stored: 0.55 });
    assert.equal(slider.value, '0.55', '保存してある上書きから始まっていない');
    const row = view.root.allByClass('unbake-models-row')
        .find(item => item.getAttribute('data-role') === 'lora');
    assert.equal(row.getAttribute('data-changed'), 'true', '開いた時点で変えた印が付いていない');
});

test('動かすと保存され、変えた印が付き、本数が届く', () => {
    const { view, saved, counts, slider } = openStrength();
    slider.value = '0.8';
    slider.dispatch('input', {});
    assert.deepEqual(saved, [{ name: 'w', index: 0, value: 0.8 }], '上書きを保存していない');
    const row = view.root.allByClass('unbake-models-row')
        .find(item => item.getAttribute('data-role') === 'lora');
    assert.equal(row.getAttribute('data-changed'), 'true', '変えた印が付いていない');
    // **開いた直後にも1回届く。** 呼び手は「今いくつ違うのか」を、
    // 触られるまで知らないままにできない（開き直しただけで上書きが残っている）。
    assert.deepEqual(counts, [0, 1], '変えた本数が呼び手へ届いていない');
});

test('記録どおりへ戻すと、上書きが消える（0 で塗り潰さない）', () => {
    // **null を渡すのが「消す」。** 0 を渡すと「0 と指した」ことになり、
    // その LoRA が黙って効かなくなる。
    const { view, saved, counts, slider } = openStrength({ stored: 0.55 });
    slider.value = '0.4';
    slider.dispatch('input', {});
    assert.deepEqual(saved.at(-1), { name: 'w', index: 0, value: null }, '上書きを消していない');
    const row = view.root.allByClass('unbake-models-row')
        .find(item => item.getAttribute('data-role') === 'lora');
    assert.equal(row.getAttribute('data-changed'), 'false', '記録どおりなのに印が残っている');
    assert.equal(counts.at(-1), 0, '戻したのに本数が減っていない');
});

// --- その場で差し替える（2026-08-22 利用者の指示）---------------------------
//
// 「変える」を押して別の面へ飛ぶ形をやめた。戻ってきたときに
// **何を見ていたかが画面から消える**のが理由。

const INSTALLED = { loras: ['w', 'other_lora'], checkpoints: ['ck', 'other_ck'] };

test('選べるのは手元に在るものと、記録が指しているものだけ', async () => {
    // **記録のモデルは必ず並べる。** 手元に無くても、戻す先が消えると戻せない。
    const box = openStrength({ installed: { loras: ['x', 'y'], checkpoints: [] } });
    await box.view.ready;
    const picker = box.loraRow().byClass('unbake-models-pick');
    picker.dispatch('click', {});
    assert.deepEqual(box.opened.at(-1).names, ['w', 'x', 'y'], '記録のモデルが候補に無い');
    assert.equal(picker.value, 'w', '記録のモデルが選ばれていない');
    // **押す前から名前が見えている**（素の `<select>` と同じ読み方ができる）。
    assert.equal(picker.textContent, 'w');
});

test('選び直すと保存され、記録と違う印が付く', async () => {
    const box = openStrength({ installed: INSTALLED });
    await box.view.ready;
    const picker = box.loraRow().byClass('unbake-models-pick');
    picker.dispatch('click', {});
    box.pick('other_lora');
    assert.deepEqual(box.swaps.at(-1), { role: 'lora', index: 0, name: 'other_lora', from: 'w' },
        '差し替えを保存していない');
    assert.equal(box.loraRow().getAttribute('data-changed'), 'true', '記録と違う印が付いていない');
    assert.equal(box.counts.at(-1), 1, '違う本数に入っていない');
});

test('差し替えたら、その名前で状態を引き直す', async () => {
    // **元の名前で引くと、画面に出ているのと違うモデルの大きさ・使用件数・
    // 削除口が出る。** 消す口が繋がっているので、ここがずれると危ない。
    const box = openStrength({ installed: INSTALLED });
    await box.view.ready;
    box.loraRow().byClass('unbake-models-pick').dispatch('click', {});
    box.pick('other_lora');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(box.asked.at(-1), 'loras:other_lora', '差し替え後の名前で引いていない');
});

test('前に選んだモデルがあれば、そこから始まる', async () => {
    const box = openStrength({ installed: INSTALLED, storedName: 'other_lora' });
    await box.view.ready;
    assert.equal(box.loraRow().byClass('unbake-models-pick').value, 'other_lora',
        '保存してある差し替えから始まっていない');
    assert.equal(box.loraRow().getAttribute('data-changed'), 'true', '開いた時点で印が付いていない');
});

test('↺ は記録どおりのときだけ押せない', async () => {
    const box = openStrength({ installed: INSTALLED });
    await box.view.ready;
    const reset = box.loraRow().byClass('unbake-models-reset');
    assert.equal(reset.getAttribute('disabled'), 'true', '記録どおりなのに押せる');
    box.slider.value = '0.9';
    box.slider.dispatch('input', {});
    assert.equal(reset.getAttribute('disabled'), null, '変えたのに押せない');
});

test('↺ は強度も差し替えも、まとめて記録どおりへ戻す', async () => {
    const box = openStrength({ installed: INSTALLED });
    await box.view.ready;
    const picker = box.loraRow().byClass('unbake-models-pick');
    picker.value = 'other_lora';
    picker.dispatch('change', {});
    box.slider.value = '1.4';
    box.slider.dispatch('input', {});

    box.loraRow().byClass('unbake-models-reset').dispatch('click', {});
    // **null を渡すのが「消す」。** 0 や空文字を渡すと「そう指した」ことになる。
    assert.equal(box.saved.at(-1).value, null, '強度の上書きを消していない');
    assert.equal(box.swaps.at(-1).name, null, '差し替えを消していない');
    assert.equal(box.slider.value, '0.4', 'つまみが記録の値へ戻っていない');
    assert.equal(picker.value, 'w', '選択が記録のモデルへ戻っていない');
    assert.equal(box.loraRow().getAttribute('data-changed'), 'false', '印が残っている');
});

test('名前を比べる形は、版番号のところで切れない', () => {
    // **最後の `.` から後ろを落とすと**、拡張子の付いていない名前が壊れる
    // ——実データの `ink-style_A3.1_XL` で踏んだ（サーバ側と同じ判断）。
    assert.equal(stemOf('ink-style_A3.1_XL'), 'ink-style_a3.1_xl');
    assert.equal(stemOf('ink-style_A3.1_XL.safetensors'), 'ink-style_a3.1_xl');
    assert.equal(stemOf('SDXL 1.0\\style\\ink-style_A3.1_XL.safetensors'), 'ink-style_a3.1_xl');
    assert.equal(stemOf('a/b/c.ckpt'), 'c');
    assert.equal(stemOf(null), '');
});

test('記録の素の名前と、手元のファイル名を、同じ1つとして並べる', async () => {
    // 記録が持つのは `w`、`/object_info` が配るのは `dir\\w.safetensors`。
    // **そのまま並べると同じモデルが2つ出て**、片方を選ぶだけで
    // 「記録と違う」印が付く。
    const box = openStrength({
        installed: { loras: ['dir\\w.safetensors', 'other_lora.safetensors'], checkpoints: [] },
    });
    await box.view.ready;
    const picker = box.loraRow().byClass('unbake-models-pick');
    picker.dispatch('click', {});
    assert.deepEqual(box.opened.at(-1).names,
        ['dir\\w.safetensors', 'other_lora.safetensors'], '同じモデルが2つ並んでいる');
    assert.equal(picker.value, 'dir\\w.safetensors', '手元のファイル名が選ばれていない');
    // **寄せただけでは「変えた」ではない。**
    assert.equal(box.loraRow().getAttribute('data-changed'), 'false', '触っていないのに印が付いている');
    assert.equal(box.loraRow().byClass('unbake-models-reset').getAttribute('disabled'), 'true');
    assert.deepEqual(box.swaps, [], '触っていないのに差し替えを保存している');
    // **絵と状態も、寄せ直した名前で引き直す。** 素の名前のままだと
    // 見本が 404 になることがあり、絵だけ出ない（実機で踏んだ）。
    assert.match(box.loraRow().byClass('unbake-models-thumb').getAttribute('src'),
        /name=dir%5Cw\.safetensors/, '見本を寄せ直した名前で引いていない');
    assert.equal(box.asked.at(-1), 'loras:dir\\w.safetensors', '状態を寄せ直した名前で引いていない');
});

test('2つに当たるときは寄せない（どちらか決められない）', async () => {
    const box = openStrength({
        installed: { loras: ['w.safetensors', 'dir\\w.safetensors'], checkpoints: [] },
    });
    await box.view.ready;
    const picker = box.loraRow().byClass('unbake-models-pick');
    picker.dispatch('click', {});
    // 記録の素の名前を残したまま、候補は両方見せる。
    assert.equal(picker.value, 'w', '曖昧なのに片方へ寄せている');
    assert.deepEqual(box.opened.at(-1).names, ['w', 'w.safetensors', 'dir\\w.safetensors']);
});

// --- 比べる相手（2026-08-22 に「振る」の LoRA 差し替え軸から移した）----------

test('「＋」で比べる相手を足すと、基準つきで呼び手へ届く', async () => {
    const box = openStrength({ installed: INSTALLED });
    await box.view.ready;
    const row = box.loraRow();
    // **「＋」は選ぶ面を出す。** 選んだものがそのまま比べる相手になる。
    row.byClass('unbake-models-alt-add').dispatch('click', {});
    box.pick('other_lora');
    // **1つ目は今選んでいるもの。** 基準が無いと、出た絵の側から
    // 「どれが元だったか」を言えなくなる。
    assert.deepEqual(box.alts.at(-1).values, ['w', 'other_lora'], '基準が先頭に来ていない');
    // **身元で指す。** 並び順で指すと、記録によって順が違うので別の LoRA へ当たる。
    assert.equal(box.alts.at(-1).target, 'w');
    assert.equal(row.allByClass('unbake-models-alt').length, 1, '足した相手が札で出ていない');
});

test('今選んでいるものと同じは足さない（展開器が重複で投げる）', async () => {
    const box = openStrength({ installed: INSTALLED });
    await box.view.ready;
    const row = box.loraRow();
    row.byClass('unbake-models-alt-add').dispatch('click', {});
    box.pick('w');                                   // いま選んでいるものと同じ
    assert.deepEqual(box.alts, [], '同じものを足している');
    assert.equal(row.allByClass('unbake-models-alt').length, 0);
    // 2度選んでも増えない。
    row.byClass('unbake-models-alt-add').dispatch('click', {});
    box.pick('other_lora');
    box.pick('other_lora');
    assert.deepEqual(box.alts.at(-1).values, ['w', 'other_lora'], '2度足している');
});

test('札の × で外せる', async () => {
    const box = openStrength({ installed: INSTALLED });
    await box.view.ready;
    const row = box.loraRow();
    row.byClass('unbake-models-alt-add').dispatch('click', {});
    box.pick('other_lora');
    row.byClass('unbake-models-alt-drop').dispatch('click', {});
    assert.deepEqual(box.alts.at(-1).values, ['w'], '外したのに残っている');
    assert.equal(row.allByClass('unbake-models-alt').length, 0);
});

test('選び直すと、比べる相手の基準も付いてくる', async () => {
    // **基準は「今選んでいるもの」。** 知らせ直さないと、軸の1つ目が古いままになり、
    // 出た絵の「元」が実際に回した条件と食い違う。
    const box = openStrength({ installed: { loras: ['w', 'a_lora', 'b_lora'], checkpoints: [] } });
    await box.view.ready;
    const row = box.loraRow();
    row.byClass('unbake-models-alt-add').dispatch('click', {});
    box.pick('a_lora');
    assert.deepEqual(box.alts.at(-1).values, ['w', 'a_lora']);

    // 本体を選び直すと、基準（1つ目）も付いてくる。
    row.byClass('unbake-models-pick').dispatch('click', {});
    box.pick('b_lora');
    assert.deepEqual(box.alts.at(-1).values, ['b_lora', 'a_lora'], '基準が古いまま');
});

test('checkpoint にも「＋」を出す（土台も振れる）', async () => {
    // **2026-08-22 に「振る」から移した。** 土台を変えると絵は大きく動くので、
    // 比べたい相手が複数あるのが普通——LoRA だけに出していたのを改めた。
    const box = openStrength({ installed: INSTALLED });
    await box.view.ready;
    const ckpt = box.view.root.allByClass('unbake-models-row')
        .find(item => item.getAttribute('data-role') === 'checkpoint');
    assert.ok(ckpt.byClass('unbake-models-alt-add'), 'checkpoint に「＋」が無い');

    ckpt.byClass('unbake-models-alt-add').dispatch('click', {});
    box.pick('other_ck');
    // **土台は `target` を取らない**（記録の checkpoint は1つ）ので、
    // 呼び手が LoRA と混ぜないよう種別も一緒に渡す。
    assert.equal(box.alts.at(-1).target, 'checkpoint');
    assert.equal(box.alts.at(-1).role, 'checkpoint');
    assert.deepEqual(box.alts.at(-1).values, ['ck', 'other_ck']);
});

test('モデルの面で足した相手が、詳細のボタンの枚数に届く', async () => {
    // **知らせるだけでは何も起きない。** 強度の本数も比べる相手も面の外で
    // 持っているので、描き直すところまでが1つの動き——実機で
    // 「＋で足したのに枚数が増えない」を踏んだ（2026-08-22）。
    setLocale('en');
    const { panel } = mount({
        ingest: async () => ({ records: [], errors: [] }),
        makeSweepRunner: () => ({ inputsReady: Promise.resolve(), run: async () => ({ cells: [] }), stop() {} }),
        loadInstalledModels: async (kind) => (kind === 'loras' ? ['some_lora', 'other_lora'] : ['shared_ckpt']),
        modelsIo: {
            plan: async () => ({ ok: true, state: 'one', matches: [], files: [], bytes: 0, usage: { count: 1 } }),
            remove: async () => ({ ok: true, removed: [] }),
        },
    });
    // **本体側にも LoRA を置く。** `modelsOf` は本体を先に見るので、
    // 要約にだけ置くと行が1つも出ない。
    panel.setRecords([recordOf('bridge', {
        recipe: { id: 'bridge', loras: [{ file_name: 'some_lora', strength: 1 }] },
    })]);
    const view = await panel.openDetail(panel.getRecords()[0]);
    await view.modelsPane?.ready;
    await settle();

    const before = panel.root.byClass('unbake-detail-run').textContent;
    const row = panel.root.allByClass('unbake-models-row')
        .find(item => item.getAttribute('data-role') === 'lora');
    // 「＋」は絵で選ぶ面を出す。**その面は呼び手（panel）が出す**ので、
    // ここでは面が開いたことと、選んだ結果が届くことを一緒に見る。
    row.byClass('unbake-models-alt-add').dispatch('click', {});
    const request = panel.root.byClass('unbake-picker');
    assert.ok(request, '選ぶ面が出ていない');
    const other = panel.root.allByClass('unbake-picker-row')
        .find(item => item.getAttribute('title') === 'other_lora');
    assert.ok(other, '候補に出ていない');
    other.dispatch('click', {});
    await settle();

    const after = panel.root.byClass('unbake-detail-run').textContent;
    assert.notEqual(after, before, 'ボタンの字が古いまま');
    assert.match(after, /2/, '2枚になっていない');

    // **強度も同じ橋を渡る。** 動かした本数はボタンの字に出るので、
    // 知らせるだけで描き直さないと、ここも古いままになる。
    row.byClass('unbake-models-alt-drop').dispatch('click', {});
    await settle();
    const plain = panel.root.byClass('unbake-detail-run').textContent;
    row.byClass('unbake-models-strength').value = '0.35';
    row.byClass('unbake-models-strength').dispatch('input', {});
    await settle();
    assert.notEqual(panel.root.byClass('unbake-detail-run').textContent, plain,
        '強度を動かしてもボタンの字が古いまま');
});

test('checkpoint にはつまみを出さない（強度が無い）', () => {
    const { view } = openStrength();
    const ckpt = view.root.allByClass('unbake-models-row')
        .find(item => item.getAttribute('data-role') === 'checkpoint');
    assert.ok(ckpt, 'checkpoint の行が無い');
    assert.equal(ckpt.byClass('unbake-models-strength'), null, 'checkpoint につまみを出している');
});

test('モデルの面が、使用件数と「数えた範囲」を必ず出す', async () => {
    const { panel } = mount({
        ingest: async () => ({ records: [], errors: [] }),
        modelsIo: {
            plan: async (kind, name) => ({
                ok: true, state: 'one', matches: [name], path: `/models/${name}`,
                files: [{ name: `${name}.safetensors`, bytes: 2 * 1024 * 1024 * 1024 }],
                bytes: 2 * 1024 * 1024 * 1024,
                usage: { count: 39, scope: 'library-records-only' },
            }),
            remove: async () => ({ ok: true, removed: [] }),
        },
    });
    panel.setRecords([recordOf('l')]);
    const view = await panel.openModels(panel.getRecords()[0]);
    await view.ready;
    const text = panel.root.byClass('unbake-models').text;
    assert.match(text, /39/, '使用件数が出ていない');
    assert.match(text, /2\.0 GB|2 GB/, '大きさが出ていない');
    // **0件を「安全」と読ませない。** 範囲の但し書きが必ず在ること。
    // `/0/` のような「何にでも当たる」条件で確かめない——実際の文言で見る。
    assert.equal(text.includes(t('models.scope')), true, '数えた範囲の但し書きが無い');
});

test('名前が2つに当たったモデルは押せない（候補を出したまま止める）', async () => {
    const { panel } = mount({
        ingest: async () => ({ records: [], errors: [] }),
        modelsIo: {
            plan: async () => ({
                ok: false, state: 'many',
                matches: ['DetailedEyes_V3.safetensors', 'SDXL 1.0\\tool\\DetailedEyes_V3.safetensors'],
                files: [], bytes: 0, usage: { count: 1, scope: 'library-records-only' },
            }),
            remove: async () => { throw new Error('押せてはいけない'); },
        },
    });
    panel.setRecords([recordOf('m')]);
    const view = await panel.openModels(panel.getRecords()[0]);
    await view.ready;
    const buttons = panel.root.allByClass('unbake-models-delete');
    assert.ok(buttons.length > 0);
    assert.ok(buttons.every(b => b.disabled), '曖昧なまま押せる状態になっている');
    assert.match(panel.root.byClass('unbake-models').text, /DetailedEyes_V3/, '候補を出していない');
});

test('モデルを消すときは、巻き添えの件数を確認の面に出す', async () => {
    const removed = [];
    const { panel } = mount({
        ingest: async () => ({ records: [], errors: [] }),
        modelsIo: {
            plan: async (kind, name) => ({
                ok: true, state: 'one', matches: [name], path: `/models/${name}`,
                files: [{ name: `${name}.safetensors`, bytes: 100 }], bytes: 100,
                usage: { count: 39, scope: 'library-records-only' },
            }),
            remove: async (kind, name) => { removed.push([kind, name]); return { ok: true, removed: [name] }; },
        },
    });
    panel.setRecords([recordOf('n')]);
    const view = await panel.openModels(panel.getRecords()[0]);
    await view.ready;
    await panel.root.allByClass('unbake-models-delete')[0].dispatch('click');
    await settle();
    const warnings = panel.root.allByClass('unbake-confirm-warning').map(n => n.textContent).join(' ');
    assert.match(warnings, /38/, '「他に何件が壊れるか」を出していない');
    assert.equal(warnings.includes(t('models.delete.scope')), true, '数えた範囲を出していない');
    await panel.root.byClass('unbake-confirm-go').dispatch('click');
    await settle();
    assert.deepEqual(removed, [['checkpoints', 'shared_ckpt']]);
});

test('確認の面は一覧の上に2枚重ならない', async () => {
    const { panel } = mount({
        ingest: async () => ({ records: [], errors: [] }),
        recordsIo: { save: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    });
    panel.setRecords([recordOf('o')]);
    panel.confirmDeleteRecord(panel.getRecords()[0]);
    assert.ok(panel.confirmView);
    panel.confirmDeleteRecord(panel.getRecords()[0]);
    assert.equal(panel.root.allByClass('unbake-confirm').length, 1, '確認の面が2枚出ている');
});

// --- 表示の細部 -------------------------------------------------------------

test('0バイトと「大きさが読めない」を混ぜない', () => {
    assert.equal(sizeText(0), '0 B');
    assert.equal(sizeText(null), '—');
    assert.equal(sizeText(undefined), '—');
    assert.match(sizeText(1024), /1\.0 KB|1 KB/);
});

test('消す口を、よく押すものと同じ顔にしない', async () => {
    const { panel } = mount({
        ingest: async () => ({ records: [], errors: [] }),
        recordsIo: { save: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    });
    panel.setRecords([recordOf('p')]);
    const del = panel.root.byClass('unbake-act-delete');
    assert.ok(del, '削除ボタンが記録の操作に出ていない');
    assert.ok(String(del.attributes.get('title') || '').length > 0, '何のボタンか読み上げられない');
});

test('口が無ければ削除ボタンを出さない（押せないボタンを並べない）', () => {
    const { panel } = mount({ ingest: async () => ({ records: [], errors: [] }) });
    panel.setRecords([recordOf('q')]);
    assert.equal(panel.root.byClass('unbake-act-delete'), null);
    assert.equal(panel.root.byClass('unbake-act-models'), null);
});

test('確認の面を直接作っても、押すまで何も起きない', async () => {
    const doc = fakeDocument();
    let called = 0;
    const view = createConfirmView({
        documentRef: doc,
        title: 'x',
        files: [{ name: 'a.safetensors', bytes: 10 }],
        warnings: ['warn'],
        onConfirm: async () => { called += 1; return { ok: true, removed: ['a.safetensors'] }; },
    });
    assert.equal(called, 0, '開いただけで走っている');
    await view.root.byClass('unbake-confirm-go').dispatch('click');
    await settle();
    assert.equal(called, 1);
    // 消したあとは押し直せない（二度押しで同じ処理が走らない）。
    assert.equal(view.root.byClass('unbake-confirm-go').disabled, true);
});

test('大きさが分からない項目を「合計 0 B」に丸めない', async () => {
    // **実機で最初にそう出た。** 記録の削除では消える実ファイルの大きさを
    // 画面が知らないので `bytes: null` を渡している。`Number(null) || 0` で
    // 足すと「合計 0 B」＝**中身が空だと読める**（実際には記録と対の画像が消える）。
    const doc = fakeDocument();
    const unknown = createConfirmView({
        documentRef: doc, title: 'x',
        files: [{ name: 'なにか', bytes: null }],
        onConfirm: async () => ({ ok: true, removed: [] }),
    });
    assert.doesNotMatch(unknown.root.text, /0 B/, '分からない大きさを 0 に丸めている');
    assert.match(unknown.root.text, /—/, '分からないことを出していない');

    // 一部だけ分かるときは、**分かっている分だけの合計**だと明示する。
    const partial = createConfirmView({
        documentRef: doc, title: 'x',
        files: [{ name: 'a', bytes: 2048 }, { name: 'b', bytes: null }],
        onConfirm: async () => ({ ok: true, removed: [] }),
    });
    assert.equal(partial.root.text.includes(t('confirm.filesPartial', { count: 2, size: '2.0 KB' })), true,
        '一部しか測れていないことを伝えていない');

    // 全部分かるときは、今までどおりの言い方。
    const full = createConfirmView({
        documentRef: doc, title: 'x',
        files: [{ name: 'a', bytes: 1024 }],
        onConfirm: async () => ({ ok: true, removed: [] }),
    });
    assert.equal(full.root.text.includes(t('confirm.files', { count: 1, size: '1.0 KB' })), true);
});

// --- ポップアップと「二度と表示しない」（2026-08-22 利用者の指示）-------------

test('確認は面ではなくポップアップで、後ろの一覧を隠さない', () => {
    const { panel } = mount({
        ingest: async () => ({ records: [], errors: [] }),
        recordsIo: { save: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    });
    panel.setRecords([recordOf('r1'), recordOf('r2')]);
    const bodyBefore = panel.root.byClass('unbake-body').style.display;
    panel.confirmDeleteRecord(panel.getRecords()[0]);
    const backdrop = panel.root.byClass('unbake-confirm-backdrop');
    assert.ok(backdrop, '重ねる面になっていない');
    assert.equal(backdrop.attributes.get('role'), 'dialog');
    assert.equal(backdrop.attributes.get('aria-modal'), 'true');
    // **後ろが隠れないこと。** ここが本題——どれを消そうとしているのかが
    // 確認の最中も見えている必要がある。
    assert.equal(panel.root.byClass('unbake-body').style.display, bodyBefore,
        '確認を出すために一覧を隠している');
    // 記録の操作（🗑）は後ろに残ったまま＝一覧が描かれている。
    assert.ok(panel.root.byClass('unbake-act-delete'), '後ろの一覧が消えている');
});

test('「二度と表示しない」を付けて消すと、設定として保存される', async () => {
    const written = [];
    const { panel } = mount({
        ingest: async () => ({ records: [], errors: [] }),
        recordsIo: { save: async () => ({ ok: true }), remove: async () => ({ ok: true, removed: ['x'] }) },
        settingsIo: { read: async () => ({ settings: {} }), write: async (patch) => { written.push(patch); return {}; } },
    });
    panel.setRecords([recordOf('r3')]);
    panel.confirmDeleteRecord(panel.getRecords()[0]);
    panel.root.byClass('unbake-confirm-suppress').checked = true;
    await panel.root.byClass('unbake-confirm-go').dispatch('click');
    await settle();
    assert.deepEqual(written, [{ confirm_before_delete: false }], '設定へ保存していない');
});

test('消せなかった回に「二度と表示しない」を効かせない', async () => {
    const written = [];
    const { panel } = mount({
        ingest: async () => ({ records: [], errors: [] }),
        recordsIo: { save: async () => ({ ok: true }), remove: async () => ({ ok: false, error: 'nope' }) },
        settingsIo: { read: async () => ({ settings: {} }), write: async (patch) => { written.push(patch); return {}; } },
    });
    panel.setRecords([recordOf('r4')]);
    panel.confirmDeleteRecord(panel.getRecords()[0]);
    panel.root.byClass('unbake-confirm-suppress').checked = true;
    await panel.root.byClass('unbake-confirm-go').dispatch('click');
    await settle();
    // **失敗した回で切ると、次からは理由も見えないまま同じ失敗を繰り返す。**
    assert.deepEqual(written, [], '消せなかったのに確認を切っている');
});

test('確認を切ってあると、ポップアップを出さずに消す（結果は履歴へ出す）', async () => {
    const removed = [];
    const { panel } = mount({
        ingest: async () => ({ records: [], errors: [] }),
        recordsIo: {
            save: async () => ({ ok: true }),
            remove: async (id) => { removed.push(id); return { ok: true, removed: [`${id}.unbake.json`] }; },
        },
        display: { confirmBeforeDelete: false },
    });
    panel.setRecords([recordOf('r5')]);
    panel.confirmDeleteRecord(panel.getRecords()[0]);
    await settle();
    await settle();
    assert.deepEqual(removed, ['r5'], '消していない');
    assert.equal(panel.root.byClass('unbake-confirm-backdrop'), null, '切ってあるのにポップアップが出た');
    // **黙らせない。** 確認を出さないことと、何が起きたか伝えないことは別。
    assert.match(panel.root.byClass('unbake-log').text, /r5\.unbake\.json/,
        '何を消したのかが履歴に出ていない');
    // **消えた記録は一覧からも消える。** ポップアップが出ないぶん、
    // 画面が変わらないと「押しても消えない」ようにしか見えない
    // （2026-08-22 に実機でそう報告された）。
    assert.deepEqual(panel.getRecords().map(item => item.id), [], '記録が残っている');
    assert.equal(panel.root.byClass('unbake-act-delete'), null, '一覧を描き直していない');
});

test('設定から確認を戻すと、その場で効く', async () => {
    const { panel } = mount({
        ingest: async () => ({ records: [], errors: [] }),
        recordsIo: { save: async () => ({ ok: true }), remove: async () => ({ ok: true, removed: [] }) },
        display: { confirmBeforeDelete: false },
    });
    panel.setRecords([recordOf('r6')]);
    // 切ってある状態では出ない。
    panel.confirmDeleteRecord(panel.getRecords()[0]);
    assert.equal(panel.root.byClass('unbake-confirm-backdrop'), null);
    // 設定画面の保存を通して戻す（`onSaved` は `applyDisplay` を呼ぶ）。
    panel.applyDisplay({ confirm_before_delete: true });
    panel.setRecords([recordOf('r7')]);
    panel.confirmDeleteRecord(panel.getRecords()[0]);
    assert.ok(panel.root.byClass('unbake-confirm-backdrop'),
        '設定で戻しても、開き直すまで確認が出ない');
});

test('ポップアップの外を押すと閉じる（＝消さない）', async () => {
    const removed = [];
    const { panel } = mount({
        ingest: async () => ({ records: [], errors: [] }),
        recordsIo: {
            save: async () => ({ ok: true }),
            remove: async (id) => { removed.push(id); return { ok: true }; },
        },
    });
    panel.setRecords([recordOf('r8')]);
    panel.confirmDeleteRecord(panel.getRecords()[0]);
    const backdrop = panel.root.byClass('unbake-confirm-backdrop');
    await backdrop.dispatch('click', { target: backdrop });
    await settle();
    assert.equal(panel.root.byClass('unbake-confirm-backdrop'), null, '外を押しても閉じない');
    assert.deepEqual(removed, [], '閉じただけで消えている');
});

test('ポップアップの中を押しても閉じない（読んでいる最中に消えない）', async () => {
    const { panel } = mount({
        ingest: async () => ({ records: [], errors: [] }),
        recordsIo: { save: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    });
    panel.setRecords([recordOf('r9')]);
    panel.confirmDeleteRecord(panel.getRecords()[0]);
    const backdrop = panel.root.byClass('unbake-confirm-backdrop');
    await backdrop.dispatch('click', { target: panel.root.byClass('unbake-confirm') });
    await settle();
    assert.ok(panel.root.byClass('unbake-confirm-backdrop'), '中を押したら閉じてしまう');
});

// --- お気に入り（2026-08-22 利用者の指摘）------------------------------------

test('上流が立てた印も外せる（上流のファイルは書き換えない）', () => {
    // **実データではお気に入り128件のほとんどが上流由来**で、元は外せなかった。
    // お気に入り順に並べると上に来るのが全部それなので、
    // **押しても何も起きない**画面になっていた。
    const { panel } = mount({ ingest: async () => ({ records: [], errors: [] }) });
    panel.setRecords([recordOf('up', { favorite: true })]);
    const star = panel.root.byClass('unbake-act-favorite');
    assert.equal(star.getAttribute('data-on'), 'true', '上流の印が出ていない');

    star.dispatch('click', {});
    assert.equal(panel.root.byClass('unbake-act-favorite').getAttribute('data-on'), 'false',
        '押しても外れない');
    // もう一度押すと戻る（打ち消しの名簿から抜ける）。
    panel.root.byClass('unbake-act-favorite').dispatch('click', {});
    assert.equal(panel.root.byClass('unbake-act-favorite').getAttribute('data-on'), 'true',
        '押し戻せない');
});

test('外した印は、次に開いたときも外れたまま', () => {
    // **上流の印は次の走査で戻ってくる。** 打ち消しはこちら側で持つ。
    const { panel } = mount({
        ingest: async () => ({ records: [], errors: [] }),
        display: { unfavoriteIds: ['up'] },
    });
    panel.setRecords([recordOf('up', { favorite: true })]);
    assert.equal(panel.root.byClass('unbake-act-favorite').getAttribute('data-on'), 'false',
        '外したはずの印が戻っている');
});

test('お気に入りだけに絞れる（件数は絞っても見え続ける）', () => {
    const { panel } = mount({ ingest: async () => ({ records: [], errors: [] }) });
    panel.setRecords([
        recordOf('a', { favorite: true }),
        recordOf('b'),
        recordOf('c'),
    ]);
    const chip = panel.root.byClass('unbake-chip-favorite');
    assert.ok(chip, 'お気に入りの絞り込みが無い');
    assert.match(chip.textContent, /1/, '件数が出ていない');
    assert.equal(panel.root.allByClass('unbake-act-favorite').length, 3);

    chip.dispatch('click', {});
    assert.equal(chip.getAttribute('data-on'), 'true', '押した印が付いていない');
    assert.equal(panel.root.allByClass('unbake-act-favorite').length, 1, '絞れていない');
    // **件数は絞り込んでいても見え続ける**（判定の絞り込みと同じ作法）。
    assert.match(panel.root.byClass('unbake-chip-favorite').textContent, /1/);

    panel.root.byClass('unbake-chip-favorite').dispatch('click', {});
    assert.equal(panel.root.allByClass('unbake-act-favorite').length, 3, '戻せていない');
});

test('戻る先が無いなら、戻る口も出さない（使っているモデル）', async () => {
    // **押しても何も起きないボタンを出さない**（2026-08-22 利用者の指摘）。
    // 詳細の中へ差すときは `onClose: null` なので、戻る先そのものが無い。
    const box = openStrength({ installed: INSTALLED });
    await box.view.ready;
    assert.equal(box.view.root.byClass('unbake-sweep-back'), null, '戻る口が残っている');
    assert.equal(box.view.root.byClass('unbake-sweep-head'), null, '題まで出している');

    // 単体で開くとき（`onClose` が在る）は今までどおり出る。
    const alone = createModelsView({
        documentRef: fakeDocument(),
        record: { id: 'r1', checkpoint: 'ck', loras: [] },
        io: { plan: async () => ({ ok: true, state: 'none', matches: [] }), remove: async () => ({ ok: true }) },
        onDelete: () => {},
        onClose: () => {},
    });
    await alone.ready;
    assert.ok(alone.root.byClass('unbake-sweep-back'), '単体の面から戻る口が消えている');
});

// --- プロンプトが名指しする LoRA（2026-08-22 利用者の指摘）-------------------
//
// **実データ 347件のうち 20件**で、プロンプトの `<lora:…>` が `loras` に
// 入っていなかった（`Civitai_Recipe_91163810` は5本すべて欠落し、件数は 0）。

test('`<lora:名前:効き目>` を読む', () => {
    assert.deepEqual(lorasInPrompt('a <lora:foo:0.8> b <lora:bar> c'),
        [{ name: 'foo', strength: 0.8 }, { name: 'bar', strength: 1 }]);
    // 効き目を書いていなければ 1（0 に丸めると効かなくなる）。
    assert.deepEqual(lorasInPrompt('<lora:x>'), [{ name: 'x', strength: 1 }]);
    // 同じ名前は1度だけ。
    assert.equal(lorasInPrompt('<lora:x:1> <lora:X:2>').length, 1);
    // 3つ目以降（clip 側の効き目）が付いていても壊れない。
    assert.deepEqual(lorasInPrompt('<lora:y:0.5:0.3>'), [{ name: 'y', strength: 0.5 }]);
    assert.deepEqual(lorasInPrompt(''), []);
    assert.deepEqual(lorasInPrompt(null), []);
});

test('一覧に無い LoRA も、使っているモデルとして出す', () => {
    const entries = modelsOf({}, {
        checkpoint: 'ck',
        loras: [{ file_name: 'listed' }],
        gen_params: { prompt: 'x <lora:listed:0.7> <lora:only_in_prompt:0.4> y' },
    });
    const names = entries.filter(e => e.role === 'lora').map(e => e.name);
    // **一覧に在るものは二重に出ない**（茎で弾く）。
    assert.deepEqual(names, ['listed', 'only_in_prompt']);
    const found = entries.find(e => e.name === 'only_in_prompt');
    assert.equal(strengthOf(found.source), 0.4, '文に書いてある効き目を拾っていない');
    // **出どころを消さない。** 版 ID も hash も無いので、同じ強さの手掛かりだと読ませない。
    assert.equal(found.source.fromPrompt, true);
    assert.notEqual(entries.find(e => e.name === 'listed').source.fromPrompt, true);
});

test('一覧が空でも、文が名指ししていれば出す', () => {
    // 実データ `Civitai_Recipe_91163810` の形（5本すべて欠落・件数 0）。
    const entries = modelsOf({ loras: [], gen_params: { prompt: '<lora:a:1> <lora:b:1>' } });
    assert.deepEqual(entries.filter(e => e.role === 'lora').map(e => e.name), ['a', 'b']);
});

test('戻る先が無いなら、戻る口も出さない（出た絵）', async () => {
    // **同じ死んだボタンが2つの面に在った**（2026-08-22 利用者の指摘）。
    // 「使っているモデル」だけ直して終わりにすると、隣のタブに残る。
    setLocale('en');
    const { panel } = mount({
        ingest: async () => ({ records: [], errors: [] }),
        loadVariants: async () => ({ outputs: [], recipe: null }),
    });
    panel.setRecords([recordOf('v1')]);
    const view = await panel.openDetail(panel.getRecords()[0]);
    const tab = panel.root.allByClass('unbake-detail-tab')
        .find(item => item.getAttribute('data-tab') === 'variants')
        || panel.root.allByClass('unbake-detail-tabs')[0]?.children?.[0];
    tab?.dispatch('click', {});
    await settle();
    await settle();
    assert.ok(panel.root.byClass('unbake-variants'), '出た絵の面が出ていない');
    assert.equal(panel.root.byClass('unbake-sweep-back'), null, '戻る口が残っている');
    void view;
});

// --- 取り込んだ直後の控えを、書庫の記録へ入れ替える（2026-08-22 利用者の報告）---
//
// 取り込み器が作る控えはディスクの記録と別物で、そのままだと3つ同時に壊れる:
// 絵が出ない・消せない・名前が変わらない。**読み直せば3つとも直る。**

test('保存できたら書庫から読み直して差し替える', async () => {
    setLocale('en');
    // **面が並べる形**（`libraryRowToRecord` を通した後）。
    const fresh = [
        { id: 'saved-1', title: 'civitai_1', verdict: 'reproducible', previewUrl: '/p?id=saved-1' },
    ];
    const reloads = [];
    const { panel } = mount({
        ingest: async () => ({ records: [{ id: 'temp-1', title: 'dropped.png' }], errors: [] }),
        recordsIo: {
            save: async () => ({ ok: true, id: 'saved-1' }),
            remove: async () => ({ ok: true }),
            reload: async () => { reloads.push(true); return fresh; },
        },
        settingsIo: {
            read: async () => ({ settings: {} }), write: async () => ({}),
            // **こちらは*行*を返す口。** 面へ渡ってはいけない方（下の検査で固定する）。
            rescan: async () => [{ id: 'saved-1', title: 'civitai_1', preview: true }],
        },
    });
    await panel.ingestRouted({ route: 'drop', file: 'x.png' });
    await settle();
    assert.deepEqual(reloads, [true], '保存したのに読み直していない');
    // **控えではなく、ディスクの記録が並ぶ。**
    assert.deepEqual(panel.getRecords().map(r => r.id), ['saved-1'], '控えのまま並んでいる');
    assert.equal(panel.getRecords()[0].previewUrl, '/p?id=saved-1', '絵の口が控えのまま');
});

test('読み直しに、この回で取り込んだ分を渡す（全件の判定を組み直さない）', async () => {
    /*
     * **実機で 353件・約6秒**（2026-08-26 利用者の報告）。URL を1本
     * ドロップするたび、取り込んだ1件のために他の 352件を組み直していた。
     *
     * 組み立て側は既に「計算済みは飛ばす」作りなので、原因は**読み直しが
     * 全件の控えを捨てていた**こと。**捨てる先を教えれば足りる。**
     */
    setLocale('en');
    const got = [];
    const { panel } = mount({
        ingest: async () => ({ records: [{ id: 'temp-1', title: 'dropped.png' }], errors: [] }),
        recordsIo: {
            save: async () => ({ ok: true, id: 'saved-1' }),
            remove: async () => ({ ok: true }),
            reload: async (changed) => {
                got.push(changed);
                return [{ id: 'saved-1', title: 'civitai_1', verdict: 'reproducible' }];
            },
        },
    });
    await panel.ingestRouted({ route: 'drop', file: 'x.png' });
    await settle();
    assert.equal(got.length, 1, '読み直していない');
    assert.ok(Array.isArray(got[0]), `変わった先を渡していない: ${JSON.stringify(got[0])}`);
    // **保存で付いた書庫の id が要る。** 控えの id では表の行に当たらない。
    assert.deepEqual(got[0].map(record => record.libraryId ?? record.id), ['saved-1'],
        `渡した顔ぶれが違う: ${JSON.stringify(got[0])}`);
});

test('読み直しに*行*の口を使わない（使うと一覧の絵が全部消える）', async () => {
    // **実機で起きた**（2026-08-23 利用者の報告）: 取り込んだ直後に一覧の絵が
    // 全部消え、再読み込みで直る。行は `preview: true` を持つが、面が読むのは
    // `previewUrl`——**ディスクの記録も索引も正しかった**のに「保存できていない」
    // ように見えた。
    //
    // 元の検査はこれを見逃した。**偽物が実物と違う形を返していた**からで、
    // `rescan` の返り値に `previewUrl` を持たせてあった。
    setLocale('en');
    const rows = [{ id: 'saved-3', title: 'civitai_3', preview: true, base_model: 'SDXL' }];
    const { panel } = mount({
        ingest: async () => ({ records: [{ id: 'temp-3', title: 'dropped.png' }], errors: [] }),
        recordsIo: {
            save: async () => ({ ok: true, id: 'saved-3' }),
            remove: async () => ({ ok: true }),
            // **形を変える責任はこちら側。** 口が無いなら控えのまま残す。
            reload: null,
        },
        settingsIo: {
            read: async () => ({ settings: {} }), write: async () => ({}),
            rescan: async () => rows,
        },
    });
    await panel.ingestRouted({ route: 'drop', file: 'x.png' });
    await settle();
    const shown = panel.getRecords();
    // 行がそのまま並んでいたら、`previewUrl` を1つも持たない一覧になる。
    assert.equal(shown.some(r => r.preview === true && !('previewUrl' in r)), false,
        '生の行を面へ渡している（絵の口が無い記録が並ぶ）');
    assert.deepEqual(shown.map(r => r.id), ['temp-3'], '読み直せないのに控えを捨てている');
});

test('読み直せなくても取り込みは成功のまま（理由だけ出す）', async () => {
    setLocale('en');
    const { panel } = mount({
        ingest: async () => ({ records: [{ id: 'temp-2', title: 'dropped.png' }], errors: [] }),
        recordsIo: {
            save: async () => ({ ok: true, id: 'saved-2' }),
            remove: async () => ({ ok: true }),
            reload: async () => { throw new Error('disk is busy'); },
        },
        settingsIo: {
            read: async () => ({ settings: {} }), write: async () => ({}),
        },
    });
    const result = await panel.ingestRouted({ route: 'drop', file: 'x.png' });
    await settle();
    // **読み直せないことと、取り込めないことは別。**
    assert.equal(result.ok, true, '読み直しの失敗で取り込みまで失敗にしている');
    assert.match(panel.root.byClass('unbake-log').text, /disk is busy/, '理由が出ていない');
    assert.deepEqual(panel.getRecords().map(r => r.id), ['temp-2'], '控えまで消えている');
});

test('外したら、タイルの★も消える（ボタンと同じ答えになる）', () => {
    // **`record.favorite` を直に見ていた**ので、こちらで外しても
    // 上流の印が残り、★が消えなかった（2026-08-22 利用者の報告）。
    setLocale('en');
    // **印はタイルにしか出ない**（表には ★ の列が無い）。
    const { panel } = mount({
        ingest: async () => ({ records: [], errors: [] }),
        display: { listView: 'tiles' },
    });
    panel.setRecords([recordOf('up', { favorite: true })]);
    const markOf = () => panel.root.allByClass('unbake-tile-mark')
        .find(m => m.getAttribute('data-mark') === 'favorite');
    assert.ok(markOf(), '上流の印が出ていない');

    panel.root.byClass('unbake-act-favorite').dispatch('click', {});
    assert.equal(markOf(), undefined, '外したのに★が残っている');
    assert.equal(panel.root.byClass('unbake-act-favorite').getAttribute('data-on'), 'false',
        'ボタンと印が食い違っている');

    panel.root.byClass('unbake-act-favorite').dispatch('click', {});
    assert.ok(markOf(), '押し戻しても★が出ない');
});

test('外した印は、開き直しても★を出さない', () => {
    setLocale('en');
    const { panel } = mount({
        ingest: async () => ({ records: [], errors: [] }),
        display: { unfavoriteIds: ['up'], listView: 'tiles' },
    });
    panel.setRecords([recordOf('up', { favorite: true })]);
    const mark = panel.root.allByClass('unbake-tile-mark')
        .find(m => m.getAttribute('data-mark') === 'favorite');
    assert.equal(mark, undefined, '外したはずの★が戻っている');
});

// --- 組めるかを、開いた時点で確かめる（2026-08-23 利用者の報告）-------------

test('詳細を開くとき、組めるかを確かめて面へ渡す', async () => {
    setLocale('en');
    const asked = [];
    const { panel } = mount({
        ingest: async () => ({ records: [], errors: [] }),
        loadVariants: async () => ({ outputs: [], recipe: null }),
        makeSweepRunner: () => ({ run: async () => ({}), stop() {} }),
        loadRecord: async () => ({ id: 'r', gen_params: { prompt: 'x' } }),
        canBuild: async (recipe) => {
            asked.push(recipe?.id);
            return { ok: false, error: 'no checkpoint information' };
        },
    });
    panel.setRecords([{ id: 'r', libraryId: 'r', title: 'T', verdict: 'blocked' }]);
    await panel.openDetail(panel.getRecords()[0]);
    await settle();

    assert.deepEqual(asked, ['r'], '確かめていない（押してから失敗する）');
    const run = panel.root.byClass('unbake-detail-run');
    assert.ok(run, '出すボタンが無い');
    assert.equal(run.disabled, true, '組めないのに押せる');
    assert.match(panel.root.text, /no checkpoint information/, '理由が画面に出ていない');
});

test('確かめる口が落ちても、押せなくはしない', async () => {
    setLocale('en');
    // **「確かめられない」と「組めない」を混ぜない。** `/object_info` が
    // 取れないだけで出せなくすると、原因の判らない行き止まりになる。
    const { panel } = mount({
        ingest: async () => ({ records: [], errors: [] }),
        loadVariants: async () => ({ outputs: [], recipe: null }),
        makeSweepRunner: () => ({ run: async () => ({}), stop() {} }),
        loadRecord: async () => ({ id: 'r', checkpoint: { file_name: 'a.safetensors' },
                                   gen_params: { prompt: 'x', seed: 1 } }),
        canBuild: async () => { throw new Error('object_info unreachable'); },
    });
    panel.setRecords([{ id: 'r', libraryId: 'r', title: 'T', verdict: 'reproducible' }]);
    await panel.openDetail(panel.getRecords()[0]);
    await settle();
    assert.equal(panel.root.byClass('unbake-detail-run').disabled, false,
        '確かめられなかっただけで押せなくしている');
});

// --- 実行器へ渡すのはレシピ（2026-08-24 利用者の報告）-----------------------
//
// 詳細の「出す」だけが記録の入れ物を渡していた。実行器は受け取ったものを
// **そのまま組み立てへ流す**ので、書庫の要約が持つ**文字列の `checkpoint`** が
// 読まれ、「チェックポイント情報がありません」で1枚も投入されずに終わっていた。
// 束の実行も、1枚の再現も、Sweep も、全部レシピを渡している。

test('詳細の「出す」は、実行器へレシピを渡す（記録の入れ物ではない）', async () => {
    setLocale('en');
    const seen = [];
    const { panel } = mount({
        ingest: async () => ({ records: [], errors: [] }),
        loadVariants: async () => ({ outputs: [], recipe: null }),
        canBuild: async () => ({ ok: true, error: null }),
        // **書庫の要約と同じ形**——`checkpoint` はオブジェクト、id は記録の id。
        loadRecord: async () => ({
            id: 'r',
            checkpoint: { file_name: 'wai.safetensors', modelVersionId: 1 },
            gen_params: { prompt: 'a cat', seed: 7, steps: 20, cfg_scale: 7 },
        }),
        makeSweepRunner: () => ({
            inputsReady: Promise.resolve({}),
            run: async ({ record }) => { seen.push(record); return { cells: [] }; },
            stop() {},
        }),
    });
    // 一覧の記録は `checkpoint` を**文字列**で持つ（`libraryRowToRecord` の形）。
    panel.setRecords([{
        id: 'r', libraryId: 'r', title: 'T', verdict: 'reproducible',
        checkpoint: 'wai.safetensors',
    }]);
    const view = await panel.openDetail(panel.getRecords()[0]);
    await settle();
    view.root.byClass('unbake-detail-run').dispatch('click', {});
    await settle();
    await settle();

    assert.equal(seen.length, 1, '実行器を呼んでいない');
    const passed = seen[0];
    // **これが本題。** 文字列のまま渡すと、組み立てが checkpoint を見つけられない。
    assert.equal(typeof passed.checkpoint, 'object', '記録の入れ物を渡している');
    assert.equal(passed.checkpoint.file_name, 'wai.safetensors');
    assert.equal(passed.gen_params.prompt, 'a cat', 'レシピの条件が届いていない');
    // 刻印と再利用の索引が引くので、id は記録の側。
    assert.equal(passed.id, 'r');
    // 入れ物を二重に渡していないこと（`recipe` を抱えたまま渡さない）。
    assert.equal(passed.recipe, undefined, 'レシピを入れ子のまま渡している');
});

// --- 消した時点で一覧から消える（2026-08-28 利用者の報告）-------------------

test('確認の面が開いたままでも、消えた分は一覧から消える', async () => {
    /*
     * **「レコードを削除した後、タイル表示が残っています」**（実機の報告）。
     *
     * 確認の面は**消した後も開いたまま**残る（何が消えたかを1件ずつ出すため）。
     * 描き直しを「閉じたとき」だけにしていたので、**「消しました」と書いてある
     * 面の後ろに、消したはずのタイルが見えている**状態になっていた
     * ——読む人には*消えていない*としか映らない。
     *
     * **タイルで測る。** 確認は既定で入っている（入れたばかりの環境はこちら）ので、
     * この道が既定の見え方そのもの。
     */
    const { panel } = mount({
        display: { listView: 'tiles', confirmBeforeDelete: true },
        recordsIo: { remove: async (id) => ({ ok: true, removed: [id] }) },
    });
    panel.setRecords([recordOf('a'), recordOf('b'), recordOf('c')]);
    const tilesOf = () => panel.root.allByClass('unbake-tile')
        .filter(node => node.className === 'unbake-tile').length;
    assert.equal(tilesOf(), 3, '前提が崩れている（タイルで描かれていない）');

    panel.root.findAll(n => String(n.className || '').includes('unbake-act-delete'))[0]
        .dispatch('click', {});
    await settle();
    const go = panel.root.findAll(n => String(n.className || '').includes('unbake-confirm-go'))[0];
    assert.ok(go, '確認の面が出ていない');
    go.dispatch('click', {});
    await settle();

    // **まだ閉じていない。** ここで既に減っていること。
    assert.ok(panel.root.findAll(n => String(n.className || '').includes('unbake-confirm-backdrop')).length,
        '確認の面が閉じてしまっている（この検査が測りたい状態を通らない）');
    assert.equal(tilesOf(), 2, '消したのにタイルが残っている');
});

test('まとめて消す回も、1件ごとに一覧から減る', async () => {
    // **時間がかかる回ほど効く。** 減っていく様子が見えないと、
    // 「止まっているのか進んでいるのか」が読めない。
    const { panel } = mount({
        display: { listView: 'tiles', confirmBeforeDelete: true },
        recordsIo: { remove: async (id) => ({ ok: true, removed: [id] }) },
    });
    panel.setRecords([recordOf('a'), recordOf('b'), recordOf('c')]);
    const tilesOf = () => panel.root.allByClass('unbake-tile')
        .filter(node => node.className === 'unbake-tile').length;
    for (const box of panel.root.allByClass('unbake-pick').slice(0, 2)) {
        box.checked = true;
        box.dispatch('click', {});
    }
    await settle();
    assert.equal(panel.selected.length, 2, '2件選べていない');

    // 選んだうえで右クリック → まとめて削除。
    const tile = panel.root.allByClass('unbake-tile').filter(n => n.className === 'unbake-tile')[0];
    await tile.dispatch('contextmenu', { clientX: 0, clientY: 0, preventDefault() {} });
    // **訳文で探さない**（この面の検査は英語で回している）。品書きは
    // 「選んだ N 件を…」の並びなので、件数を含む削除の行を数字で当てる。
    const items = panel.root.allByClass('unbake-context-item');
    const item = items.find(node => /2/.test(node.textContent) && /delet|削除/i.test(node.textContent));
    assert.ok(item, `まとめて削除の項目が無い: ${items.map(n => n.textContent).join(' / ')}`);
    item.dispatch('click', {});
    await settle();
    const go = panel.root.findAll(n => String(n.className || '').includes('unbake-confirm-go'))[0];
    assert.ok(go, '確認の面が出ていない');
    go.dispatch('click', {});
    for (let i = 0; i < 8; i += 1) await settle();

    assert.ok(panel.root.findAll(n => String(n.className || '').includes('unbake-confirm-backdrop')).length,
        '確認の面が閉じてしまっている（測りたい状態を通らない）');
    assert.equal(tilesOf(), 1, '2件消したのにタイルが残っている');
});
