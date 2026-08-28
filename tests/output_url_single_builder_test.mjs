/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **出た絵の URL を手で組ませない**（2026-08-29）。
 *
 * ## なぜ「1本しか無いこと」を検査するのか
 *
 * 「消した絵が出る／前の絵が出る」は、利用者から**複数回**報告され、そのたびに
 * 直したのに再発した。理由は中身の難しさではなく**形**だった:
 *
 *     URL を組み立てている所   5箇所
 *     キャッシュ回避が在る所   1箇所（`openCompare` の相手側）
 *
 * 症状は「回避が無い口」から出るので、**押された画面を直しても、次は別の画面から
 * 同じものが出る**。1箇所ずつ塞ぐ限り終わらない。
 *
 * だからここで固定するのは動きではなく**構造**——`/api/view?` を手で組む所が
 * 新しく増えたら落ちる。増やしたい人は `core/outputUrl.js` を通す。
 *
 * ## 見逃さないために、対照を置く
 *
 * 検査器が壊れて（正規表現が何にも当たらない等）常に通ることが在り得るので、
 * **わざと違反した文字列を同じ規則へ通して、ちゃんと捕まることを確かめる。**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../web/', import.meta.url));

/** 出た絵の口を**手で組んでいる**行。`core/outputUrl.js` だけが持ってよい。 */
const HANDMADE = /`\/api\/view\?/;

/** この検査から外す。**理由を必ず書く**（黙って外さない）。 */
const ALLOWED = new Map([
    ['core/outputUrl.js', '組み立て器そのもの。ここだけが持つ。'],
    // 落とし込まれた URL が ComfyUI の出力かを見るだけで、**組み立てていない**。
    ['panel/dropRouting.js', '受け取った URL を判定するだけ（組み立てない）'],
]);

function jsFiles(dir) {
    const found = [];
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { found.push(...jsFiles(path)); continue; }
        if (name.endsWith('.js')) found.push(path);
    }
    return found;
}

test('出た絵の URL を手で組んでいる所は、組み立て器の1本だけ', () => {
    const offenders = [];
    for (const path of jsFiles(ROOT)) {
        const key = relative(ROOT, path).replace(/\\/g, '/');
        if (ALLOWED.has(key)) continue;
        const lines = readFileSync(path, 'utf8').split('\n');
        for (const [index, line] of lines.entries()) {
            // 注記の中の例示は数えない（説明を書けなくなる）。
            const code = line.replace(/^\s*(\*|\/\/).*$/, '');
            if (HANDMADE.test(code)) offenders.push(`${key}:${index + 1}`);
        }
    }
    assert.deepEqual(
        offenders, [],
        '出た絵の URL を手で組んでいる所が増えている。'
        + '`core/outputUrl.js` の `outputImageUrl()` を通すこと'
        + '（通さないと鮮度の印が載らず、消した絵・前の絵がそのまま出る）:\n  '
        + offenders.join('\n  '),
    );
});

test('検査器そのものが働いていることを、違反の見本で確かめる', () => {
    // **対照。** これが当たらないなら、上の「0件」は「見ていない」の意味になる。
    const violation = 'normalized.url = `/api/view?${params.toString()}`;';
    assert.ok(HANDMADE.test(violation), '違反の見本を捕まえられていない');
    // 注記の行は数えない、が効いていること。
    const comment = ' * 実測: `/api/view?filename=…&type=output` が来る';
    assert.equal(
        HANDMADE.test(comment.replace(/^\s*(\*|\/\/).*$/, '')), false,
        '注記の例示まで違反として数えている',
    );
});

test('外した所には理由が書いてある', () => {
    for (const [key, why] of ALLOWED) {
        assert.ok(why && why.length > 5, `${key} を理由なく外している`);
    }
});
