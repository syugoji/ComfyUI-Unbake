/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 設定の面と、書庫から出した記録の扱いの検査。
 *
 * **一番上の1件が本題。** 鍵が画面へ戻ってくるようになっても機能は普通に動くので、
 * 漏れたことは誰も気づかない——気づけない失敗は、検査で固定するしかない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setLocale } from '../web/i18n/index.js';
import { createSettingsView } from '../web/panel/settingsView.js';
import { createUnbakePanel } from '../web/panel/panel.js';
import { libraryRowToRecord } from '../web/unbake.js';
import { FakeNode, fakeDocument } from './fake_dom.mjs';

const SECRET = 'TOKEN-SHOULD-NEVER-BE-SHOWN';

/** Python 側の口のダブル。**秘密は伏せて返す**（本物と同じ形）。 */
function fakeIo(initial = {}) {
    const stored = {
        record_source_dirs: [],
        record_output_dir: '',
        lora_manager_base_url: '',
        civitai_api_key: '',
        raindrop_token: '',
        raindrop_collection_id: '',
        ...initial,
    };
    const calls = [];
    const view = () => ({
        settings: {
            // **持っているものは全部返す。** 白名簿にしていたので、
            // 真偽値の項目が**常に未設定として届き**、入り切りの検査が
            // 「切る側」を一度も踏めなかった（2026-08-24）。
            ...stored,
            record_source_dirs: stored.record_source_dirs,
            record_output_dir: stored.record_output_dir,
            lora_manager_base_url: stored.lora_manager_base_url,
            raindrop_collection_id: stored.raindrop_collection_id,
            civitai_api_key: { set: Boolean(stored.civitai_api_key), length: stored.civitai_api_key.length },
            raindrop_token: { set: Boolean(stored.raindrop_token), length: stored.raindrop_token.length },
        },
        path: '/somewhere/outside/the/repo/unbake.settings.json',
        loadError: null,
    });
    return {
        stored,
        calls,
        read: async () => view(),
        write: async (patch) => {
            calls.push(patch);
            for (const [key, value] of Object.entries(patch)) stored[key] = value;
            return { ok: true, ...view() };
        },
        rescan: async () => ({ total: 7, errors: [] }),
    };
}

// --- 秘密の扱い ----------------------------------------------------------

test('鍵は画面のどこにも出ない（入っているかと文字数だけ）', async () => {
    setLocale('en');
    const io = fakeIo({ raindrop_token: SECRET, civitai_api_key: 'abcd' });
    const view = createSettingsView({ documentRef: fakeDocument(), read: io.read, write: io.write });
    await view.loaded;

    // **画面の文字列に1文字も混ざっていないこと。**
    assert.doesNotMatch(view.root.text, new RegExp(SECRET));
    const states = view.root.allByClass('unbake-settings-secret-state');
    assert.equal(states.length, 2);
    assert.match(states.map(s => s.textContent).join(' '), /set \(27 characters\)/);
    assert.match(states.map(s => s.textContent).join(' '), /set \(4 characters\)/);
    // 入力欄にも入れない（`value` 経由でも読めてはいけない）。
    for (const input of view.root.allByClass('unbake-settings-input')) {
        assert.notEqual(input.value, SECRET);
    }
    // 秘密の欄は伏せ字にする。
    const secretInputs = view.root.findAll(n => n.getAttribute('type') === 'password');
    assert.equal(secretInputs.length, 2, '鍵の欄が伏せ字になっていない');
});

test('空欄のまま保存しても鍵は消えない（送らない＝変更しない）', async () => {
    setLocale('en');
    const io = fakeIo({ raindrop_token: SECRET });
    const view = createSettingsView({ documentRef: fakeDocument(), read: io.read, write: io.write });
    await view.loaded;

    const patch = view.collect();
    // **鍵を触っていないなら、鍵は差分に入らない。**
    assert.equal(Object.hasOwn(patch, 'raindrop_token'), false);
    assert.equal(Object.hasOwn(patch, 'civitai_api_key'), false);

    await view.save(patch);
    assert.equal(io.stored.raindrop_token, SECRET, '他の項目を直したら鍵が消えた');
});

test('「消す」を押したときだけ消える', async () => {
    setLocale('en');
    const io = fakeIo({ raindrop_token: SECRET });
    const view = createSettingsView({ documentRef: fakeDocument(), read: io.read, write: io.write });
    await view.loaded;

    await view.root.allByClass('unbake-settings-clear')[1].dispatch('click');
    assert.equal(io.stored.raindrop_token, '');
    assert.deepEqual(io.calls.at(-1), { raindrop_token: '' }, '消すつもりで他の項目まで送っている');
});

test('打った鍵は保存後に画面から消える', async () => {
    setLocale('en');
    const io = fakeIo();
    const view = createSettingsView({ documentRef: fakeDocument(), read: io.read, write: io.write });
    await view.loaded;

    const secretInputs = view.root.findAll(n => n.getAttribute('type') === 'password');
    secretInputs[0].value = 'typed-key';
    assert.deepEqual(view.collect().civitai_api_key, 'typed-key');
    await view.save(view.collect());
    assert.equal(io.stored.civitai_api_key, 'typed-key');
    // **打った値を残さない。** 残すと、画面共有や録画にそのまま写る。
    for (const input of secretInputs) assert.equal(input.value, '');
});

// --- ふつうの項目 --------------------------------------------------------

test('読み取り元は複数行、保存先は別項目（混ぜない）', async () => {
    setLocale('en');
    const io = fakeIo({ record_source_dirs: ['/a', '/b'], record_output_dir: '/out' });
    const view = createSettingsView({ documentRef: fakeDocument(), read: io.read, write: io.write });
    await view.loaded;

    assert.equal(view.root.byClass('unbake-settings-dirs').value, '/a\n/b');
    const patch = view.collect();
    assert.deepEqual(patch.record_source_dirs, ['/a', '/b']);
    assert.equal(patch.record_output_dir, '/out');
    // 読み取り元と保存先が同じ鍵に混ざっていないこと。
    assert.notEqual(patch.record_source_dirs, patch.record_output_dir);
});

test('保存先を分ける理由が画面に書いてある', async () => {
    setLocale('en');
    const io = fakeIo();
    const view = createSettingsView({ documentRef: fakeDocument(), read: io.read, write: io.write });
    await view.loaded;
    // **見るのは意味であって、言い回しではない。** 文言は読みやすさのために
    // 書き直す（2026-08-25 実際に書き直した）ので、**言わなければならないこと**を
    // 分けて書き、その痕跡を探す。
    assert.match(view.root.text, /Read-only/, '読むだけだと書いていない');
    assert.match(view.root.text, /damaging an existing library/,
        '既存のライブラリを壊さないための分離だと書いていない');
    // 補助が上書きしないことも書いてある（食い違いの扱いが画面から読める）。
    assert.match(view.root.text, /found on disk wins/,
        '食い違ったときディスク側が勝つと書いていない');
    // **空でも動くことを書く**（2026-08-23 利用者の指摘で足した）。
    // 実測では最初から既定の置き場へ保存されていたが、画面がそう言っていなかった
    // ——「書かないと保存されない」と読まれる。
    assert.match(view.root.text, /Leave it empty/);
    assert.match(view.root.text, /user\/unbake\/records/);
});

test('設定ファイルの場所が読める（どこに鍵があるか判る）', async () => {
    setLocale('en');
    const io = fakeIo();
    const view = createSettingsView({ documentRef: fakeDocument(), read: io.read, write: io.write });
    await view.loaded;
    assert.match(view.root.text, /outside\/the\/repo/);
});

test('数え直すと件数が出る。読めなかったフォルダは 0件 と混ぜない', async () => {
    setLocale('en');
    const io = fakeIo();
    const withErrors = { ...io, rescan: async () => ({ total: 0, errors: ['/nope: not found'] }) };
    const view = createSettingsView({
        documentRef: fakeDocument(), read: io.read, write: io.write, rescan: withErrors.rescan,
    });
    await view.loaded;
    await view.rescan();
    const status = view.root.byClass('unbake-settings-status').textContent;
    assert.match(status, /0 records found/);
    assert.match(status, /could not be read/, '読めなかったことが出ていない');
});

test('口が届かないことを、設定が空であることと混ぜない', async () => {
    setLocale('en');
    const view = createSettingsView({
        documentRef: fakeDocument(),
        read: async () => { throw new Error('404'); },
        write: async () => ({ ok: true }),
    });
    await view.loaded;
    assert.match(view.root.byClass('unbake-settings-status').textContent, /Could not read the settings/);
});

// --- 一覧との繋がり ------------------------------------------------------

test('書庫の要約は「まだ組んでいない」として並ぶ（嘘の判定を付けない）', () => {
    const record = libraryRowToRecord({
        id: 'r1', title: 'T', checkpoint: 'ck.safetensors', seed: 5,
        prompt: 'p', preview: true, has_graph: false, source: 'folder',
    });
    assert.equal(record.verdict, 'pending');
    assert.equal(record.libraryId, 'r1');
    // 参照画像は **id で引く**（画面へパスを渡さない）。
    assert.equal(record.previewUrl, '/unbake/record-preview?id=r1');
    assert.doesNotMatch(record.previewUrl, /path=/);

    const noPreview = libraryRowToRecord({ id: 'r2', preview: false });
    assert.equal(noPreview.previewUrl, null);
});

test('書庫の記録でも Sweep を押せる（本体は押した時点で取りに行く）', async () => {
    setLocale('en');
    const doc = fakeDocument();
    const host = new FakeNode('div', doc);
    const asked = [];
    const panel = createUnbakePanel(host, {
        documentRef: doc,
        width: 900,
        loadRecord: async (id) => {
            asked.push(id);
            return { id, gen_params: { seed: 1 }, loras: [] };
        },
        makeSweepRunner: () => ({ preflight: () => ({ cells: [], baselineId: null, cellCount: 0, estimatedSeconds: 0 }), run: async () => ({}), stop() {} }),
    });
    // 本体をまだ持っていない要約だけの記録。
    panel.setRecords([libraryRowToRecord({ id: 'lib-1', title: 'L' })]);
    // **入口は絵を押して開く詳細だけになった**（2026-08-22 利用者の指示で
    // 行のアイコンを外し、「振る」のタブも畳んだ）。ここで固定しているのは
    // **開いた時点で本体を取りに行く**ことで、そこは変えていない。
    await panel.openDetail(panel.getRecords()[0]);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(asked, ['lib-1'], '開いた時点で本体を取りに行っていない');
    assert.ok(panel.detailView, '詳細が開いていない');
    // 振る材料が在れば、出す口も出ている。
    assert.ok(panel.root.byClass('unbake-detail-run'), '出す口が無い');
});

test('設定の口が無ければ設定を開かず、理由を残す', async () => {
    setLocale('en');
    const doc = fakeDocument();
    const host = new FakeNode('div', doc);
    const panel = createUnbakePanel(host, { documentRef: doc, width: 900, settingsIo: null });
    await panel.root.byClass('unbake-settings-open').dispatch('click');
    assert.equal(panel.settingsView, null);
    assert.match(panel.root.byClass('unbake-log').text, /endpoints are not registered/);
});

test('設定は一覧の上に浮かび、Sweep と同時には出ない', async () => {
    setLocale('en');
    const doc = fakeDocument();
    const host = new FakeNode('div', doc);
    const io = fakeIo();
    const panel = createUnbakePanel(host, {
        documentRef: doc, width: 900, settingsIo: io,
        loadRecord: async () => ({ id: 'x', gen_params: {}, loras: [] }),
        makeSweepRunner: () => ({ preflight: () => ({ cells: [], cellCount: 0, estimatedSeconds: 0 }), run: async () => ({}), stop() {} }),
    });
    panel.setRecords([libraryRowToRecord({ id: 'lib-1', title: 'L' })]);

    await panel.root.byClass('unbake-settings-open').dispatch('click');
    assert.ok(panel.settingsView);
    // **一覧を隠さない**（2026-08-24 利用者の指示でページからポップアップへ）。
    // 隠していた間は、開いている最中に**何件あるのか・どれを見ていたのかが
    // 画面から消えて**いた。
    assert.notEqual(panel.root.byClass('unbake-body').style.display, 'none', '一覧を隠している');
    assert.ok(panel.root.byClass('unbake-popup-layer'), '浮かべる器が無い');
    // **面の中に閉じる。** `fixed` で画面いっぱいに広げると ComfyUI の操作まで塞ぐ。
    assert.equal(doc.body.children.length, 0, '別の窓を開いている');

    // Sweep を開くと設定は閉じる（2枚同時に出さない）。
    // **入口は詳細**になったが、「同時に出さない」は変えていない。
    panel.closeOverlays();
    panel.setRecords([libraryRowToRecord({ id: 'lib-1', title: 'L' })]);
    await panel.openDetail(panel.getRecords()[0]);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(panel.settingsView, null, '設定と詳細が同時に出ている');
    assert.ok(panel.detailView);
    assert.equal(doc.body.children.length, 0, '別の窓を開いている');

    panel.closeOverlays();
    assert.equal(panel.root.byClass('unbake-body').style.display, '');
});

// --- 応援の案内（2026-08-22 → 2026-08-24 に送り先を決め打ちへ）----------------
//
// **設定の `donate_url` は撤去した。** 送り先が決まり、通しで実測して通ったので
// 設定で持つ理由が消えた。**空にできる欄を残すほうが害**——「まだ決めていない」
// という嘘の状態を作れてしまう。以前ここに在った「決まっていなければそう出す」
// 検査は、その状態が構造として作れなくなったので消した（受け持ちが無い検査を残さない）。

test('保存ボタンは置かない（触れば保存される）', async () => {
    setLocale('en');
    const io = fakeIo();
    const view = createSettingsView({ documentRef: fakeDocument(), read: io.read, write: io.write });
    await view.loaded;
    // **押す口が在れば「押さないと保存されない」と読む。**
    // 自動保存は 2026-08-23 から効いていたのに、ボタンが残っていたせいで
    // 「保存されない」と報告された（2026-08-24）。
    assert.equal(view.root.byClass('unbake-settings-save'), null, '保存ボタンが残っている');
});

test('触っただけで保存される（押す口が無いので、ここが唯一の道）', async () => {
    setLocale('en');
    const io = fakeIo();
    const view = createSettingsView({ documentRef: fakeDocument(), read: io.read, write: io.write });
    await view.loaded;
    const before = io.calls.length;
    const check = view.root.byClass('unbake-settings-check');
    assert.ok(check, '真偽の欄が無い');
    check.checked = !check.checked;
    check.dispatch('change', {});
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(io.calls.length > before, '触っても保存されていない');
});

test('保存したことは、触った欄の横で言う', async () => {
    setLocale('en');
    const io = fakeIo();
    const view = createSettingsView({ documentRef: fakeDocument(), read: io.read, write: io.write });
    await view.loaded;
    // **一番下だと見えない。** 長い一覧を下へ送っている間は画面に入らない（実機の指摘）。
    await view.save({ theme: 'amber' });
    const marks = view.root.allByClass('unbake-settings-saved').filter(m => m.textContent);
    assert.equal(marks.length, 1, '印が出た欄の数が想定と違う');
    // **送っていない欄には出さない。** 全部に出ると、どれを保存したのか読めない。
    assert.equal(view.root.byClass('unbake-settings-status').textContent, '',
        '成功をまだ一番下にも出している');
});

// --- 絞り込みを残す（2026-08-24 利用者の指示）--------------------------------
//
// **元は「絞り込みは保存しない」と決めていた。** だが実機では開き直すたびに
// 絞り込み直すことになり、**同じ帯に並んでいる並び替え・見せ方だけが残る**という
// 揃わなさになっていた。

test('判定の絞り込みは、押した時点で保存される', async () => {
    setLocale('en');
    const doc = fakeDocument();
    const io = fakeIo();
    const panel = createUnbakePanel(new FakeNode('div', doc), {
        documentRef: doc, width: 900, settingsIo: io,
    });
    const chip = panel.root.byClass('unbake-chip');
    chip.dispatch('click', {});
    await new Promise(resolve => setTimeout(resolve, 0));
    const wrote = io.calls.at(-1) || {};
    assert.ok(Array.isArray(wrote.hidden_verdicts), '隠した判定を送っていない');
    assert.equal(wrote.hidden_verdicts.length, 1, '押した1つが入っていない');
});

test('保存した絞り込みで開き直る', () => {
    setLocale('en');
    const doc = fakeDocument();
    const panel = createUnbakePanel(new FakeNode('div', doc), {
        documentRef: doc, width: 900,
        display: { hiddenVerdicts: ['reproducible'], favoritesOnly: true },
    });
    panel.setRecords([
        { id: 'a', title: 'A', verdict: 'reproducible' },
        { id: 'b', title: 'B', verdict: 'unavailable' },
    ]);
    const chip = panel.root.findAll(n => String(n.className).includes('unbake-chip'))
        .find(n => n.getAttribute('data-verdict') === 'reproducible');
    assert.ok(chip, '判定のチップが無い');
    assert.equal(chip.getAttribute('data-on'), 'false', '隠したはずの判定が出ている');
    const favorites = panel.root.byClass('unbake-chip-favorite');
    assert.equal(favorites.getAttribute('data-on'), 'true', 'お気に入りだけの状態が戻っていない');
});

test('隠す方を持つ（判定が増えた日に、新しい判定が既定で隠れない）', () => {
    setLocale('en');
    const doc = fakeDocument();
    // **「見せる方」で持っていると、種類が増えた瞬間に新しい判定が消える。**
    const panel = createUnbakePanel(new FakeNode('div', doc), {
        documentRef: doc, width: 900, display: { hiddenVerdicts: [] },
    });
    const chips = panel.root.findAll(n => n.getAttribute?.('data-verdict'));
    assert.ok(chips.length > 0, '判定のチップが無い');
    for (const chip of chips) {
        assert.equal(chip.getAttribute('data-on'), 'true', '何も隠していないのに隠れている');
    }
});

test('印を出すのは、値が実際に動いた欄だけ', async () => {
    setLocale('en');
    const io = fakeIo();
    const view = createSettingsView({ documentRef: fakeDocument(), read: io.read, write: io.write });
    await view.loaded;
    // **送る側は毎回フォーム全体を送る**（差分だけだと「空にした」と「触っていない」が
    // 区別できない）。だから**送った鍵＝変えた鍵ではない**。
    // ここを取り違えて、触っていない欄にまで印が出ていた（2026-08-24 実機の指摘）。
    await view.save(view.collect());
    assert.deepEqual(
        view.root.allByClass('unbake-settings-saved').filter(m => m.textContent), [],
        '何も変えていないのに印が出ている',
    );
    // 1つだけ動かせば、1つだけ光る。
    const check = view.root.byClass('unbake-settings-check');
    check.checked = !check.checked;
    await view.save(view.collect());
    assert.equal(
        view.root.allByClass('unbake-settings-saved').filter(m => m.textContent).length, 1,
        '変えた欄の数と印の数が合っていない',
    );
});

test('レコードの置き場（複数行）の横にも印が出る', async () => {
    setLocale('en');
    const io = fakeIo();
    const view = createSettingsView({ documentRef: fakeDocument(), read: io.read, write: io.write });
    await view.loaded;
    // **この欄だけ印が無かった**（見出しが `labelrow` に包まれていなかった）。
    view.root.byClass('unbake-settings-dirs').value = '/a\n/b';
    await view.save(view.collect());
    // 置き場の欄を含む「欄のかたまり」の中に印が在ること。
    const field = view.root.findAll(n => String(n.className) === 'unbake-settings-field')
        .find(n => n.byClass('unbake-settings-dirs'));
    assert.ok(field, '置き場の欄が見つからない');
    const mark = field.byClass('unbake-settings-saved');
    assert.ok(mark, '置き場の欄に印そのものが無い');
    assert.notEqual(mark.textContent, '', '置き場を変えたのに印が出ていない');
});

test('保存に失敗したら、消える印ではなく残る場所へ出す', async () => {
    setLocale('en');
    const view = createSettingsView({
        documentRef: fakeDocument(),
        read: async () => ({ settings: {}, path: '/x', loadError: null }),
        write: async () => { throw new Error('disk full'); },
    });
    await view.loaded;
    await view.save({ theme: 'amber' });
    // **理由は長くて欄の横に入らないうえ、消えては困る。**
    assert.match(view.root.byClass('unbake-settings-status').textContent, /disk full/, '理由が出ていない');
    const marks = view.root.allByClass('unbake-settings-saved').filter(m => m.textContent);
    assert.deepEqual(marks, [], '失敗したのに保存の印が出ている');
});

test('設定の側に送り先の欄が無い', async () => {
    const { CATALOGS } = await import('../web/i18n/index.js');
    // **鍵の側で止める。** 欄を戻すと必ず `settings.donateUrl` を引くことになり、
    // 「画面のコードが使う鍵は全部カタログに在る」（i18n_test）が赤くなる。
    // つまりこの2本で、**欄だけ戻して訳を足し忘れる**も**訳だけ残る**も両方塞がる。
    for (const locale of Object.keys(CATALOGS)) {
        assert.equal(Object.hasOwn(CATALOGS[locale], 'settings.donateUrl'), false,
            `${locale}: 撤去した設定の訳が残っている`);
    }
});

test('送り先は設定に頼らず、開いた時点で出そろっている', () => {
    setLocale('en');
    const doc = fakeDocument();
    // **設定を1つも渡さない。** 2026-08-24 に `donate_url` を撤去したので、
    // 何も渡さなくても2本が出ていなければならない。
    const panel = createUnbakePanel(new FakeNode('div', doc), { documentRef: doc, width: 900 });
    panel.root.byClass('unbake-donate-open').dispatch('click', {});
    const buttons = panel.donateView.root.allByClass('unbake-donate-button');
    assert.equal(buttons.length, 2, '送り先の数が想定と違う');
    for (const button of buttons) {
        // **自分からは出ない。** 押されたときだけ、別のタブで開く。
        assert.match(button.getAttribute('href') || '', /^https:\/\//, 'https でない送り先がある');
        assert.equal(button.getAttribute('target'), '_blank');
        assert.match(button.getAttribute('rel') || '', /noopener/);
    }
});

test('上流（LoRA Manager）への導線は出さない', async () => {
    setLocale('en');
    const doc = fakeDocument();
    const panel = createUnbakePanel(new FakeNode('div', doc), { documentRef: doc, width: 900 });
    panel.root.byClass('unbake-donate-open').dispatch('click', {});
    const hrefs = panel.donateView.root.allByClass('unbake-donate-button')
        .map(b => b.getAttribute('href') || '');
    // **2026-08-24 に利用者が前提を改めた**——Unbake は LoRA Manager とは機能が全く異なり、
    // 完全に独立している。独立した道具の支援画面から他所へ送らない。
    // 以前は「上流が先」という順序を守る検査を置いていたが、**守る対象が消えたので
    // 検査ごと消した**（緑のまま何も守らない見張りを残さない）。
    const upstream = hrefs.filter(h => /pixelpawsai|PixelPawsAI|afdian|patreon/i.test(h));
    assert.deepEqual(upstream, [], '上流への導線が残っている');
    assert.equal(hrefs.length, 2, '送り先の数が想定と違う');
});

test('不具合報告の導線が、公開した置き場へ向く', () => {
    /*
     * **置けなかったのが置けるようになった。** 2026-08-24 の時点では
     * `github.com/syugoji/ComfyUI-Unbake` が**実測で 404** だったので、
     * 「押すと存在しない場所へ飛ぶ口」を作らないために出していなかった。
     * **2026-08-25 に公開**され、リポジトリも issues も 200 を返す。
     *
     * 前提が消えたので緩める——**黙って足さず、検査を先に書き換えてから**。
     */
    setLocale('en');
    const doc = fakeDocument();
    const panel = createUnbakePanel(new FakeNode('div', doc), { documentRef: doc, width: 900 });
    panel.root.byClass('unbake-donate-open').dispatch('click', {});
    const help = panel.donateView.root.allByClass('unbake-donate-help-link')
        .map(b => b.getAttribute('href') || '');
    assert.equal(help.length, 1, `不具合報告の口が1つでない: ${help.join(' / ')}`);
    assert.match(help[0], /^https:\/\/github\.com\/syugoji\/ComfyUI-Unbake\/issues$/,
        `飛び先が違う: ${help[0]}`);
});

test('不具合報告を、送り先として数えない', () => {
    /*
     * **払う口と、困ったときの口は別。** 同じ数え方に混ぜると
     * 「送り先の数が想定と違う」の見張りが黙って緩む。
     */
    setLocale('en');
    const doc = fakeDocument();
    const panel = createUnbakePanel(new FakeNode('div', doc), { documentRef: doc, width: 900 });
    panel.root.byClass('unbake-donate-open').dispatch('click', {});
    const rails = panel.donateView.root.allByClass('unbake-donate-button')
        .map(b => b.getAttribute('href') || '');
    assert.equal(rails.length, 2, `送り先の数が変わっている: ${rails.join(' / ')}`);
    assert.deepEqual(rails.filter(h => /github\.com/.test(h)), [],
        '不具合報告が送り先に混ざっている');
});

test('`http(s)` 以外は送り先にしない', async () => {
    setLocale('en');
    const { usableDonateUrl } = await import('../web/panel/donateView.js');
    // **押した瞬間に何が動くか読めない口を作らない。**
    assert.equal(usableDonateUrl('javascript:alert(1)'), '');
    assert.equal(usableDonateUrl('data:text/html,<b>x'), '');
    assert.equal(usableDonateUrl('ftp://example.com'), '');
    assert.equal(usableDonateUrl('   '), '');
    assert.equal(usableDonateUrl('https://example.com/tip'), 'https://example.com/tip');
});

test('設定から送り先を差し込めない（撤去した経路が生き返っていない）', () => {
    setLocale('en');
    const doc = fakeDocument();
    const panel = createUnbakePanel(new FakeNode('div', doc), { documentRef: doc, width: 900 });
    // **知らない相手へ送らせない。** 設定の口が生き返ると、設定ファイルを書ける者が
    // 押した人の送り先をすり替えられる。撤去したのだから、渡しても効いてはいけない。
    panel.applyDisplay({ donate_url: 'https://example.com/attacker' });
    panel.root.byClass('unbake-donate-open').dispatch('click', {});
    const hrefs = panel.donateView.root.allByClass('unbake-donate-button')
        .map(b => b.getAttribute('href') || '');
    assert.deepEqual(hrefs.filter(h => h.includes('example.com')), [],
        '設定から差し込んだ送り先が出ている');
});

test('写す口は自分の送り先にだけ出る', () => {
    setLocale('en');
    const doc = fakeDocument();
    const panel = createUnbakePanel(new FakeNode('div', doc), { documentRef: doc, width: 900 });
    panel.root.byClass('unbake-donate-open').dispatch('click', {});
    const view = panel.donateView;
    // 上流の URL を写させても使い道が無く、押す先が増えるほど誰への送り先か読めなくなる。
    assert.equal(view.root.allByClass('unbake-donate-copy').length, view.ownRails.length,
        '写す口の数が自分の送り先の数と合っていない');
});

test('写せなかったことを黙らない', async () => {
    setLocale('en');
    const doc = fakeDocument();
    const failures = [];
    const { createDonateView } = await import('../web/panel/donateView.js');
    const view = createDonateView({
        documentRef: doc,
        onCopy: () => { throw new Error('boom'); },
    });
    view.root.byClass('unbake-donate-copy').dispatch('click', {});
    await Promise.resolve();
    await Promise.resolve();
    // 押したのに何も起きないと「壊れている」と読まれる。
    assert.match(view.status.textContent || '', /boom/, failures.join('') || '理由が出ていない');
});

test('宛先は畳んで1行に出す（生のURLを並べない）', async () => {
    // **狭い柱では、生のURLは語の途中で割れる**（2026-08-24 実機）。
    // 読ませたいのは宛先であって文字列ではないので、host と末尾だけに畳む。
    setLocale('en');
    const doc = fakeDocument();
    const { createDonateView } = await import('../web/panel/donateView.js');
    const view = createDonateView({ documentRef: doc });
    const links = view.root.allByClass('unbake-donate-link');
    assert.ok(links.length >= 2, `宛先の行が ${links.length} 本しか無い`);
    for (const link of links) {
        const shown = String(link.textContent || '');
        const full = String(link.getAttribute('title') || '');
        assert.ok(shown.length <= 34, `畳めていない（${shown.length}文字）: ${shown}`);
        assert.ok(!shown.startsWith('http'), `生のURLがそのまま出ている: ${shown}`);
        // **写す値と開く先は本物のまま。** 畳んだ値は開けない。
        assert.ok(full.startsWith('https://'), `全体が title に無い: ${full}`);
        assert.ok(full.includes(shown.split('/').at(-1).replace('…', '')),
            `畳んだ形が元のURLと繋がっていない: ${shown} / ${full}`);
    }
});

test('説明は既定でしまい、1つの口で出せる', async () => {
    // **項目名と説明文が同じ書式**だったので、並んだ段落から項目名を拾えなかった
    // （2026-08-24 実測：13px / weight 400 / 同色）。既定でしまう。
    setLocale('en');
    const io = fakeIo();
    const view = createSettingsView({ documentRef: fakeDocument(), read: io.read, write: io.write });
    await view.loaded;
    assert.equal(view.root.getAttribute('data-help'), 'off', '説明が既定で出ている');
    const toggle = view.root.byClass('unbake-settings-helptoggle');
    assert.ok(toggle, '説明を出す口が無い');
    toggle.dispatch('click', {});
    assert.equal(view.root.getAttribute('data-help'), 'on', '押しても出ない');
    toggle.dispatch('click', {});
    assert.equal(view.root.getAttribute('data-help'), 'off', '押し戻せない');
});

test('入り切りの欄には、横並びの目印が付く', async () => {
    setLocale('en');
    const io = fakeIo();
    const view = createSettingsView({ documentRef: fakeDocument(), read: io.read, write: io.write });
    await view.loaded;
    const checks = view.root.allByClass('unbake-settings-check');
    assert.ok(checks.length >= 3, `入り切りの欄が ${checks.length} 個しか無い`);
    const marked = view.root.allByClass('unbake-settings-field-check');
    assert.equal(marked.length, checks.length,
        `目印の付いた欄が ${marked.length} 個で、入り切りの欄 ${checks.length} 個と合わない`);
});

test('選ぶ欄の選択肢が、生の値のまま出ていない', async () => {
    // **`hide` / `show` が画面に出ていた**（2026-08-24 利用者の指摘）。
    // 何が起きるのか読めないうえ、訳の抜けは**画面を見るまで気づけない**。
    setLocale('en');
    const io = fakeIo();
    const view = createSettingsView({ documentRef: fakeDocument(), read: io.read, write: io.write });
    await view.loaded;
    const selects = view.root.findAll(node => node.tagName === 'SELECT');
    assert.ok(selects.length >= 3, `選ぶ欄が ${selects.length} 個しか無い`);
    const raw = [];
    for (const select of selects) {
        for (const option of select.children) {
            const value = String(option.getAttribute('value') ?? '');
            const label = String(option.textContent ?? '');
            if (!value) continue;                       // 空＝「宿主に合わせる」等
            if (label.startsWith('[')) { raw.push(`${value}: 訳が無い`); continue; }
            // **値そのものが出ていないこと。** `hide` と書いてあるだけの欄を作らない。
            if (label === value) raw.push(`${value}: 生の値のまま`);
        }
    }
    assert.deepEqual(raw, [], '選択肢が生の値で出ている');
});

test('入り切りは、切る側も届く（入れる側だけ通っていた）', async () => {
    // **本物のブラウザでは、切ったとき `checked` は false になるが
    // `data-checked` 属性は 'true' のまま残る。** 集める側が OR で読んでいたため、
    // **切った操作が1つも届かなかった**（2026-08-24 実機
    // 「切り替えが保存されない／保存の印が出ない」）。
    //
    // **検査も素通りしていた。** 既存の検査は入れる側しか押しておらず、
    // 偽 DOM では属性と `checked` が食い違わないので差が出なかった。
    setLocale('en');
    // **入っているのは1つだけにする。** 複数在ると、押していない欄の false で
    // 検査が受かってしまう（実際に受かった——変異が素通りした）。
    const io = fakeIo({ rich_ui: true });
    const view = createSettingsView({ documentRef: fakeDocument(), read: io.read, write: io.write });
    await view.loaded;
    const checks = view.root.allByClass('unbake-settings-check');
    assert.ok(checks.length >= 2, `入り切りの欄が ${checks.length} 個しか無い`);

    // **番号で選ばない。** 並びが変わると別の欄を押すだけの検査になる。
    const target = checks.find(node => node.getAttribute('data-checked') === 'true');
    assert.ok(target, '入っている欄が1つも無い（前提が違う）');
    // 読み込みで属性は 'true' になっている。**本物と同じ形で切る**
    // ——`checked` だけを false にし、属性はそのままにする。
    const key = String(target.getAttribute('aria-label') || '');
    target.checked = false;
    target.dispatch('change', {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const sent = io.calls.at(-1);
    assert.ok(sent, '保存が飛んでいない');
    // **押した欄そのものを名指しで見る。**
    assert.equal(sent.rich_ui, false,
        `切ったのに ${JSON.stringify(sent.rich_ui)} を送っている（${key}）`);
    assert.equal(io.stored.rich_ui, false, '保存先へ届いていない');
});

test('説明のある項目には「?」が付き、中身をそのまま持つ', async () => {
    // **説明を読むために場所を動かさない**（2026-08-24 利用者の指示）。
    // 「?」に中身が入っていないと、押しても何も出ない口だけが増える。
    setLocale('en');
    const io = fakeIo();
    const view = createSettingsView({ documentRef: fakeDocument(), read: io.read, write: io.write });
    await view.loaded;
    const hints = view.root.allByClass('unbake-settings-hint');
    assert.ok(hints.length >= 8, `「?」が ${hints.length} 個しか無い`);
    for (const node of hints) {
        const tip = String(node.getAttribute('data-tip') || '');
        assert.ok(tip.length > 10, `中身が入っていない: ${JSON.stringify(tip)}`);
        assert.ok(!tip.startsWith('['), `訳が当たっていない: ${tip}`);
        // **読み上げにも本文を渡す。** 「?」だけでは何も伝わらない。
        assert.equal(node.getAttribute('aria-label'), tip, '読み上げに本文が無い');
    }
    // 説明の段落と同じ数だけ在ること（片方にしか出ない項目を作らない）。
    const helps = view.root.allByClass('unbake-settings-help')
        .filter(node => String(node.textContent || '').trim());
    assert.ok(hints.length <= helps.length,
        `説明が無いのに「?」が付いている（? ${hints.length} / 説明 ${helps.length}）`);
});

test('設定は群に分かれている（見出しが在る）', async () => {
    setLocale('en');
    const io = fakeIo();
    const view = createSettingsView({ documentRef: fakeDocument(), read: io.read, write: io.write });
    await view.loaded;
    const titles = view.root.allByClass('unbake-settings-group-title').map(n => n.textContent);
    assert.equal(titles.length, 3, `群の見出しが ${titles.length} 本: ${JSON.stringify(titles)}`);
    assert.ok(titles.every(text => text && !text.startsWith('[')),
        `訳が当たっていない: ${JSON.stringify(titles)}`);
});

// --- 並びと自動保存（2026-08-23 利用者の指示）------------------------------

test('鍵・トークン・コレクションID が上から順に並ぶ', async () => {
    setLocale('en');
    const io = fakeIo();
    const view = createSettingsView({ documentRef: fakeDocument(), read: io.read, write: io.write });
    await view.loaded;

    // 欄の並びを、上から順の「見出しの文字列」で見る。
    const labels = view.root.allByClass('unbake-settings-label').map(node => node.textContent);
    const at = (needle) => labels.findIndex(text => text.includes(needle));
    const key = at('Civitai');
    const token = at('Raindrop token');
    const collection = at('collection');
    assert.ok(key >= 0 && token >= 0 && collection >= 0,
        `欄が見つからない: ${JSON.stringify(labels)}`);
    assert.equal(key, 0, 'Civitai の鍵が一番上にない');
    assert.ok(token > key, 'Raindrop のトークンが鍵より上にある');
    assert.ok(collection > token, 'コレクションIDがトークンより上にある');
});

test('保存を押さなくても、手が止まれば保存される', async () => {
    setLocale('en');
    const io = fakeIo();
    const view = createSettingsView({ documentRef: fakeDocument(), read: io.read, write: io.write });
    await view.loaded;
    const before = io.calls.length;

    // 打っている最中は送らない（**半端な値を何度も保存しない**）。
    const input = view.root.allByClass('unbake-settings-input')
        .find(node => node.getAttribute('type') === 'text');
    input.value = '4242';
    input.dispatch('input', {});
    assert.equal(io.calls.length, before, '1文字ごとに保存している');

    // 手が止まれば送る。
    await new Promise(resolve => setTimeout(resolve, 900));
    assert.ok(io.calls.length > before, '手が止まっても保存していない');
    assert.equal(io.stored.raindrop_collection_id, '4242', '打った値が保存されていない');
});

test('選択やチェックは、変わった瞬間に保存される', async () => {
    setLocale('en');
    const io = fakeIo();
    const view = createSettingsView({ documentRef: fakeDocument(), read: io.read, write: io.write });
    await view.loaded;
    const before = io.calls.length;

    const check = view.root.allByClass('unbake-settings-check')[0];
    check.checked = true;
    check.setAttribute('data-checked', 'true');
    check.dispatch('change', {});
    // **待たない。** 選び直しは打ち終わりが無いので、遅らせる理由が無い。
    assert.ok(io.calls.length > before, 'チェックを変えても保存していない');
});

test('打っている欄には、保存の後の値を当て直さない', async () => {
    setLocale('en');
    const doc = fakeDocument();
    const io = fakeIo();
    const view = createSettingsView({ documentRef: doc, read: io.read, write: io.write });
    await view.loaded;

    const input = view.root.allByClass('unbake-settings-input')
        .find(node => node.getAttribute('type') === 'text');
    input.value = '打ちかけ';
    // **その欄を触っている状態にする。** 当て直すとカーソルが飛ぶ。
    doc.activeElement = input;
    view.apply({ settings: { raindrop_collection_id: 'サーバの値' } });
    assert.equal(input.value, '打ちかけ', '打っている欄を上書きしている');

    // 触っていない欄には当たること（**当て直しそのものを止めない**）。
    doc.activeElement = null;
    view.apply({ settings: { raindrop_collection_id: 'サーバの値' } });
    assert.equal(input.value, 'サーバの値', '当て直しが効いていない');
});
