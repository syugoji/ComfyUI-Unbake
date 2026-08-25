/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * **稼働中の ComfyUI が実際に配っているバイト列**を取って、拡張として成立するかを見る。
 *
 * `npm test` の検査はリポジトリのファイルを読む。**それは配られる物とは別の実体**で、
 * 間に「ComfyUI が `WEB_DIRECTORY` をどう解決するか」という段が丸ごと入っている。
 * ここはその段を通した後を見る:
 *
 *   1. `/api/extensions` に自分のファイルが載っているか（載らなければ画面は何も読まない）
 *   2. 配られた各ファイルが **ES モジュールとして読めるか**（ブラウザが最初に落ちる場所）
 *   3. 配られた入口へ ComfyUI の `app` を渡すと、**サイドバータブが登録され、
 *      その `render(el)` がパネルを描くか**
 *   4. 同じ関数で全画面も開くか（決定⑤）
 *
 * **これは画面の確認の代わりにはならない。** ここで確かめられるのは
 * 「配られた物が拡張として成立する」ところまでで、ComfyUI の画面に実際にタブが
 * 見えたかどうかではない。**通ったことを「画面で見た」と言い換えないこと。**
 *
 *   node tests/served_extension_probe.mjs --url http://127.0.0.1:8288
 *
 * 終了コード: 0=全部通った / 1=どこかで落ちた
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function argOf(name, fallback = null) {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BASE = (argOf('--url') || process.env.UNBAKE_COMFY_URL || '').replace(/\/+$/, '');
if (!BASE) {
    console.error('使い方: node tests/served_extension_probe.mjs --url http://127.0.0.1:8288');
    process.exit(2);
}

const failures = [];
const note = (ok, label, detail = '') => {
    console.log(`${ok ? 'OK ' : 'NG '} ${label}${detail ? '  ' + detail : ''}`);
    if (!ok) failures.push(label);
};

// --- 1. /api/extensions に載っているか ------------------------------------
let listed = [];
try {
    const response = await fetch(`${BASE}/api/extensions`);
    listed = await response.json();
} catch (error) {
    console.error(`ComfyUI へ届きません（${BASE}）: ${error.message}`);
    process.exit(1);
}
const mine = listed.filter(p => /\/ComfyUI-Unbake\//.test(p));
note(mine.length > 0, '/api/extensions に載っている', `${mine.length}件 / 全体 ${listed.length}件`);
const entry = mine.find(p => p.endsWith('/unbake.js'));
note(Boolean(entry), '入口 unbake.js が載っている', entry || '');
if (!entry) process.exit(1);

// --- 2. 配られたバイト列をそのまま取り出して、モジュールとして読む -----------
// **リポジトリのファイルを読み直さない。** ここで見たいのは配信経路を通った後の物。
const dir = await mkdtemp(path.join(os.tmpdir(), 'unbake-served-'));
const localOf = (served) => path.join(dir, served.replace(/^\/extensions\/ComfyUI-Unbake\//, ''));
let bytes = 0;
try {
    for (const served of mine) {
        const response = await fetch(BASE + served);
        if (!response.ok) { note(false, `配信 ${served}`, `HTTP ${response.status}`); continue; }
        const text = await response.text();
        bytes += text.length;
        const target = localOf(served);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, text, 'utf8');
    }
    note(bytes > 0, '配られたバイト列を取得した', `${mine.length}ファイル / ${bytes}文字`);

    // **入口はここで import しない。** import した時点で自動起動が走り、
    // 以後は同じ URL がモジュールキャッシュに載って**2度目の評価が起きない**。
    // 「読める」を先に確かめたつもりで、肝心の登録を観測できなくなる。
    for (const served of mine.filter(p => p !== entry)) {
        try {
            await import(pathToFileURL(localOf(served)).href);
            note(true, `モジュールとして読める ${served.split('/').pop()}`);
        } catch (error) {
            note(false, `モジュールとして読める ${served.split('/').pop()}`, error.message);
        }
    }

    // --- 3. **画面と同じ経路で**入口を読み込ませる -------------------------
    // **ここを間違えて一度落とした。** 最初の版は `module.registerUnbake(app)` を
    // 自分で呼んでいて、**画面が一度も通らない経路を通していた**。実機では入口が
    // `window.app` を見ており、frontend にそれが無いので登録は起きていなかった——
    // それでもこの検査は緑だった。**呼ぶのは import だけにする。**
    const doc = fakeDocument();
    const registered = [];
    const extensions = [];
    const app = {
        extensionManager: { registerSidebarTab: (tab) => registered.push(tab) },
        registerExtension: (ext) => extensions.push(ext),
    };
    globalThis.document = doc;
    // frontend が置く実体と同じ形にする（`/scripts/app.js` はこれを読む shim）。
    globalThis.window = { comfyAPI: { app: { app } } };
    globalThis.comfyAPI = globalThis.window.comfyAPI;

    // **相対 URL を origin で解決する。** ブラウザは `/unbake/records` を
    // ページの origin へ向けるが、Node の `fetch` は相対 URL を投げて落とす。
    // 補わないと**書庫が常に「届かない」**になり、データの経路を一度も通らない
    // まま「拡張として成立している」とだけ言うことになる。
    const realFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = (input, init) => {
        const url = String(input);
        const resolved = url.startsWith('/') ? BASE + url : url;
        requests.push(resolved);
        return realFetch(resolved, init);
    };

    let module;
    try {
        module = await import(pathToFileURL(localOf(entry)).href);
        note(true, 'モジュールとして読める unbake.js');
    } catch (error) {
        note(false, 'モジュールとして読める unbake.js', error.message);
    }

    note(extensions.length === 1, 'import しただけで拡張が1つ登録された',
        extensions.map(e => e.name).join(',') || '(なし＝画面では何も起きない)');
    const extension = extensions[0];
    note(extension?.name === 'Unbake', '拡張の名前が Unbake', String(extension?.name));
    // ComfyUI は `setup()` を後から呼ぶ。**画面と同じ順序で呼ぶ。**
    await extension?.setup?.();

    note(registered.length === 1, 'setup() でサイドバータブを1つ登録した',
        registered.map(t => t.id).join(',') || '(なし)');
    note(registered[0]?.id === 'unbake', 'タブの id が unbake', String(registered[0]?.id));
    note(Boolean(doc.getElementById('unbake-theme')), 'テーマ CSS を差し込んだ');

    if (registered.length === 0) {
        // **ここで落ちたら以降は測れない。** 例外で止まると「どの検査が落ちたか」が
        // 読めなくなるので、理由を出して畳む（実測: 旧版の `window.app` 判定に戻すと
        // ここが 0 件になり、それが唯一の症状だった——例外もログも出ない）。
        console.log('---');
        console.log('サイドバータブが1つも登録されていないので、以降は測れません。');
        console.log(`落ちた検査: ${failures.length}件`);
        process.exit(1);
    }

    const host = doc.createElement('div');
    host.ownerDocument = doc;
    const panel = registered[0].render(host);
    const roots = walk(host).filter(n => n.className === 'unbake-root');
    note(roots.length === 1, 'render(el) がパネルを描いた', `${roots.length}個`);
    note(roots[0]?.getAttribute('data-mode') === 'sidebar', '器はサイドバー');

    // --- 4. 同じ関数で全画面も開く（決定⑤） --------------------------------
    const full = module.openFullscreen(doc);
    const shell = doc.getElementById('unbake-fullscreen');
    const fullRoots = shell ? walk(shell).filter(n => n.className === 'unbake-root') : [];
    note(fullRoots.length === 1, '全画面でも同じパネルが描かれた');
    note(fullRoots[0]?.getAttribute('data-mode') === 'fullscreen', '器は全画面');
    note((extension?.commands || []).some(c => c.id === 'Unbake.OpenFullscreen'),
        '全画面のコマンドを登録した');
    full.close();

    // --- 5. **中身が両方に届いているか。** ---------------------------------
    //
    // ここは長いあいだ**構造の文字列**で比べていた:
    //
    //     const shape = (n) => walk(n).map(x => x.tagName + '.' + x.className).join('|');
    //     note(shape(roots[0]) === shape(fullRoots[0]), '2つの器で構造が同一');
    //
    // **空の器2つは構造が同一である。** 実際に全画面は常に0件で開いていて、
    // それでもこの行は緑だった——器の形は、器が空でも一致する。
    // **比べるべきは件数**で、しかも**0件そのものを赤にする**必要がある。
    const ready = module.autostarted?.whenLibraryReady;
    if (!ready) {
        note(false, '書庫の到着を待つ口が無い（待たずに比べると空どうしで通る）');
    } else {
        await ready();
        await new Promise(resolve => setTimeout(resolve, 0));
        const sidebarCount = panel.getRecords().length;
        const view = extension.commands.find(c => c.id === 'Unbake.OpenFullscreen').function();
        const fullCount = view.panel.getRecords().length;
        view.close();

        // **0件を「一致」と読ませない。** 書庫が本当に空の環境ではここが赤くなるが、
        // それは正しい——**比較が成立していない**ことを、通過と区別して言うべきである。
        note(sidebarCount > 0, 'サイドバーに書庫が届いている',
            `${sidebarCount}件（0なら以下の比較は成立しない）`);
        note(fullCount === sidebarCount, '全画面がサイドバーと同じ件数を持って開く',
            `サイドバー ${sidebarCount}件 / 全画面 ${fullCount}件`);

        // **書庫は1回しか取らない。** 器の数だけ取ると、開くたびに
        // 226.3 KiB（実測）を取り直すことになる。
        const listCalls = requests.filter(url => url.includes('/unbake/records'));
        note(listCalls.length === 1, '書庫を1回しか取っていない', `${listCalls.length}回`);

        // --- 6. 判定が実データで散るか ------------------------------------
        //
        // **`pending` 固定を外した効果はここでしか見えない。** チップが
        // `not built 346` のままなら、絞り込みは1件も絞れていない。
        const started = Date.now();
        const pass = await module.autostarted.verdicts.run(panel.getRecords());
        const tally = module.autostarted.verdicts.tally(
            panel.getRecords().map(r => r.libraryId).filter(Boolean)
        );
        const kinds = Object.entries(tally).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`);
        note(tally.pending === 0, '判定が全件で終わっている', `未判定 ${tally.pending}件`);
        note(tally.reproducible + tally.approximate > 0, '再現できる記録が在る', kinds.join(' / '));
        console.log(`   判定 ${pass.done}件 / ${Date.now() - started}ms`
            + `（HTTP を通した値。**画面の描画は入っていない**）`);
        const forkCalls = requests.filter(url => url.includes('/api/lm/'));
        note(forkCalls.length === 0, 'フォークの口を1本も叩いていない',
            forkCalls.length ? forkCalls.slice(0, 2).join(', ') : '0本');
    }
    note(!doc.getElementById('unbake-fullscreen'), '閉じると全画面の器が消える');
    panel.destroy?.();
} finally {
    await rm(dir, { recursive: true, force: true });
}

console.log('---');
console.log(failures.length === 0
    ? '配られた物は拡張として成立している（**画面で見たわけではない**）'
    : `落ちた検査: ${failures.length}件`);
process.exit(failures.length === 0 ? 0 : 1);

// --- DOM のダブル ---------------------------------------------------------
function walk(node, out = []) {
    out.push(node);
    for (const child of node.children || []) walk(child, out);
    return out;
}

function fakeDocument() {
    const byId = new Map();
    const make = (tag) => {
        const node = {
            tagName: String(tag).toUpperCase(),
            className: '', textContent: '', attributes: {}, style: {},
            children: [], listeners: {}, scrollTop: 0, scrollHeight: 0,
            _id: '',
            get id() { return this._id; },
            set id(value) { this._id = value; byId.set(value, this); },
            get rel() { return this.attributes.rel; }, set rel(v) { this.attributes.rel = v; },
            get href() { return this.attributes.href; }, set href(v) { this.attributes.href = v; },
            setAttribute(k, v) { this.attributes[k] = String(v); },
            getAttribute(k) { return this.attributes[k] ?? null; },
            append(...items) { this.children.push(...items); for (const c of items) c.parent = this; },
            replaceChildren(...items) { this.children = [...items]; },
            remove() {
                if (this._id) byId.delete(this._id);
                if (!this.parent) return;
                this.parent.children = this.parent.children.filter(c => c !== this);
                this.parent = null;
            },
            addEventListener(t, h) { (this.listeners[t] ||= []).push(h); },
            removeEventListener(t, h) { this.listeners[t] = (this.listeners[t] || []).filter(x => x !== h); },
        };
        return node;
    };
    const doc = {
        createElement: make,
        getElementById: (id) => byId.get(id) || null,
        addEventListener() {}, removeEventListener() {},
    };
    doc.head = make('head'); doc.head.ownerDocument = doc;
    doc.body = make('body'); doc.body.ownerDocument = doc;
    return doc;
}
