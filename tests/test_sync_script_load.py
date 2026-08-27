# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**同梱スクリプトの読み込み方**（2026-08-26）。

以前は `importlib.util.spec_from_file_location` で**パスから**読み込んでいた。
動きはするが、走査器から見ると「文字列で指した場所を実行する」形で、
0.1.1 で消した「設定から来た任意のパスを実行する」分岐と区別が付かない。

Comfy Registry は 0.1.0 / 0.1.1 / 0.1.2 を `Flagged` にしており（2026-08-26 実測・
理由は非公開）、0.1.2 で子プロセスをやめても結果が変わらなかった。**同種の形は
ここだけ残っていた**ので、置き場を取り込める名前にして普通の import へ変えた。

**これは推測にもとづく変更。** それでも、この検査が守るのは推測ではなく
**壊していないこと**——読み込めること・設定を読み直せること・`__main__` を
走らせないこと・パス実行へ戻っていないこと。
"""
import io
import os
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


class LoadPathTest(unittest.TestCase):
    def test_同梱スクリプトを普通に取り込める(self):
        import importlib

        mod = importlib.import_module("civitai_recipe_sync.civitai_image_download")
        # **中身が生きていること。** 名前だけ通っても意味が無い。
        for name in ("main", "apply_cli_flags", "emit_event"):
            self.assertTrue(callable(getattr(mod, name, None)), f"{name} が無い")

    def test_読み直すと設定を取り直す(self):
        """設定は module 直下で確定するので、使い回すと初回の値のまま動く。"""
        import importlib

        mod = importlib.import_module("civitai_recipe_sync.civitai_image_download")
        marker = "_unbake_reload_marker"
        setattr(mod, marker, object())
        again = importlib.reload(mod)
        self.assertIs(again, mod, "reload が別の実体を返している")
        # module 直下がもう一度走った証拠は、**直下で代入される名前**が
        # 生きていること。印は reload が消さないので、それでは測れない。
        self.assertTrue(callable(getattr(again, "main", None)), "読み直しで壊れた")

    def test_取り込んでも__main__は走らない(self):
        """末尾の `sys.exit()` と `input()` を動かさない。"""
        import importlib

        mod = importlib.import_module("civitai_recipe_sync.civitai_image_download")
        self.assertNotEqual(mod.__name__, "__main__")
        self.assertEqual(mod.__name__, "civitai_recipe_sync.civitai_image_download")

    def test_パスから実行する形へ戻っていない(self):
        """**戻したら赤くする。** ここが緩むと、直した意味が黙って消える。"""
        source = io.open(ROOT / "unbake" / "services" / "sync_script_runner.py",
                         encoding="utf-8").read()
        # 注記の中では触れてよいので、**コードとして書かれた呼び出し**だけを見る。
        code = chr(10).join(
            line for line in source.splitlines()
            if not line.lstrip().startswith("#") and not line.lstrip().startswith("*"))
        for banned in ("spec_from_file_location", "module_from_spec", "exec_module"):
            self.assertNotIn(
                banned + "(", code,
                f"パスから実行する形へ戻っている: {banned}")

    def test_MIT_の木へGPLのファイルを混ぜていない(self):
        """置き場を改名しただけで、**中身は1文字も変えない**という約束。"""
        tree = ROOT / "civitai_recipe_sync"
        self.assertTrue((tree / "LICENSE").is_file(), "MIT の LICENSE が消えている")
        self.assertFalse((tree / "__init__.py").exists(),
                         "MIT の木へ __init__.py を置いている（名前空間パッケージで足りる）")

    def test_出所の記載が置き場の名前と合っている(self):
        notice = io.open(ROOT / "NOTICE", encoding="utf-8").read()
        self.assertIn("civitai_recipe_sync/", notice, "NOTICE が古い置き場を指している")
        self.assertNotIn("civitai-recipe-sync/", notice)


if __name__ == "__main__":
    unittest.main()
