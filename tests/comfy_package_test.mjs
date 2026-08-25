/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **ComfyUI が起動時に実際に読む部分**を検査する。
 *
 * ここが「人が動かせる形になっている」の中身で、しかも**壊れても静かに落ちる**。
 * `WEB_DIRECTORY` が実在しなければ拡張は読み込まれず、ログにも何も出ないまま
 * サイドバーのタブが出ないだけになる——「実装が無い」のと見分けが付かない。
 *
 * **これは実機での起動確認の代わりにはならない。** ここで確かめているのは
 * ComfyUI が読む契約の形であって、実際に ComfyUI へ入れて開いた結果ではない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INIT = fs.readFileSync(path.join(ROOT, '__init__.py'), 'utf8');

test('__init__.py が ComfyUI の読み込み契約を満たす', () => {
    assert.match(INIT, /NODE_CLASS_MAPPINGS/, 'NODE_CLASS_MAPPINGS が無い');
    assert.match(INIT, /NODE_DISPLAY_NAME_MAPPINGS/, 'NODE_DISPLAY_NAME_MAPPINGS が無い');
    assert.match(INIT, /WEB_DIRECTORY\s*=\s*["']\.\/web["']/, 'WEB_DIRECTORY が ./web を指していない');
});

test('WEB_DIRECTORY の直下に拡張の入口 JS がある', () => {
    // 入口は直下に置く。読み手（人）が最初に開く場所を1つに決めるため。
    const entries = fs.readdirSync(path.join(ROOT, 'web'), { withFileTypes: true })
        .filter(e => e.isFile() && e.name.endsWith('.js'))
        .map(e => e.name);
    assert.deepEqual(entries, ['unbake.js'], 'web/ 直下の入口 JS が想定と違う');
});

test('入口以外は拡張として登録しない（全部 import されるので二重登録しない）', () => {
    // **当初「ComfyUI は直下の `*.js` だけ読む」と書いていたが、これは誤りだった。**
    // 稼働中の ComfyUI（v0.28.3・frontend 1.42.15）で実測すると、`/api/extensions` は
    // `WEB_DIRECTORY` 配下を**再帰的に**列挙する——こちらの15ファイルが全部載り、
    // 画面はその全部を import する（実測 2026-08-20・全体79件のうち15件が Unbake）。
    //
    // 動作は壊れない（残りは副作用の無いモジュールなので読まれるだけ）が、
    // **`web/` に置いた物は必ず読まれる**という前提になる。だから:
    //   - 登録の呼び出しは入口1本にしか置かない（置くと二重登録になる）
    //   - import しただけで何かが起きるコードを `web/` へ置かない
    const files = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.js')) files.push(p);
        }
    };
    walk(path.join(ROOT, 'web'));
    assert.ok(files.length >= 15, '走査が壊れている（' + files.length + '件）');

    // **見るのは「呼んでいるか」。** 名前が出てくるだけで数えていたので、
    // 由来を書いた注釈（`registerSidebarTab` が渡してくる器の話）まで
    // 登録扱いになった——**注釈を書けなくする検査**は、規約の側が間違っている。
    const CALL = /register(?:SidebarTab|Extension)\s*\??\.?\s*\(/;
    const registrars = files.filter(f => CALL.test(fs.readFileSync(f, 'utf8')));
    assert.deepEqual(
        registrars.map(f => path.relative(ROOT, f).split(path.sep).join('/')),
        ['web/unbake.js'],
        '入口以外にも登録の呼び出しがある＝画面が全部 import したときに二重登録になる',
    );
});

test('入口 JS がサイドバーと全画面の両方を登録している', () => {
    const entry = fs.readFileSync(path.join(ROOT, 'web/unbake.js'), 'utf8');
    assert.match(entry, /registerSidebarTab/, 'サイドバータブを登録していない');
    assert.match(entry, /openFullscreen/, '全画面の入口が無い');
    // **同じ関数を両方へ渡していること。** ここが決定⑤の全部。
    const mounts = [...entry.matchAll(/createUnbakePanel\(/g)].length;
    assert.ok(mounts >= 2, 'パネルの生成が1箇所しかない（器が2つになっていない）');
});

test('サイドバーのボタンから製品名にたどり着ける（どの言語でも）', async () => {
    // **画面のどこにも名前が出ない状態を作らない。** frontend（実測 v1.42.15）は
    // `tooltip` をボタンの `aria-label` にし、`title` は画面に出さない。
    // 最初の版は tooltip が「Generation Record → Replay Manifest → Sweep」だけで、
    // **どこにも "Unbake" と書かれていなかった**——探した人が見つけられず、
    // 「拡張が読み込まれていない」と誤診断させた。
    //
    // 多言語化したので、**訳した言語のどれかで名前が落ちる**ことがありうる。
    // 文言はカタログに移ったので、カタログ側を全言語ぶん見る。
    const entry = fs.readFileSync(path.join(ROOT, 'web/unbake.js'), 'utf8');
    assert.match(entry, /tooltip:\s*t\('app\.tooltip'\)/, 'tooltip がカタログを引いていない');

    const { CATALOGS } = await import('../web/i18n/index.js');
    const locales = Object.keys(CATALOGS);
    assert.ok(locales.length >= 2, '言語が1つしかない＝多言語の検査になっていない');
    for (const locale of locales) {
        assert.match(CATALOGS[locale]['app.tooltip'], /Unbake/,
            `${locale} のツールチップに製品名が入っていない＝その言語で名前が画面に出ない`);
    }
});

test('キャンバスノードを1つも登録しない（パネルだけを出す）', () => {
    assert.match(INIT, /NODE_CLASS_MAPPINGS:\s*dict\s*=\s*\{\}/, 'ノードを登録し始めている');
});

test('pyproject.toml に依存が無い（依存のライセンスが乗ってこないこと）', () => {
    const toml = fs.readFileSync(path.join(ROOT, 'pyproject.toml'), 'utf8');
    assert.match(toml, /dependencies\s*=\s*\[\]/, 'Python 依存が入っている');
    assert.match(toml, /license\s*=/, 'ライセンス指定が無い');
});

test('寄付の導線が「未設定である」ことが読み取れる', () => {
    // **開通していない導線の 0 は、需要の 0 ではない。**
    // 埋めるのは人間の作業なので、埋まっていないこと自体をここで可視にしておく。
    const funding = fs.readFileSync(path.join(ROOT, '.github/FUNDING.yml'), 'utf8');
    const active = activeFundingLines(funding);
    if (active.length === 0) {
        // 未設定。**そのときは注記が残っていること**（消えると理由が判らなくなる）。
        assert.match(funding, /テスト送金/, '未設定なのに、埋め方と検証手順の注記が無い');
    } else {
        // **設定側も測る。** ここは以前 `/[A-Za-z0-9_-]+/` を本文全体に当てており、
        // **空の値でも注記の日本語に当たって通っていた**（何も検査していないのと同じ）。
        // 見るのは有効行の**値**であって、ファイルのどこかに英数字が在ることではない。
        for (const line of active) {
            const value = line.slice(line.indexOf(':') + 1).trim();
            assert.notEqual(value, '', `有効行の値が空: ${line}`);
            assert.doesNotMatch(value, /[<>]/, `雛形のまま値が入っていない: ${line}`);
        }
    }
});

/** `FUNDING.yml` の**有効な**行（コメントでも空でもない `key: value`）。 */
function activeFundingLines(text) {
    return text.split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => !line.startsWith('#') && /^[a-z_]+\s*:/.test(line));
}

/** `FUNDING.yml` の有効行に書かれた URL（`custom:` の配列も開く）。 */
function fundingUrls(text) {
    return activeFundingLines(text)
        .flatMap(line => line.match(/https?:\/\/[^\s'"\],]+/g) || []);
}

test('導線を設定したなら、検証済みか未検証かがファイルから読み取れる', () => {
    // **0 を需要0と読ませないための注記が、設定と同時に消えないようにする。**
    // `D-20260820-03`: テスト送金を飛ばすこと自体は禁じない。飛ばしたなら
    // 「導線は未検証」と明記する——その明記がここで消えるのが一番危ない。
    const funding = fs.readFileSync(path.join(ROOT, '.github/FUNDING.yml'), 'utf8');
    if (activeFundingLines(funding).length === 0) return;   // 未設定は上の検査の受け持ち
    assert.match(
        funding, /検証していない|検証済み/,
        '導線を設定したのに、通しで検証したかどうかが書かれていない',
    );
});

test('有効な導線の URL は絶対 https である', () => {
    // **相対や http のまま公開すると、押した先が無言で別の所になる。**
    // GitHub の Sponsor ボタンは値をそのまま出すので、ここで弾く。
    const funding = fs.readFileSync(path.join(ROOT, '.github/FUNDING.yml'), 'utf8');
    for (const url of fundingUrls(funding)) {
        assert.match(url, /^https:\/\//, `絶対 https でない導線: ${url}`);
    }
});

test('README と FUNDING.yml と ♡ の面が、同じ送り先を指している', async () => {
    // **食い違うのは書き足したときで、消したときではない。** 2本目を足して
    // README だけ直し忘れると、**GitHub から来た人と README を読んだ人で送り先が違う**。
    // どちらが正かは誰にも判らなくなるので、書いた瞬間に落とす。
    //
    // **見る先は 2026-08-24 に `unbake/settings.py` から `web/panel/donateView.js` へ移した**
    // ——設定の `donate_url` を撤去し、送り先を面の表へ決め打ちにしたため。
    // 出どころが動いたのに検査が古い場所を見続けると、**緑のまま何も守らなくなる。**
    const funding = fs.readFileSync(path.join(ROOT, '.github/FUNDING.yml'), 'utf8');
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    for (const url of fundingUrls(funding)) {
        assert.ok(readme.includes(url), `FUNDING.yml にあるのに README に無い: ${url}`);
    }
    const { OWN_RAILS } = await import('../web/panel/donateView.js');
    assert.ok(OWN_RAILS.length > 0, '面の送り先が空（検査が素通りしている）');
    const active = activeFundingLines(funding).join('\n');
    for (const rail of OWN_RAILS) {
        assert.ok(readme.includes(rail.url), `♡ の面にあるのに README に無い: ${rail.url}`);
        // `FUNDING.yml` は `ko_fi: syugoji` のように**名前だけ**で書く行がある
        // （GitHub がその場で URL を組む）。URL 一致だけを見ると、**正しい設定を
        // 食い違いと呼ぶ**ので、名前でも照合する。見るのは有効行だけ——
        // 注記のコメントに名前が出てくるのを一致と数えない。
        const handle = rail.url.replace(/\/+$/, '').split('/').pop();
        assert.ok(active.includes(rail.url) || active.includes(handle),
            `♡ の面にあるのに FUNDING.yml の有効行に無い: ${rail.url}`);
    }
});

test('README の支援節に、上流への導線が残っていない', () => {
    // **2026-08-24 に利用者が前提を改めた**——Unbake は LoRA Manager とは機能が全く異なり、
    // 完全に独立している。以前は「上流を自分より先に置く」順序を検査していたが、
    // **守る対象が消えたので、置いていないことを見る側へ入れ替えた。**
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const section = readme.slice(readme.indexOf('\n## 支援'));
    assert.notEqual(section, '', 'README に「支援」節が無い');
    const upstream = section.match(/pixelpawsai|PixelPawsAI|afdian|patreon/gi) || [];
    assert.deepEqual(upstream, [], '支援節に上流への導線が残っている');
});
