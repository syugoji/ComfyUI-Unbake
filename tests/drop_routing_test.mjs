/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * D&D の3経路と、Civitai 画像 ID の抽出。
 *
 * **ID 抽出は上流を開かずに書き直した部分**なので、正しさは「同じ答えが出るか」でしか
 * 確かめられない。既存レシピ346件に対する突き合わせは `--recipes` を渡したときだけ走る
 * （環境に依存する検査を既定へ入れると、無い環境で赤くなって意味が変わる）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
    CIVITAI_DOMAINS,
    extractCivitaiImageId,
    extractCivitaiImageIdFromCandidates,
    extractCivitaiPostId,
} from '../web/panel/civitaiImageId.js';
import {
    DROP_ROUTES, UNSUPPORTED_CODES, parseComfyViewUrl, routeDrop,
} from '../web/panel/dropRouting.js';

/** `dataTransfer` の最小のダブル。 */
const transfer = (map = {}, files = []) => ({ getData: (type) => map[type] || '', files });

test('Civitai のページ URL から ID を取る', () => {
    assert.deepEqual(
        extractCivitaiImageId('https://civitai.com/images/47986787'),
        { id: '47986787', source: 'page', domain: 'civitai.com' },
    );
    assert.deepEqual(
        extractCivitaiImageId('https://civitai.com/images/47986787?postId=123'),
        { id: '47986787', source: 'page', domain: 'civitai.com' },
    );
});

test('ミラードメインも受ける（実データの94%がこちら）', () => {
    // **`.com` だけを受ける実装は静かに94%を落とす。**
    // 実測（既存レシピ346件）: civitai.red 326 / civitai.com 14 / ローカル画像 6。
    assert.ok(CIVITAI_DOMAINS.includes('civitai.red'));
    assert.equal(extractCivitaiImageId('https://civitai.red/images/18176508')?.id, '18176508');
    assert.equal(extractCivitaiImageId('https://civitai.red/images/18176508')?.domain, 'civitai.red');
});

test('CDN URL は最終セグメントから取る', () => {
    const got = extractCivitaiImageId(
        'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/8a2f/width=1024/47986787.jpeg',
    );
    assert.deepEqual(got, { id: '47986787', source: 'cdn', domain: 'civitai.com' });
});

test('Civitai 以外は取らない（誤検出しない）', () => {
    assert.equal(extractCivitaiImageId('https://example.com/images/47986787'), null);
    assert.equal(extractCivitaiImageId('https://civitai.com/models/12345'), null);
    assert.equal(extractCivitaiImageId('D:\\Work\\ref\\ComfyUI_00042_.png'), null);
    assert.equal(extractCivitaiImageId(''), null);
});

test('HTML 断片に埋まった CDN URL も拾う', () => {
    const got = extractCivitaiImageIdFromCandidates([
        '<img src="https://image.civitai.com/abc/width=450/72877227.jpeg">',
    ]);
    assert.equal(got?.id, '72877227');
});

test('/api/view の判定はホスト名でなくパスで行う', () => {
    // LAN 越しに ComfyUI を開くとホストが変わる。ホストで分岐すると捕捉経路が死ぬ。
    const local = parseComfyViewUrl('http://127.0.0.1:8188/api/view?filename=a.png&type=output&subfolder=');
    const lan = parseComfyViewUrl('http://192.168.1.20:8188/api/view?filename=a.png&type=output&subfolder=sweep%2F01');
    assert.equal(local?.filename, 'a.png');
    assert.equal(local?.subfolder, '', 'subfolder は空のことがある（実測）');
    assert.equal(lan?.subfolder, 'sweep/01');
    assert.equal(parseComfyViewUrl('https://civitai.com/images/1'), null);
});

test('3経路が正しく分かれる', () => {
    assert.equal(
        routeDrop(transfer({ 'text/uri-list': 'https://civitai.red/images/18176508' })).route,
        DROP_ROUTES.CIVITAI,
    );
    assert.equal(
        routeDrop(transfer({}, [{ name: 'x.png', type: 'image/png' }])).route,
        DROP_ROUTES.LOCAL_FILE,
    );
    assert.equal(
        routeDrop(transfer({ 'text/uri-list': 'http://127.0.0.1:8188/api/view?filename=x.png&type=output&subfolder=' })).route,
        DROP_ROUTES.COMFY_OUTPUT,
    );
    assert.equal(routeDrop(transfer({}, [])), null);
});

test('ComfyUI 出力のファイル名に Civitai の ID が入っていても捕捉側へ行く', () => {
    // **これを取り違えると、捕捉できるものをわざわざ再構成しにいく。**
    // 実測の payload そのもの（`Recipe_Civitai_Recipe_47986787_00045_.png`）。
    const routed = routeDrop(transfer({
        'text/uri-list':
            'http://127.0.0.1:8188/api/view?filename=Recipe_Civitai_Recipe_47986787_00045_.png&type=output&subfolder=',
    }));
    assert.equal(routed.route, DROP_ROUTES.COMFY_OUTPUT);
    assert.equal(routed.filename, 'Recipe_Civitai_Recipe_47986787_00045_.png');
});

test('既存の抽出結果と一致する（--recipes を渡したときだけ走る）', (t) => {
    const i = process.argv.indexOf('--recipes');
    const dir = i >= 0 ? process.argv[i + 1] : process.env.UNBAKE_RECIPES_DIR;
    if (!dir || !fs.existsSync(dir)) {
        t.skip('レシピの置き場が指定されていない（UNBAKE_RECIPES_DIR か --recipes）');
        return;
    }
    const files = fs.readdirSync(dir).filter(name => name.endsWith('.recipe.json'));
    assert.ok(files.length > 0, 'レシピが0件＝走査が壊れている');
    let urls = 0;
    let matched = 0;
    const falsePositives = [];
    for (const name of files) {
        let recipe;
        try { recipe = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
        const source = String(recipe.source_path || '');
        const got = extractCivitaiImageId(source);
        if (/^https?:\/\//i.test(source)) {
            urls += 1;
            const expected = (/\/images\/(\d+)/.exec(source) || [])[1] || null;
            if (got && got.id === expected) matched += 1;
        } else if (got) {
            falsePositives.push(source);
        }
    }
    assert.equal(matched, urls, 'URL 形式の全件で一致しなかった');
    assert.deepEqual(falsePositives, [], 'ローカル画像を Civitai と誤検出した');
});

// --- 投稿 URL（2026-08-24・記事の公開を止めていた件）------------------------
//
// **実測**: `/posts/30572284` -> null / `/images/47986787` -> 取れる。
// 投稿URLは `PAGE_PATH` に当たらず、最終セグメントに拡張子が無いので
// `CDN_LAST_SEGMENT` にも当たらない。落ちること自体は正しいが、
// **呼び手には「読めなかった」としか伝わらず、打つ手が渡らなかった。**

test('投稿 URL からは画像 ID を取らない（取れたことにしない）', () => {
    // **1枚に決められないものを、決めたふりで返さない。**
    assert.equal(extractCivitaiImageId('https://civitai.com/posts/30572284'), null);
    assert.equal(extractCivitaiImageId('https://civitai.red/posts/30572296'), null);
});

test('投稿 URL は投稿として見分ける（ミラードメインも）', () => {
    assert.deepEqual(extractCivitaiPostId('https://civitai.com/posts/30572284'), {
        postId: '30572284', domain: 'civitai.com', url: 'https://civitai.com/posts/30572284',
    });
    // **ドメインは `.com` だけではない。** 実データの94%が `.red`。
    assert.equal(extractCivitaiPostId('https://civitai.red/posts/1')?.domain, 'civitai.red');
    // 画像ページを投稿と間違えない。
    assert.equal(extractCivitaiPostId('https://civitai.com/images/47986787'), null);
    // よそのドメインの `/posts/` は拾わない。
    assert.equal(extractCivitaiPostId('https://example.com/posts/123'), null);
});

test('投稿 URL を落とすと、理由を種類で返す（文言で当てさせない）', () => {
    const routed = routeDrop(transfer({ 'text/uri-list': 'https://civitai.com/posts/30572284' }));
    assert.equal(routed?.route, DROP_ROUTES.UNSUPPORTED, '判らなかった扱いのまま');
    assert.equal(routed?.code, UNSUPPORTED_CODES.CIVITAI_POST);
    assert.equal(routed?.postId, '30572284');
    assert.equal(routed?.domain, 'civitai.com');
});

test('投稿ページから絵をつまんだ場合は、扱えない扱いにしない', () => {
    // **拾えるものは拾う。** 投稿ページから画像をドラッグすると
    // `text/uri-list` は投稿URLでも、`text/html` に CDN URL が入っている。
    // 順序を間違えると、**取り込めるものを扱えない扱いにしてしまう。**
    const routed = routeDrop(transfer({
        'text/uri-list': 'https://civitai.com/posts/30572284',
        'text/html': '<img src="https://image.civitai.com/abc/width=450/47986787.jpeg">',
    }));
    assert.equal(routed?.route, DROP_ROUTES.CIVITAI);
    assert.equal(routed?.imageId, '47986787');
});

test('何も判らなかったものは、扱えない扱いにもしない', () => {
    // **null（判らない）と UNSUPPORTED（判ったが扱えない）を混ぜない。**
    // 混ぜると、打つ手のある方と無い方が同じ見え方になる。
    assert.equal(routeDrop(transfer({ 'text/uri-list': 'https://example.com/whatever' })), null);
    assert.equal(routeDrop(transfer({})), null);
});
