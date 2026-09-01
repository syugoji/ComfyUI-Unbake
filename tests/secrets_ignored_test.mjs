/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **「.gitignore 済み」と書いた物が、本当に無視されること**
 * （2026-08-31・監査 I-20260831-08）。
 *
 * 配布物の4箇所が `civitai_recipe_sync/config.json` は `.gitignore` 済みだと
 * 明記していた——`config.example.json` の `_comment`、`README.md` の2箇所、
 * `civitai_image_download.py` の冒頭。**どれも事実ではなかった。**
 * `.gitignore` に該当の行が無く、`git check-ignore` は「無視しない」を返す。
 *
 * **害は秘匿値の漏洩そのもの。** 利用者は README のとおり
 * `cp config.example.json config.json` して `raindrop_token` と
 * `civitai_api_key` を埋める。「誤コミットしない」と保証されているので
 * `git add -A` する。この拡張自体が GitHub 配布で、`custom_nodes` を fork して
 * push する運用があるため、**そのまま公開リポジトリへ載りうる**。
 *
 * **文章では守れない**（4箇所そろって嘘になっていた）ので、検査で留める。
 * 追加した無視の規則が効いているかは `git check-ignore` に聞く——
 * `.gitignore` の中身を正規表現で読むと、書き方を変えた瞬間に嘘になる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * ここが git の作業ツリーか。
 *
 * **配布物として展開された木では測れない**（zip で落とした利用者、複製した
 * 検査用の木）。そこで `git check-ignore` は 128 を返すので、**「無視されない」
 * と読んではいけない**——測れないことと、測って駄目だったことは別である。
 */
async function insideGitWorkTree() {
    try {
        const { stdout } = await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT });
        return String(stdout).trim() === 'true';
    } catch {
        return false;
    }
}

/** `git check-ignore` は無視されるとき 0、されないとき 1 を返す。 */
async function ignored(relative) {
    try {
        await run('git', ['check-ignore', '-q', '--', relative], { cwd: ROOT });
        return true;
    } catch (error) {
        if (error?.code === 1) return false;
        throw error;
    }
}

test('秘匿値を入れる設定ファイルが、本当に無視される', async (t) => {
    if (!(await insideGitWorkTree())) { t.skip('git の作業ツリーではないので測れない'); return; }
    assert.equal(await ignored('civitai_recipe_sync/config.json'), true,
        '`.gitignore 済み` と4箇所に書いてあるのに、git は無視しない');
});

test('置き場を変えても、名前が同じなら無視される', async (t) => {
    if (!(await insideGitWorkTree())) { t.skip('git の作業ツリーではないので測れない'); return; }
    // `CIVITAI_SYNC_CONFIG` で別の場所へ置ける仕様なので、名前で拾う。
    assert.equal(await ignored('config.json'), true, 'リポジトリ直下の config.json が拾えていない');
});

test('対照: 見本のほうは追跡し続ける（無視したら配布物から消える）', async (t) => {
    if (!(await insideGitWorkTree())) { t.skip('git の作業ツリーではないので測れない'); return; }
    assert.equal(await ignored('civitai_recipe_sync/config.example.json'), false,
        '見本まで無視している＝利用者が手順を始められない');
});

test('「.gitignore 済み」と書いている箇所を数え、全部が同じ約束を指している', async () => {
    // **文章を消すのではなく、文章が正しくなったことを確かめる。**
    // 将来この約束を撤回するなら、4箇所の文言と一緒にこの検査を消すこと。
    const files = [
        'civitai_recipe_sync/config.example.json',
        'civitai_recipe_sync/README.md',
        'civitai_recipe_sync/civitai_image_download.py',
    ];
    let claims = 0;
    for (const rel of files) {
        const text = await readFile(join(ROOT, rel), 'utf8');
        claims += [...text.matchAll(/\.gitignore/g)].length;
    }
    assert.ok(claims >= 4,
        `「.gitignore 済み」の記述が減っている（${claims}箇所）。約束を撤回したなら、この検査も一緒に直すこと`);
});
