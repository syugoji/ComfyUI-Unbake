/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **設定画面から触った「重ねて出す」が、その場で効く**（`I-20260830-28`）。
 *
 * `installSidebarOverlay` は `enabled` と `width` を**呼ばれた時点で閉じ込める**。
 * 当て直しは組み直しと言語変更の2箇所からしか呼ばれていなかったので、
 * 設定画面で切っても重なったまま・幅に数字を入れても変わらなかった。
 *
 * **掴み手でドラッグした時だけ効く**という形なので、利用者は自分の操作ミスを
 * 疑う。値は保存されるので次に起動すると効いており、しかも「重ねて出す」を
 * 切る道は設定画面**だけ**——切りたい人に回避路が無い。案内文
 * （`settings.sidebarOverlay.help`）は逆に即時に効くと約束している。
 *
 * ## なぜ既存の検査が素通りしたか
 *
 * `sidebar_overlay_test.mjs` は `installSidebarOverlay` を**直接呼ぶ**ので、
 * 設定を書く入口を通らない。`wiring_test.mjs` は `unbake.js` の**文字列を
 * 正規表現で照合する**だけで、その行が**いつ実行されるか**を見ていない。
 *
 * だからここは**利用者と同じ道**を通す——設定画面の切り替えを押して、
 * **読み直さずに**印が消えることを見る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerUnbake } from '../web/unbake.js';
import { fakeDocument } from './fake_dom.mjs';
import { t } from '../web/i18n/index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * サーバが返す入切の既定を、**実体（`unbake/settings.py`）から読む**。
 *
 * 手で `{}` を返していたら、設定画面は `sidebar_overlay` を**切**として描く
 * 一方で面は入として動く——**実機では起きない食い違い**を作ってしまい、
 * 「別の設定を触ったら重なりが外れた」という嘘の症状が出た（実際そうなった）。
 * 既定は `True` である（実測）。
 */
function serverDefaults() {
    const source = fs.readFileSync(path.join(ROOT, 'unbake/settings.py'), 'utf8');
    const block = /KNOWN_KEYS:[\s\S]*?\n\}/.exec(source)?.[0] || '';
    const out = {};
    for (const [, key, value] of block.matchAll(/"([a-z0-9_]+)":\s*(True|False),/g)) {
        out[key] = value === 'True';
    }
    return out;
}

const DEFAULTS = serverDefaults();

/** 保存された設定を覚えるサーバのダブル。**書いた値は読み返せる。** */
function stubEndpoints(store) {
    globalThis.fetch = async (url, init) => {
        const text = String(url);
        if (text.includes('/unbake/settings')) {
            if (init?.method === 'POST') {
                Object.assign(store, JSON.parse(init.body || '{}'));
            }
            return { ok: true, status: 200, json: async () => ({ ok: true, settings: { ...store } }) };
        }
        return {
            ok: true, status: 200,
            json: async () => ({ ok: true, records: [], rows: [] }),
            arrayBuffer: async () => new ArrayBuffer(0),
        };
    };
}

function fakeApp() {
    const state = { extensions: [], tabs: [] };
    return {
        state,
        registerExtension(extension) { state.extensions.push(extension); },
        extensionManager: { registerSidebarTab: (tab) => state.tabs.push(tab) },
        ui: { settings: { getSettingValue: () => 'ja' } },
    };
}

/** 拡張を起こし、サイドバーを1つ描く。 */
async function bootSidebar(initial = {}) {
    const store = { language: 'ja', ...DEFAULTS, ...initial };
    stubEndpoints(store);
    const doc = fakeDocument();
    const app = fakeApp();
    registerUnbake(app, { documentRef: doc });
    await app.state.extensions[0].setup();
    await settle();
    /*
     * **宿主の器ごと作る。** 重ねる仕掛けは祖先を辿って
     * `.side-bar-panel`（ComfyUI の器）を探し、**見つからなければ何もしない**。
     * 素の `div` へ描くと印が付かず、この検査は空振りする（最初そうなった）。
     */
    const sideBar = doc.createElement('div');
    sideBar.className = 'p-splitterpanel side-bar-panel';
    const host = doc.createElement('div');
    sideBar.append(host);
    doc.body.append(sideBar);
    const panel = app.state.tabs[0].render(host);
    await settle();
    return { doc, host: sideBar, panel, store };
}

/** 設定画面の切り替え（入切）。 */
const checksOf = (view) => view.root.findAll(
    node => node.tagName === 'INPUT' && node.getAttribute?.('type') === 'checkbox');

/**
 * 重ねて出している印。**`installSidebarOverlay` が付け外しする当のもの。**
 *
 * 印が付くのは**宿主の器そのもの**（`.side-bar-panel`）で、その子孫ではない。
 * `findAll` は子孫しか見ないので、器を渡して**自分を見る**（最初これで空振りした）。
 */
const overlaid = (sideBar) => sideBar.getAttribute?.('data-unbake-overlay') === 'true';

test('サーバの既定を読めている（前提）', () => {
    assert.equal(DEFAULTS.sidebar_overlay, true,
        'サーバの既定を読めていない＝設定画面と面が食い違う状態で測ることになる');
    assert.ok(Object.keys(DEFAULTS).length >= 5,
        `入切の既定を ${Object.keys(DEFAULTS).length} 個しか読めていない＝走査が壊れている`);
});

test('既定では重ねて出している（前提）', async () => {
    const { host } = await bootSidebar();
    assert.equal(overlaid(host), true,
        '重ねる印が付いていない＝この検査は何も測れない');
});

test('設定画面で切ったら、読み直さずに重なりが外れる', async () => {
    const { host, panel, store } = await bootSidebar();
    assert.equal(overlaid(host), true, '前提: 重なっている');

    panel.openSettings();
    await settle();
    const view = panel.settingsView;
    assert.ok(view, '設定画面が開いていない');

    // **利用者が押すのと同じ口を押す。** 切り替えは名札（`aria-label`）でしか
    // 見分けられないので、訳文を引いて突き合わせる。
    const label = t('settings.sidebarOverlay');
    const toggle = checksOf(view).find(node => node.getAttribute?.('aria-label') === label);
    assert.ok(toggle, `「${label}」の切り替えが設定画面に無い`);

    toggle.checked = false;
    await toggle.dispatch('change', { target: toggle });
    await settle();
    await settle();

    assert.equal(store.sidebar_overlay, false, '前提: 設定は保存されている');
    assert.equal(overlaid(host), false,
        '切ったのに重なったまま（読み直すまで効かない）');
});

test('[対照] 別の設定を触っても、重なりは外れない', async () => {
    const { host, panel } = await bootSidebar();
    panel.openSettings();
    await settle();
    const label = t('settings.sidebarOverlay');
    const other = checksOf(panel.settingsView)
        .find(node => node.getAttribute?.('aria-label') !== label);
    assert.ok(other, '前提: 別の切り替えが在る');
    other.checked = !other.checked;
    await other.dispatch('change', { target: other });
    await settle();
    assert.equal(overlaid(host), true,
        '関係の無い設定で重なりが外れている（当て直しの条件が広すぎる）');
});

/*
 * **「どの設定でも当て直す」に広げる変異は、ここでは観測できない**（実測）。
 *
 * 当て直しは器を外して付け直すので掴み手が作り直される——そこを見れば
 * 余計な当て直しが判る、と考えて対照を書いたが**落ちた**。他の鍵の多くは
 * `applyDisplay` の先で面ごと組み直しており、その道が `reoverlay()` を
 * 通るので、**関係の無い設定でも掴み手は作り直される**。
 *
 * つまり条件を広げても最終状態も掴み手も同じで、**観測できる差が無い**
 * ＝等価変異である。条件を狭く書いてあるのは意味の上での正しさ（この鍵の
 * ためだけの当て直し）であって、検査で留められる性質ではない。
 * **留められないものを、留めたふりの検査で埋めない。**
 */

test('重ねる設定を触ったときは、当て直す（対照の裏返し）', async () => {
    const { host, panel } = await bootSidebar();
    const gripOf = () => host.children.find(
        child => String(child.className || '').includes('unbake-sidebar-grip')) || null;
    const before = gripOf();
    assert.ok(before, '前提: 掴み手が在る');

    panel.openSettings();
    await settle();
    const label = t('settings.sidebarOverlay');
    const toggle = checksOf(panel.settingsView)
        .find(node => node.getAttribute?.('aria-label') === label);
    toggle.checked = false;
    await toggle.dispatch('change', { target: toggle });
    await settle();
    await settle();

    assert.notEqual(gripOf(), before, '当て直していない（掴み手が古いまま）');
});
