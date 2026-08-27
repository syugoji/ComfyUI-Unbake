/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **足りないノードパックを、ComfyUI-Manager に入れてもらう**（2026-08-28 利用者の指示）。
 *
 * **こちらは pip を触らない。** 実測すると、この面が必要とするパックは
 * 依存の重い側だった:
 *
 *     ComfyUI-Impact-Pack  … numpy / opencv-python-headless / transformers /
 *                            git+…/sam2 の10行 ＋ install.py
 *     ComfyUI_smZNodes     … 依存なし
 *
 * 版の解決も衝突の検出も戻しも Manager が持っている。**Unbake の仕事は
 * 「何が足りないか」を渡すことだけ**で、入れる責任は Manager 側に残す。
 *
 * ---
 *
 * **Manager の API は版で形が違う**（両方とも実測して合わせた）:
 *
 *     3.41（ポータブル）  GET  /api/customnode/getmappings?mode=cache
 *                         POST /api/manager/queue/install   ← 平らな本体
 *                         POST /api/manager/queue/start
 *
 *     4.2.2（Desktop）    GET  /api/v2/customnode/getmappings?mode=cache
 *                         POST /api/v2/manager/queue/task   ← kind + params
 *                         POST /api/v2/manager/queue/start
 *
 * **名前の対応表はこちらで持たない。** `getmappings` が返すのは
 * 利用者自身の Manager が持っている地図（実測 5,590 件）で、
 * **鍵はそのままパックの id** になっている（`comfyui_smznodes` /
 * `comfyui-impact-pack`）。公開している以上、どのノードが足りないかも
 * どのパックが要るかも環境ごとに違うので、**その場で引く**。
 */

/** 版ごとの道。**`api` の値でしか分岐しない**（分岐を1箇所に閉じる）。 */
const ROUTES = {
    v2: {
        version: '/api/v2/manager/version',
        mappings: '/api/v2/customnode/getmappings?mode=cache',
        install: '/api/v2/manager/queue/task',
        start: '/api/v2/manager/queue/start',
    },
    v1: {
        version: '/api/manager/version',
        mappings: '/api/customnode/getmappings?mode=cache',
        install: '/api/manager/queue/install',
        start: '/api/manager/queue/start',
    },
};

/**
 * どちらの Manager が居るかを確かめる。**新しい方から順に見る。**
 *
 * @param {(path: string, options?: object) => Promise<any>} request
 * @returns {Promise<{api: 'v2'|'v1', version: string}|null>} 居なければ null
 */
export async function detectManager(request) {
    for (const api of ['v2', 'v1']) {
        try {
            const response = await request(ROUTES[api].version, { method: 'GET' });
            if (!response?.ok) continue;
            const version = typeof response.text === 'function'
                ? String(await response.text()).trim()
                : '';
            return { api, version };
        } catch {
            // **黙って次へ。** 片方が無いのは普通のことで、失敗ではない。
        }
    }
    return null;
}

/**
 * ノードの名前から、入れるべきパックを引く。
 *
 * @param {(path: string, options?: object) => Promise<any>} request
 * @param {'v2'|'v1'} api
 * @param {string[]} classNames 手元に無いノードの名前（その場で測った物）
 * @returns {Promise<Array<{id: string, title: string, nodes: string[]}>>}
 *
 * **判らないものは黙って落とす。** 推測で名前を出すと、入れても直らない物を
 * 入れさせることになる（この面が前から持っている決めごと）。
 */
export async function packsForNodes(request, api, classNames) {
    const wanted = [...new Set((classNames || []).map(name => String(name)))];
    if (!wanted.length) return [];
    const response = await request(ROUTES[api].mappings, { method: 'GET' });
    if (!response?.ok) throw new Error('mappings unavailable');
    const map = await response.json();
    const found = new Map();
    for (const [id, value] of Object.entries(map || {})) {
        const nodes = Array.isArray(value) ? (value[0] || []) : [];
        const title = (Array.isArray(value) ? (value[1] || {}) : {}).title_aux || id;
        const hit = wanted.filter(name => nodes.includes(name));
        if (!hit.length) continue;
        const already = found.get(id);
        if (already) already.nodes.push(...hit.filter(n => !already.nodes.includes(n)));
        else found.set(id, { id, title: String(title), nodes: [...hit] });
    }
    return [...found.values()];
}

/** 版ごとの投げ方。**ここだけが形の違いを知る。** */
function installBody(api, pack, clientId, uiId) {
    if (api === 'v2') {
        return {
            ui_id: uiId,
            client_id: String(clientId || ''),
            kind: 'install',
            params: {
                id: pack.id,
                // **`version` は必須**（`ManagerPackInfo`）。どの版かは
                // `selected_version` が決めるので、ここは印にしかならない。
                version: 'unknown',
                selected_version: 'latest',
                mode: 'cache',
                channel: 'default',
                skip_post_install: false,
            },
        };
    }
    return {
        ui_id: uiId,
        id: pack.id,
        version: 'unknown',
        selected_version: 'latest',
        skip_post_install: false,
    };
}

/**
 * パックを Manager の行列へ入れ、流し始める。
 *
 * @returns {Promise<{queued: string[], failed: Array<{id: string, detail: string}>}>}
 *
 * **1件の失敗で残りを止めない。** 止めると「何件入ったのか」が判らないまま
 * 終わる（この面が消す側で既に決めていること）。
 */
export async function installPacks(request, api, packs, { clientId = '', uuid } = {}) {
    const queued = [];
    const failed = [];
    const nextId = typeof uuid === 'function' ? uuid : () => `unbake-${queued.length + failed.length}`;
    for (const pack of packs || []) {
        try {
            const response = await request(ROUTES[api].install, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(installBody(api, pack, clientId, nextId())),
            });
            if (response?.ok) queued.push(pack.id);
            else failed.push({ id: pack.id, detail: `HTTP ${response?.status ?? '?'}` });
        } catch (error) {
            failed.push({ id: pack.id, detail: error?.message || String(error) });
        }
    }
    if (queued.length) {
        // **入れただけでは走らない。** 行列は別に起こす必要がある
        //（両方の版で同じ形）。
        try { await request(ROUTES[api].start, { method: 'POST' }); } catch { /* 起こせなくても結果は返す */ }
    }
    return { queued, failed };
}
