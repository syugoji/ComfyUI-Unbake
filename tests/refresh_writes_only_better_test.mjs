/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **出典が空を返した回を書かない**——面から実際に押して確かめる
 *（2026-08-26 実機で 9件が空で塗り潰された）。
 *
 * 判断そのもの（`hasVersionEvidence`）は `refresh_from_source_test.mjs` で
 * 固定してあるが、**それを呼んでいるか**は誰も見ていなかった——守りの行を
 * 消しても全部緑のままだった。ここは `registerUnbake` から面まで通して、
 * **保存の口が叩かれないこと**で確かめる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerUnbake } from '../web/unbake.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale } from '../web/i18n/index.js';

setLocale('ja');

const settle = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

function fakeApp() {
    const state = { extensions: [], tabs: [] };
    return {
        state,
        registerExtension(extension) { state.extensions.push(extension); },
        extensionManager: { registerSidebarTab: (tab) => state.tabs.push(tab) },
        ui: { settings: { getSettingValue: () => 'ja' } },
    };
}

/**
 * 出典が **画像は返すが `meta` を持たない** 場合のダブル。
 * 実測（2026-08-26）: `civitai.com/images/53290457` はこの形で、
 * 345件中 9件が同じだった。
 */
function stubHost({ meta = null, current = null } = {}) {
    const calls = [];
    const previous = globalThis.fetch;
    const row = {
        id: 'rec-1', title: 'civitai_53290457',
        checkpoint: 'flux.safetensors', modified: 1000,
        has_graph: false, preview: false,
        source_path: 'https://civitai.com/images/53290457',
    };
    globalThis.fetch = async (input, init) => {
        const url = String(input);
        calls.push({ url, method: init?.method || 'GET' });
        const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
        if (url.startsWith('/unbake/settings')) {
            return json({ settings: { record_source_dirs: [], record_output_dir: '', language: 'ja' } });
        }
        if (url.startsWith('/unbake/records')) {
            return json({ records: [row], total: 1, offset: 0, errors: [], sourceDirs: ['/fixture'], outputDir: '' });
        }
        if (url.startsWith('/unbake/record?')) {
            // 既定では**名前しか持っていない**（＝読み直しの対象）。
            return json(current || { id: 'rec-1', title: 'civitai_53290457',
                          checkpoint: { file_name: 'flux.safetensors' }, loras: [],
                          source_path: row.source_path });
        }
        if (url.includes('civitai.com/api/v1/images')) {
            // **`imageId=` で引くと `meta` が入れ子で返る**（実測 2026-08-26）。
            // 平らな形で作ると、取り出せたはずのものが取り出せない検査になる。
            return json({ items: [{
                id: 53290457, url: 'https://image.civitai.com/x.png', nsfwLevel: 1,
                meta: meta === null ? null : { id: 53290457, meta },
            }] });
        }
        if (url.startsWith('/unbake/record-save')) return json({ ok: true, id: 'rec-1' });
        // **宿主の口も返す。** 404 のままだと取り込みが例外になり、
        // 「空だから書かなかった」ではなく「失敗した」に化ける。
        if (url.includes('civitai.com/api/v1/model-versions/')) {
            // **版の中身も要る。** これが無いと版IDだけでは名前が決まらず、
            // 「空だった」と区別が付かない結果になる（実際にそうなった）。
            return json({
                id: 691639, name: 'v1', baseModel: 'Flux.1 D',
                model: { name: 'Flux', type: 'Checkpoint' },
                files: [{ name: 'flux_dev.safetensors', primary: true, sizeKB: 1024,
                          type: 'Model', hashes: { SHA256: 'A'.repeat(64) } }],
            });
        }
        if (url.startsWith('/object_info')) return json({ CheckpointLoaderSimple: {} });
        if (url.startsWith('/api/embeddings')) return json([]);
        return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    };
    calls.restore = () => { globalThis.fetch = previous; };
    calls.saves = () => calls.filter(c => c.url.startsWith('/unbake/record-save'));
    return calls;
}

async function mountAndRefresh(calls) {
    const doc = fakeDocument();
    const app = fakeApp();
    const handle = registerUnbake(app, { documentRef: doc });
    await app.state.extensions[0].setup();
    const panel = app.state.tabs[0].render(doc.createElement('div'));
    await handle.whenLibraryReady();
    await settle(10);
    await panel.root.byClass('unbake-settings-open').dispatch('click');
    await settle(30);
    const button = panel.root.findAll(
        node => node.textContent === '出典から読み直す')[0];
    assert.ok(button, `読み直しの口が無い: ${panel.root.text.slice(0, 200)}`);
    await button.dispatch('click', {});
    await settle(120);
    return panel;
}

test('出典に情報が無ければ、1件も保存しない', async () => {
    const calls = stubHost({ meta: null });
    try {
        const panel = await mountAndRefresh(calls);
        assert.deepEqual(calls.saves(), [],
            `空の応答を書いている（元の記録が消える）: ${JSON.stringify(calls.saves())}`);
        assert.match(panel.root.text, /出典に情報が無かった 1 件/,
            `空だったことを言っていない: ${panel.root.text.slice(-260)}`);
    } finally { calls.restore(); }
});

test('もう版IDを持つ記録は「飛ばし」であって「空」ではない', async () => {
    /*
     * **2つの道を混ぜない。** 「読み直す必要が無かった」と「読み直したが
     * 出典に何も無かった」は、押した人の打つ手が違う——前者は正常、
     * 後者は出典の側の問題。守りが全部を飲み込んでいないことも、ここで判る。
     */
    const calls = stubHost({ meta: null, current: {
        id: 'rec-1', title: 'civitai_53290457',
        checkpoint: { file_name: 'flux.safetensors', modelVersionId: 691639 }, loras: [],
        source_path: 'https://civitai.com/images/53290457',
    } });
    try {
        const panel = await mountAndRefresh(calls);
        assert.deepEqual(calls.saves(), [], '触る必要が無いのに書いている');
        assert.match(panel.root.text, /飛ばし 1 件/,
            `飛ばしとして数えていない: ${panel.root.text.slice(-200)}`);
        assert.match(panel.root.text, /出典に情報が無かった 0 件/,
            '飛ばしを「空」に混ぜている');
        // **出典を叩いていない。** 読み直す必要が無いのだから、往復もしない。
        assert.equal(calls.filter(c => c.url.includes('civitai.com')).length, 0,
            '要らない問い合わせをしている');
    } finally { calls.restore(); }
});
