/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **台帳が知っている別名で、拡大器が解決されること**（`I-20260830-10`）。
 *
 * 台帳は `4x_foolhardy_Remacri.pth` と `Remacri` / `4x-Remacri` の対応を持っている。
 * ところが実行側 `resolveInstalledUpscaler()` は**手書きの `UPSCALER_ALIASES` しか
 * 見ていなかった**ので、導入済みでも「入っていません」と言って lanczos へ落ちていた
 * （ESRGAN と lanczos は質感が明確に違う）。しかも不足モデルの面は「台帳で取れる」と
 * 表示するため、押して落とし終えても直らない。
 *
 * Civitai 由来レシピの拡大器 URN は**実測346件中33件すべてが Remacri**。記録に
 * 拡大器が在れば毎回踏んでいた。
 *
 * ## 手書きで数名だけ流さない
 *
 * 既存の `model_preview_test.mjs` は `UPSCALER_ALIASES` の先頭2行と**完全一致する
 * 名前しか流していない**ので、別名解決の経路が一度も歩かれていなかった。ここでは
 * **台帳の実体（`unbake/services/known_model_catalog.py`）を読んで、拡大器の
 * 全別名を表駆動で流す**——別名を足した人の分が自動で守られる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveInstalledUpscaler } from '../web/core/recipeWorkflowBuilder.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 台帳の実体から拡大器の項目を読む。**JS 側へ書き写さない。** */
function upscalerEntries() {
    // **改行で答えを変えない。** 作業木が CRLF の環境が実在し（統合 root が
    // まさにそうだった）、区切りを LF 決め打ちで探すと**台帳を0件と読んで
    // 検査が全滅**する。worktree では LF なので緑に見え、統合してから落ちた
    // ——一番読みにくい形なので、読み込んだ時点で正規化する。
    const source = fs.readFileSync(
        path.join(ROOT, 'unbake/services/known_model_catalog.py'), 'utf8')
        .split('\r\n').join('\n');
    const entries = [];
    for (const block of source.split('KnownModel(').slice(1)) {
        const body = block.slice(0, block.indexOf('),\n') + 1);
        if (!/folder\s*=\s*"upscale_models"/.test(body)) continue;
        const filename = /filename\s*=\s*"([^"]+)"/.exec(body)?.[1];
        if (!filename) continue;
        const aliasBlock = /aliases\s*=\s*\(([\s\S]*?)\)/.exec(body)?.[1] || '';
        const aliases = [...aliasBlock.matchAll(/"([^"]+)"/g)].map(m => m[1]);
        entries.push({ filename, aliases });
    }
    return entries;
}

/** 台帳を JS 側が受け取る形（`{models: [{filename, aliases}]}`）へ。 */
const catalogOf = (entries) => ({ models: entries, installed: [], unavailable: null });

test('台帳に拡大器が在る（前提）', () => {
    const entries = upscalerEntries();
    assert.ok(entries.length >= 3, `拡大器を読めていない: ${entries.length}件`);
    assert.ok(entries.some(e => /Remacri/i.test(e.filename)), 'Remacri が読めていない');
});

test('台帳の別名すべてが、導入済みのファイル名へ解決する', () => {
    const entries = upscalerEntries();
    const catalog = catalogOf(entries);
    const failures = [];
    for (const entry of entries) {
        // 「そのファイルだけが手元に在る」状況を作る。
        const installed = [entry.filename];
        for (const alias of entry.aliases) {
            const got = resolveInstalledUpscaler(alias, installed, catalog);
            if (got !== entry.filename) failures.push(`${alias} → ${JSON.stringify(got)}`);
        }
    }
    assert.deepEqual(failures, [], '台帳の別名なのに解決できないものがある');
});

test('Remacri は導入済みなら lanczos へ落ちない（報告そのもの）', () => {
    const catalog = catalogOf(upscalerEntries());
    for (const name of ['Remacri', '4x-Remacri', '4x_foolhardy_Remacri']) {
        assert.equal(
            resolveInstalledUpscaler(name, ['4x_foolhardy_Remacri.pth'], catalog),
            '4x_foolhardy_Remacri.pth', `${name} が解決できない`);
    }
});

test('[対照] 台帳を渡さなければ、従来どおり解決しない', () => {
    // **これが無いと「常に解決する」実装でも上の検査は通る。**
    assert.equal(
        resolveInstalledUpscaler('Remacri', ['4x_foolhardy_Remacri.pth'], null), null,
        '台帳なしで解決している（別の経路で当たっている）');
});

test('[対照] 台帳に在っても、手元に無ければ解決しない', () => {
    // 無い物を指すノードを組むと ComfyUI が投入ごと拒む＝1枚も出ない。
    const catalog = catalogOf(upscalerEntries());
    assert.equal(resolveInstalledUpscaler('Remacri', ['other.pth'], catalog), null,
        '手元に無いのに解決している');
});

test('手書きの別名表は、その canonical のファイルが手元に在れば解決する', () => {
    /*
     * **向きに注意。** 一度ここを「canonical は台帳に実在すること」と書いて、
     * `[/remacri/i, 'remacri_original']` を「死んだ行」として消した。だが
     * この表が照合する相手は**台帳ではなく手元の一覧**で、台帳に無い綴りで
     * 置かれているファイルを拾うのがまさにこの表の役目である。
     *
     * 実機には `remacri_original.pth` が在り、消した瞬間に 26件が lanczos へ
     * 落ちた（`Remacri` 22 / `4x_foolhardy_Remacri` 4）。**台帳の側を見る検査は
     * 誤りだったので捨て、「手元に在れば解決する」を測る。**
     */
    const source = fs.readFileSync(
        path.join(ROOT, 'web/core/recipeWorkflowBuilder.js'), 'utf8');
    const block = /const UPSCALER_ALIASES = \[([\s\S]*?)\n\];/.exec(source)?.[1];
    assert.ok(block, 'UPSCALER_ALIASES が読めない');
    const rows = [...block.matchAll(/\[\/([^/]+)\/i,\s*'([^']+)'\]/g)]
        .map(m => ({ pattern: new RegExp(m[1], 'i'), canonical: m[2] }));
    assert.ok(rows.length >= 4, `別名表が読めていない: ${rows.length}行`);

    const failures = [];
    for (const { pattern, canonical } of rows) {
        // その canonical のファイルだけが手元に在る状況。
        const installed = [`${canonical}.pth`];
        // その行が拾うはずの名前を1つ作る（canonical 自身は必ず当たる）。
        if (!pattern.test(canonical)) continue;
        const got = resolveInstalledUpscaler(canonical, installed, null);
        if (got !== installed[0]) failures.push(`${canonical} → ${JSON.stringify(got)}`);
    }
    assert.deepEqual(failures, [], '手元に在るのに解決できない別名がある');
});

test('実機に在る綴りで置かれた Remacri が解決する（退行の再発防止）', () => {
    // 2026-08-30 実機の導入一覧そのもの。**台帳の canonical とは違う綴り**で
    // 置かれている。
    const installed = [
        '4x-AnimeSharp.pth', '4x-UltraSharp.pth', '4xNomos8kDAT.pth',
        '4x_NMKD-Siax_200k.pth', 'RealESRGAN_x4plus.pth',
        'RealESRGAN_x4plus_anime_6B.pth', 'SwinIR_4x.pth',
        'remacri_original.pth',
    ];
    const catalog = catalogOf(upscalerEntries());
    for (const name of ['Remacri', '4x_foolhardy_Remacri', '4x-Remacri']) {
        assert.equal(resolveInstalledUpscaler(name, installed, catalog), 'remacri_original.pth',
            `${name} が lanczos へ落ちる（この綴りで置かれている環境が実在する）`);
    }
});
test('手元のファイル名が別名側でも解決する', () => {
    // **台帳の `filename` だけを見ると、この形が落ちる。** 手元に在るのが
    // `Remacri.pth`（別名側の綴り）で、台帳の canonical は
    // `4x_foolhardy_Remacri.pth` という組み合わせは普通に在る。
    // 見本の導入名を常に canonical にしていると、この経路が一度も歩かれない
    // （変異検査が捕まえた）。
    const catalog = catalogOf(upscalerEntries());
    assert.equal(
        resolveInstalledUpscaler('4x-Remacri', ['Remacri.pth'], catalog),
        'Remacri.pth', '別名の綴りで置かれたファイルを見つけられない');
});

test('別名どうしが混ざっても、台帳が同じ項目なら解決する', () => {
    const catalog = catalogOf(upscalerEntries());
    const entries = upscalerEntries();
    const failures = [];
    for (const entry of entries) {
        if (!entry.aliases.length) continue;
        // 手元に在るのは**最初の別名**。引くのは canonical の filename。
        const installed = [`${entry.aliases[0]}.pth`];
        const got = resolveInstalledUpscaler(entry.filename, installed, catalog);
        if (got !== installed[0]) failures.push(`${entry.filename} → ${JSON.stringify(got)}`);
    }
    assert.deepEqual(failures, [], '台帳の同じ項目なのに繋がらない組み合わせがある');
});
