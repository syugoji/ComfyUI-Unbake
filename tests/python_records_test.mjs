/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 記録の保存と削除、モデルの削除（`I-20260821-03` ＋ 2026-08-21 ユーザー指示）。
 *
 * ここで固定するのは**間違えると取り返しがつかない**ものだけ:
 *
 *  1. 書く先は `.unbake.json` **だけ**（`.recipe.json` は1バイトも書かない）
 *  2. 上書きしない（取り込み直しで手を入れた記録が黙って戻らない）
 *  3. 消すのは**索引が知っているパス**だけ・**置き場の中**だけ
 *  4. 対の画像も一緒に消す（孤児を残さない）
 *  5. 名前が2つに当たったら**消さない**（実データに1件ある）
 *  6. 付随を消すとき、**隣の別モデルを巻き込まない**
 *  7. 名前の中の `.` を**拡張子と読み違えない**（版番号で茎が切れる）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SPLIT_LINES = new RegExp('\r?\n');
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function python(code) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'unbake-'));
    const file = path.join(dir, 'probe.py');
    writeFileSync(file, code, 'utf8');
    try {
        for (const exe of ['python', 'python3', 'py']) {
            const res = spawnSync(exe, [file], {
                cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 60_000,
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

/** Python が居ない環境では飛ばす（**黙って緑にしない**——理由を出す）。 */
function run(t, code) {
    const res = python(code);
    if (res === null) { t.skip('python が見つからない'); return null; }
    assert.equal(res.status, 0, `python が落ちた:\n${res.stdout}\n${res.stderr}`);
    return JSON.parse(res.stdout.trim().split('\n').at(-1));
}

/** 記録を数件置いた一時フォルダを作って、そこを読み書きさせる下ごしらえ。 */
const PRELUDE = `
import json, os, sys, tempfile
sys.path.insert(0, ${JSON.stringify(ROOT)})
from unbake import records
from unbake.library import RecordLibrary

work = tempfile.mkdtemp(prefix="unbake-probe-")
source = os.path.join(work, "source"); os.makedirs(source)
output = os.path.join(work, "output"); os.makedirs(output)

def put(folder, name, body, preview=True):
    p = os.path.join(folder, name)
    with open(p, "w", encoding="utf-8") as fh:
        json.dump(body, fh)
    if preview:
        stem = p[: -len(".recipe.json")] if name.endswith(".recipe.json") else p[: -len(".unbake.json")]
        with open(stem + ".webp", "wb") as fh:
            fh.write(b"not really an image")
    return p

class Settings:
    def __init__(self, values): self.values = values
    def get(self, key, default=None): return self.values.get(key, default)
`;

test('保存の書き先は `.unbake.json` で、`.recipe.json` を1つも作らない', (t) => {
    const out = run(t, `${PRELUDE}
settings = Settings({"record_source_dirs": [source], "record_output_dir": output})
result = records.save_record(settings, {"id": "abc-123", "title": "t", "loras": []})
made = sorted(os.listdir(output))
print(json.dumps({"result": result["ok"], "made": made}))
`);
    if (!out) return;
    assert.equal(out.result, true);
    assert.deepEqual(out.made, ['abc-123.unbake.json']);
});

test('同じ id を上書きしない（取り込み直しで手を入れた記録が戻らない）', (t) => {
    const out = run(t, `${PRELUDE}
settings = Settings({"record_source_dirs": [source], "record_output_dir": output})
first = records.save_record(settings, {"id": "dup", "title": "one"})
second = records.save_record(settings, {"id": "dup", "title": "two"})
with open(os.path.join(output, "dup.unbake.json"), encoding="utf-8") as fh:
    kept = json.load(fh)["title"]
print(json.dumps({"first": first["ok"], "second": second["ok"], "error": second.get("error"), "kept": kept}))
`);
    if (!out) return;
    assert.equal(out.first, true);
    assert.equal(out.second, false, '2回目が上書きしている');
    assert.match(String(out.error), /already/);
    assert.equal(out.kept, 'one', '中身が入れ替わっている');
});

test('id にパス区切りを通さない（置き場の外へ書かせない）', (t) => {
    const out = run(t, `${PRELUDE}
settings = Settings({"record_source_dirs": [source], "record_output_dir": output})
result = records.save_record(settings, {"id": "../../escaped", "title": "t"})
outside = os.path.exists(os.path.join(work, "escaped.unbake.json"))
print(json.dumps({"id": result["id"], "made": sorted(os.listdir(output)), "outside": outside}))
`);
    if (!out) return;
    assert.doesNotMatch(out.id, /[\\/]/, 'id にパス区切りが残っている');
    assert.equal(out.outside, false, '置き場の外にファイルができている');
    assert.equal(out.made.length, 1);
});

test('削除は本体と対の画像を消し、消したものを1件ずつ返す', (t) => {
    const out = run(t, `${PRELUDE}
put(source, "keep.recipe.json", {"id": "keep"})
put(source, "gone.recipe.json", {"id": "gone"})
settings = Settings({"record_source_dirs": [source], "record_output_dir": output})
library = RecordLibrary(settings).scan()
result = records.delete_record(library, settings, "gone")
print(json.dumps({"removed": sorted(result["removed"]), "failed": result["failed"],
                  "left": sorted(os.listdir(source)), "owner": result["owner"]}))
`);
    if (!out) return;
    assert.deepEqual(out.removed, ['gone.recipe.json', 'gone.webp'], '対の画像が残っている');
    assert.deepEqual(out.failed, []);
    assert.deepEqual(out.left, ['keep.recipe.json', 'keep.webp'], '隣の記録を巻き込んでいる');
    assert.equal(out.owner, 'lora-manager', '書いた主体を返していない');
});

test('LoRA Manager が書いた記録と Unbake が書いた記録を、別のものとして返す', (t) => {
    const out = run(t, `${PRELUDE}
put(source, "from-lm.recipe.json", {"id": "from-lm"})
put(output, "from-unbake.unbake.json", {"id": "from-unbake"})
settings = Settings({"record_source_dirs": [source], "record_output_dir": output})
library = RecordLibrary(settings).scan()
rows, _ = library.summaries(offset=0, limit=10)
print(json.dumps({r["id"]: r.get("owner") for r in rows}))
`);
    if (!out) return;
    assert.equal(out['from-lm'], 'lora-manager');
    assert.equal(out['from-unbake'], 'unbake');
});

test('索引に在っても、走査対象の外なら消さない', (t) => {
    const out = run(t, `${PRELUDE}
outside = os.path.join(work, "outside"); os.makedirs(outside)
put(outside, "stray.recipe.json", {"id": "stray"})
settings = Settings({"record_source_dirs": [outside], "record_output_dir": output})
library = RecordLibrary(settings).scan()
# 索引を作ったあとで設定だけ差し替える＝索引が古い状態。
settings.values["record_source_dirs"] = [source]
try:
    records.delete_record(library, settings, "stray")
    verdict = "deleted"
except records.RecordError as error:
    verdict = str(error)
print(json.dumps({"verdict": verdict, "still": os.path.exists(os.path.join(outside, "stray.recipe.json"))}))
`);
    if (!out) return;
    assert.match(out.verdict, /refusing to delete outside/, '走査対象の外を消している');
    assert.equal(out.still, true);
});

test('知らない id を消せと言われたら、何も触らずに理由を返す', (t) => {
    const out = run(t, `${PRELUDE}
put(source, "a.recipe.json", {"id": "a"})
settings = Settings({"record_source_dirs": [source], "record_output_dir": output})
library = RecordLibrary(settings).scan()
try:
    records.delete_record(library, settings, "nope")
    verdict = "deleted"
except records.RecordError as error:
    verdict = str(error)
print(json.dumps({"verdict": verdict, "left": sorted(os.listdir(source))}))
`);
    if (!out) return;
    assert.match(out.verdict, /no such record/);
    assert.deepEqual(out.left, ['a.recipe.json', 'a.webp']);
});

// --- モデル側 ---------------------------------------------------------------

const MODEL_PRELUDE = `
import json, os, sys, tempfile, types
sys.path.insert(0, ${JSON.stringify(ROOT)})

work = tempfile.mkdtemp(prefix="unbake-models-")
root = os.path.join(work, "loras"); os.makedirs(os.path.join(root, "sub"))

def touch(rel, size=8):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as fh:
        fh.write(b"x" * size)
    return p

# ComfyUI の \`folder_paths\` のダブル。**本物と同じ2つの口だけ**を持たせる。
fake = types.ModuleType("folder_paths")
_files = []
fake.get_folder_paths = lambda kind: [root]
fake.get_filename_list = lambda kind: list(_files)
fake.get_full_path = lambda kind, rel: os.path.join(root, rel.replace("\\\\", os.sep))
sys.modules["folder_paths"] = fake
from unbake import models
`;

test('サブフォルダの中のモデルを、名前だけで引ける', (t) => {
    const out = run(t, `${MODEL_PRELUDE}
touch("sub/DeepInside.safetensors")
_files.append("sub\\\\DeepInside.safetensors")
found = models.resolve("loras", "DeepInside")
print(json.dumps({"state": found["state"], "matches": found["matches"], "hasPath": bool(found["path"])}))
`);
    if (!out) return;
    assert.equal(out.state, 'one');
    assert.equal(out.hasPath, true, 'サブフォルダの中を引けていない（導入済み482本中399本が該当）');
});

test('名前が2つに当たったら消さない（実データに1件ある）', (t) => {
    const out = run(t, `${MODEL_PRELUDE}
touch("DetailedEyes_V3.safetensors")
touch("sub/DetailedEyes_V3.safetensors")
_files.extend(["DetailedEyes_V3.safetensors", "sub\\\\DetailedEyes_V3.safetensors"])
found = models.resolve("loras", "DetailedEyes_V3")
try:
    models.delete("loras", "DetailedEyes_V3")
    verdict = "deleted"
except models.ModelError as error:
    verdict = str(error)
left = sorted(os.listdir(root)) + sorted(os.listdir(os.path.join(root, "sub")))
print(json.dumps({"state": found["state"], "matches": found["matches"], "verdict": verdict, "left": left}))
`);
    if (!out) return;
    assert.equal(out.state, 'many');
    assert.equal(out.matches.length, 2, '候補を返していない');
    assert.match(out.verdict, /more than one/, '曖昧なまま片方を消している');
    assert.ok(out.left.includes('DetailedEyes_V3.safetensors'), 'ファイルが消えている');
});

test('付随は消すが、茎が違う隣のモデルは巻き込まない', (t) => {
    const out = run(t, `${MODEL_PRELUDE}
touch("princess_xl_v2.safetensors", 100)
touch("princess_xl_v2.metadata.json")
touch("princess_xl_v2.preview.png")
touch("princess_xl_v2_extra.safetensors", 50)
_files.extend(["princess_xl_v2.safetensors", "princess_xl_v2_extra.safetensors"])
plan = models.plan_delete("loras", "princess_xl_v2")
result = models.delete("loras", "princess_xl_v2")
print(json.dumps({"planned": sorted(f["name"] for f in plan["files"]), "planBytes": plan["bytes"],
                  "removed": sorted(result["removed"]), "bytes": result["bytes"],
                  "left": sorted(os.listdir(root))}))
`);
    if (!out) return;
    assert.deepEqual(out.removed, [
        'princess_xl_v2.metadata.json', 'princess_xl_v2.preview.png', 'princess_xl_v2.safetensors',
    ]);
    assert.deepEqual(out.left, ['princess_xl_v2_extra.safetensors', 'sub'],
        '前方一致で隣のモデルを巻き込んでいる');
    // **押す前に総量が出ること。** 実測で落とす側は10本目が 34 GB だった。
    assert.deepEqual(out.planned, out.removed, '消す前の一覧と実際に消したものが食い違う');
    assert.equal(out.planBytes, out.bytes);
});

test('置き場に無い名前は消さない（0件と失敗を混ぜない）', (t) => {
    const out = run(t, `${MODEL_PRELUDE}
touch("only.safetensors")
_files.append("only.safetensors")
try:
    models.delete("loras", "missing")
    verdict = "deleted"
except models.ModelError as error:
    verdict = str(error)
print(json.dumps({"verdict": verdict, "left": sorted(os.listdir(root))}))
`);
    if (!out) return;
    assert.match(out.verdict, /not installed/);
    assert.deepEqual(out.left, ['only.safetensors', 'sub']);
});

test('知らない種別は引くことも消すこともできない', (t) => {
    const out = run(t, `${MODEL_PRELUDE}
verdicts = []
for kind in ("loras", "wallets", "../etc"):
    try:
        models.installed(kind)
        verdicts.append([kind, "ok"])
    except models.ModelError as error:
        verdicts.append([kind, str(error)])
print(json.dumps(verdicts))
`);
    if (!out) return;
    assert.deepEqual(out[0], ['loras', 'ok']);
    assert.match(out[1][1], /unsupported kind/);
    assert.match(out[2][1], /unsupported kind/);
});

test('置き場の外を指す相対名は、絶対パスへ落とさない', (t) => {
    const out = run(t, `${MODEL_PRELUDE}
touch("inside.safetensors")
outside = os.path.join(work, "outside.safetensors")
with open(outside, "wb") as fh:
    fh.write(b"secret")
_files.extend(["inside.safetensors", "..\\\\outside.safetensors"])
print(json.dumps({
    "inside": bool(models.full_path("loras", "inside.safetensors")),
    "outside": models.full_path("loras", "..\\\\outside.safetensors"),
    "still": os.path.exists(outside),
}))
`);
    if (!out) return;
    assert.equal(out.inside, true);
    assert.equal(out.outside, null, '置き場の外のパスを返している（改造版はここが空いている）');
    assert.equal(out.still, true);
});

test('使用件数は、一覧の窓に関係なく全件を数える', (t) => {
    // **数えるのと見せるのは別。** 一覧は窓（offset/limit）で切って返すが、
    // 「このモデルを何件が使っているか」は**窓の外も含めて**数える
    // ——落とすと、消してよい件数が実際より少なく見える。
    const out = run(t, `${PRELUDE}
put(source, "one.recipe.json", {"id": "one", "checkpoint": "shared_ckpt"})
put(source, "two.recipe.json", {"id": "two", "checkpoint": "shared_ckpt"})
settings = Settings({"record_source_dirs": [source], "record_output_dir": output})
library = RecordLibrary(settings).scan()
import types
sys.modules.setdefault("folder_paths", types.ModuleType("folder_paths"))
from unbake import models
used = models.usage(library, "shared_ckpt")
shown, total = library.summaries(offset=0, limit=1)   # ← 窓は1件だけ
print(json.dumps({"count": used["count"], "scope": used["scope"],
                  "shown": len(shown), "total": total}))
`);
    if (!out) return;
    assert.equal(out.shown, 1, '窓が効いていない＝この検査が何も測っていない');
    assert.equal(out.count, 2, '窓の外の記録を数から落としている');
    assert.equal(out.total, 2, '全体の件数を返していない');
    assert.equal(out.scope, 'library-records-only', '数えた範囲を返していない');
});

// --- 保存した先を、走査が見ているか（実機で最初に壊れた形）------------------

test('`record_output_dir` を設定していなくても、保存した記録が一覧へ出る', (t) => {
    // **実機で最初に壊れたのはここ。** 保存の既定は `<user>/unbake/records` なのに
    // 走査側は `record_output_dir` が空だと**そこを見なかった**ので、
    // ファイルはディスクに在るのに一覧は 346件のまま動かなかった。
    // node の検査は毎回 `record_output_dir` を明示していたので**全部緑だった**。
    const out = run(t, `${PRELUDE}
import unbake.settings as settings_module
home = os.path.join(work, "home"); os.makedirs(home)
os.environ["UNBAKE_SETTINGS_DIR"] = home

settings = Settings({"record_source_dirs": [source]})   # ← 保存先を設定しない
saved = records.save_record(settings, {"id": "kept", "title": "kept"})
library = RecordLibrary(settings).scan()
rows, total = library.summaries(offset=0, limit=10)
print(json.dumps({
    "savedTo": saved["path"],
    "defaultDir": str(settings_module.default_records_dir()),
    "ids": [r["id"] for r in rows],
    "total": total,
    "owner": rows[0].get("owner") if rows else None,
    "errors": library.scan_errors,
}))
`);
    if (!out) return;
    assert.equal(out.total, 1, '保存したのに一覧へ出ていない（書く側と読む側の既定が食い違う）');
    assert.deepEqual(out.ids, ['kept']);
    assert.equal(out.owner, 'unbake');
    // **書いた先と、既定として宣言している先が同じであること。**
    assert.ok(out.savedTo.startsWith(out.defaultDir),
        `書いた先(${out.savedTo})が既定(${out.defaultDir})の外`);
});

test('一度も保存していない環境で、既定のフォルダが無いことを失敗として数えない', (t) => {
    // 既定のフォルダは最初は存在しない。そこを「見つかりません」と数えると、
    // **「設定したのに0件」の理由を読む欄が、毎回この1行で埋まる。**
    const out = run(t, `${PRELUDE}
home = os.path.join(work, "empty-home"); os.makedirs(home)
os.environ["UNBAKE_SETTINGS_DIR"] = home
put(source, "a.recipe.json", {"id": "a"})
settings = Settings({"record_source_dirs": [source]})
library = RecordLibrary(settings).scan()
rows, total = library.summaries(offset=0, limit=10)
print(json.dumps({"total": total, "errors": library.scan_errors}))
`);
    if (!out) return;
    assert.equal(out.total, 1);
    assert.deepEqual(out.errors, [], '既定のフォルダが無いことを失敗として出している');
});

test('設定した保存先が無いときは、黙らずに理由を出す（既定とは扱いを変える）', (t) => {
    const out = run(t, `${PRELUDE}
home = os.path.join(work, "home2"); os.makedirs(home)
os.environ["UNBAKE_SETTINGS_DIR"] = home
settings = Settings({"record_source_dirs": [source],
                     "record_output_dir": os.path.join(work, "typo-here")})
library = RecordLibrary(settings).scan()
print(json.dumps({"errors": library.scan_errors}))
`);
    if (!out) return;
    assert.equal(out.errors.length, 1, '打ち間違えた保存先が黙って無視されている');
    assert.match(out.errors[0], /typo-here/);
});

// --- 参照画像（2026-08-22「取り込んだ記録に画像が無い」の報告を受けて）--------

test('落としてよいホストを絞る（後方一致では見ない）', (t) => {
    const out = run(t, `${PRELUDE}
cases = [
    "https://image.civitai.com/abc/original=true/x.jpeg",
    "https://civitai.red/images/1/x.webp",
    "https://civitai.com/x.png",
    "https://evilcivitai.com/x.png",
    "https://civitai.com.example.net/x.png",
    "http://127.0.0.1:8188/queue",
    "file:///C:/Windows/win.ini",
    "",
]
print(json.dumps([[u, records._host_allowed(u)] for u in cases]))
`);
    if (!out) return;
    const by = Object.fromEntries(out);
    assert.equal(by['https://image.civitai.com/abc/original=true/x.jpeg'], true, 'サブドメインを弾いている');
    assert.equal(by['https://civitai.red/images/1/x.webp'], true);
    assert.equal(by['https://civitai.com/x.png'], true);
    // **後方一致で見ると、この2つが通ってしまう。**
    assert.equal(by['https://evilcivitai.com/x.png'], false, '似た名前のホストを通している');
    assert.equal(by['https://civitai.com.example.net/x.png'], false, 'ドメインの途中で一致している');
    // **社内ネットワークを覗く口にしない。**
    assert.equal(by['http://127.0.0.1:8188/queue'], false);
    assert.equal(by['file:///C:/Windows/win.ini'], false);
});

test('知らないホストの画像は取りに行かない（記録の保存は成功したまま）', (t) => {
    const out = run(t, `${PRELUDE}
settings = Settings({"record_source_dirs": [source], "record_output_dir": output})
result = records.save_record(settings, {"id": "no-image", "title": "t"},
                             preview_url="https://example.com/x.png")
print(json.dumps({"ok": result["ok"], "preview": result["preview"],
                  "made": sorted(os.listdir(output))}))
`);
    if (!out) return;
    // **記録は残る。** 画像が取れないことで記録まで失うのは筋が悪い。
    assert.equal(out.ok, true, '画像が取れないと記録まで残らない');
    assert.equal(out.preview.ok, false);
    assert.match(out.preview.error, /known host/);
    assert.deepEqual(out.made, ['no-image.unbake.json'], '画像でないものが置き場に出来ている');
});

test('画像の URL を記録の中へ残す（後から取り直せる）', (t) => {
    const out = run(t, `${PRELUDE}
settings = Settings({"record_source_dirs": [source], "record_output_dir": output})
records.save_record(settings, {"id": "keeps-url"}, preview_url="https://image.civitai.com/x.webp")
with open(os.path.join(output, "keeps-url.unbake.json"), encoding="utf-8") as fh:
    saved = json.load(fh)
print(json.dumps({"preview_url": saved.get("preview_url")}))
`);
    if (!out) return;
    assert.equal(out.preview_url, 'https://image.civitai.com/x.webp');
});

test('落とせる拡張子が、走査が探す拡張子の中に収まっている', (t) => {
    // **収まっていないと、落とせても `_preview_for()` が見つけられない**
    // ——画像はディスクに在るのに一覧では「絵が無い」ままになる。
    const out = run(t, `${PRELUDE}
from unbake.library import PREVIEW_SUFFIXES
print(json.dumps({
    "canWrite": sorted(set(records.PREVIEW_TYPES.values())),
    "scanned": list(PREVIEW_SUFFIXES),
}))
`);
    if (!out) return;
    const outside = out.canWrite.filter(x => !out.scanned.includes(x));
    assert.deepEqual(outside, [], `走査が探さない拡張子で保存しうる: ${outside.join(' / ')}`);
});

// --- 見本が動画しか無いモデル（2026-08-22 利用者の指摘）----------------------

test('動画から静止画を1枚作り、二度目は作り直さない', (t) => {
    // **実測で39件が動画しか持たず、画面で無地になっていた**
    // （checkpoint 9 / LoRA 30）。`_CONTENT_TYPES` は画像しか返さないので、
    // 動画を持つモデルは「見本が無い」のと同じ扱いになっていた。
    const out = run(t, `
import json, os, sys, tempfile, subprocess
sys.path.insert(0, ${JSON.stringify(ROOT)})
home = tempfile.mkdtemp(prefix="unbake-still-")
os.environ["UNBAKE_SETTINGS_DIR"] = home
from unbake import model_previews
from pathlib import Path

work = tempfile.mkdtemp(prefix="unbake-video-")
model = Path(work) / "some_model.safetensors"
model.write_bytes(b"not a real model")
video = Path(work) / "some_model.mp4"

# **本物の動画を作る。** 偽のバイト列だと「読めなかった」を「動画が無い」と
# 混ぜてしまい、検査が何も見ていないことになる。
made = False
try:
    import av, numpy as np
    with av.open(str(video), mode="w") as container:
        stream = container.add_stream("mpeg4", rate=1)
        stream.width, stream.height = 64, 48
        stream.pix_fmt = "yuv420p"
        frame = av.VideoFrame.from_ndarray(np.full((48, 64, 3), 200, dtype=np.uint8), format="rgb24")
        for packet in stream.encode(frame):
            container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)
    made = video.is_file() and video.stat().st_size > 0
except Exception as error:
    made = False

result = {"made": made}
if made:
    # 隣に動画が在ることを見つけられるか。
    result["found"] = str(model_previews.video_beside(model) or "")
    first = model_previews.still_for("checkpoints", "some_model.safetensors", model)
    result["still"] = bool(first and Path(first).is_file())
    if first:
        result["bytes"] = Path(first).stat().st_size
        stamp = Path(first).stat().st_mtime_ns
        # 2度目は作り直さない（同じファイルをそのまま返す）。
        second = model_previews.still_for("checkpoints", "some_model.safetensors", model)
        result["cached"] = (str(second) == str(first)) and Path(second).stat().st_mtime_ns == stamp
        # **models フォルダへは書かない。** 置き場は user ディレクトリの下。
        result["outsideModels"] = work not in str(first)
    # 画像も動画も無いモデルでは何も作らない。
    bare = Path(work) / "bare.safetensors"
    bare.write_bytes(b"x")
    result["bare"] = model_previews.still_for("checkpoints", "bare.safetensors", bare)
print(json.dumps(result))
`);
    if (!out) return;
    if (!out.made) { t.skip('この環境では検査用の動画を作れない（av が無い）'); return; }
    assert.match(out.found, /some_model\.mp4$/, '隣の動画を見つけられていない');
    assert.equal(out.still, true, '動画から静止画を作れていない');
    assert.ok(out.bytes > 0, '空のファイルを作っている');
    assert.equal(out.cached, true, '押すたびに作り直している');
    assert.equal(out.outsideModels, true, 'models フォルダへ書いている（上流とぶつかる）');
    assert.equal(out.bare, null, '見本が無いモデルにも何か作っている');
});

test('名前の中の `.` を拡張子と読み違えない', () => {
    // **記録は名前しか持たない。** 拡張子の付いていない名前を
    // `os.path.splitext` へ通すと、最後の `.` から後ろが落ちる——
    // 実データの `ink-style_A3.1_XL` が `ink-style_a3` になり、
    // **導入済みなのに「入っていない」**になっていた（見本が出ない形で気づいた）。
    const res = python(`
import json, sys
sys.path.insert(0, ".")
from unbake.models import _stem
print(json.dumps({
    "bare": _stem("ink-style_A3.1_XL"),
    "withSuffix": _stem("ink-style_A3.1_XL.safetensors"),
    "withFolder": _stem("SDXL 1.0/style/ink-style_A3.1_XL.safetensors"),
    "windows": _stem("SDXL 1.0\\\\style\\\\ink-style_A3.1_XL.safetensors"),
    "ckpt": _stem("model_v1.5.ckpt"),
    "plain": _stem("DetailedEyes_V3"),
}))
`);
    if (!res) return;                     // python が無い環境では何も主張しない
    assert.equal(res.status, 0, res.stderr);
    const got = JSON.parse(res.stdout.trim().split(/\r?\n/).pop());
    // **拡張子の有無で茎が変わらない。** ここが食い違うと名前が引けない。
    assert.equal(got.bare, 'ink-style_a3.1_xl', '版番号のところで切れている');
    assert.equal(got.withSuffix, got.bare, '拡張子付きと食い違う');
    assert.equal(got.withFolder, got.bare, 'フォルダ付きと食い違う');
    assert.equal(got.windows, got.bare, '\\ 区切りと食い違う');
    // **本体の拡張子は落とす**（そこまで残すと今度は逆に引けない）。
    assert.equal(got.ckpt, 'model_v1.5', '本体の拡張子を落としていない');
    assert.equal(got.plain, 'detailedeyes_v3');
});

test('ログインの HTML をモデルとして保存しない', () => {
    // **Civitai の取得口は、鍵が無いとログインの画面へ流す。** ここを見ないと
    // その HTML が `.safetensors` として置き場へ入り、hash も大きさも
    // 渡していない呼び方だと誰も気づけない。
    const res = python(`
import json, os, sys, tempfile, types
sys.path.insert(0, ".")
root = tempfile.mkdtemp()
os.makedirs(os.path.join(root, "loras"), exist_ok=True)
fake = types.ModuleType("folder_paths")
fake.folder_names_and_paths = {"loras": ([os.path.join(root, "loras")], set())}
fake.get_folder_paths = lambda kind: [os.path.join(root, kind)]
sys.modules["folder_paths"] = fake
from unbake import download

class R:
    def __init__(self, body, ctype):
        self._b, self._i = body, 0
        self.headers = {"Content-Type": ctype}
    def read(self, n=-1):
        c = self._b[self._i:self._i + (n if n and n > 0 else len(self._b))]
        self._i += len(c)
        return c
    def __enter__(self): return self
    def __exit__(self, *a): return False

def opener_of(body, ctype):
    return lambda request, timeout=None: R(body, ctype)

out = {}
for label, body, ctype in (
    ("html", b"<!doctype html><html>login</html>", "text/html; charset=utf-8"),
    ("binary", b"MODELBYTES", "application/octet-stream"),
):
    try:
        r = download.download_model(url="https://x/y", kind="loras",
                                    filename="probe_%s.safetensors" % label,
                                    opener=opener_of(body, ctype))
        out[label] = {"ok": True, "left": os.path.basename(r["path"])}
    except Exception as e:
        out[label] = {"ok": False, "error": str(e)[:120]}
# **置き去りが無いこと。** 落としかけを残すと、次の取得が「もう在る」で止まる。
out["leftovers"] = sorted(os.listdir(os.path.join(root, "loras")))
print(json.dumps(out))
`);
    if (!res) return;                     // python が無い環境では何も主張しない
    assert.equal(res.status, 0, res.stderr);
    const got = JSON.parse(res.stdout.trim().split(/\r?\n/).pop());
    assert.equal(got.html.ok, false, 'HTML をモデルとして保存している');
    assert.match(got.html.error, /web page|API key/, '理由が読めない');
    assert.equal(got.binary.ok, true, '普通の取得まで止めている');
    // HTML の側は1バイトも残さない。
    assert.deepEqual(got.leftovers, ['probe_binary.safetensors'], '落としかけが残っている');
});

test('画面が送る鍵が、保存できる鍵として登録されている', () => {
    // **知らない鍵は保存しない**という規則があるので、片方だけ足すと
    // **黙って捨てられる**——実際に `unfavorite_ids` でそうなり、
    // 「チェックを外してもお気に入り表示が消えない」と報告された（2026-08-22）。
    const res = python(`
import json, sys
sys.path.insert(0, ".")
from unbake.settings import KNOWN_KEYS
print(json.dumps(sorted(KNOWN_KEYS.keys())))
`);
    if (!res) return;                     // python が無い環境では何も主張しない
    assert.equal(res.status, 0, res.stderr);
    const known = new Set(JSON.parse(res.stdout.trim().split(/\r?\n/).pop()));
    // 画面から送っている鍵（送り先が無ければ、押しても効かない）。
    for (const key of [
        'favorite_ids', 'unfavorite_ids',
        'confirm_before_delete', 'sort_key', 'sort_descending', 'list_view', 'tile_size',
        // 絞り込みも残す（2026-08-24）。**片側だけ足すと黙って捨てられる。**
        'hidden_verdicts', 'favorites_only',
        // 宿主全体に効く設定。**保存できないと、切っても次の起動で戻る。**
        'disable_dark_reader',
    ]) {
        assert.ok(known.has(key), `${key} が保存できる鍵に無い`);
    }
    // **撤去した鍵は、両側から消えていること**（2026-08-24・`donate_url`）。
    // 片側だけ残ると、画面から送っても黙って捨てられるか、保存はできるが誰も読まないかになる。
    // どちらも**設定画面からは正常に見える**ので、ここで止める。
    assert.equal(known.has('donate_url'), false, '撤去した donate_url が保存できる鍵に残っている');
});


// --- 手元の絵を記録の隣へ置く（2026-08-23 利用者の指示）---------------------
//
// **サーバは取りに行けない。** 相手が `http(s)` の URL でなければ手が無いので、
// 落とし込んだファイルの絵は、画面から受け取る以外に残す方法が無い。
// **「任意の画像を書ける口」にしない**ための線引きをここで固定する。

test('手元の絵を、記録と同じ名前で隣へ置く', (t) => {
    const out = run(t, `${PRELUDE}
settings = Settings({"record_source_dirs": [source], "record_output_dir": output})
png = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) + b"0" * 32
result = records.save_record(settings, {"id": "local-1", "title": "t"}, preview_bytes=png)
made = sorted(os.listdir(output))
print(json.dumps({"ok": result["ok"], "preview": result["preview"], "made": made}))
`);
    if (!out) return;
    assert.equal(out.ok, true);
    assert.equal(out.preview.ok, true, '絵を置いていない');
    // **名前はサーバが決める。** 呼び手が渡すのは id だけ。
    assert.deepEqual(out.made, ['local-1.png', 'local-1.unbake.json']);
});

test('拡張子は中身で決める（名乗りを信じない）', (t) => {
    const out = run(t, `${PRELUDE}
settings = Settings({"record_source_dirs": [source], "record_output_dir": output})
jpg = bytes([0xFF, 0xD8, 0xFF]) + b"0" * 32
records.save_record(settings, {"id": "as-jpg", "title": "t"}, preview_bytes=jpg)
webp = b"RIFF" + bytes(4) + b"WEBP" + b"0" * 32
records.save_record(settings, {"id": "as-webp", "title": "t"}, preview_bytes=webp)
print(json.dumps({"made": sorted(os.listdir(output))}))
`);
    if (!out) return;
    assert.ok(out.made.includes('as-jpg.jpg'), 'JPEG を JPEG として置いていない');
    assert.ok(out.made.includes('as-webp.webp'), 'WebP を WebP として置いていない');
});

test('画像でないバイト列は書かない（記録は残す）', (t) => {
    // **これを通すと、任意の中身をディスクへ書ける口になる。**
    const out = run(t, `${PRELUDE}
settings = Settings({"record_source_dirs": [source], "record_output_dir": output})
result = records.save_record(
    settings, {"id": "not-image", "title": "t"},
    preview_bytes=b"<html>this is not an image at all</html>")
print(json.dumps({"ok": result["ok"], "preview": result["preview"], "made": sorted(os.listdir(output))}))
`);
    if (!out) return;
    // 記録は残る。**絵が置けないことと、記録が残せないことは別。**
    assert.equal(out.ok, true, '絵のせいで記録まで落としている');
    assert.equal(out.preview.ok, false);
    assert.match(String(out.preview.error), /not an image/);
    assert.deepEqual(out.made, ['not-image.unbake.json'], '画像でないものを書いている');
});

test('大きすぎるバイト列は書かない', (t) => {
    const out = run(t, `${PRELUDE}
settings = Settings({"record_source_dirs": [source], "record_output_dir": output})
png = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
huge = png + b"0" * (records.MAX_PREVIEW_BYTES + 1)
result = records.save_record(settings, {"id": "huge", "title": "t"}, preview_bytes=huge)
print(json.dumps({"ok": result["ok"], "preview": result["preview"], "made": sorted(os.listdir(output))}))
`);
    if (!out) return;
    assert.equal(out.ok, true);
    assert.equal(out.preview.ok, false);
    assert.match(String(out.preview.error), /too large/);
    assert.deepEqual(out.made, ['huge.unbake.json']);
});

test('id が置き場の外を指しても、そこへは書かない', (t) => {
    // 名前は `safe_id` を通る。**絵も同じ名前で置く**ので、記録と一緒に守られる。
    const out = run(t, `${PRELUDE}
settings = Settings({"record_source_dirs": [source], "record_output_dir": output})
png = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) + b"0" * 32
result = records.save_record(settings, {"id": "../../escaped", "title": "t"}, preview_bytes=png)
outside = sorted(os.listdir(os.path.dirname(output)))
print(json.dumps({"ok": result["ok"], "made": sorted(os.listdir(output)), "outside": outside}))
`);
    if (!out) return;
    assert.equal(out.ok, true);
    assert.deepEqual(out.outside, ['output', 'source'], '置き場の外へ書いている');
    assert.ok(out.made.every(name => !name.includes('..')), 'id をそのまま名前にしている');
});

test('data: の解き方（名乗りは見ない・壊れていれば `None`）', () => {
    const res = python(`
import json, sys
sys.path.insert(0, ".")
from unbake.routes import decode_preview_data
print(json.dumps({
    "ok": decode_preview_data("data:image/png;base64,aGVsbG8=") == b"hello",
    "plain": decode_preview_data("hello") is None,
    "broken": decode_preview_data("data:image/png;base64,!!!!") is None,
    "none": decode_preview_data(None) is None,
    # **名乗りは見ない。** 中身で決めるのは書く側の仕事。
    "any_type": decode_preview_data("data:text/plain;base64,aGVsbG8=") == b"hello",
}))
`);
    if (!res) return;
    assert.equal(res.status, 0, res.stderr);
    const got = JSON.parse(res.stdout.trim().split(SPLIT_LINES).pop());
    for (const [name, value] of Object.entries(got)) {
        assert.equal(value, true, `${name} が期待どおりでない`);
    }
});


// --- 一覧の「グラフあり」欄（2026-08-23 利用者の指摘）-----------------------

test('こちらが書いた記録のグラフも「あり」と数える', (t) => {
    const out = run(t, `${PRELUDE}
settings = Settings({"record_source_dirs": [source], "record_output_dir": output})
node = {"1": {"class_type": "CheckpointLoaderSimple", "inputs": {}}}
# 上流のレシピは comfy_prompt に持つ（テンプレート文字列の中なので引用符は使わない）
put(source, "upstream.recipe.json", {"id": "upstream", "title": "u", "comfy_prompt": node})
# こちらが書いた記録は prompt に持つ（ComfyUI の出力を落とし込むとこの形）
put(output, "own.unbake.json", {"id": "own", "title": "o", "prompt": node,
    "workflow": {"nodes": [{"id": 1}], "links": []}})
# 本文のプロンプト——**グラフではない**
put(output, "text.unbake.json", {"id": "text", "title": "t", "prompt": "masterpiece, best quality"})
# ノードの形をしていない dict。**文字列と違って手前の型判定では落ちない**ので、
# class_type を見ている行が効いているかを確かめられるのはこちらだけ。
put(output, "notnodes.unbake.json", {"id": "notnodes", "title": "n", "prompt": {"a": 1, "b": 2}})
lib = RecordLibrary(settings); lib.scan()
rows = {r["id"]: r for r in lib.rows()}
print(json.dumps({k: {"graph": rows[k]["has_graph"], "ui": rows[k]["has_ui_graph"]}
                  for k in ("upstream", "own", "text", "notnodes")}))
`);
    if (!out) return;
    assert.equal(out.upstream.graph, true, '上流のグラフを見落としている');
    // **ノード13個の完全なグラフを持つ記録が `false` と出ていた**（実データ
    // `ComfyUI_00444_`）。下流はこの欄を見て「再現不可」と言う。
    assert.equal(out.own.graph, true, 'こちらが書いた記録のグラフを見落としている');
    assert.equal(out.own.ui, true, '画面へ開ける形なのに数えていない');
    // **本文を取り違えない。** 通すと「グラフがある」と言いながら開けない。
    assert.equal(out.text.graph, false, '本文のプロンプトをグラフと数えている');
    assert.equal(out.notnodes.graph, false, 'ノードでない dict をグラフと数えている');
});

// --- 落とせなかった理由に種類を付ける（2026-08-23 利用者の指示）-------------
//
// **文言を読んで種類を当てない。** 実データの失敗5件は
// 「HTTP 404 ×2」と「could not reach the Civitai API ×3」で、
// **どちらも「もう配布されていない」**——それは文言からは読めない。

test('落とせなかった理由には、必ず機械可読の種類が付く', () => {
    const res = python(`
import json, sys
sys.path.insert(0, ".")
import unbake.download as dl

# **正規表現を使わない。** ここは道具を何段か通るので、逃がし文字が消える
# ——実際に消えて検査そのものが落ちた（2026-08-23）。素の文字列で数える。
source = open("unbake/download.py", encoding="utf-8").read()
marker = "raise DownloadError("
bare = []
for line in source.split(chr(10)):
    at = line.find(marker)
    if at < 0:
        continue
    tail = line[at + len(marker):].rstrip()
    # 1行で閉じていて、引数の区切りが無いものが「種類なし」。
    if tail.endswith(")") and "," not in tail:
        bare.append(line.strip())
    if tail.endswith(") from error") and "," not in tail[:-len(" from error")]:
        bare.append(line.strip())
print(json.dumps({
    "raises": source.count(marker),
    "bare": bare,
    "probes": {"gone": dl.DownloadError("x", "gone").code, "default": dl.DownloadError("x").code},
}))
`);
    if (!res) return;
    assert.equal(res.status, 0, res.stderr);
    const got = JSON.parse(res.stdout.trim().split(SPLIT_LINES).pop());
    assert.ok(got.raises >= 15, `raise を拾えていない（${got.raises}件）`);
    assert.deepEqual(got.bare, [], `種類の付いていない raise が在る: ${got.bare.join(' / ')}`);
    assert.equal(got.probes.gone, 'gone');
    // 既定は「判らない」。**黙って別の種類にしない。**
    assert.equal(got.probes.default, 'unknown');
});

test('版が引けないことも「もう無い」として返る', () => {
    // 実データの失敗3件がこれ。**打つ手は 404 と同じ**（諦める）なので、
    // 別の言葉で出すと「何か違うことが起きた」と読まれる。
    const res = python(`
import json, sys
sys.path.insert(0, ".")
from unbake.civitai import resolve_version
out = resolve_version("999999999", fetch=lambda url, key="": None)
print(json.dumps({"ok": out["ok"], "code": out.get("code")}))
`);
    if (!res) return;
    assert.equal(res.status, 0, res.stderr);
    const got = JSON.parse(res.stdout.trim().split(SPLIT_LINES).pop());
    assert.equal(got.ok, false);
    assert.equal(got.code, 'gone', '版が引けないことに種類が付いていない');
});

test('保存した記録は、他の言語のパーサでも読める（NaN を書かない）', (t) => {
    // **JSON に `NaN` は無い。** Python の `json` は既定で書き、既定で読み戻すので
    // **Python の中だけで見る限り何も壊れていないように見える**が、
    // ブラウザの `JSON.parse` は落ちる——記録は元画像の ComfyUI グラフを
    // そのまま持ち、毎回実行し直すノードは `IS_CHANGED` に `float('nan')` を返す。
    //
    // 塞ぐ道具（`unbake/utils/json_io.py`）は在ったのに、**呼んでいる場所が
    // 1つも無かった**（2026-08-24 に改造版と突き合わせて発覚）。
    const out = run(t, `${PRELUDE}
settings = Settings({"record_source_dirs": [source], "record_output_dir": output})
body = {"id": "nan-1", "title": "t",
        "prompt": {"3": {"class_type": "Text", "inputs": {"is_changed": float("nan")}}},
        "cfg": float("inf")}
result = records.save_record(settings, body)
written = open(os.path.join(output, "nan-1.unbake.json"), encoding="utf-8").read()
print(json.dumps({"ok": result["ok"], "text": written}))
`);
    if (!out) return;
    assert.equal(out.ok, true);
    // **合格条件を「Python で読めること」にしない。** それが見逃しの正体だった。
    let parsed = null;
    assert.doesNotThrow(() => { parsed = JSON.parse(out.text); },
        '書いた記録が JSON.parse で読めない');
    assert.equal(parsed.prompt['3'].inputs.is_changed, null,
        'JSON で表せない値を、数値として書いている');
    assert.equal(parsed.cfg, null, '無限大をそのまま書いている');
    // 検出器が生きているか——素の書き方ならこの検査は落ちる。
    assert.throws(() => JSON.parse('{"v": NaN}'), '検査器が緩い');
});

test('ディスクへ書く経路が、全部 strict な書き手を通っている', async () => {
    // **道具が在るだけでは発火しない。** `json_io.py` は移植されていたのに、
    // 呼んでいる場所が1つも無かった（2026-08-24 に改造版と突き合わせて発覚）。
    // 1箇所ずつ直しても次に足した所で戻るので、
    // **「素の json.dump が残っていないこと」**を形で固定する。
    //
    // 探すのは**文字列だけ**で行う。正規表現を組むと、逃がし損ねた日に
    // **空振りしたまま緑になる**（空集合に対する全称は必ず真）。
    const { readFile, readdir } = await import('node:fs/promises');
    const WORD = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_';
    const files = [];
    const walk = async (at) => {
        for (const entry of await readdir(at, { withFileTypes: true })) {
            if (entry.name === '__pycache__') continue;
            const full = path.join(at, entry.name);
            if (entry.isDirectory()) await walk(full);
            else if (entry.name.endsWith('.py')) files.push(full);
        }
    };
    await walk(path.join(ROOT, 'unbake'));
    assert.ok(files.length >= 10, `走査が ${files.length} 件しか拾っていない`);

    const offenders = [];
    let scanned = 0;
    for (const file of files) {
        if (file.endsWith(path.join('utils', 'json_io.py'))) continue;   // 器そのもの
        const source = await readFile(file, 'utf8');
        source.split('\n').forEach((line, index) => {
            for (const needle of ['json.dump(', 'json.dumps(']) {
                const at = line.indexOf(needle);
                if (at < 0) continue;
                // `dumps_json_strict(` などに含まれる `json.dump` を拾わない。
                const before = at > 0 ? line[at - 1] : ' ';
                if (WORD.includes(before) || before === '.') continue;
                scanned += 1;
                offenders.push(`${path.relative(ROOT, file)}:${index + 1}`);
            }
        });
    }
    // 検出器が生きているか——器の側には素の呼び出しが実在する。
    const io = await readFile(path.join(ROOT, 'unbake', 'utils', 'json_io.py'), 'utf8');
    assert.ok(io.includes('json.dumps(') && io.includes('json.dump('),
        '検査の当てどころが変わっている（器に素の呼び出しが無い）');
    assert.deepEqual(offenders, [], '素の json.dump が残っている（NaN を書ける経路）');
    assert.equal(scanned, 0);
});

test('上限に当たったことを「もう引けない」と混ぜない', (t) => {
    // **打つ手が正反対**（待つ / 諦める）なのに、429 も「版が消えた」も
    // 同じ顔で出ていた。しかも黙って続けると叩き続けることになる。
    const out = run(t, `${PRELUDE}
import urllib.error
from unbake import civitai

class FakeHeaders:
    def get(self, key, default=None):
        return "7" if key == "Retry-After" else default

def limited(request, timeout=30):
    url = request.full_url if hasattr(request, "full_url") else str(request)
    raise urllib.error.HTTPError(url, 429, "Too Many Requests", FakeHeaders(), None)

# **本物の _get_json を通す。** 分岐はその中に在るので、
# 差し替えるのは**その外側**（実際に投げる所）でなければ意味が無い。
real = civitai.urllib.request.urlopen
civitai.urllib.request.urlopen = limited
try:
    got = civitai.resolve_version("12345")
finally:
    civitai.urllib.request.urlopen = real
print(json.dumps({"code": got.get("code"), "retryAfter": got.get("retryAfter"), "error": got.get("error")}))
`);
    if (!out) return;
    assert.equal(out.code, 'rate_limited', '429 を「もう引けない」と混ぜている');
    assert.equal(out.retryAfter, 7, 'Retry-After を読んでいない');
    assert.match(String(out.error), /slow down/, '理由が読めない');
});

test('出た絵を消す口は、置き場の外を消さない', (t) => {
    // **ここへ着いた時点で戻せない。** `..` や絶対パスで抜けられると、
    // 「出た絵を消す」口がライブラリを消す口になる（2026-08-25）。
    const root = mkdtempSync(path.join(os.tmpdir(), 'unbake-out-'));
    const outside = mkdtempSync(path.join(os.tmpdir(), 'unbake-far-'));
    const sub = path.join(root, 'sub');
    mkdirSync(sub);
    writeFileSync(path.join(sub, 'a.png'), 'x', 'utf8');
    writeFileSync(path.join(outside, 'c.png'), 'x', 'utf8');
    const res = python([
        'import sys, json',
        'sys.path.insert(0, ".")',
        'from unbake import outputs',
        `outputs._default_output_dir = lambda: ${JSON.stringify(root)}`,
        'inside = outputs.delete_output("a.png", "sub")',
        'sep = outputs.delete_output("../c.png", "")',
        `escape = outputs.delete_output("c.png", "../" + ${JSON.stringify(path.basename(outside))})`,
        'print("R:" + json.dumps({"inside": inside["ok"], "sep": sep["ok"], "escape": escape["ok"]}))',
    ].join('\n'));
    const stillThere = existsSync(path.join(outside, 'c.png'));
    const gone = !existsSync(path.join(sub, 'a.png'));
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    if (res === null) { t.skip('python が見つからない'); return; }
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout.match(/R:(.*)/)[1]);
    assert.equal(out.inside, true, '置き場の中を消せていない');
    assert.equal(gone, true, '消したと言って残っている');
    assert.equal(out.sep, false, '名前に区切りを混ぜて抜けられる');
    assert.equal(out.escape, false, '`..` で置き場の外へ抜けられる');
    assert.equal(stillThere, true, '置き場の外を消している');
});
