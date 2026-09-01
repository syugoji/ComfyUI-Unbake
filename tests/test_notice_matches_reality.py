# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**NOTICE が実装と食い違わないこと**
（2026-08-31・監査 I-20260831-09, I-20260831-18）。

NOTICE は2箇所で事実と逆のことを書いていた。

1. 同梱スクリプトを「別プロセスで動かす・import しない」と書いていたが、
   **0.1.2 以降は同一プロセスで `sync_script_runner.py` が import している**。
   `pyproject.toml` は 2026-08-27 に同じ訂正を済ませていて、**NOTICE 側だけが
   子プロセス時代のまま残っていた**。

   害は再配布側に出る。「別プロセスで動く独立スクリプト」と読めば
   `civitai_recipe_sync/` を任意の同梱物とみなして外せてしまい、
   `resolve_script_path()` が `RaindropSyncConfigError` を投げて
   **Raindrop 同期が丸ごと死ぬ**——NOTICE 自身が「前のリリースで実際に
   起きた」と書いている事故に戻る。

2. 「bundles no npm dependency and no Python dependency」と締めていたが、
   同梱スクリプトは第三者パッケージ `requests` を import する。
   宿主（ComfyUI の `requirements.txt`）が供給するので**依存を足していない**
   のは本当だが、**「何も import しない」とは読めてしまう**。

**文章は再び嘘になりうる**（実際4箇所そろって嘘になった `.gitignore` の例が
ある）ので、機械で留める。

## I-20260831-18 について

`tests/test_sync_script_load.py` の docstring は4つを守ると宣言しているが、
実測できているのは4番目（原文 grep）だけだった——1〜3は同梱スクリプトを
直接 import しているだけで、**製品側の `sync_script_runner.py` を1行も
実行していない**。変異で確認済み（`_apply_cli_flags` の呼び出しを消しても
Python 133 passed / JS 0 fail）。ここでその1行を実際に通す。
"""
import ast
import inspect
import io
import os
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(rel):
    with io.open(os.path.join(ROOT, rel), encoding="utf-8") as handle:
        return handle.read()


class NoticeMatchesRealityTest(unittest.TestCase):
    def setUp(self):
        self.notice = read("NOTICE")

    def test_同一プロセスで_import_していると書いてある(self):
        self.assertIn(
            "same process", self.notice,
            "NOTICE が同一プロセスでの import に触れていない"
            "（再配布側が同梱物を任意と読んで外し、Raindrop 同期が死ぬ）")

    def test_子プロセス時代の記述が残っていない(self):
        # **打ち消しの文脈でだけ残す**（訂正の経緯は消さない）。
        stale = "it is not imported"
        if stale in self.notice:
            where = self.notice.index(stale)
            around = self.notice[max(0, where - 400):where + 200]
            self.assertIn(
                "used to say", around,
                "「import しない」が訂正の文脈なしに残っている")

    def test_同梱スクリプトが実際に_import_しているものが_NOTICE_に在る(self):
        """**原文を読んで数える。** 名前を足したら NOTICE も足す。"""
        source = read("civitai_recipe_sync/civitai_image_download.py")
        third_party = set()
        stdlib = {
            "os", "re", "sys", "json", "time", "hashlib", "traceback",
            "concurrent", "concurrent.futures", "argparse", "logging",
            "pathlib", "typing", "urllib", "shutil", "datetime", "base64",
            "io", "math", "random", "collections", "itertools", "functools",
            "tempfile", "subprocess", "threading", "signal", "textwrap",
        }
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    third_party.add(alias.name.split(".")[0])
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                third_party.add(node.module.split(".")[0])
        third_party -= stdlib

        self.assertTrue(third_party, "import を1つも拾えていない（走査が壊れている）")
        for name in sorted(third_party):
            self.assertIn(
                name, self.notice,
                "同梱スクリプトが %s を import しているのに NOTICE に無い" % name)

    def test_依存ゼロの宣言が_import_ゼロと読めない形になっている(self):
        self.assertIn(
            "requests", self.notice,
            "「no Python dependency」だけが残っていて、`requests` を数え落とす")


class SyncScriptRunnerBehaviourTest(unittest.TestCase):
    """I-20260831-18: 製品側の1行を実際に通す。"""

    def test_CLIフラグを当てる呼び出しが実在する(self):
        from unbake.services import sync_script_runner as module

        source = inspect.getsource(module)
        self.assertIn(
            "_apply_cli_flags", source,
            "CLI フラグを当てる経路が消えている（無人実行の判定が効かなくなる）")

    def test_設定を読み直す呼び出しが実在する(self):
        from unbake.services import sync_script_runner as module

        source = inspect.getsource(module)
        self.assertIn(
            "importlib.reload", source,
            "設定の読み直しが消えている（前回の値のまま走る）")

    def test_apply_cli_flags_が実際にスクリプトの口へ渡る(self):
        """**原文 grep で終わらせない。** 呼んで、引数が届くことを見る。

        引数の解釈はスクリプト側の責任なので、こちらが真似してはいけない
        （実装のコメントがそう書いている）。だから測るのは
        **「スクリプトの `apply_cli_flags()` へそのまま渡ったか」**だけ。
        """
        from unbake.services.sync_script_runner import SyncScriptRunner

        runner = SyncScriptRunner.__new__(SyncScriptRunner)
        seen = []

        class FakeScript:
            @staticmethod
            def apply_cli_flags(argv):
                seen.append(list(argv))

        runner._apply_cli_flags(FakeScript, ["--unattended", "--limit", "3"])
        self.assertEqual(
            seen, [["--unattended", "--limit", "3"]],
            "CLI フラグがスクリプトへ届いていない（無人実行の判定が素通りする）")

    def test_口の無い配布物は_そうと判る形で落ちる(self):
        """**対照。** 壊れた配布物を黙って通さないこと。"""
        from unbake.services.sync_script_runner import SyncScriptRunner

        runner = SyncScriptRunner.__new__(SyncScriptRunner)

        class Broken:
            pass

        with self.assertRaises(AttributeError) as caught:
            runner._apply_cli_flags(Broken, ["--unattended"])
        self.assertIn("apply_cli_flags", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
