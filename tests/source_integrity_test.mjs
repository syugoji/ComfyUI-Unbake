/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 配布物の完全性 — **NOTICE が主張していることを、機械で検査する。**
 *
 * この切り出しの根拠は「上流を1つも import しない」「本文を写していない」
 * 「著作権が単独で自分にある」の3点で、どれも**壊れても赤くならない**種類の主張である。
 * 文章で書くと、次にファイルを1つ足した瞬間に静かに嘘になる。ここで固定する。
 *
 * `replay-core/tests/source_integrity_test.mjs` の形を踏襲している。
 * あちらで2度踏んだ失敗（公開した手順そのものが参照を印字していなかった／
 * 生の NUL バイトで grep から静かに消えていた）は、こちらでも同じ形で起こりうる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** **上流のファイル。ここが例外の唯一の宣言場所**（NOTICE は散文でこれを繰り返さない）。 */
const UPSTREAM_FILES = ['web/core/genParamsMapper.js'];

/** ComfyUI 本体が拡張向けに公開している shim。**入口だけがこれを使ってよい。** */
const HOST_MODULE = '../../scripts/app.js';

/**
 * ComfyUI 本体が供給するもの。パッケージが同梱するのではない。
 *
 * `server` は ComfyUI の `server.py`（`class PromptServer`・実測で本体に在る）。
 * `aiohttp` は ComfyUI 本体の web サーバそのもの（`server.py` の 32-33 行で
 * `import aiohttp` / `from aiohttp import web`・実測 2026-08-20。portable の
 * `python_embeded/Lib/site-packages/aiohttp` にも在る）。**この拡張が
 * 持ち込む依存ではない**ので、`pyproject.toml` の `dependencies` は空のままでよい。
 * **フォークのモジュールではない**ので、`folder_paths` と同じ扱いにする。
 * ここへ足すときは、必ず**本体側にそのファイルが在ることを確かめてから**にすること
 * ——名前だけ見て許すと、フォークの依存を宿主だと思い込んで通してしまう。
 */
// `av` は ComfyUI の `requirements.txt` に `av>=16.0.0` として在り、本体の
// `comfy_extras`（`nodes_video.py` / `nodes_images.py` ほか5箇所）が `import av`
// している（実測 2026-08-22・portable の site-packages にも在る）。
// **`cv2` は足さない。** site-packages には在るが `requirements.txt` に無く、
// 別の拡張が持ち込んだものかもしれない——名前だけ見て宿主だと思い込まない。
const HOST_PROVIDED_PYTHON = new Set(['folder_paths', 'PIL', 'server', 'aiohttp', 'av']);

const PY_STDLIB = new Set([
    '__future__', 'asyncio', 'base64', 'collections', 'contextlib', 'copy', 'csv',
    'concurrent', 'dataclasses', 'datetime', 'enum', 'functools', 'glob', 'hashlib', 'inspect',
    'importlib', 'io', 'itertools', 'json', 'logging', 'math', 'os', 'pathlib',
    'random', 're', 'shutil', 'struct', 'subprocess', 'sys', 'tempfile', 'threading',
    'time', 'traceback', 'types', 'typing', 'urllib', 'uuid', 'zipfile',
]);

async function filesUnder(dir, exts) {
    const out = [];
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const entry of entries) {
        if (entry.name === '__pycache__' || entry.name === 'node_modules') continue;
        const p = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...await filesUnder(p, exts));
        else if (exts.some(x => entry.name.endsWith(x))) out.push(p);
    }
    return out;
}

const rel = (p) => relative(ROOT, p).split(sep).join('/');

const jsFiles = () => filesUnder(join(ROOT, 'web'), ['.js', '.mjs']);
const pyFiles = () => filesUnder(join(ROOT, 'unbake'), ['.py']);

/**
 * コメントを落としてから走査する。**散文に書いた語で誤検出しない**ため。
 * 完璧な字句解析ではない——文字列中の `//` を落とす可能性はあるが、
 * それは検査が**見落とす**側なので、許可リスト側で別途塞いでいる。
 */
function stripComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** **大域の `fetch` 識別子だけ**に当てる。`doFetch` / `fetchResourceAvailability` / `.fetch` は当てない。 */
const GLOBAL_FETCH_SOURCE = '(?<![A-Za-z0-9_$.])fetch(?![A-Za-z0-9_$])';

test('ソースに生の NUL バイトが無い（grep から静かに消えないこと）', async () => {
    const files = [...await jsFiles(), ...await pyFiles()];
    assert.ok(files.length >= 20, '検査対象が少なすぎる（' + files.length + '件）＝走査が壊れている');
    const offenders = [];
    for (const f of files) {
        const n = (await readFile(f)).filter(b => b === 0).length;
        if (n) offenders.push(rel(f) + ' (NUL ' + n + '個)');
    }
    assert.deepEqual(offenders, [], 'NUL を含むファイルは grep がバイナリ扱いして内容検索から外す');
});

test('配布する文書にも生の NUL バイトが無い', async () => {
    for (const name of ['NOTICE', 'LICENSE', 'README.md', '__init__.py']) {
        let buf;
        try { buf = await readFile(join(ROOT, name)); } catch { continue; }
        assert.equal(buf.filter(b => b === 0).length, 0, name + ' に NUL がある');
    }
});

test('web/ の参照がパッケージの外を指さない', async () => {
    // **これが切り出しの根拠そのもの。** 1つでも**フォーク**を指した時点で
    // 「フォークから独立している」が成立しなくなる。
    //
    // 例外は `../../scripts/app.js` **だけ**——ComfyUI 本体が拡張向けに公開している
    // shim で、Python 側の `folder_paths` と同じ「宿主が供給するもの」である。
    // 拡張である以上ここは避けられない。**避けようとして `window.app` を見た結果、
    // 実機で一度も登録されないまま無音で死んだ**（frontend の実体は `window.comfyAPI.app.app`）。
    const bad = [];
    const hostImports = [];
    for (const f of await jsFiles()) {
        const text = await readFile(f, 'utf8');
        const specs = [
            ...text.matchAll(/^\s*(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/gm),
            ...text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g),
        ];
        for (const m of specs) {
            const spec = m[1];
            if (spec === HOST_MODULE) { hostImports.push(rel(f)); continue; }
            const ok = /^\.{1,2}\/[A-Za-z0-9_./-]+\.(?:js|mjs)$/.test(spec) && !spec.includes('../../');
            if (!ok) bad.push(rel(f) + ': ' + spec);
        }
        for (const _m of text.matchAll(/\brequire\s*\(/g)) bad.push(rel(f) + ': require() を使っている');
    }
    assert.deepEqual(bad, [], 'パッケージ内の相対参照以外がある');
    // **宿主へ触るのは入口1本に閉じる。** core が宿主を知り始めたら切り出しが崩れる。
    assert.deepEqual([...new Set(hostImports)], ['web/unbake.js'],
        '入口以外が ComfyUI 本体を import している');
});

test('unbake/ の import が標準ライブラリ・兄弟・宿主提供のものだけ', async () => {
    const bad = [];
    for (const f of await pyFiles()) {
        const text = await readFile(f, 'utf8');
        for (const m of text.matchAll(/^\s*from\s+(\.*)([A-Za-z0-9_.]*)\s+import\s/gm)) {
            const [, dots, mod] = m;
            if (dots) continue; // 相対＝兄弟
            const top = mod.split('.')[0];
            if (!PY_STDLIB.has(top) && !HOST_PROVIDED_PYTHON.has(top)) bad.push(rel(f) + ': from ' + mod);
        }
        for (const m of text.matchAll(/^\s*import\s+([A-Za-z0-9_.]+)/gm)) {
            const top = m[1].split('.')[0];
            if (!PY_STDLIB.has(top) && !HOST_PROVIDED_PYTHON.has(top)) bad.push(rel(f) + ': import ' + m[1]);
        }
    }
    assert.deepEqual(bad, [], '上流フォークか外部パッケージを参照している');
});

/**
 * **同梱スクリプトの import も見る。**
 *
 * 上の検査は相対 import を「兄弟」として無条件に通す（`if (dots) continue;`）ので、
 * `from ...civitai_recipe_sync import …` は素通りする。子プロセスで動かしていた頃は
 * それでよかった——別プロセスの依存はこちらの配布物の話ではなかった。
 * **0.1.2 で同一プロセスへ移した時点で、その前提は消えている**（`sync_script_runner.py`）。
 * 今このスクリプトが第三者パッケージを1つ足せば、それは **`dependencies = []` と
 * 宣言している配布物の実行時依存**になる。
 *
 * `pyproject.toml` にはこの穴を注意書きで残していたが、**散文は検査を素通りする**ので
 * ここで機械に見せる。**スクリプトは1文字も変えない方針**なので、通常このリストは動かない。
 * 動いたときは「上流が依存を増やした」という報告そのものになる。
 */
const SYNC_SCRIPT_ALLOWED = new Set([
    // ComfyUI 本体の `requirements.txt` が持つ（実測 2026-08-25・27行目）。
    // **`pyproject.toml` の `dependencies = []` はこれを根拠にしている。**
    'requests',
]);

test('同梱スクリプトの import が標準ライブラリと宿主提供のものだけ', async () => {
    const files = await filesUnder(join(ROOT, 'civitai_recipe_sync'), ['.py']);
    assert.ok(files.length > 0, '同梱スクリプトが1つも見つからない（置き場の改名か配り漏れ）');
    const bad = [];
    for (const f of files) {
        const text = await readFile(f, 'utf8');
        for (const m of text.matchAll(/^\s*from\s+(\.*)([A-Za-z0-9_.]*)\s+import\s/gm)) {
            const [, dots, mod] = m;
            if (dots) continue;
            const top = mod.split('.')[0];
            if (!PY_STDLIB.has(top) && !HOST_PROVIDED_PYTHON.has(top) && !SYNC_SCRIPT_ALLOWED.has(top)) {
                bad.push(rel(f) + ': from ' + mod);
            }
        }
        for (const m of text.matchAll(/^\s*import\s+([A-Za-z0-9_.]+)/gm)) {
            const top = m[1].split('.')[0];
            if (!PY_STDLIB.has(top) && !HOST_PROVIDED_PYTHON.has(top) && !SYNC_SCRIPT_ALLOWED.has(top)) {
                bad.push(rel(f) + ': import ' + m[1]);
            }
        }
    }
    assert.deepEqual(bad, [], '同梱スクリプトが宣言外の依存を持ち込んでいる');
});

test('web/core に大域の fetch 識別子が1つも無い（環境は呼び手が注入する）', async () => {
    // **切り出せなかった理由がここだった。** `/object_info` を判定モジュールの中で
    // 取りに行っていたので、フォークのページの上でしか動かせなかった。
    // 大域へ出るのは `web/host/` だけ、という境界を検査で保つ。
    const files = (await jsFiles()).filter(f => rel(f).startsWith('web/core/'));
    assert.ok(files.length >= 9, 'core の走査が壊れている（' + files.length + '件）');
    const offenders = [];
    for (const f of files) {
        const n = [...(await readFile(f, 'utf8')).matchAll(new RegExp(GLOBAL_FETCH_SOURCE, 'g'))].length;
        if (n) offenders.push(rel(f) + ' (' + n + '箇所)');
    }
    assert.deepEqual(offenders, [], 'core が自分で外へ出ている');

    // **境界の反対側も確かめる。** host が誰も外へ出ていないなら、
    // 上の 0件は「注入した」ではなく「経路ごと消えた」を意味する。
    const host = await readFile(join(ROOT, 'web/host/comfyHost.js'), 'utf8');
    assert.ok(new RegExp(GLOBAL_FETCH_SOURCE).test(host),
        'host 側にも大域の呼び出しが無い＝経路ごと消えている');
});

test('web/core に大域の localStorage 識別子が1つも無い（入れ物も呼び手が注入する）', async () => {
    // **HTTP と同じ理由。** `localStorage` を core が直接見ると、その瞬間から
    // ブラウザの上でしか動かないモジュールになる。しかも壊れ方が静かで、
    // Node のテストでは `undefined.getItem` の例外になり、埋め込み用途では
    // 保存だけが黙って落ちる——どちらも「動かない」と見えない。
    // `fetch` と違い、**`.` の前も除かない**——`globalThis.localStorage` と書いても
    // 掴んでいるのは同じ大域の入れ物で、注入したことにはならない。
    const GLOBAL_STORAGE = '(?<![A-Za-z0-9_$])(?:local|session)Storage(?![A-Za-z0-9_$])';
    const files = (await jsFiles()).filter(f => rel(f).startsWith('web/core/'));
    assert.ok(files.length >= 20, 'core の走査が壊れている（' + files.length + '件）');
    const offenders = [];
    for (const f of files) {
        const text = stripComments(await readFile(f, 'utf8'));
        const n = [...text.matchAll(new RegExp(GLOBAL_STORAGE, 'g'))].length;
        if (n) offenders.push(rel(f) + ' (' + n + '箇所)');
    }
    assert.deepEqual(offenders, [], 'core が自分で大域の入れ物を掴んでいる');

    // **境界の反対側。** host も触っていないなら、上の 0件は「注入した」ではなく
    // 「保存の経路ごと消えた」を意味する。
    const host = await readFile(join(ROOT, 'web/host/comfyHost.js'), 'utf8');
    assert.ok(new RegExp(GLOBAL_STORAGE).test(stripComments(host)),
        'host 側にも大域の入れ物が無い＝保存の経路ごと消えている');
});

test('本人のファイル全部に著作権表示があり、上流のファイルには無い', async () => {
    // **将来のデュアルライセンスを可能にする唯一の担保。**
    // 表示が無いまま配ると、後から著作権を主張しづらくなる。
    const files = [
        ...await jsFiles(),
        ...await pyFiles(),
        ...await filesUnder(join(ROOT, 'web'), ['.css']),
    ];
    const missing = [];
    const wronglyStamped = [];
    for (const f of files) {
        const stamped = (await readFile(f, 'utf8')).includes('Copyright (C) 2026 syugoji');
        if (UPSTREAM_FILES.includes(rel(f))) {
            if (stamped) wronglyStamped.push(rel(f));
        } else if (!stamped) {
            missing.push(rel(f));
        }
    }
    assert.deepEqual(missing, [], '著作権表示の無い自作ファイルがある');
    assert.deepEqual(wronglyStamped, [], '上流のファイルへ自分の著作権表示を入れている');
});

test('宣言した上流ファイルが実在し、NOTICE がそれを名指ししている', async () => {
    for (const name of UPSTREAM_FILES) {
        const text = await readFile(join(ROOT, name), 'utf8');
        assert.ok(text.length > 0, name + ' が空');
    }
    const notice = await readFile(join(ROOT, 'NOTICE'), 'utf8');
    for (const name of UPSTREAM_FILES) {
        assert.ok(notice.includes(name), 'NOTICE が ' + name + ' を明記していない');
    }
});

test('LICENSE が GPL-3.0 の正文である', async () => {
    const text = await readFile(join(ROOT, 'LICENSE'), 'utf8');
    assert.match(text, /GNU GENERAL PUBLIC LICENSE/);
    assert.match(text, /Version 3, 29 June 2007/);
    assert.doesNotMatch(text, /AFFERO/, 'AGPL の正文が入っている（決定③は GPL-3.0）');
    assert.ok(text.length > 30000, '正文にしては短い（' + text.length + '文字）＝差し替わっている可能性');
});

/**
 * **着地ページは1枚ではない。** 英語版と日本語版があり、読者はどちらかにしか
 * 降りてこない。片方だけ見張ると、**もう片方から上流の名前が消えても緑のまま**になる。
 *
 * `section` は「やらないこと」の節を各言語で名指しするための形。
 * 訳し方が変わったらここも変える——**見出しを消してよい、という意味ではない。**
 */
const READMES = [
    { file: 'README.md', section: /##\s*What it deliberately does not do/i },
    { file: 'README.ja.md', section: /##\s*やらないこと/ },
];

/**
 * **上流の寄付導線は「上流の口」で見る。** `ko-fi` という語では見ない——
 * どちらの README にも**自分の** ko-fi（`ko-fi.com/syugoji`）が末尾に在るので、
 * 語だけで見ると**上流への言及が丸ごと消えても緑のまま**になる。
 * 2026-08-25 に実際その状態が一度できた（`/ko-fi|Patreon/` で見ていた）。
 */
const UPSTREAM_FUNDING = /ko-fi\.com\/pixelpawsai|patreon\.com\/c\/pixelpaws/i;

test('どちらの README にも「やらないこと」「上流を前提にすること」が入っている', async () => {
    // **要件①（客の取り合いにならない）を文書側で固定する。**
    // **`genParamsMapper.js` の出所は GPL の帰属表示**なので、ここは値切れない。
    for (const { file, section } of READMES) {
        const readme = await readFile(join(ROOT, file), 'utf8');
        assert.match(readme, section, file + ': やらないことの節が無い');
        assert.match(readme, /ComfyUI-Lora-Manager|LoRA Manager/, file + ': 上流を前提にする記述が無い');
        assert.match(readme, /genParamsMapper\.js/, file + ': genParamsMapper.js の出所が明記されていない');
    }
});

test('英語版と日本語版が、上流の支援導線について同じ状態である', async () => {
    // **「在る」も「無い」も指定しない。揃っていることだけを見る。**
    //
    // 利用者決定（2026-08-25）で上流の支援案内は両方から外れたが、**それを
    // 「無いこと」として固定はしない**——後で戻すのは正しい変更でありうるので、
    // 検査が反対しては困る。**本当の危険は片方だけ動くこと**で、
    // そうなると読者は言語によって違う立ち位置の文書を読む。
    //
    // **アプリ内の導線（`donateView.js`）は別で、そちらは上流を自分より先に置いている**
    // （`D-20260820-03`）。README から外れてもその決定は崩れない。
    const en = await readFile(join(ROOT, 'README.md'), 'utf8');
    const ja = await readFile(join(ROOT, 'README.ja.md'), 'utf8');
    assert.equal(UPSTREAM_FUNDING.test(en), UPSTREAM_FUNDING.test(ja),
        '上流の支援導線が片方の README にしか無い（言語で立ち位置が変わる）');
    // **自分の口は両方に在る。** 上の検査が「ko-fi という語」で通っていないことの裏取り。
    for (const [name, text] of [['README.md', en], ['README.ja.md', ja]]) {
        assert.ok(text.includes('ko-fi.com/syugoji'), name + ': 自分の支援導線が無い');
    }
});

test('両方の README が、同じ見出し構成になっている', async () => {
    // **片方だけ節を消すと、言語によって読める内容が変わる。**
    // 2026-08-25 に実際、英語版だけ「やらないこと」の名指しが残った。
    // 見出しの**個数**で見る（文言は言語で違うので中身では比べられない）。
    const en = await readFile(join(ROOT, 'README.md'), 'utf8');
    const ja = await readFile(join(ROOT, 'README.ja.md'), 'utf8');
    const heads = (t) => t.split(/\r?\n/).filter(l => /^##\s/.test(l)).length;
    assert.equal(heads(en), heads(ja),
        `見出しの数が違う（en=${heads(en)} / ja=${heads(ja)}）＝片方だけ節が増減している`);
});

test('両方の README が互いを指している（片方しか無い状態に落ちない）', async () => {
    // 英語だけ更新して日本語を消す／逆をやると、**片方の読者に届かない**。
    // 相互リンクを要求しておけば、消したときにここが赤くなる。
    const en = await readFile(join(ROOT, 'README.md'), 'utf8');
    const ja = await readFile(join(ROOT, 'README.ja.md'), 'utf8');
    assert.ok(en.includes('README.ja.md'), 'README.md が日本語版を指していない');
    assert.ok(ja.includes('README.md'), 'README.ja.md が英語版を指していない');
});

test('外向きの語彙が3層で統一されている（recipe を見出しに使わない）', async () => {
    // 決定④。`recipe` は上流の語彙（上流 4,686回 対 本人 510回）なので、
    // 外向きの主語に使うと「同じ機能」に見える＝要件①に反する。
    // **内部識別子の `recipe` は変えない。** ここで見るのは利用者が読む文だけ。
    for (const { file } of READMES) {
        const readme = await readFile(join(ROOT, file), 'utf8');
        for (const term of ['Generation Record', 'Replay Manifest', 'Sweep']) {
            assert.ok(readme.includes(term), file + ': 外向きの語 ' + term + ' が無い');
        }
        const headings = readme.split(/\r?\n/).filter(line => /^#{1,6}\s/.test(line));
        const offending = headings.filter(line => /\brecipes?\b/i.test(line));
        assert.deepEqual(offending, [], file + ': 見出しに recipe を外向きの語として使っている');
    }
});

/**
 * **書き込みの語。** Python でファイルへ書く言い方を素直に並べる。
 * 完璧ではない（`getattr` で組み立てれば抜ける）が、抜けるのは**見落とす側**で、
 * 「書いていないのに赤くなる」方向へは倒れない。
 */
const PY_WRITE_SOURCE = String.raw`\.write_text\(|\bjson\.dump\(|\.open\(\s*["']\s*[wax]|\bopen\(\s*[^)]*["']\s*[wax]|\.write\(|\bos\.replace\(|\bshutil\.(?:copy|move)`;

test('`*.recipe.json` を知っているコードが、1行も書き込みを持たない', async () => {
    // **書いた瞬間に Unbake はレシピ編集器になる。** そうなると、稼働中の
    // LoRA Manager と同じ実ファイルを取り合うことになり、**どちらが正かを
    // 実行時に決める**羽目になる（フォルダが正、という決めごとが壊れる）。
    //
    // 禁止を文章で書いても下流の機械は読まないので、**レシピのパスを知っている
    // ファイル**という条件で機械的に囲う。パスを知らないコードは、書こうにも
    // 書く先を組み立てられない。
    const write = new RegExp(PY_WRITE_SOURCE);
    const offenders = [];
    let awareCount = 0;
    for (const file of await pyFiles()) {
        const text = await readFile(file, 'utf8');
        // **散文を先に落とす。** docstring でレシピの話をしているだけの
        // ファイルが2件（`json_io.py` / `resource_availability_service.py`）
        // 引っ掛かった——**引用したデータを自分の検査へ入れない。**
        const code = text.replace(/^\s*#.*$/gm, ' ').replace(/"""[\s\S]*?"""/g, ' ');
        if (!code.includes('RECIPE_SUFFIX') && !code.includes('.recipe.json')) continue;
        awareCount += 1;
        if (write.test(code)) offenders.push(rel(file));
    }
    assert.deepEqual(offenders, [],
        'レシピのパスを知っているファイルに書き込みがある（レシピ編集器になる）');
    // **囲いが空でないこと。** 0ファイルなら、この検査は何も見ていない。
    assert.ok(awareCount > 0, 'レシピのパスを知っているファイルが1つも見つからない');
});

test('ディスクを変える HTTP の口が、宣言した一覧と完全に一致する', async () => {
    // **元は「記録を書き換える口は1つも無い」だった。** 2026-08-21 に決定が変わり、
    // 取り込んだ記録を残す口と、記録・モデルを消す口が要ることになった
    // （取り込んだ分が再読み込みで消えていた＝`I-20260821-03`／ユーザー指示）。
    //
    // **緩めたのではなく、守る対象を絞り直した。** 口の有無で守れなくなったので、
    // 下の3つを個別に固定する:
    //   1. ディスクを変える口の**一覧が宣言と一致する**（気づかないうちに増えない）
    //   2. Unbake が**書く**のは `.unbake.json` だけ（`.recipe.json` は書かない）
    //   3. 消す側は**索引が知るパス**と**置き場の中**の両方を確かめてから消す
    const routes = await readFile(join(ROOT, 'unbake/routes.py'), 'utf8');
    const posts = [...routes.matchAll(/@routes\.(post|put|patch|delete)\("([^"]+)"\)/g)]
        .map(m => `${m[1].toUpperCase()} ${m[2]}`);
    assert.deepEqual(posts.sort(), [
        'POST /unbake/download',
        'POST /unbake/download-cancel',
    // **伴走（テキストエンコーダ・VAE）を落とす。** 受けるのは系統名だけで、
    // 置き場は目録の `folder` から ComfyUI が決める（呼び手はパスを指せない）。
    'POST /unbake/download-model-companions',
        // **モデルを消す**（2026-08-21 ユーザー決定・ゴミ箱へは送らず完全に消す）。
        'POST /unbake/model-delete',
        // 見本を取りに行く口（2026-08-21）。**models フォルダへは書かない**
        // ——置き場は ComfyUI の user ディレクトリの下で、上流の落とした見本と
        // ぶつからない（`model_previews.cache_dir()`）。下でそれも確かめる。
        'POST /unbake/model-preview',
        // **出た絵を消す**（2026-08-25 利用者の指示）。取り消しは面が猶予で持つ
        // ——ここへ着いた時点では戻せないので、置き場の外は必ず断る（下で確かめる）。
        'POST /unbake/output-delete',
        // 記録を残す・消す（`I-20260821-03`）。
        'POST /unbake/record-delete',
        'POST /unbake/record-save',
        'POST /unbake/settings',
    ], `想定していない書き込みの口がある: ${posts.join(' / ')}`);
    // **出た絵を消す口が、置き場の外を断ること。** 断らないと、
    // 「出た絵を消す」口がライブラリを消す口になる。
    const outputs = await readFile(join(ROOT, 'unbake/outputs.py'), 'utf8');
    assert.match(outputs, /def delete_output\(/, '出た絵を消す関数が無い');
    assert.match(outputs, /outside the output directory/, '置き場の外を断っていない');
    assert.match(outputs, /os\.path\.realpath\(target\)/,
        '正規化した後で確かめていない（`a\/..\/..` を通す）');
    assert.match(outputs, /filename must not contain a path/,
        '名前に区切りを混ぜられる（判定より先に置き場を抜ける）');

    // **見本の書き先が models フォルダの外であること。** ここが崩れると、
    // 上流のダウンロードと同じ場所を2つの実装が書くことになる。
    const previews = await readFile(join(ROOT, 'unbake/model_previews.py'), 'utf8');
    assert.match(previews, /Path\(base\) \/ "unbake" \/ "model-previews"/,
        '見本の置き場が user ディレクトリの下でない');
    assert.doesNotMatch(previews, /folder_paths\.get_full_path/,
        '見本の側からモデルの場所を組み立てている（書き先が models へ寄る）');
    // **本題1: 書く先の拡張子。** Unbake が新しく書くのは自分の拡張子だけで、
    // `.recipe.json` は1バイトも書かない——書いた瞬間にレシピ編集器になり、
    // 稼働中の LoRA Manager と実ファイルを取り合う（この決定は変わっていない）。
    const records = await readFile(join(ROOT, 'unbake/records.py'), 'utf8');
    assert.match(records, /f"\{record_id\}\{UNBAKE_SUFFIX\}"/,
        '保存の書き先が `.unbake.json` で組まれていない');
    const recordsCode = stripComments(records).replace(/"{3}[\s\S]*?"{3}/g, ' ');
    assert.doesNotMatch(recordsCode, /RECIPE_SUFFIX|\.recipe\.json/,
        '保存・削除のコードが `.recipe.json` を名指しで組み立てている');

    // **本題2: 消す前の確認。** 索引の行から辿り、置き場の中に在ることを
    // 実際のパスで確かめてからでないと消さない。どちらか一方でも欠けると、
    // 画面から置き場の外を消せる口になる（改造版 LoRA Manager の削除は
    // パスの検証が無く、`..` で外へ出られる。**ここは意図的に違える**）。
    for (const [needle, why] of [
        ['raw_row(', '索引の行から辿っていない（画面のパスを信じている）'],
        ['_inside(', '置き場の中に在ることを確かめていない'],
        ['commonpath', '実際のパスで比べていない（文字列の前方一致はリンクで抜ける）'],
    ]) {
        assert.ok(records.includes(needle), `records.py: ${why}`);
    }
    const models = await readFile(join(ROOT, 'unbake/models.py'), 'utf8');
    for (const [needle, why] of [
        ['_inside(', '置き場の中に在ることを確かめていない'],
        ['commonpath', '実際のパスで比べていない'],
        ['"many"', '名前が2つに当たったときの分岐が無い（実データに1件ある）'],
    ]) {
        assert.ok(models.includes(needle), `models.py: ${why}`);
    }
    // **モデルを消す口はパスを受け取らない。** 受け取るのは種別と名前だけ
    // ——`?path=` を作らなかったのと同じ理由で、渡さない方が確実。
    const deleteRoute = routes.slice(routes.indexOf('_post_model_delete'));
    assert.doesNotMatch(deleteRoute.slice(0, 900), /get\("path"\)|\bpayload\.get\("path"\)/,
        'モデル削除の口がパスを受け取っている');
});


test('検査自体が発火することを確かめる（沈黙する検査を置かない）', () => {
    // 上の検査はすべて「見つからなければ緑」になる形。**発火しない検査は無いのと同じ**なので、
    // 同じ判定式が、わざと壊した入力で赤になることをここで示す。
    const globalFetch = new RegExp(GLOBAL_FETCH_SOURCE);
    assert.equal(globalFetch.test('const r = await fetch(url);'), true);
    assert.equal(globalFetch.test('const r = await doFetch(url);'), false);
    assert.equal(globalFetch.test('fetchResourceAvailability(items)'), false);
    assert.equal(globalFetch.test('env.fetch(url)'), false);

    const outsideSpec = 'comfyui-lora-manager/static/js/utils/genParamsMapper.js';
    assert.equal(/^\.{1,2}\/[A-Za-z0-9_./-]+\.(?:js|mjs)$/.test(outsideSpec), false);

    assert.equal(stripComments('// fetch(x)\nconst a = 1;').includes('fetch'), false);

    // 書き込みの検出器。**書いている形で赤、読んでいる形で緑**になること。
    const write = new RegExp(PY_WRITE_SOURCE);
    assert.equal(write.test('path.write_text(payload)'), true);
    assert.equal(write.test('with temp.open("w", encoding="utf-8") as s:'), true);
    assert.equal(write.test('json.dump(payload, stream)'), true);
    assert.equal(write.test('os.replace(temp, self._path)'), true);
    assert.equal(write.test('data = json.loads(path.read_text(encoding="utf-8"))'), false);
    assert.equal(write.test('canonical = json.dumps(manifest, sort_keys=True)'), false);
    assert.equal(write.test('entries = sorted(os.scandir(root))'), false);
});

/**
 * **子プロセスの起動先は同梱物1点だけ。**
 *
 * v0.1.0 が Comfy Registry で `Flagged` になった（2026-08-25）。理由は通知されなかったが、
 * 実測でコード側に見つかったのは**設定から来た任意のパスを Python として実行する分岐**で、
 * `settings.py` の既知キーに無く UI からも触れない**到達不能な分岐**だった。
 * **走査器はコードを読むのであって到達可能性を見ない。** 消したうえで、戻らないよう見張る。
 *
 * あわせて**同梱されていること自体**も見る——以前の既定パスは `..` で
 * パッケージの外を指しており、**Registry から入れた人はこの機能を一度も使えなかった**。
 * 「配線が正しい」と「配布物に入っている」は別で、前者だけ見ていると後者が抜ける。
 */
test('同期スクリプトは同梱されており、起動先を外から差し替えられない', async () => {
    const rel = join('civitai_recipe_sync', 'civitai_image_download.py');
    const script = await readFile(join(ROOT, rel), 'utf8');
    assert.ok(script.length > 10000, rel + ' が同梱されていない（または中身が空）');

    const service = await readFile(join(ROOT, 'unbake', 'services', 'raindrop_sync_service.py'), 'utf8');

    // ① 既定パスが `..` でパッケージの外へ出ない
    const decl = /DEFAULT_SCRIPT_RELATIVE_PATH\s*=\s*\(([^)]*)\)/.exec(service);
    assert.ok(decl, 'DEFAULT_SCRIPT_RELATIVE_PATH の宣言が読めない');
    assert.ok(!decl[1].includes('..'),
        '起動先がパッケージの外を指している（配布物に入らないので誰も使えない）');

    // ② 設定からパスを受ける口が無い
    assert.ok(!service.includes('raindrop_sync_script_path'),
        '設定から実行パスを受ける口が戻っている（任意のファイルを Python として実行できる）');

    // ③ 起動しているのは「同梱物を指す変数」だけ。生のパス文字列を渡していない。
    for (const m of service.matchAll(/create_subprocess_exec\(\s*([^)]*?)\)/gs)) {
        assert.ok(/self\._python/.test(m[1]),
            'create_subprocess_exec が self._python 以外を起動している');
        assert.ok(/script_path/.test(m[1]),
            'create_subprocess_exec が script_path 以外を実行している');
    }
});

test('同梱した同期スクリプトの出所が NOTICE に書いてある', async () => {
    // **同梱物が増えたら NOTICE も増える。** MIT を GPL-3.0 の配布物へ入れるのは
    // 適合するが、**適合することと表示しなくてよいことは別**。
    // **ファイル名ではなくディレクトリ名で見る。** NOTICE 自身が
    // 「ファイル一覧を散文へ書かない（1つ足した瞬間に陳腐化する）」と宣言しているので、
    // 名指しを要求すると**この文書の方針と喧嘩する**検査になる。
    // 見たいのは「別ライセンスの同梱物が在ることが書いてあるか」であって、
    // 中身が何ファイルかではない。
    const notice = await readFile(join(ROOT, 'NOTICE'), 'utf8');
    assert.match(notice, /civitai_recipe_sync/,
        'NOTICE が同梱の civitai_recipe_sync/ に触れていない');
    assert.match(notice, /\bMIT\b/, 'NOTICE が同梱物のライセンス（MIT）に触れていない');
    const license = await readFile(join(ROOT, 'civitai_recipe_sync', 'LICENSE'), 'utf8');
    assert.match(license, /MIT License/, '同梱スクリプトの LICENSE が MIT の正文でない');
});

test('子プロセスを起こさない（同期は同一プロセスで動く）', async () => {
    // **これは 2026-08-25 に手で消した性質なので、戻ったら赤くなるべきである。**
    //
    // Comfy Registry の自動走査が v0.1.0 と v0.1.1 を `Flagged` にした。理由は
    // 通知されなかったが、0.1.1 で「設定から来た任意のパスを実行する」分岐を
    // 消しても結果が変わらなかったので、**子プロセスを起こすこと自体**が
    // 引っかかっていると判断して `sync_script_runner.py` へ作り替えた。
    //
    // **`subprocess` を標準ライブラリ一覧から外す形では守れない。** あれは
    // 「標準ライブラリかどうか」の判定で、使ってよいかとは別の話だから。
    const offenders = [];
    for (const f of await pyFiles()) {
        const text = await readFile(f, 'utf8');
        // 散文で経緯を説明している箇所（まさにこのファイルの上の方）で誤検出しないよう、
        // **コメントと docstring を落としてから**見る。
        const code = text
            .replace(/^\s*#.*$/gm, ' ')
            .replace(/"""[\s\S]*?"""/g, ' ')
            .replace(/'''[\s\S]*?'''/g, ' ');
        for (const pat of [/\bcreate_subprocess_exec\b/, /\bcreate_subprocess_shell\b/,
                           /\bsubprocess\.(?:run|Popen|call|check_output|check_call)\b/,
                           /\bos\.(?:system|popen|exec[lv]p?e?)\b/]) {
            if (pat.test(code)) offenders.push(rel(f) + ': ' + pat.source);
        }
    }
    assert.deepEqual(offenders, [], '子プロセスを起こす経路が戻っている');
});

test('同期は同梱スクリプトを「差し替えたうえで」呼ぶ', async () => {
    // 素朴に `main()` を呼ぶだけだと **`apply_cli_flags()` が一度も走らない**
    // （スクリプト側でそれを呼ぶのは `if __name__ == "__main__":` の中だけ）。
    // 走らないと **Civitai ToS §11.9 の分岐**——無人実行時に不足 LoRA の
    // 自動ダウンロードを止める処理——が発火しない。**しかも無言で。**
    const runner = await readFile(
        join(ROOT, 'unbake', 'services', 'sync_script_runner.py'), 'utf8');
    for (const needed of ['apply_cli_flags', 'emit_event', 'module.print', '--unattended']) {
        assert.ok(runner.includes(needed), 'sync_script_runner.py が ' + needed + ' を扱っていない');
    }
    // **`sys.stdout` を差し替えない。** 差し替えると ComfyUI の他のスレッドの
    // 出力まで巻き込む。モジュール大域の `print` を置くのが正しい。
    assert.ok(!/sys\.stdout\s*=/.test(runner),
        'sys.stdout を差し替えている（他のスレッドの出力まで奪う）');
});

test('README に書いた判定名が、画面のカタログと一致する', async () => {
    // **2026-08-25 に利用者が見つけた食い違い。** README は
    // 「そのまま再現できる／近似になる（理由つき）／足りない」の**3つ**を挙げていたが、
    // 画面に出るのは **5つ**で、しかも**どの語も一致していなかった**
    // （実物は「再現性 高／再現性 中／再現不可／落とせば試せる／未確認」）。
    //
    // **読者は画面で同じ文字列を探す。** 説明と画面が違うと、探して見つからない。
    // 散文の側だけを直しても、次にカタログを変えた日に同じ状態へ戻るので、
    // **カタログを出典にして機械で照合する**。
    const keys = ['reproducible', 'approximate', 'blocked', 'downloadable', 'pending'];
    const pairs = [['README.ja.md', 'ja'], ['README.md', 'en']];
    for (const [file, locale] of pairs) {
        const catalogue = await readFile(join(ROOT, 'web', 'i18n', 'locales', `${locale}.js`), 'utf8');
        const readme = await readFile(join(ROOT, file), 'utf8');
        const missing = [];
        for (const key of keys) {
            // **`String.raw` で書く。** 素のテンプレートリテラルだと `\.` が `.` へ、
            // `\s` が `s` へ潰れて、**正規表現が黙って別物になる**（一度そうなった）。
            const m = new RegExp(String.raw`"verdict\.${key}\.short":\s*"([^"]+)"`).exec(catalogue);
            assert.ok(m, `${locale}.js に verdict.${key}.short が無い`);
            if (!readme.includes(m[1])) missing.push(`${key}="${m[1]}"`);
        }
        assert.deepEqual(missing, [],
            `${file} が画面に出る判定名を載せていない（読者が画面で探して見つからない）`);
    }
});

test('README に利用者の手元でしか意味を持たない数値を書かない', async () => {
    // **2026-08-25 に利用者が指摘。** 「346件」は書き手のレシピ本数で、
    // 読者の環境とは何の関係も無い。**測ったこと自体は正しくても、
    // 読む人にとっては意味のない数字**なので、一般的な主張の側だけを残した。
    //
    // 実測値そのものは捨てていない——`_Planning` の決定文書と `tests/` が持っている。
    // ここで禁じるのは**着地ページに置くこと**だけ。
    const banned = [/\b346\b/, /13,251/, /\b508\b/, /\b317\b/];
    for (const file of ['README.md', 'README.ja.md']) {
        const readme = await readFile(join(ROOT, file), 'utf8');
        const hits = banned.filter(re => re.test(readme)).map(re => re.source);
        assert.deepEqual(hits, [], `${file} に書き手の環境の数値が残っている: ${hits.join(', ')}`);
    }
});

test('落とし込みの出口が、records を必ず toRecipeShape へ通している', async () => {
    // **配線そのものを見る。** `toRecipeShape()` の中身を検査しても、
    // `ingest()` がそれを呼ばなくなったことは捕まらない——実際、変異検査で
    // 「出口で揃えるのをやめる」が素通りしたので、この検査を足した。
    //
    // 押し込み口は6箇所ある。個々を見張ると増えたときに漏れるので、
    // **出口が1本であること**と**そこを通していること**の2つで見る。
    const source = await readFile(join(ROOT, 'web', 'unbake.js'), 'utf8');

    const wrapper = /export async function ingest\(routed\)\s*\{([\s\S]*?)\n\}/.exec(source);
    assert.ok(wrapper, 'export された ingest() が読めない');
    assert.match(wrapper[1], /toRecipeShape\(/,
        'ingest() が records を toRecipeShape へ通していない（記録の形がそのまま下流へ流れる）');

    // **中の実装が直接 export されていないこと。** されていると、
    // 揃える工程を飛ばして呼べる口ができる。
    assert.ok(!/export\s+(async\s+)?function\s+ingestRouted/.test(source),
        'ingestRouted が export されている（揃えずに呼べる口になる）');
});

test('Raindrop の取り込みと、URL の落とし込みが同じ経路を通る', async () => {
    // **取り込み器を2本持たない。** 2本あると、`.red` の扱いのような決めごとが
    // 片方にだけ残って静かに食い違う（出典の 326/340 が `.red` なので実害が出る）。
    //
    // docstring は「同じ `routed` を作って渡すだけ」と宣言しているが、
    // **宣言は壊れても赤くならない**ので、構造で固定する。
    const panel = await readFile(join(ROOT, 'web', 'panel', 'panel.js'), 'utf8');

    // Raindrop 側が独自に取得・組み立てをしていないこと。
    const importOne = /importOne:\s*\(target\)\s*=>\s*([A-Za-z_$][\w$]*)\(/.exec(panel);
    assert.ok(importOne, 'Raindrop の importOne が読めない');
    assert.equal(importOne[1], 'ingestRouted',
        'Raindrop が落とし込みとは別の関数で取り込んでいる');

    // 落とし込み側も同じ関数を通ること。
    assert.match(panel, /await\s+ingestRouted\(routed\)/,
        '落とし込みが ingestRouted を通っていない');

    // その関数が `ingest()` を1本だけ呼ぶこと。
    const body = /async function ingestRouted\(routed\)\s*\{([\s\S]*?)\n    \}/.exec(panel);
    assert.ok(body, 'panel の ingestRouted が読めない');
    assert.match(body[1], /await ingest\(routed\)/, 'ingest() を通していない');

    // **Raindrop の面が、自前で取得や組み立てをしていないこと。**
    const raindrop = await readFile(join(ROOT, 'web', 'panel', 'raindropView.js'), 'utf8');
    for (const forbidden of ['fetchCivitaiImage', 'recipeFromCivitaiMeta', 'recordFromCivitaiImage']) {
        assert.ok(!raindrop.includes(forbidden),
            `raindropView が ${forbidden} を自前で呼んでいる（取り込み器が2本になる）`);
    }
});

test('版IDの引き直しは、捕捉した絵にも当たる', async () => {
    // **2026-08-25 利用者の報告。** 「不足モデルのダウンロードができない」。
    // 原因は B（`attachLookedUpVersions`）を **recipe 経路にしか繋いでいなかった**こと。
    // グラフを持つ絵（実測14%）は捕捉経路を通るので、**取得先が判らないまま**だった
    // ——版IDが無いと `downloadable` に分類されず、落とす導線が出ない。
    //
    // **経路が2本ある以上、両方を見る。** 片方だけ直しても、次に片方が増えたら同じ穴が開く。
    const source = await readFile(join(ROOT, 'web', 'unbake.js'), 'utf8');
    const branch = /if \(captured\.ok\) \{([\s\S]*?)\n        \}/.exec(source);
    assert.ok(branch, '捕捉できたときの分岐が読めない');
    assert.match(branch[1], /attachLookedUpVersions\(/,
        '捕捉経路で版IDを引いていない（落とす導線が出ない）');
    // **形を揃えてから引く。** 捕捉直後の checkpoint はただの文字列で、
    // 資源の形になっていないと引く相手が読めない。
    assert.match(branch[1], /toRecipeShape\(/,
        '形を揃える前に引こうとしている');
    const shapeAt = branch[1].indexOf('toRecipeShape(');
    const lookAt = branch[1].indexOf('attachLookedUpVersions(');
    assert.ok(shapeAt < lookAt, '引いてから揃えている（順序が逆）');
});

test('取得は並列だが、本数に上限がある', async () => {
    // **上限が要る。** 無制限に開くと、こちらの回線も相手の側も痛める。
    // 上流（改造版 LoRA Manager）も semaphore で抑えている。
    const panel = await readFile(join(ROOT, 'web', 'panel', 'panel.js'), 'utf8');
    assert.match(panel, /Array\.from\(\{ length: Math\.min\(3, wanted\.length\) \}/,
        '走者の数に上限が無い（または並列になっていない）');

    // **並列では `break` が使えない。** 自分より後ろは既に走っている。
    // 中断は「新しく始めない」で表す。
    const runOne = /const runOne = async \(item, index\) => \{([\s\S]*?)\n            \};/.exec(panel);
    assert.ok(runOne, '取得1本ぶんの関数が読めない');
    assert.ok(!/\n\s+break;/.test(runOne[1]),
        '並列の中で break を使っている（後ろが走ったまま止まったことになる）');
    assert.match(runOne[1], /if \(downloadCanceled\) return;/,
        '中断を見ていない');

    // サーバ側にも同じ上限が在ること。**片方だけ増やすと、拒まれ続ける。**
    const routes = await readFile(join(ROOT, 'unbake', 'routes.py'), 'utf8');
    assert.match(routes, /MAX_PARALLEL_DOWNLOADS\s*=\s*3/,
        'サーバ側の上限が3でない（画面側と食い違う）');
    assert.match(routes, /this version is already downloading/,
        '同じ版を2本走らせない守りが無い（同じ .part を2つが書く）');
});
