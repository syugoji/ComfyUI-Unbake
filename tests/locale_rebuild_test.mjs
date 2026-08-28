/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **言語を変えたら、開いている面が全部描き直される。**
 *
 * 実機の報告（2026-08-29）: ComfyUI を English にしても Unbake が日本語のまま、
 * Unbake 側を English にしても日本語の文が出る。設定ファイルを見ると
 * `Comfy.Locale = en` / Unbake `language = en` の両方が正しく保存されていた。
 *
 * 原因は保存でも解決でもなく**描き直しの範囲**だった。作り直していたのは
 * サイドバーだけで、
 *
 *   - 全画面から言語を変えた人には**何も起きない**
 *   - サイドバーを一度も開いていなければ `rebuildSidebar` は `null` なので
 *     **丸ごと空振り**する
 *
 * どちらも「選んだのに変わらない」に見え、しかも設定画面の選択は新しい言語を
 * 指しているので**画面からは正常に見える**。見出しと列名は面を作るときに
 * 一度だけ文字を入れる造りなので、描き直さない限り古い言語が残る。
 *
 * **だから見るのは「呼ばれたか」ではなく「何面が作り直されたか」。**
 * 0 を返すことがそのまま症状である。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerUnbake } from '../web/unbake.js';
import { fakeDocument } from './fake_dom.mjs';

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/** ComfyUI の `app` の最小のダブル。**言語は宿主から取る**ので、それも持たせる。 */
function fakeApp(locale = 'en') {
    const state = { extensions: [], tabs: [] };
    return {
        state,
        registerExtension(extension) { state.extensions.push(extension); },
        extensionManager: { registerSidebarTab: (tab) => state.tabs.push(tab) },
        ui: { settings: { getSettingValue: () => locale } },
    };
}

/** 設定と記録の口を空で返す。**面が開けることだけが要る。** */
function stubEndpoints() {
    globalThis.fetch = async (url) => {
        const text = String(url);
        const body = text.includes('/unbake/settings')
            ? { ok: true, settings: { language: '' } }
            : { ok: true, records: [], rows: [] };
        return { ok: true, status: 200, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) };
    };
}

/** 拡張を起こす。**面はまだ1つも開かない。** */
async function boot() {
    stubEndpoints();
    const doc = fakeDocument();
    const app = fakeApp();
    const handle = registerUnbake(app, { documentRef: doc });
    await app.state.extensions[0].setup();
    await settle();
    return { doc, app, handle };
}

test('面が1つも開いていなければ 0 を返す（黙って成功しない）', async () => {
    const { handle } = await boot();
    assert.equal(handle.rebuildOpenPanels(), 0,
        '開いていない面を作り直したことにしている');
});

test('サイドバーだけ開いていれば 1 面を作り直す', async () => {
    const { doc, app, handle } = await boot();
    app.state.tabs[0].render(doc.createElement('div'));
    await settle();
    assert.equal(handle.rebuildOpenPanels(), 1, 'サイドバーを作り直していない');
});

test('全画面だけ開いていても作り直す（ここが実機で空振りしていた）', async () => {
    // **サイドバーを一度も開かない。** この経路では `rebuildSidebar` が `null` で、
    // 直す前は 0 面＝言語を選んでも画面が1文字も変わらなかった。
    const { app, handle } = await boot();
    app.state.extensions[0].commands.find(c => c.id === 'Unbake.OpenFullscreen').function();
    await settle();
    assert.equal(handle.rebuildOpenPanels(), 1, '全画面を作り直していない');
});

test('両方開いていれば 2 面とも作り直す', async () => {
    const { doc, app, handle } = await boot();
    app.state.tabs[0].render(doc.createElement('div'));
    app.state.extensions[0].commands.find(c => c.id === 'Unbake.OpenFullscreen').function();
    await settle();
    assert.equal(handle.rebuildOpenPanels(), 2, '片方しか作り直していない');
});

test('閉じた全画面を開き直さない', async () => {
    // **`fullscreenView` は `Esc` で閉じられても更新されない。** それを
    // 「開いている」の根拠にすると、閉じた面が勝手に戻ってくる。
    const { doc, app, handle } = await boot();
    const view = app.state.extensions[0].commands
        .find(c => c.id === 'Unbake.OpenFullscreen').function();
    view.close();
    await settle();
    assert.equal(handle.rebuildOpenPanels(), 0, '閉じた全画面を開き直している');
    assert.equal(doc.getElementById('unbake-fullscreen'), null, '器が残っている');
});
