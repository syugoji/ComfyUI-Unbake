# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**入口から辿れない Python モジュールが、宣言した表と一致すること。**

JS 側には `tests/defects_test.mjs` の `KNOWN_UNREACHED` という同じ見張りが
以前から在ったが、**Python 側には無かった**。だから 2026-08-26 の棚卸しまで、
`known_model_catalog.py`(536行) と `known_model_downloader.py`(232行) が
**どこからも呼ばれないまま**残っているのに誰も気づかなかった——中身は
「拡散モデルに付いてくるテキストエンコーダと VAE を落とす」という、
実際に要る機能だった。

**片側だけ見張ると、見張っていない側へ溜まる。** ここは0にはできない
（順に配線していく）ので、**宣言と実物が一致することだけ**を固定する。
配線したらこの表から1行消す（進みが表から読める）。
"""
import ast
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

#: 入口。ComfyUI が読むのはここだけ。
ENTRY = "__init__.py"

#: **入口から辿れないと判っているもの。** 理由を添える。
KNOWN_UNREACHED = {
    # --- Raindrop の同期（1,003行）------------------------------------------
    # Unbake が実際に使っているのは `unbake/raindrop.py`（付箋を読むだけ）で、
    # 取り込みは画面側が行う。この2つは**同梱の同期スクリプトを回す**別系統で、
    # 子プロセスをやめて同一プロセス内へ移す作業まで済んでいるが繋いでいない。
    # **`create_subprocess_exec` の語は説明のコメントにしか残っていない**
    #（Registry の走査は到達性を見ないので、実行系の語は原文から消してある）。
    "unbake/services/raindrop_sync_service.py",
    "unbake/services/sync_script_runner.py",
    # --- レシピの重い機能（1,971行）-----------------------------------------
    # 再現の証拠マニフェスト・素材の配布状況・改訂の不変履歴・振りの保存。
    # どれも独立して完結しており、繋ぐ先は画面側（そちらも孤児）。
    "unbake/services/recipes/__init__.py",
    "unbake/services/recipes/replay_manifest_service.py",
    "unbake/services/recipes/resource_availability_service.py",
    "unbake/services/recipes/revision_service.py",
    "unbake/services/recipes/sweep_service.py",
    # --- 出力メタデータ（143行）---------------------------------------------
    # A1111 形式のパラメータ文字列を組む。書き込む側（`recipe_pnginfo.py`）は
    # 届いているので、**片側だけが孤児**。
    "unbake/utils/generation_metadata.py",
    # `model_file_validation.py` は 2026-08-26 に配線した——ハッシュが無いときの
    # 二の矢として、落とし終わった中身の形を見る（`Content-Type` を見る一の矢は
    # 元から在り、`text/html` と名乗る相手はそこで弾いている）。
}


def _modules():
    out = []
    for path in ROOT.rglob("*.py"):
        rel = path.relative_to(ROOT).as_posix()
        if "__pycache__" in rel or rel.startswith("tests/"):
            continue
        # 配布物の外（同梱の別ツリー）は見張らない。
        if rel.startswith("civitai_recipe_sync/"):
            continue
        out.append(rel)
    return sorted(out)


def _imports(rel: str):
    """このファイルが読む、同じツリーの中のモジュール。"""
    tree = ast.parse((ROOT / rel).read_text(encoding="utf-8"))
    here = Path(rel).parent
    found = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            if node.level:                      # 相対 import
                base = here
                for _ in range(node.level - 1):
                    base = base.parent
                target = base / node.module.replace(".", "/") if node.module else base
            elif str(node.module or "").startswith("unbake"):
                target = Path(node.module.replace(".", "/"))
            else:
                continue
            found.add(target.as_posix() + ".py")
            found.add((target / "__init__.py").as_posix())
            # `from .pkg import name` の `name` がモジュールのこともある
            for alias in node.names:
                found.add((target / alias.name).as_posix() + ".py")
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.startswith("unbake"):
                    found.add(alias.name.replace(".", "/") + ".py")
    return found


class PythonReachabilityTest(unittest.TestCase):
    def test_入口から辿れないものが宣言と一致する(self):
        every = _modules()
        self.assertGreaterEqual(len(every), 20, "走査が壊れている")
        self.assertIn(ENTRY, every, "入口を見つけられていない")

        seen = set()
        stack = [ENTRY]
        while stack:
            rel = stack.pop()
            if rel in seen:
                continue
            seen.add(rel)
            # **袋の印は、中身へ届いた時点で届いている。** `__init__.py` は
            # `from .services.x import y` で暗黙に読まれるので、これを孤児に
            # 数えると「置いてあるだけの空ファイル」で表が埋まる。
            parent = Path(rel).parent
            while str(parent) not in (".", ""):
                seen.add((parent / "__init__.py").as_posix())
                parent = parent.parent
            for target in _imports(rel):
                if target in every and target not in seen:
                    stack.append(target)

        unreached = sorted(set(every) - seen)
        self.maxDiff = None
        self.assertEqual(
            unreached, sorted(KNOWN_UNREACHED),
            "孤児の一覧が宣言と食い違う（配線したなら表から消す・生えたなら繋ぐ）",
        )

    def test_見張りが生きている(self):
        # **0件を合格と読まない。** 入口を辿れていなければ、
        # 全部が孤児になるか、全部が到達済みになる。
        reached = _imports(ENTRY)
        self.assertTrue(any("routes" in r for r in reached),
                        "入口から routes へ辿れていない（走査が壊れている）")


if __name__ == "__main__":
    unittest.main()
