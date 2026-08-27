/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 工程0.5 — **後の工程が踏む地雷を、踏んだら赤くなる形で置き直す。**
 *
 * どれも「壊れていても普通に動く」種類の瑕疵で、だから今まで残っていた。
 * 1件につき1つ、**その瑕疵が戻ったときにだけ落ちる**検査を置く。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkpointNameOf, normalizeRunListEntry } from '../web/core/recipeRunList.js';
import { loadLibrary } from '../web/unbake.js';
import { installComfyHost } from '../web/host/comfyHost.js';
import { setLocale } from '../web/i18n/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => relative(ROOT, p).split(sep).join('/');

async function filesUnder(dir, extension, out = []) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await filesUnder(path, extension, out);
        else if (path.endsWith(extension)) out.push(path);
    }
    return out;
}

// --- 瑕疵2: 1ページを超えると無言で打ち切る -------------------------------

test('記録が口の1ページを超えても、黙って切らずに全部読む', async () => {
    setLocale('en');
    const TOTAL = 1234;
    const calls = [];
    const rows = Array.from({ length: TOTAL }, (_, i) => ({ id: `r${i}`, title: `R${i}` }));
    installComfyHost({
        request: async (url) => {
            calls.push(url);
            const query = new URL(url, 'http://x').searchParams;
            const offset = Number(query.get('offset') || 0);
            const limit = Number(query.get('limit') || 200);
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    records: rows.slice(offset, offset + limit),
                    total: TOTAL, offset, errors: [], sourceDirs: ['/x'], outputDir: '',
                }),
            };
        },
        storage: null,
    });

    const { records, messages } = await loadLibrary();
    // 元は1回だけ取って、返ってきた分をそのまま全件として扱っていた。
    assert.equal(records.length, TOTAL, `${TOTAL}件のうち ${records.length}件しか読めていない`);
    assert.ok(calls.length > 1, 'ページ送りが1回で終わっている（上限を超えられていない）');
    assert.deepEqual(messages, [], '全部読めたのに警告が出ている');
});

test('走査し直すのは1周目だけ（途中で索引を作り直さない）', async () => {
    // **書いた直後の記録は、走査し直さないと索引に無い。** だから読み直しでは
    // 頼む——が、**ページを繰るたびに頼むと索引が作り直される**。並びがずれて、
    // 同じ記録を2度読む／1度も読まない。
    setLocale('en');
    const TOTAL = 1200;
    const rescans = [];
    installComfyHost({
        request: async (url) => {
            const query = new URL(url, 'http://x').searchParams;
            const offset = Number(query.get('offset') || 0);
            const limit = Number(query.get('limit') || 200);
            rescans.push(query.get('rescan') === '1');
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    records: Array.from({ length: Math.max(0, Math.min(limit, TOTAL - offset)) },
                        (_, i) => ({ id: `r${offset + i}`, title: 'R' })),
                    total: TOTAL,
                    sourceDirs: [],
                }),
            };
        },
        storage: null,
    });

    await loadLibrary({ rescan: true });
    assert.ok(rescans.length > 1, 'ページ送りが1回で終わっていて、この検査が何も見ていない');
    assert.equal(rescans[0], true, '1周目で走査し直していない（書いた記録が索引に無いまま）');
    assert.deepEqual(rescans.slice(1), rescans.slice(1).map(() => false),
        '2周目以降も走査し直している（索引が作り直されて並びがずれる）');

    // 頼まなければ、1周目でも走査し直さない。
    rescans.length = 0;
    await loadLibrary();
    assert.deepEqual(rescans, rescans.map(() => false), '頼んでいないのに走査し直している');
});

test('設定は読み込み指定として渡らない（`null` でも落ちない）', async () => {
    // `ensureSettings().then(loadLibrary)` と書いていたので、**解決した設定が
    // そのまま第1引数**として渡っていた。引数を1つも取らない間は無害だが、
    // 受ける形を足した途端に「設定を読み込み指定として読む」経路になる。
    setLocale('en');
    installComfyHost({
        request: async () => ({
            ok: true, status: 200,
            json: async () => ({ records: [{ id: 'a', title: 'A' }], total: 1, sourceDirs: ['/x'] }),
        }),
        storage: null,
    });
    const { records } = await loadLibrary(null);
    assert.equal(records.length, 1, '`null` を渡されて落ちている');
});

test('本当に足りないときは、足りないと言う（黙って縮まない）', async () => {
    setLocale('en');
    installComfyHost({
        // 口が進まない（同じ10件を返し続ける）状況を作る。
        request: async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                records: Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, title: 'X' })),
                total: 999, offset: 0, errors: [], sourceDirs: ['/x'], outputDir: '',
            }),
        }),
        storage: null,
    });
    const { records, messages } = await loadLibrary();
    assert.ok(records.length < 999);
    assert.ok(messages.some(m => m.includes('999')),
        `足りないことが出ていない: ${JSON.stringify(messages)}`);
    assert.ok(messages.every(m => !/^\[.*\]$/.test(m)), '未訳の鍵がそのまま出ている');
});

// --- 瑕疵3: 読み手0件の死んだ設定欄 ---------------------------------------

test('設定に、誰も読まない項目が無い', async () => {
    const settings = await readFile(join(ROOT, 'unbake/settings.py'), 'utf8');
    const keys = [...settings.matchAll(/^\s*"([a-z_]+)":\s/gm)].map(m => m[1]);
    assert.ok(keys.length >= 4, `設定の鍵を拾えていない（${keys.length}件）＝走査が壊れている`);

    const sources = [
        ...await filesUnder(join(ROOT, 'web'), '.js'),
        ...(await filesUnder(join(ROOT, 'unbake'), '.py')),
    ].filter(f => !f.includes('__pycache__') && !f.endsWith(`settings.py`));
    const bodies = await Promise.all(sources.map(f => readFile(f, 'utf8')));

    // **語として照合する。** 部分一致だと `json.dumps(sort_keys=True)` が
    // `sort_key` の読み手に見えて、死んだ設定欄が黙って通る（実際に通っていた）。
    const dead = keys.filter((key) => {
        const word = new RegExp(`(?<![A-Za-z0-9_])${key}(?![A-Za-z0-9_])`);
        return !bodies.some(body => word.test(body));
    });
    assert.deepEqual(dead, [],
        `設定できるのに誰も読まない項目がある（設定した人は効いたと思う）: ${dead.join(', ')}`);

    // **語境界の照合が効いていること。** `sort_keys` を `sort_key` の
    // 読み手と数えてしまうと、この検査は死んだ欄を見逃す。
    const word = new RegExp('(?<![A-Za-z0-9_])sort_key(?![A-Za-z0-9_])');
    assert.equal(word.test('json.dumps(payload, sort_keys=True)'), false);
    assert.equal(word.test('settings.get("sort_key")'), true);
});

// --- 瑕疵4: NOTICE と同梱台帳の矛盾 ---------------------------------------

test('NOTICE が、同梱している台帳を実物どおりに書いている', async () => {
    const catalog = await readFile(join(ROOT, 'unbake/services/known_model_catalog.py'), 'utf8');
    const bundled = (catalog.match(/^\s*filename=/gm) || []).length;
    assert.ok(bundled > 0, '同梱台帳の件数を拾えていない＝走査が壊れている');

    const notice = await readFile(join(ROOT, 'NOTICE'), 'utf8');
    // 「台帳は同梱しない」と書かない。実物が同梱している。
    assert.doesNotMatch(notice, /No model catalogue[\s\S]{0,60}included/,
        'NOTICE が「台帳は同梱しない」と書いているが、実物は同梱している');
    assert.ok(notice.includes(String(bundled)),
        `NOTICE に同梱件数 ${bundled} が書かれていない`);
    assert.ok(notice.includes('known_model_catalog.py'),
        'NOTICE が同梱台帳のファイル名を名指ししていない');
});

// --- 瑕疵5: README の事実誤り（extra_pnginfo） -----------------------------

test('extra_pnginfo に何を入れているかの記述が、実装と一致している', async () => {
    const sweep = await readFile(join(ROOT, 'web/core/sweepRunner.js'), 'utf8');
    const trial = await readFile(join(ROOT, 'web/core/recipeTrialRunner.js'), 'utf8');
    // 実装が入れているのは印だけ。グラフは1つも入れていない。
    const payloads = [...`${sweep}\n${trial}`.matchAll(/extra_pnginfo:\s*\{([^}]*)\}/g)]
        .map(m => m[1].trim());
    assert.ok(payloads.length >= 2, `実装側を拾えていない（${payloads.length}件）`);
    for (const payload of payloads) {
        assert.doesNotMatch(payload, /prompt|workflow|graph/,
            `extra_pnginfo にグラフを入れている: ${payload}`);
    }

    // 文書が「グラフも extra_pnginfo に焼かれる」と書いていないこと。
    for (const name of ['README.md', 'web/unbake.js']) {
        const text = await readFile(join(ROOT, name), 'utf8');
        for (const line of text.split(/\r?\n/)) {
            if (!line.includes('extra_pnginfo')) continue;
            assert.doesNotMatch(line, /実行したグラフと/,
                `${name} が「extra_pnginfo に実行したグラフが焼かれる」と書いている: ${line.trim()}`);
        }
    }
});

test('口の一覧を書いた表が、実際に登録する経路と食い違わない', async () => {
    // **文書と実物のずれは、このパッケージで何度も起きている**
    // （NOTICE の台帳・README の `extra_pnginfo`）。表を足したら検査も足す。
    const routes = await readFile(join(ROOT, 'unbake/routes.py'), 'utf8');
    const declared = [...routes.matchAll(/^\s*"(\/unbake\/[a-z-]+)",$/gm)].map(m => m[1]);
    assert.ok(declared.length >= 5, `registered_paths() を拾えていない（${declared.length}）`);

    const documented = [...routes.matchAll(/``(?:GET|POST)\s+(\/unbake\/[a-z-]+)``/g)].map(m => m[1]);
    assert.ok(documented.length >= 5, `冒頭の表を拾えていない（${documented.length}）`);

    assert.deepEqual([...new Set(documented)].sort(), [...new Set(declared)].sort(),
        '冒頭の表と registered_paths() が食い違っている');
});

// --- 瑕疵6: 孤児モジュール -------------------------------------------------

/**
 * **入口から辿れないモジュール。** 配線されていないので、壊れていても
 * 誰も気づかない——実測で 7,857行がこの状態だった。
 *
 * ここは0にはできない（工程1〜6で順に配線していく）。**宣言と実物が
 * 一致することだけを固定する**ので、新しい孤児が生えたら赤くなり、
 * 配線したらこの表から1行消す（進みが表から読める）。
 */
const KNOWN_UNREACHED = [
    // **2026-08-22: 「振る」の面を畳んだ**（利用者の指示）。中身は詳細へ移した
    // ——seed の枚数・`{...}` の置換・語の追記・ステップ/CFG の刻み・LoRA の
    // 強度と差し替え・土台の差し替え・結果の格子と進捗と取消と取り込み。
    // **面そのものは消していない**ので、ここへ正直に載せる（消すかどうかは別の判断）。
    'web/core/experimentTypes.js',
    'web/panel/sweepView.js',
    'web/core/a1111LoraMerge.js',
    // `downloadSizeEstimate.js` は 2026-08-20 に配線した（落とす前に合計を出す）。
    // `modelCompanions.js` は 2026-08-26 に配線した——**口がフォークの
    // `/api/lm/…` を向いたままだった**ので、繋ぎ替えたうえで落とす流れへ入れた
    // （拡散モデルは本体だけでは動かないので、押す前の総量に伴走を足す）。
    'web/core/recipeCompositionScore.js',
    // `recipeLoraOverrides.js` は 2026-08-22 に配線した（詳細の帯のスライダー）。
    'web/core/recipeMetadata.js',
    'web/core/recipeMissingResources.js',
    'web/core/recipeNotes.js',
    'web/core/recipeOutputs.js',
    'web/core/recipeReferenceInfo.js',
    'web/core/recipeRunList.js',
    'web/core/recipeTrialRunner.js',
];

test('入口から辿れないモジュールが、宣言した表と完全に一致する', async () => {
    const all = (await filesUnder(join(ROOT, 'web'), '.js')).map(rel);
    assert.ok(all.length >= 40, `走査が壊れている（${all.length}件）`);

    const seen = new Set();
    // `from '…'` / `import('…')` / 副作用 import の3つを拾う。
    const SPEC = /from\s+'(\.[^']*)'|import\s*\(\s*'(\.[^']*)'\s*\)|import\s+'(\.[^']*)'/g;
    const follow = async (path) => {
        if (seen.has(path)) return;
        seen.add(path);
        const text = await readFile(join(ROOT, path), 'utf8');
        for (const match of text.matchAll(SPEC)) {
            const spec = match[1] || match[2] || match[3];
            const target = rel(resolve(dirname(join(ROOT, path)), spec));
            if (all.includes(target)) await follow(target);
        }
    };
    await follow('web/unbake.js');

    const unreached = all.filter(f => !seen.has(f)).sort();
    assert.deepEqual(unreached, [...KNOWN_UNREACHED].sort(),
        '孤児の一覧が宣言と食い違う（配線したなら表から消す・生えたなら繋ぐ）');

    // **翻訳カタログの孤児は0であること。** 同じ鍵を持つ写しが4つ在り
    // （`core.en.js` / `core.ja.js` / `en.js` / `ja.js`・計533行）、
    // どれも `locales/` の完全な重複だった（鍵152/152・44/44 が値まで一致）。
    // **写しは「検査が固定する」と自称していたが、その検査は存在しなかった。**
    assert.deepEqual(unreached.filter(f => f.startsWith('web/i18n/')), [],
        '翻訳カタログに孤児が在る（鍵の一致を測っているのは locales/ だけ）');
});

// --- 瑕疵7: 束の checkpoint 名が空になる -----------------------------------

test('checkpoint 名を、来た形に関係なく取り出す', () => {
    // 一覧が渡してくる記録は文字列（要約が名前へ潰している）。
    assert.equal(checkpointNameOf('ck.safetensors'), 'ck.safetensors');
    // レシピの本体はオブジェクト。
    assert.equal(checkpointNameOf({ file_name: 'ck.safetensors' }), 'ck.safetensors');
    assert.equal(checkpointNameOf(null), '');
    assert.equal(checkpointNameOf(undefined), '');
    assert.equal(checkpointNameOf({}), '');
});

test('checkpoint 名は表示名ではなくファイル名を採る', () => {
    // **実データ346件のうち326件が両方を持ち、322件で値が違う**（実測 2026-08-20）。
    // `name` は人が読む題（"The Araminta Experiment (SDXL+Flux)"）で、
    // `file_name` が実体（"theAramintaExperiment_cv5"）。表示名を採ると、
    // 要約（`file_name` を返す）と突き合わないので、束と一覧が別物になる。
    assert.equal(
        checkpointNameOf({
            name: 'The Araminta Experiment (SDXL+Flux)',
            file_name: 'theAramintaExperiment_cv5',
        }),
        'theAramintaExperiment_cv5',
    );
});

test('一覧から来た記録が、束の中で名前を失わない', () => {
    const entry = normalizeRunListEntry({ id: 'rec-1', title: 'T', checkpoint: 'ck.safetensors' });
    assert.equal(entry.checkpointName, 'ck.safetensors',
        '文字列の checkpoint が空文字に潰れている（束が全部名前無しで並ぶ）');
});
