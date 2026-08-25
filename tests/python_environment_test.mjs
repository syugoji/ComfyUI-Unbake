/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * Python 側の注入口を、実際に Python を起こして確かめる。
 *
 * 切り出しで外したのは `py/config.py` / `py/services/settings_manager.py` /
 * `py/services/downloader.py` の3本。**使用面積は極小だが、外し方を間違えると
 * 「既定値へ黙って落ちる」形になり、テストは緑のまま実機だけが別物を読む。**
 *
 * `node:test` から回すのは、リポジトリの CI がこのディレクトリを
 * `node --test` で拾うからである（実行主体を2つに分けない）。
 * Python が無い環境では skip する——**「走らなかった」を「通った」にしない。**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * **`-c` でコードを渡さない。** Windows でシェル経由に渡すと引用符が落ち、
 * `print("ok")` が `print(ok)` になって NameError で落ちる——そして
 * 「python が無い」と読める形で skip されるので、**検査ごと静かに消える**
 * （実際にそうなっていた。5件が「python が見つからない」で skip されていた）。
 * 一時ファイルへ書いてパスだけ渡す。
 */
function python(code) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'unbake-'));
    const file = path.join(dir, 'probe.py');
    writeFileSync(file, code, 'utf8');
    try {
        for (const exe of ['python', 'python3', 'py']) {
            const res = spawnSync(exe, [file], {
                cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 60_000,
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

test('環境が未設置なら投げる（黙って既定値へ落ちない）', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    const res = python([
        'import sys; sys.path.insert(0, ".")',
        'from unbake.environment import require_environment, reset_environment',
        'reset_environment()',
        'try:',
        '    require_environment(); print("NO-RAISE")',
        'except RuntimeError as e:',
        '    print("RAISED" if "未設置" in str(e) else "WRONG:" + str(e))',
    ].join('\n'));
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /RAISED/, res.stdout + res.stderr);
});

test('注入するものの形が違えば据える時点で弾く', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    // **同期/非同期の食い違いも契約。** await されないコルーチンとして静かに落ちるので、
    // 入口で弾かないと「全緑のまま何も落ちてこない」状態になる。
    const res = python([
        'import sys; sys.path.insert(0, ".")',
        'from unbake.environment import UnbakeEnvironment',
        'class S:',
        '    def get(self, key, default=None): return default',
        'def sync_download(url, save_path, progress_callback=None): return (True, save_path)',
        'out = []',
        'try:',
        '    UnbakeEnvironment(settings=object())',
        'except TypeError: out.append("settings-rejected")',
        'try:',
        '    UnbakeEnvironment(settings=S(), download_file=sync_download)',
        'except TypeError: out.append("sync-download-rejected")',
        'UnbakeEnvironment(settings=S())',
        'out.append("valid-accepted")',
        'print(",".join(out))',
    ].join('\n'));
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), 'settings-rejected,sync-download-rejected,valid-accepted');
});

test('モデル格納先は注入で差し替えられ、未知の種別は投げる', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    // 未知の鍵を空で返すと「設定されていない」と見分けが付かなくなる。
    const res = python([
        'import sys; sys.path.insert(0, ".")',
        'from unbake.environment import UnbakeEnvironment',
        'class S:',
        '    def get(self, key, default=None): return default',
        'env = UnbakeEnvironment(settings=S(), model_roots=lambda kind: ["/models/" + kind])',
        'print(env.model_roots("loras")[0])',
        'print(env.model_roots("checkpoints")[0])',
        'try:',
        '    env.model_roots("nope"); print("NO-RAISE")',
        'except KeyError: print("RAISED")',
    ].join('\n'));
    assert.equal(res.status, 0, res.stderr);
    const lines = res.stdout.trim().split(/\r?\n/);
    assert.deepEqual(lines, ['/models/loras', '/models/checkpoints', 'RAISED']);
});

test('ダウンローダ未設置のまま落とそうとしたら投げる', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    const res = python([
        'import sys, asyncio; sys.path.insert(0, ".")',
        'from unbake.environment import UnbakeEnvironment',
        'class S:',
        '    def get(self, key, default=None): return default',
        'env = UnbakeEnvironment(settings=S())',
        'try:',
        '    asyncio.run(env.download_file("http://x/y", "/tmp/y")); print("NO-RAISE")',
        'except RuntimeError as e:',
        '    print("RAISED" if "未設置" in str(e) else "WRONG")',
    ].join('\n'));
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /RAISED/);
});

test('unbake パッケージ全体が上流なしで import できる', (t) => {
    if (!havePython) { t.skip('python が見つからない'); return; }
    // **これが切り出しの成否そのもの。** 上流の1本でも残っていれば ImportError になる。
    const res = python([
        'import sys, importlib; sys.path.insert(0, ".")',
        'mods = [',
        '  "unbake", "unbake.environment",',
        '  "unbake.services.raindrop_sync_service",',
        '  "unbake.services.known_model_catalog",',
        '  "unbake.services.known_model_downloader",',
        '  "unbake.services.recipes.replay_manifest_service",',
        '  "unbake.services.recipes.resource_availability_service",',
        '  "unbake.services.recipes.sweep_service",',
        '  "unbake.utils.model_file_names",',
        '  "unbake.utils.recipe_pnginfo",',
        ']',
        'for m in mods: importlib.import_module(m)',
        'print("IMPORTED", len(mods))',
    ].join('\n'));
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /IMPORTED 10/);
});
