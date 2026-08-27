/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 設定・書庫・HTTP の口を、実際に Python を起こして確かめる。
 *
 * ここで固定するのは、**壊れても赤くならず、壊れると取り返しがつかない**もの:
 *
 *  1. **秘密の値が HTTP へ出ない。** 出るようになっても機能は普通に動くので、
 *     漏れたことは誰も気づかない。
 *  2. **参照画像がパスで引けない。** ``?path=`` の口を1つ足すだけで、
 *     走査対象の外を読ませられる。
 *  3. **「設定されていない」と「空を設定した」を混ぜない。**
 *  4. **読めなかったフォルダを 0件 と混ぜない。**
 *  5. **補助の API がフォルダの値を上書きしない。**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** `-c` は使わない（Windows で引用符が落ち、検査ごと静かに skip される）。 */
function python(code) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'unbake-'));
    const file = path.join(dir, 'probe.py');
    writeFileSync(file, code, 'utf8');
    try {
        for (const exe of ['python', 'python3', 'py']) {
            const res = spawnSync(exe, [file], {
                cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 60_000,
                // **出力の文字コードを固定する。** Windows の既定（cp932）で
                // 受けると日本語の理由文が化け、`見つかりません` を探す検査が
                // 「理由が出ていない」として落ちる——**文字化けは情報の不在ではない**
                // のに、そう読めてしまう形で赤くなる。
                env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
            });
            if (res.error) continue;
            return res;
        }
        return null;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

const probe = python('print("ok")');
const havePython = Boolean(probe && probe.status === 0 && probe.stdout.includes('ok'));

/** 走査させる記録を並べた一時フォルダを作る。 */
function fixtureDir() {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'unbake-lib-'));
    const write = (name, body) => writeFileSync(path.join(dir, name), body, 'utf8');
    write('a.recipe.json', JSON.stringify({
        id: 'rec-a', title: 'A', base_model: 'SDXL',
        checkpoint: { file_name: 'ck.safetensors' },
        loras: [{ file_name: 'l1' }],
        gen_params: { seed: 7, prompt: 'a prompt' },
    }));
    write('a.webp', 'not really a webp but a real file');
    write('b.recipe.json', JSON.stringify({ id: 'rec-b', title: 'B', comfy_prompt: { 3: {} } }));
    write('broken.recipe.json', '{ not json');
    write('ignored.txt', 'x');
    return dir;
}

/** 中身のある最小の PNG を作る（幅×高さだけが要る）。 */
function tinyPng(width, height) {
    // `require` は使えない（ESM）。取り込みは上で済ませてある。
    const crcTable = [];
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
    }
    const crc = (buf) => {
        let c = 0xffffffff;
        for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const sum = Buffer.alloc(4);
        sum.writeUInt32BE(crc(body));
        return Buffer.concat([len, body, sum]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;    // bit depth
    ihdr[9] = 2;    // truecolour
    const raw = Buffer.alloc(height * (1 + width * 3));
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

const head = (dir, settingsFile) => [
    'import sys, json',
    'sys.path.insert(0, ".")',
    'from unbake.settings import FileSettings',
    'from unbake.library import RecordLibrary',
    `s = FileSettings(${JSON.stringify(settingsFile)})`,
    `s.update({"record_source_dirs": [${JSON.stringify(dir)}]})`,
];

// --- 設定 ---------------------------------------------------------------

test('秘密の値は HTTP へ返らない（入っているかと長さだけ）', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    const dir = mkdtempSync(path.join(os.tmpdir(), 'unbake-set-'));
    const file = path.join(dir, 'settings.json');
    const res = python([
        'import sys, json',
        'sys.path.insert(0, ".")',
        'from unbake.settings import FileSettings, SECRET_KEYS',
        `s = FileSettings(${JSON.stringify(file)})`,
        's.update({"raindrop_token": "tok-ABCDEFGHIJ", "civitai_api_key": "civ-123", "raindrop_collection_id": "42"})',
        'view = s.public_view()',
        'print(json.dumps(view, ensure_ascii=False))',
        '# 生の値はプロセスの中でだけ取れる',
        'print("RAW:" + s.get("raindrop_token"))',
        'print("SECRETS:" + ",".join(sorted(SECRET_KEYS)))',
    ].join('\n'));
    rmSync(dir, { recursive: true, force: true });
    assert.equal(res.status, 0, res.stderr);
    const view = JSON.parse(res.stdout.split('\n')[0]);

    // **値そのものが1文字も出ていないこと。**
    assert.deepEqual(view.raindrop_token, { set: true, length: 14 });
    assert.deepEqual(view.civitai_api_key, { set: true, length: 7 });
    assert.doesNotMatch(res.stdout.split('\n')[0], /tok-ABCDEFGHIJ|civ-123/,
        '秘密の値が画面へ返る形に混ざっている');
    // 秘密でない鍵はそのまま出る（出ないと設定できたか判らない）。
    assert.equal(view.raindrop_collection_id, '42');
    // プロセスの中では取れる（Raindrop 同期がこれを使う）。
    assert.match(res.stdout, /RAW:tok-ABCDEFGHIJ/);
});

test('「設定していない」と「空を設定した」を混ぜない', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    const dir = mkdtempSync(path.join(os.tmpdir(), 'unbake-set2-'));
    const file = path.join(dir, 'settings.json');
    const res = python([
        'import sys, json',
        'sys.path.insert(0, ".")',
        'from unbake.settings import FileSettings',
        `s = FileSettings(${JSON.stringify(file)})`,
        'print(json.dumps(s.public_view()["raindrop_token"]))',
        's.update({"raindrop_token": "abc"})',
        'print(json.dumps(s.public_view()["raindrop_token"]))',
        's.update({"raindrop_token": ""})',
        'print(json.dumps(s.public_view()["raindrop_token"]))',
    ].join('\n'));
    rmSync(dir, { recursive: true, force: true });
    assert.equal(res.status, 0, res.stderr);
    const [before, after, cleared] = res.stdout.trim().split('\n').map(JSON.parse);
    assert.deepEqual(before, { set: false, length: 0 });
    assert.deepEqual(after, { set: true, length: 3 });
    // **空文字を送れば消える。** 消す手段が無いと、鍵を入れ替えられない。
    assert.deepEqual(cleared, { set: false, length: 0 });
});

test('知らない鍵は保存せず、拒んだことを返す', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    const dir = mkdtempSync(path.join(os.tmpdir(), 'unbake-set3-'));
    const file = path.join(dir, 'settings.json');
    const res = python([
        'import sys, json',
        'sys.path.insert(0, ".")',
        'from unbake.settings import FileSettings',
        `s = FileSettings(${JSON.stringify(file)})`,
        'print(json.dumps(s.update({"raindrop_collection_id": "1", "whatever": "x"})))',
        `print(open(${JSON.stringify(file)}, encoding="utf-8").read())`,
    ].join('\n'));
    rmSync(dir, { recursive: true, force: true });
    assert.equal(res.status, 0, res.stderr);
    const lines = res.stdout.trim().split('\n');
    const result = JSON.parse(lines[0]);
    assert.deepEqual(result.saved, ['raindrop_collection_id']);
    assert.deepEqual(result.rejected, ['whatever']);
    assert.doesNotMatch(lines.slice(1).join('\n'), /whatever/, '知らない鍵が書き込まれている');
});

test('壊れた設定ファイルでも起動でき、壊れていたことが読める', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    const dir = mkdtempSync(path.join(os.tmpdir(), 'unbake-set4-'));
    const file = path.join(dir, 'settings.json');
    writeFileSync(file, '{ this is not json', 'utf8');
    const res = python([
        'import sys, json',
        'sys.path.insert(0, ".")',
        'from unbake.settings import FileSettings',
        `s = FileSettings(${JSON.stringify(file)}).load()`,
        'print(json.dumps({"error": s.load_error, "view": s.public_view()["raindrop_collection_id"]}))',
    ].join('\n'));
    rmSync(dir, { recursive: true, force: true });
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout.trim());
    // **黙って既定へ落ちない。** 落ちると「設定が効かない」の理由が永久に判らない。
    assert.match(parsed.error, /JSON/);
    assert.equal(parsed.view, '');
});

// --- 書庫 ---------------------------------------------------------------

test('フォルダを走査して記録が並ぶ（要約だけ・本体は含まない）', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    const dir = fixtureDir();
    const settingsDir = mkdtempSync(path.join(os.tmpdir(), 'unbake-s-'));
    const res = python([
        ...head(dir, path.join(settingsDir, 'settings.json')),
        'lib = RecordLibrary(s).scan()',
        'rows, total = lib.summaries()',
        'print(json.dumps({"total": total, "rows": rows, "errors": lib.scan_errors}, ensure_ascii=False))',
    ].join('\n'));
    rmSync(dir, { recursive: true, force: true });
    rmSync(settingsDir, { recursive: true, force: true });
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout.trim());

    assert.equal(parsed.total, 2, '読めた2件が並んでいない');
    const byId = Object.fromEntries(parsed.rows.map(r => [r.id, r]));
    assert.equal(byId['rec-a'].checkpoint, 'ck.safetensors');
    assert.equal(byId['rec-a'].seed, 7);
    assert.equal(byId['rec-a'].preview, true, '対の参照画像を見つけていない');
    assert.equal(byId['rec-a'].source, 'folder');
    // **グラフの有無を一覧で見分けられる**（346件中48件しか持っていない）。
    assert.equal(byId['rec-a'].has_graph, false);
    assert.equal(byId['rec-b'].has_graph, true);
    assert.equal(byId['rec-b'].preview, false);
    // 要約に本体を混ぜない（346件ぶん送ると数十MBになる）。
    assert.equal(Object.hasOwn(byId['rec-a'], 'comfy_prompt'), false);
    // **読めなかった1件を黙って捨てない。**
    assert.equal(parsed.errors.length, 1);
    assert.match(parsed.errors[0], /broken\.recipe\.json/);
});

test('設定したフォルダが無いことを「0件」と混ぜない', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    const settingsDir = mkdtempSync(path.join(os.tmpdir(), 'unbake-s2-'));
    const res = python([
        ...head(path.join(settingsDir, 'does-not-exist'), path.join(settingsDir, 'settings.json')),
        'lib = RecordLibrary(s).scan()',
        'rows, total = lib.summaries()',
        'print(json.dumps({"total": total, "errors": lib.scan_errors}, ensure_ascii=False))',
    ].join('\n'));
    rmSync(settingsDir, { recursive: true, force: true });
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.total, 0);
    assert.equal(parsed.errors.length, 1, '見つからないフォルダが理由として出ていない');
    assert.match(parsed.errors[0], /見つかりません/);
});

test('参照画像は id でしか引けない（走査した記録の対だけ）', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    const dir = fixtureDir();
    const outside = mkdtempSync(path.join(os.tmpdir(), 'unbake-outside-'));
    writeFileSync(path.join(outside, 'secret.png'), 'should never be served', 'utf8');
    const settingsDir = mkdtempSync(path.join(os.tmpdir(), 'unbake-s3-'));
    const res = python([
        ...head(dir, path.join(settingsDir, 'settings.json')),
        'lib = RecordLibrary(s).scan()',
        'found = lib.preview_path("rec-a")',
        'print("A:" + (str(found) if found else "NONE"))',
        '# 走査に無い記録・パスめいた文字列・親への脱出は、どれも None',
        'for probe in ["rec-b", "../secret", "..\\\\secret", ' + JSON.stringify(path.join(outside, 'secret.png')) + ', ""]:',
        '    print("P:" + str(lib.preview_path(probe)))',
        '# そもそもパスを受ける口が無いことを、面の側からも確かめる',
        'import inspect',
        'print("SIG:" + ",".join(inspect.signature(lib.preview_path).parameters))',
    ].join('\n'));
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    rmSync(settingsDir, { recursive: true, force: true });
    assert.equal(res.status, 0, res.stderr);

    assert.match(res.stdout, /A:.*a\.webp/, '対の画像を引けていない');
    // 改行は `\r\n` で来る。**行末を落としてから比べる。**
    const probes = res.stdout.split('\n').map(l => l.trim()).filter(l => l.startsWith('P:'));
    assert.equal(probes.length, 5);
    for (const line of probes) {
        assert.equal(line, 'P:None', `走査の外を返している: ${line}`);
    }
    // 引数は record_id だけ。**パスを渡す口が無い。**
    assert.match(res.stdout, /SIG:record_id\s*$/m, '引数に record_id 以外がある');
});

test('補助の一覧はフォルダの記録を上書きしない', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    const dir = fixtureDir();
    const settingsDir = mkdtempSync(path.join(os.tmpdir(), 'unbake-s4-'));
    const res = python([
        ...head(dir, path.join(settingsDir, 'settings.json')),
        'lib = RecordLibrary(s).scan()',
        '# フォルダに在る rec-a を別の題名で送っても、変わらないこと',
        'added = lib.add_supplement([',
        '    {"id": "rec-a", "title": "OVERWRITTEN"},',
        '    {"id": "rec-c", "title": "only in lora manager"},',
        '])',
        'rows, total = lib.summaries()',
        'by = {r["id"]: r for r in rows}',
        'print(json.dumps({"added": added, "total": total,',
        '  "a_title": by["rec-a"]["title"], "a_source": by["rec-a"]["source"],',
        '  "c_source": by["rec-c"]["source"]}, ensure_ascii=False))',
    ].join('\n'));
    rmSync(dir, { recursive: true, force: true });
    rmSync(settingsDir, { recursive: true, force: true });
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout.trim());

    assert.equal(parsed.added, 1, 'フォルダに在る id まで足している');
    assert.equal(parsed.a_title, 'A', '補助がフォルダの値を上書きしている');
    assert.equal(parsed.a_source, 'folder');
    // **どこから来たかが読める。** 読めないと食い違いは「無かったこと」になる。
    assert.equal(parsed.c_source, 'lora-manager');
    assert.equal(parsed.total, 3);
});

// --- HTTP の口 -----------------------------------------------------------

test('設定を書くと索引が作り直される（古い一覧を返し続けない）', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    const dir = fixtureDir();
    const empty = mkdtempSync(path.join(os.tmpdir(), 'unbake-empty-'));
    const settingsDir = mkdtempSync(path.join(os.tmpdir(), 'unbake-s5-'));
    const res = python([
        'import sys, json',
        'sys.path.insert(0, ".")',
        'from unbake import routes',
        'from unbake.settings import FileSettings',
        `routes._settings = FileSettings(${JSON.stringify(path.join(settingsDir, 'settings.json'))}).load()`,
        `routes.write_settings({"record_source_dirs": [${JSON.stringify(empty)}]})`,
        'print("EMPTY:" + str(routes.list_records()["total"]))',
        `routes.write_settings({"record_source_dirs": [${JSON.stringify(dir)}]})`,
        'print("FULL:" + str(routes.list_records()["total"]))',
        'print("RECORD:" + json.dumps(routes.read_record("rec-a"), ensure_ascii=False))',
        'print("MISSING:" + str(routes.read_record("nope")))',
        'print("PATHS:" + ",".join(routes.registered_paths()))',
    ].join('\n'));
    rmSync(dir, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
    rmSync(settingsDir, { recursive: true, force: true });
    assert.equal(res.status, 0, res.stderr);

    assert.match(res.stdout, /EMPTY:0/);
    assert.match(res.stdout, /FULL:2/, '設定を変えたのに古い索引を返している');
    // 本体は id を引いたときだけ返る（一覧には入らない）。
    const record = JSON.parse(res.stdout.match(/RECORD:(.*)/)[1]);
    assert.equal(record.gen_params.prompt, 'a prompt');
    assert.match(res.stdout, /MISSING:None/);
    // **口は `/unbake/` に閉じる**（フォークの `/api/lm/` とも本体の `/api/` とも重ねない）。
    const paths = res.stdout.match(/PATHS:(.*)/)[1].split(',');
    assert.ok(paths.length >= 4);
    for (const p of paths) assert.match(p, /^\/unbake\//);
});

test('設定の読み出しに秘密の値が1つも混ざらない（口の側でも確かめる）', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    const settingsDir = mkdtempSync(path.join(os.tmpdir(), 'unbake-s6-'));
    const res = python([
        'import sys, json',
        'sys.path.insert(0, ".")',
        'from unbake import routes',
        'from unbake.settings import FileSettings',
        `routes._settings = FileSettings(${JSON.stringify(path.join(settingsDir, 'settings.json'))}).load()`,
        'routes.write_settings({"raindrop_token": "TOKEN-SHOULD-NEVER-APPEAR", "civitai_api_key": "KEY-SHOULD-NEVER-APPEAR"})',
        '# 書いた直後の応答と、読み直した応答の両方を見る',
        'print(json.dumps(routes.write_settings({"raindrop_collection_id": "9"}), ensure_ascii=False))',
        'print(json.dumps(routes.read_settings(), ensure_ascii=False))',
    ].join('\n'));
    rmSync(settingsDir, { recursive: true, force: true });
    assert.equal(res.status, 0, res.stderr);
    // **書いた直後の応答にも混ぜない。** ここが一番漏れやすい
    //（「保存しました」の応答に保存した値をそのまま返してしまう形）。
    assert.doesNotMatch(res.stdout, /TOKEN-SHOULD-NEVER-APPEAR|KEY-SHOULD-NEVER-APPEAR/,
        '秘密の値が応答に混ざっている');
    assert.match(res.stdout, /"set": ?true/);
});

test('設定ファイルがリポジトリの中を指さない', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    const res = python([
        'import sys, os',
        'sys.path.insert(0, ".")',
        'from unbake.settings import settings_path',
        'print("PATH:" + str(settings_path()))',
        'print("CWD:" + os.getcwd())',
    ].join('\n'));
    assert.equal(res.status, 0, res.stderr);
    const settingsFile = res.stdout.match(/PATH:(.*)/)[1].trim();
    const cwd = res.stdout.match(/CWD:(.*)/)[1].trim();
    // **トークンを git の管理下へ置かない。**
    assert.ok(!path.resolve(settingsFile).startsWith(path.resolve(cwd)),
        `設定ファイルがリポジトリの中にある: ${settingsFile}`);
});

// --- 要約が「ディスク → 画面」の関所であること -----------------------------
//
// **12項目しか返していなかった。** その結果、利用者が既に払った手作業
// （実測: `favorite: true` 64件・ライセンス4列 各345件・NSFW格付け344件）が
// 画面に一度も届いていなかった。**足りないのはデータではなく通り道だった。**

/** 手作業の値が入った記録を並べる。値は実データの形をそのまま使う。 */
function graderFixtureDir() {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'unbake-grade-'));
    const write = (name, body) => writeFileSync(path.join(dir, name), body, 'utf8');
    write('graded.recipe.json', JSON.stringify({
        id: 'graded', title: 'Graded',
        favorite: true,
        license: '全構成が画像販売可（Image/Sell・解決0）',
        commercial_ok: 'YES',
        license_source_url: 'https://example.invalid/license',
        license_checked_at: '2026-08-14',
        preview_nsfw_level: 16,
        comfy_prompt: { 3: {} },
        comfy_workflow: { nodes: [] },
        gen_params: { seed: 1 },
    }));
    // **格付けも分類も無い記録。** Sweep が今まさに出した画像がこれに当たる。
    write('bare.recipe.json', JSON.stringify({ id: 'bare', title: 'Bare' }));
    return dir;
}

test('要約が、利用者の手作業（お気に入り・ライセンス・格付け）を画面まで運ぶ', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    const dir = graderFixtureDir();
    const settingsDir = mkdtempSync(path.join(os.tmpdir(), 'unbake-s-'));
    const res = python([
        ...head(dir, path.join(settingsDir, 'settings.json')),
        'lib = RecordLibrary(s).scan()',
        'rows, total = lib.summaries()',
        'print(json.dumps({"rows": rows}, ensure_ascii=False))',
    ].join('\n'));
    rmSync(dir, { recursive: true, force: true });
    rmSync(settingsDir, { recursive: true, force: true });
    assert.equal(res.status, 0, res.stderr);
    const byId = Object.fromEntries(JSON.parse(res.stdout.trim()).rows.map(r => [r.id, r]));

    const graded = byId['graded'];
    assert.equal(graded.favorite, true, 'お気に入りが要約に乗っていない');
    assert.equal(graded.commercial_ok, 'YES');
    assert.equal(graded.license_source_url, 'https://example.invalid/license');
    assert.equal(graded.preview_nsfw_level, 16);
    // **判定日を落とさない。** 商用可否だけを出すと「今の分類」と読まれる
    // （実データは345件すべて 2026-08-14 の一度きり）。
    assert.equal(graded.license_checked_at, '2026-08-14',
        '商用可否は乗ったのに判定日が落ちている');

    // **API グラフと UI グラフは別の列。** OR で潰すと、画面へそのまま開ける
    // 36件（実データ）を見分けられないという元の問題が解けない。
    assert.equal(graded.has_graph, true);
    assert.equal(graded.has_ui_graph, true);
});

test('格付けの無い記録を安全側へ丸めない（Sweep が今出した画像がこれ）', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    const dir = graderFixtureDir();
    const settingsDir = mkdtempSync(path.join(os.tmpdir(), 'unbake-s-'));
    const res = python([
        ...head(dir, path.join(settingsDir, 'settings.json')),
        'lib = RecordLibrary(s).scan()',
        'rows, _ = lib.summaries()',
        'print(json.dumps({"rows": rows}, ensure_ascii=False))',
    ].join('\n'));
    rmSync(dir, { recursive: true, force: true });
    rmSync(settingsDir, { recursive: true, force: true });
    assert.equal(res.status, 0, res.stderr);
    const bare = Object.fromEntries(JSON.parse(res.stdout.trim()).rows.map(r => [r.id, r]))['bare'];

    // **0 は「安全と判定された」で、null は「一度も判定されていない」。**
    // 混ぜると、格付けの無い記録が全部「安全」に化けて配信中に出る。
    assert.equal(bare.preview_nsfw_level, null,
        '未格付けが 0（安全）へ丸められている');
    assert.equal(bare.license, null, '空のライセンスが空文字で来ている（未設定と区別できない）');
    assert.equal(bare.commercial_ok, null);
    assert.equal(bare.favorite, false);
    assert.equal(bare.has_ui_graph, false);

    // 鍵そのものは在る。**「無い」と「そもそも来ていない」を画面が区別できる形。**
    for (const key of ['favorite', 'license', 'commercial_ok', 'license_checked_at', 'preview_nsfw_level']) {
        assert.ok(Object.hasOwn(bare, key), `要約に ${key} の鍵が無い`);
    }
});

// --- 要約に実体のパスを混ぜない -------------------------------------------
//
// 実測（2026-08-20・稼働中の口）で `/unbake/records` は **346行すべてに
// 絶対パス**を載せていた（`D:\AI\forge\webui\models\Lora\recipes\...`）。
// 参照画像を id でしか引けなくした（`?path=` の口を作らなかった）のと同じ
// 理由で、パスは渡さない——**塞いだ口の外側から同じ情報が読めるなら、
// 塞いだことにならない。**

test('一覧の要約に実体のパスが1つも混ざらない', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    const dir = fixtureDir();
    const settingsDir = mkdtempSync(path.join(os.tmpdir(), 'unbake-s-'));
    const res = python([
        ...head(dir, path.join(settingsDir, 'settings.json')),
        'lib = RecordLibrary(s).scan()',
        'rows, total = lib.summaries()',
        'print(json.dumps({"rows": rows}, ensure_ascii=False))',
        '# 索引の側はパスを持ち続けている（本体と参照画像の解決に要る）',
        'print("INTERNAL:" + str(any(r.get("path") for r in lib._index.values())))',
    ].join('\n'));
    rmSync(dir, { recursive: true, force: true });
    rmSync(settingsDir, { recursive: true, force: true });
    assert.equal(res.status, 0, res.stderr);
    const lines = res.stdout.trim().split('\n');
    const rows = JSON.parse(lines[0]).rows;

    assert.ok(rows.length >= 2, `要約が少なすぎる（${rows.length}件）＝走査が壊れている`);
    const leaked = rows.filter(row => Object.hasOwn(row, 'path'));
    assert.deepEqual(leaked, [], '要約に実体のパスが載っている');

    // **値そのものが1文字も出ていないこと。** 鍵を消しても別名で載れば同じなので、
    // 鍵ではなく**値**で見る（秘匿の検査と同じ作法）。
    const strings = rows.flatMap(row => Object.values(row).filter(v => typeof v === 'string'));
    const carrying = strings.filter(v => v.includes(dir));
    assert.deepEqual(carrying, [], '要約のどこかに走査元のパスが混ざっている');

    // **索引からは消していない。** 消すと本体も参照画像も引けなくなる
    // ——「渡さない」と「捨てる」は別。
    assert.ok(lines.some(l => l === 'INTERNAL:True'),
        '索引側のパスまで消している（本体と参照画像が引けなくなる）');
});


// --- 出力の口（工程2） -----------------------------------------------------
//
// **層をまたぐ鍵の食い違いは、例外もログも出さずに0件を返す。**
// 実測（2026-08-20）で、Sweep の印は JS が `unbake_sweep` / `unbake.sweep` /
// `record_id` で書き、Python は `lora_manager_sweep` /
// `lora-manager.recipe-sweep-cell` / `recipe_id` で読もうとしていた。
// **3点とも違うので、焼いた3枚は1枚も読めなかった。**

/** 印を焼いた PNG を並べた一時フォルダを作る（Pillow が要る）。 */
function outputFixtureScript(dir) {
    return [
        'import sys, json, os',
        'sys.path.insert(0, ".")',
        'try:',
        '    from PIL import Image',
        '    from PIL.PngImagePlugin import PngInfo',
        'except ImportError:',
        '    print("NO_PILLOW"); raise SystemExit',
        `root = ${JSON.stringify(dir)}`,
        'os.makedirs(os.path.join(root, "sub"), exist_ok=True)',
        '',
        'def write(name, chunks):',
        '    meta = PngInfo()',
        '    for key, value in chunks.items():',
        '        meta.add_text(key, value)',
        '    Image.new("RGB", (4, 4)).save(os.path.join(root, name), pnginfo=meta)',
        '',
        '# Unbake が焼く形',
        'write("a.png", {"prompt": "{\\"1\\": {}}", "unbake_sweep": json.dumps({',
        '    "schema": "unbake.sweep", "version": 1, "record_id": "rec-unbake",',
        '    "template_id": "t", "job_id": "j", "cell_id": "c", "signature": "sig-a"})})',
        '# フォークが焼いた形（手元の出力に9枚実在する）',
        'write(os.path.join("sub", "b.png"), {"prompt": "{\\"2\\": {}}", "lora_manager_sweep": json.dumps({',
        '    "schema": "lora-manager.recipe-sweep-cell", "version": 1, "recipe_id": "rec-fork",',
        '    "template_id": "t", "job_id": "j", "cell_id": "c", "signature": "sig-b"})})',
        '# 印の無い絵',
        'write("c.png", {"prompt": "{\\"3\\": {}}"})',
    ];
}

test('JS が焼いた印も、フォークが焼いた印も、同じ形で読める', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    const dir = mkdtempSync(path.join(os.tmpdir(), 'unbake-out-'));
    const res = python([
        ...outputFixtureScript(dir),
        'from unbake.utils.recipe_pnginfo import read_sweep_reference_from_image',
        'got = {}',
        'for name in ["a.png", os.path.join("sub", "b.png"), "c.png"]:',
        '    got[name.replace(os.sep, "/")] = read_sweep_reference_from_image(os.path.join(root, name))',
        'print(json.dumps(got, ensure_ascii=False))',
    ].join('\n'));
    rmSync(dir, { recursive: true, force: true });
    if (res.stdout.includes('NO_PILLOW')) { t.skip('Pillow が無い'); return; }
    assert.equal(res.status, 0, res.stderr);
    const got = JSON.parse(res.stdout.trim().split('\n').at(-1));

    // **両方読めること。** 元は Unbake 側が1枚も読めなかった。
    assert.ok(got['a.png'], 'Unbake が焼いた印が読めていない');
    assert.ok(got['sub/b.png'], 'フォークが焼いた印が読めていない');
    assert.equal(got['c.png'], null, '印の無い絵から参照を作っている');

    // **受け側で形を1つに揃える。** `recipe_id` で来ても `record_id` で返す。
    assert.equal(got['a.png'].record_id, 'rec-unbake');
    assert.equal(got['sub/b.png'].record_id, 'rec-fork');
    assert.equal(got['a.png'].signature, 'sig-a');
    assert.equal(got['sub/b.png'].signature, 'sig-b');
});

test('出力の口は生の値だけを返し、パスを混ぜない', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    const dir = mkdtempSync(path.join(os.tmpdir(), 'unbake-out-'));
    const res = python([
        ...outputFixtureScript(dir),
        'from unbake.outputs import OutputScanner, RAW_KEYS',
        'sc = OutputScanner(output_dir_getter=lambda: root)',
        'page = sc.page(offset=0, limit=10)',
        'print(json.dumps(page, ensure_ascii=False))',
        'print("KEYS:" + ",".join(RAW_KEYS))',
    ].join('\n'));
    const fixtureDirPath = dir;
    rmSync(dir, { recursive: true, force: true });
    if (res.stdout.includes('NO_PILLOW')) { t.skip('Pillow が無い'); return; }
    assert.equal(res.status, 0, res.stderr);
    const lines = res.stdout.trim().split('\n');
    const page = JSON.parse(lines.find(line => line.startsWith('{')));

    assert.equal(page.total, 3, `3枚のはずが ${page.total}枚`);
    assert.equal(page.outputs.length, 3);

    // **パスを渡さない。** 値ベースで見る（鍵を消しても別名で載れば同じ）。
    const serialised = JSON.stringify(page);
    assert.ok(!serialised.includes(fixtureDirPath.replaceAll('\\', '\\\\'))
        && !serialised.includes(fixtureDirPath),
        '応答のどこかに走査元のパスが混ざっている');
    for (const row of page.outputs) {
        assert.ok(!/[\\:]/.test(row.filename), `filename にパスが入っている: ${row.filename}`);
        assert.ok(row.subfolder === '' || row.subfolder === 'sub', `subfolder が相対でない: ${row.subfolder}`);
    }

    // **生のまま返す。** ここで JSON にしたり正規化したりしない。
    const stamped = page.outputs.find(row => row.raw.unbake_sweep);
    assert.ok(stamped, 'Unbake の印を持つ行が返っていない');
    assert.equal(typeof stamped.raw.unbake_sweep, 'string', '印を解析して返している');
    assert.equal(typeof stamped.raw.prompt, 'string');
    assert.ok(JSON.parse(stamped.raw.unbake_sweep).record_id, '生の文字列が壊れている');

    // 返す鍵は宣言した一覧だけ。
    const declared = new Set(lines.find(line => line.startsWith('KEYS:')).slice(5).split(','));
    for (const row of page.outputs) {
        for (const key of Object.keys(row.raw)) {
            assert.ok(declared.has(key), `宣言していない鍵を返している: ${key}`);
        }
    }
});


test('真偽値と整数の設定が、型どおりに保存される', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    const settingsDir = mkdtempSync(path.join(os.tmpdir(), 'unbake-s-'));
    const file = path.join(settingsDir, 'settings.json');
    const res = python([
        'import sys, json',
        'sys.path.insert(0, ".")',
        'from unbake.settings import FileSettings',
        `s = FileSettings(${JSON.stringify(file)})`,
        // 画面のフォームは文字列で送ってくる。
        's.update({"show_commercial_ok": "false", "group_by_checkpoint": "true",',
        '          "compact_width": "640", "sidebar_width": "not a number",',
        '          "theme": "AMBER"})',
        'print(json.dumps({k: s.get(k, None) for k in',
        '  ["show_commercial_ok","group_by_checkpoint","compact_width",',
        '   "sidebar_width","theme"]}, ensure_ascii=False))',
    ].join('\n'));
    rmSync(settingsDir, { recursive: true, force: true });
    assert.equal(res.status, 0, res.stderr);
    const got = JSON.parse(res.stdout.trim());

    // **`"false"` を真として読ませない。** 型を寄せる前は文字列のまま保存され、
    // 空でない文字列なので読み手には真として届いていた（設定が効かないのに
    // エラーも出ない形）。
    assert.equal(got.show_commercial_ok, false);
    assert.equal(got.group_by_checkpoint, true);
    assert.equal(got.compact_width, 640);
    // 読めない数は**既定へ戻す**（素通しすると閾値の比較が黙って常に偽になる）。
    // `sidebar_width` の既定は 0 ＝「窓に合わせる」。
    assert.equal(got.sidebar_width, 0);
    // 決まった語のうちどれかへ寄せる（知らない値は既定へ倒す）。
    assert.equal(got.theme, 'amber');
});


// --- 単品ダウンロード（工程6・手順20/21）-----------------------------------
//
// **危ないのは書き込む先。** 落とすのは数GBのファイルで、置き場所を間違えると
// 気づきにくい。ここで固定するのは4つ:
//
//   1. 置き場の**外へは書けない**（`../` を含む名前を渡しても）
//   2. **既にあるものを上書きしない**（同名の別物へ差し替えると
//      「同じ名前なのに別の絵が出る」という一番厄介な壊れ方をする）
//   3. **hash が合わなければ本物の名前へ置かない**（切れたファイルが
//      「落とし済み」に見えると、落とし直す機会が永久に来ない）
//   4. **Civitai 以外のホストからは落とさない**（API が返した URL でも確かめる）

function downloadScript(body) {
    return [
        'import sys, os, json, hashlib, tempfile',
        'sys.path.insert(0, ".")',
        'import unbake.download as dl',
        'root = tempfile.mkdtemp(prefix="unbake-dltest-")',
        // `root` は 2026-08-28 に足した引数（落とす先の根を選べるようにした）。
        // **ここの `root` は退避先の一時フォルダ**なので、名前を分けて受ける。
        'dl._model_dir = lambda kind, download_root="": root',
        ...body,
    ].join('\n');
}

test('置き場の外へは書けない（`../` を渡しても）', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    const res = python(downloadScript([
        'out = []',
        'for name in ["../evil.safetensors", "..\\\\evil.safetensors",',
        '             "sub/../../evil.safetensors", "/etc/passwd.safetensors",',
        '             "C:\\\\Windows\\\\evil.safetensors", "normal.safetensors"]:',
        '    try:',
        '        target = dl.safe_target("loras", name)',
        '        inside = os.path.commonpath([os.path.abspath(root), os.path.abspath(target)]) == os.path.abspath(root)',
        '        out.append({"name": name, "inside": inside, "base": os.path.basename(target)})',
        '    except dl.DownloadError as error:',
        '        out.append({"name": name, "refused": str(error)})',
        'print(json.dumps(out, ensure_ascii=False))',
    ]));
    assert.equal(res.status, 0, res.stderr);
    const rows = JSON.parse(res.stdout.trim().split('\n').at(-1));
    assert.equal(rows.length, 6);
    for (const row of rows) {
        if (row.refused) continue;
        assert.equal(row.inside, true, `置き場の外へ出た: ${row.name} -> ${row.base}`);
        assert.doesNotMatch(row.base, /[\\/]/, `basename になっていない: ${row.base}`);
    }
});

test('モデルとして読めない拡張子を落とさない', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    const res = python(downloadScript([
        'out = {}',
        'for name in ["evil.exe", "script.py", "a.safetensors", "b.ckpt", ""]:',
        '    try:',
        '        dl.safe_target("loras", name); out[name] = "ok"',
        '    except dl.DownloadError as error:',
        '        out[name] = "refused"',
        'print(json.dumps(out, ensure_ascii=False))',
    ]));
    assert.equal(res.status, 0, res.stderr);
    const got = JSON.parse(res.stdout.trim().split('\n').at(-1));
    assert.equal(got['evil.exe'], 'refused');
    assert.equal(got['script.py'], 'refused');
    assert.equal(got[''], 'refused');
    assert.equal(got['a.safetensors'], 'ok');
    assert.equal(got['b.ckpt'], 'ok');
});

test('知らない置き場を受けない', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    const res = python([
        'import sys, json',
        'sys.path.insert(0, ".")',
        'import unbake.download as dl',
        'out = {}',
        'for kind in ["loras", "checkpoints", "somewhere_else", ""]:',
        '    try:',
        '        dl._model_dir(kind); out[kind] = "resolved"',
        '    except dl.DownloadError as error:',
        '        out[kind] = "refused" if "unsupported kind" in str(error) else "no-comfy"',
        'print(json.dumps(out, ensure_ascii=False))',
    ].join('\n'));
    assert.equal(res.status, 0, res.stderr);
    const got = JSON.parse(res.stdout.trim().split('\n').at(-1));
    assert.equal(got.somewhere_else, 'refused', '知らない置き場を受けている');
    assert.equal(got[''], 'refused');
    // ComfyUI の外なので `loras` は解決できない——**そこは別の理由**であること。
    assert.equal(got.loras, 'no-comfy');
});

test('落としたものは hash を照合し、合わなければ置かない', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    const res = python(downloadScript([
        'class FakeResponse:',
        '    def __init__(self, payload): self.payload = payload; self.headers = {}',
        '    def read(self, n): ',
        '        out, self.payload = self.payload[:n], self.payload[n:]',
        '        return out',
        '    def __enter__(self): return self',
        '    def __exit__(self, *a): return False',
        // **本物の safetensors の器にする。** 中身の形を見る検算が入ったので、
        // モデルでないバイト列を `.safetensors` と名乗らせると正しく弾かれる。
        // ここで測りたいのは hash の照合なので、器のほうは本物にしておく。
        'import json as _json',
        '_head = _json.dumps({"__metadata__": {}}).encode()',
        'body = len(_head).to_bytes(8, "little") + _head + bytes(8)',
        'good = hashlib.sha256(body).hexdigest()',
        'opener = lambda request, timeout=0: FakeResponse(body)',
        'out = {}',
        '# 合う hash なら置かれる',
        'r = dl.download_model(url="https://civitai.com/x", kind="loras", filename="ok.safetensors",',
        '                      sha256=good, expected_bytes=len(body), opener=opener)',
        'out["ok"] = {"placed": os.path.exists(os.path.join(root, "ok.safetensors")),',
        '             "verified": r["verified"], "bytes": r["bytes"], "sent": len(body)}',
        '# 合わない hash なら置かれない',
        'try:',
        '    dl.download_model(url="https://civitai.com/x", kind="loras", filename="bad.safetensors",',
        '                      sha256="0"*64, expected_bytes=len(body), opener=opener)',
        '    out["mismatch"] = "placed!!"',
        'except dl.DownloadError as error:',
        '    out["mismatch"] = {"refused": "checksum" in str(error),',
        '                       "placed": os.path.exists(os.path.join(root, "bad.safetensors")),',
        '                       "leftovers": [f for f in os.listdir(root) if f.endswith(".part")]}',
        '# 2回目は上書きしない',
        'try:',
        '    dl.download_model(url="https://civitai.com/x", kind="loras", filename="ok.safetensors",',
        '                      sha256=good, opener=opener)',
        '    out["again"] = "overwrote!!"',
        'except dl.DownloadError as error:',
        '    out["again"] = "refused" if "already there" in str(error) else str(error)',
        '# hash が無ければ「確かめた」と言わない',
        'r2 = dl.download_model(url="https://civitai.com/x", kind="loras", filename="nohash.safetensors",',
        '                       opener=opener)',
        'out["nohash"] = {"verified": r2["verified"]}',
        'print(json.dumps(out, ensure_ascii=False))',
    ]));
    assert.equal(res.status, 0, res.stderr);
    const got = JSON.parse(res.stdout.trim().split('\n').at(-1));

    assert.equal(got.ok.placed, true, '合う hash なのに置かれていない');
    assert.equal(got.ok.verified, true);
    // **送った長さと突き合わせる。** 数字を直に書くと、器を本物へ替えた
    // だけで赤くなる（実際にそうなった: 19 -> 36）。測りたいのは
    // 「送った分だけ受け取ったか」であって、長さそのものではない。
    assert.equal(got.ok.bytes, got.ok.sent);
    assert.ok(got.ok.sent > 0, '空を送っている（何も測れていない）');

    assert.equal(got.mismatch.refused, true, 'hash 違いを通している');
    assert.equal(got.mismatch.placed, false, 'hash が合わないのに本物の名前へ置いた');
    assert.deepEqual(got.mismatch.leftovers, [], '途中のファイルが残っている');

    assert.equal(got.again, 'refused', '既にあるものを上書きした');

    // **hash が無ければ「確かめた」と言わない。** 言うと、切れたダウンロードと
    // 成功の区別が付かないまま「検証済み」として扱われる。
    assert.equal(got.nohash.verified, false);
});

test('Civitai 以外のホストからは落とさない', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    const res = python([
        'import sys, json',
        'sys.path.insert(0, ".")',
        'from unbake.civitai import resolve_version',
        'def fake(url, api_key=""):',
        '    return {"id": 1, "model": {"type": "LORA"},',
        '            "files": [{"primary": True, "name": "a.safetensors", "sizeKB": 10,',
        '                       "downloadUrl": "https://evil.example/a.safetensors",',
        '                       "hashes": {"SHA256": "ab"}}]}',
        'bad = resolve_version("1", fetch=fake)',
        'def good_fetch(url, api_key=""):',
        '    payload = fake(url)',
        '    payload["files"][0]["downloadUrl"] = "https://civitai.com/api/download/models/1"',
        '    return payload',
        'good = resolve_version("1", fetch=good_fetch)',
        'def unknown(url, api_key=""):',
        '    payload = fake(url); payload["model"]["type"] = "Workflows"; return payload',
        'weird = resolve_version("1", fetch=unknown)',
        'nothing = resolve_version("1", fetch=lambda url, api_key="": None)',
        'print(json.dumps({"bad": bad, "good": good, "weird": weird, "nothing": nothing}, ensure_ascii=False))',
    ].join('\n'));
    assert.equal(res.status, 0, res.stderr);
    const got = JSON.parse(res.stdout.trim().split('\n').at(-1));

    assert.equal(got.bad.ok, false, 'API が返した URL をそのまま信じている');
    assert.match(got.bad.error, /evil\.example/);

    assert.equal(got.good.ok, true, got.good.error);
    assert.equal(got.good.kind, 'loras');
    assert.equal(got.good.sha256, 'ab');

    // **推測で置き場を決めない。** 間違えると探しても見つからない場所へ落ちる。
    assert.equal(got.weird.ok, false);
    assert.match(got.weird.error, /unsupported model type/);

    // **取れなかったことを「存在しない」と混ぜない。**
    assert.equal(got.nothing.ok, false);
    assert.match(got.nothing.error, /could not reach/);
});


// --- Raindrop は「あとで読む箱」（工程5・手順19）------------------------------
//
// 用途は取得ではなく**先送り**。Civitai で見つけた時点では ComfyUI を起動して
// いないので、その場でブックマークだけして後で回収する。だから要るのは**一覧**だけ。
//
// **同梱の `raindrop_sync_service.py` は配線しなかった。** あれは Raindrop の
// クライアントではなく、フォーク側の `civitai_image_download.py` を別プロセスで
// 起動する実行器で、そのスクリプトは `.recipe.json` を書く（実測で書き込み5箇所）
// ——**Unbake は書き戻さない**という決めごとに正面から反する。

test('鍵が無いことと、0件だったことを混ぜない', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    const res = python([
        'import sys, json',
        'sys.path.insert(0, ".")',
        'from unbake.raindrop import list_bookmarks',
        'out = {',
        '  "no_token": list_bookmarks(token=""),',
        '  "bad_collection": list_bookmarks(token="t", collection_id="../evil", fetch=lambda u, k: {}),',
        '  "unreachable": list_bookmarks(token="t", fetch=lambda u, k: None),',
        '}',
        'print(json.dumps(out, ensure_ascii=False))',
    ].join('\n'));
    assert.equal(res.status, 0, res.stderr);
    const got = JSON.parse(res.stdout.trim().split('\n').at(-1));

    assert.equal(got.no_token.ok, false);
    assert.equal(got.no_token.error, 'no-token', '鍵が無いことが理由として返っていない');
    assert.deepEqual(got.no_token.items, []);

    // コレクションIDは数字だけ（URL へ勝手なものを差し込ませない）。
    assert.equal(got.bad_collection.ok, false);
    assert.match(got.bad_collection.error, /number/);

    // **取れなかったことを「0件」と混ぜない。**
    assert.equal(got.unreachable.ok, false);
    assert.match(got.unreachable.error, /could not reach/);
});

test('一覧は要らないものを持ち出さず、Civitai の画像IDだけ添える', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    const res = python([
        'import sys, json',
        'sys.path.insert(0, ".")',
        'from unbake.raindrop import list_bookmarks',
        'payload = {"count": 3, "items": [',
        '  {"link": "https://civitai.red/images/12345", "title": "A", "created": "t1",',
        '   "cover": "https://rdl.ink/cover/a.jpg",',
        '   "note": "個人的なメモ", "tags": ["x"], "_id": 1},',
        '  {"link": "https://civitai.com/images/67890?postId=1", "title": "B", "created": "t2",',
        '   "cover": "javascript:alert(1)"},',
        '  {"link": "https://example.com/other", "title": "C", "created": "t3"},',
        ']}',
        'got = list_bookmarks(token="t", collection_id="42", fetch=lambda u, k: payload)',
        'print(json.dumps({"result": got, "url_seen": None}, ensure_ascii=False))',
    ].join('\n'));
    assert.equal(res.status, 0, res.stderr);
    const { result } = JSON.parse(res.stdout.trim().split('\n').at(-1));

    assert.equal(result.ok, true);
    assert.equal(result.items.length, 3);
    // **`.red` も `.com` も拾う**（手元の記録の出典は326/340件が `.red`）。
    assert.equal(result.items[0].civitaiImageId, '12345');
    assert.equal(result.items[1].civitaiImageId, '67890');
    // Civitai でないものは ID が付かない（**捨てはしない**）。
    assert.equal(result.items[2].civitaiImageId, null);

    // **表紙は通す**（2026-08-25 利用者の指摘）。画面は最初から絵を出す作りだったのに
    // ここが送っていなかったので、**一度も出ていなかった**——片側だけ配線されていた。
    assert.equal(result.items[0].cover, 'https://rdl.ink/cover/a.jpg', '表紙を落としている');
    // **http(s) 以外は落とす。** 画面は受け取った文字列をそのまま `src` に貼る。
    assert.equal(result.items[1].cover, '', 'javascript: をそのまま渡している');
    // 表紙が無いブックマークは空（画面は空なら枠ごと出さない）。
    assert.equal(result.items[2].cover, '');

    // **要らないものを持ち出さない。** メモやタグは返さない。
    for (const item of result.items) {
        assert.deepEqual(Object.keys(item).sort(), ['civitaiImageId', 'cover', 'created', 'link', 'title']);
    }
    assert.doesNotMatch(JSON.stringify(result), /個人的なメモ/, 'メモを持ち出している');
});

test('Raindrop へ書き戻す口を1つも持たない', async () => {
    // 「あとで読む箱」は読むだけ。ブックマークを消したり動かしたりしない。
    const source = await import('node:fs/promises')
        .then(fs => fs.readFile(path.join(ROOT, 'unbake/raindrop.py'), 'utf8'));
    assert.doesNotMatch(source, /method\s*=\s*["'](POST|PUT|DELETE|PATCH)/i,
        'Raindrop へ書き込む口がある');
    assert.doesNotMatch(source, /\bdata\s*=/, 'リクエストへ本文を載せている（書き込みの疑い）');
    // 検出器が生きていること。
    assert.match('method="POST"', /method\s*=\s*["'](POST|PUT|DELETE|PATCH)/i);
});

test('見本画像の寸法を記録へ添える（寸法の無いレシピが正方形にならない）', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    // **読む側だけが在って、作る側がどこにも無かった**（2026-08-24 実測）。
    // そのため寸法の無いレシピは全部 1024x1024 の正方形で再現されていた。
    // 実データ `civitai_82283141`: 見本 480x695 → 832x1216（元の絵と同じ）。
    const dir = mkdtempSync(path.join(os.tmpdir(), 'unbake-prev-'));
    const settingsDir = mkdtempSync(path.join(os.tmpdir(), 'unbake-prev-s-'));
    writeFileSync(path.join(dir, 'p.png'), tinyPng(8, 12));
    writeFileSync(path.join(dir, 'notimage.txt'), 'x', 'utf8');
    // LoRA Manager は見本画像そのものを `file_path` に書く（実データもこの形）。
    writeFileSync(path.join(dir, 'p.recipe.json'), JSON.stringify({
        id: 'rec-p', title: 'P', file_path: path.join(dir, 'p.png'),
        gen_params: { seed: 7, prompt: 'p prompt' },
    }), 'utf8');
    writeFileSync(path.join(dir, 'q.recipe.json'), JSON.stringify({
        id: 'rec-q', title: 'Q', file_path: path.join(dir, 'notimage.txt'),
        gen_params: { seed: 8, prompt: 'q prompt' },
    }), 'utf8');
    const res = python([
        'import sys, json',
        'sys.path.insert(0, ".")',
        'from unbake import routes',
        'from unbake.settings import FileSettings',
        `routes._settings = FileSettings(${JSON.stringify(path.join(settingsDir, 'settings.json'))}).load()`,
        `routes.write_settings({"record_source_dirs": [${JSON.stringify(dir)}]})`,
        'print("PREVIEW:" + json.dumps(routes.read_record("rec-p").get("preview_size"), ensure_ascii=False))',
        'print("UNREADABLE:" + json.dumps(routes.read_record("rec-q").get("preview_size"), ensure_ascii=False))',
    ].join('\n'));
    rmSync(dir, { recursive: true, force: true });
    rmSync(settingsDir, { recursive: true, force: true });
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(res.stdout.match(/PREVIEW:(.*)/)[1]), { width: 8, height: 12 },
        '見本の寸法が付いていない');
    // **開けないものを指していても落ちない。** ここは補いであって本筋ではない。
    assert.equal(res.stdout.match(/UNREADABLE:(.*)/)[1].trim(), 'null',
        '読めない見本で寸法を捏造している');
});

test('条件が直下に在る記録も、一覧の行に値が出る', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    // **記録の形（直下）とレシピの形（gen_params）の2つが在り、
    // 一覧はレシピの形しか読めなかった。** そのため自作 PNG を取り込むと
    // 行だけが空になり、判定が実際より低く出て（読み直すと上がる）、
    // その行から再現を押しても条件が無いので絵が出なかった
    // （2026-08-24 実機 `ComfyUI_00444_`）。
    const dir = mkdtempSync(path.join(os.tmpdir(), 'unbake-shape-'));
    const settingsDir = mkdtempSync(path.join(os.tmpdir(), 'unbake-shape-s-'));
    writeFileSync(path.join(dir, 'r.recipe.json'), JSON.stringify({
        id: 'rec-r', title: 'R',
        seed: 173502072326292, steps: 14, cfg: 4,
        sampler: 'dpmpp_2m', scheduler: 'karras', width: 832, height: 1216,
        positive: 'masterpiece', negative: 'lowres',
    }), 'utf8');
    const res = python([
        'import sys, json',
        'sys.path.insert(0, ".")',
        'from unbake import routes',
        'from unbake.settings import FileSettings',
        `routes._settings = FileSettings(${JSON.stringify(path.join(settingsDir, 'settings.json'))}).load()`,
        `routes.write_settings({"record_source_dirs": [${JSON.stringify(dir)}]})`,
        'rows = routes.list_records()["records"]',
        'print("ROW:" + json.dumps(rows[0], ensure_ascii=False))',
    ].join('\n'));
    rmSync(dir, { recursive: true, force: true });
    rmSync(settingsDir, { recursive: true, force: true });
    assert.equal(res.status, 0, res.stderr);
    const row = JSON.parse(res.stdout.match(/ROW:(.*)/)[1]);
    assert.equal(row.seed, 173502072326292, '種が行に出ていない');
    assert.equal(row.steps, 14, '歩数が行に出ていない');
    assert.equal(row.cfg_scale, 4, 'cfg が行に出ていない（名前が違うだけ）');
    assert.equal(row.sampler, 'dpmpp_2m');
    assert.equal(row.size, '832x1216', '寸法が行に出ていない');
    assert.equal(row.prompt, 'masterpiece');
    assert.equal(row.negative_prompt, 'lowres');
});

// --- 土台のモデルを、手元のモデルの情報から補う（2026-08-25 実機）------------
//
// タイル左上の札が空の記録が **350件中17件** あり、`civitai_137684933` と
// `ComfyUI_00444_` が実機で報告された。記録は `base_model` を持っていないが、
// **手元の `<モデル>.metadata.json` は両方とも `"Illustrious"` と書いていた**
// ——名前から当てる（推測する）必要はなく、書いてある値を引けばよい。

test('モデル名の鍵は、フォルダと拡張子を落として引ける', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    const res = python([
        'import sys, json',
        'sys.path.insert(0, ".")',
        'from unbake.model_index import name_key',
        'cases = ["Illustrious\\anime\\wai.safetensors", "wai.SafeTensors", "re-mixmain.fp16",',
        '         "sub/dir/x.ckpt", "", None]',
        'print("OUT:" + json.dumps([name_key(c) for c in cases]))',
    ].join('\n'));
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout.match(/OUT:(.*)/)[1]);
    assert.equal(out[0], 'wai', 'フォルダが落ちていない');
    assert.equal(out[1], 'wai', '拡張子の大小で別の鍵になっている');
    // **点より後ろを切ってはいけない。** 実データに在る名前で、
    // `.fp16` を落とすと別のモデルの鍵になる。
    assert.equal(out[2], 're-mixmain.fp16', 'モデル名の一部を拡張子として落としている');
    assert.equal(out[3], 'x');
    assert.deepEqual([out[4], out[5]], ['', ''], '空と None を鍵にしている');
});

test('metadata に書いてある土台のモデルを索引が持つ', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    const dir = mkdtempSync(path.join(os.tmpdir(), 'unbake-mi-'));
    writeFileSync(path.join(dir, 'wai.metadata.json'), JSON.stringify({
        file_name: 'waiIllustriousSDXL_v150', base_model: 'Illustrious', sha256: 'a'.repeat(64),
    }), 'utf8');
    // `base_model` が無く `civitai.baseModel` だけ在る形も引けること。
    writeFileSync(path.join(dir, 'flux.metadata.json'), JSON.stringify({
        file_name: 'flux1-dev', civitai: { id: 1, baseModel: 'Flux.1 D' },
    }), 'utf8');
    const res = python([
        'import sys, json',
        'sys.path.insert(0, ".")',
        'from pathlib import Path',
        'from unbake import model_index',
        `model_index._roots = lambda kind: ([Path(${JSON.stringify(dir)})] if kind == "checkpoints" else [])`,
        'model_index.reset()',
        'index = model_index.get(True)',
        'print("OUT:" + json.dumps({',
        '  "base": index["kinds"]["checkpoints"]["baseByName"],',
        '  "wai": model_index.base_model_for("Illustrious\\anime\\waiIllustriousSDXL_v150.safetensors", index),',
        '  "flux": model_index.base_model_for("flux1-dev", index),',
        '  # **大小が違うだけの名前でも引ける。** 記録側は Civitai の表記、',
        '  # 手元は保存したときのファイル名で、実データでも揃っていない。',
        '  "case": model_index.base_model_for("WAIILLUSTRIOUSSDXL_V150.SAFETENSORS", index),',
        '  "unknown": model_index.base_model_for("nothing-here.safetensors", index),',
        '}, ensure_ascii=False))',
    ].join('\n'));
    rmSync(dir, { recursive: true, force: true });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout.match(/OUT:(.*)/)[1]);
    assert.equal(out.wai, 'Illustrious', '記録側のフォルダ込みの名前から引けていない');
    assert.equal(out.flux, 'Flux.1 D', 'civitai 側の値を読んでいない');
    assert.equal(out.case, 'Illustrious', '大小が違うだけで引けなくなっている');
    // **「引けなかった」を「無い」と混ぜない。**
    assert.equal(out.unknown, null, '手元に無いモデルへ値を作っている');
});

test('記録が持っていない土台のモデルだけを補い、出どころを残す', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    const dir = mkdtempSync(path.join(os.tmpdir(), 'unbake-fill-'));
    const settingsDir = mkdtempSync(path.join(os.tmpdir(), 'unbake-fill-s-'));
    // 記録が値を持っている側（上書きしてはいけない）。
    writeFileSync(path.join(dir, 'has.recipe.json'), JSON.stringify({
        id: 'has', title: 'has', base_model: 'SDXL 1.0',
        checkpoint: { file_name: 'wai.safetensors' },
    }), 'utf8');
    // 持っていない側（補う）。
    writeFileSync(path.join(dir, 'lacks.recipe.json'), JSON.stringify({
        id: 'lacks', title: 'lacks',
        checkpoint: { file_name: 'Illustrious\anime\wai.safetensors' },
    }), 'utf8');
    // checkpoint そのものが無い側（引きようが無い）。
    writeFileSync(path.join(dir, 'none.recipe.json'), JSON.stringify({
        id: 'none', title: 'none',
    }), 'utf8');
    // checkpoint は在るが**手元に無い**側。**引けなかったら空のまま**が正しい
    // ——ここを埋めると、画面には「SDXL」と書いてあるのに根拠が無い札が出る。
    writeFileSync(path.join(dir, 'miss.recipe.json'), JSON.stringify({
        id: 'miss', title: 'miss',
        checkpoint: { file_name: 'never-seen.safetensors' },
    }), 'utf8');
    const res = python([
        'import sys, json',
        'sys.path.insert(0, ".")',
        'from unbake import routes',
        'from unbake.settings import FileSettings',
        `routes._settings = FileSettings(${JSON.stringify(path.join(settingsDir, 'settings.json'))}).load()`,
        `routes.write_settings({"record_source_dirs": [${JSON.stringify(dir)}]})`,
        'from unbake.library import RecordLibrary',
        'from unbake import model_index',
        '# **索引そのものを差し替える。** scan() が補っていることまで見る',
        '# ——補う関数が在るだけでは、一覧には1件も出ない。',
        'model_index.base_model_for = lambda name, index=None: ("Illustrious" if "wai" in str(name) else None)',
        'lib = RecordLibrary(routes._settings)',
        'lib.scan()',
        '# 2度目は「もう補ってある」ので 0 件になる。',
        'filled = lib.fill_base_models()',
        'rows = {row["id"]: row for row in lib.rows()}',
        'print("OUT:" + json.dumps({"filled": filled, "rows": rows}, ensure_ascii=False))',
    ].join('\n'));
    rmSync(dir, { recursive: true, force: true });
    rmSync(settingsDir, { recursive: true, force: true });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout.match(/OUT:(.*)/)[1]);
    assert.equal(out.rows.has.base_model, 'SDXL 1.0', '記録が持っていた値を上書きしている');
    assert.equal(out.rows.has.base_model_source, undefined, '触っていない行に出どころが付いている');
    assert.equal(out.rows.lacks.base_model, 'Illustrious', '補えていない');
    assert.equal(out.rows.lacks.base_model_source, 'model-index', '出どころを残していない');
    assert.ok(!out.rows.none.base_model, 'checkpoint が無い記録に値を作っている');
    assert.ok(!out.rows.miss.base_model, '手元に無いモデルの記録へ値を作っている');
    assert.equal(out.rows.miss.base_model_source, undefined, '補えていないのに出どころが付いている');
    // `scan()` の中で既に一度補っているので、2度目の呼びでは 0 件になる
    // ——**「補えた」と「もう補ってある」を数で言い分けられる。**
    assert.equal(out.filled, 0, `scan() が補っていない（後から ${out.filled} 件補えた）`);
});
