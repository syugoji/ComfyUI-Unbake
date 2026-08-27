# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**使っているのに import していないモジュールが無いこと。**

2026-08-26 に実際にやった: `routes.py` の `import json` を置換で消したまま、
**構文検査は通り**、`json.` を7箇所で使ったままになった。
`import` の欠落は文法的には正しいので、**動かして初めて落ちる**——
しかも落ちるのはその行を通ったときだけなので、機能ごと静かに死ぬ。

**モジュールを実際に import すれば済む話ではない。** `routes.py` は
ComfyUI の `folder_paths` を要求するので、素の Python では読み込めない。
だから構文木で見る。
"""
import ast
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

#: 標準ライブラリのうち、`名前.属性` の形で使うもの。
#: **網羅する必要は無い**——ここに無いものは検査から漏れるだけで、
#: 誤って赤くすることはない（見落とす側へ倒してある）。
WATCHED = {
    "json", "os", "sys", "time", "threading", "base64", "hashlib", "shutil",
    "tempfile", "urllib", "asyncio", "re", "math", "logging", "uuid", "zipfile",
    "struct", "importlib", "copy", "csv", "glob", "inspect", "itertools",
}


def _python_files():
    for path in (ROOT / "unbake").rglob("*.py"):
        if "__pycache__" in path.parts:
            continue
        yield path


class ImportsCompleteTest(unittest.TestCase):
    def test_使っているモジュールをimportしている(self):
        problems = []
        for path in _python_files():
            tree = ast.parse(path.read_text(encoding="utf-8"))
            imported = set()
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        imported.add((alias.asname or alias.name).split(".")[0])
                elif isinstance(node, ast.ImportFrom):
                    for alias in node.names:
                        imported.add(alias.asname or alias.name)
                # 局所 import も数える（関数の中で import することがある）
            # `名前.属性` の形で参照されている名前。
            used = set()
            for node in ast.walk(tree):
                if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
                    used.add(node.value.id)
            # 局所変数や引数を除くため、**見張る名前だけ**に絞る。
            for name in sorted((used & WATCHED) - imported):
                problems.append(f"{path.relative_to(ROOT)}: {name} を import していない")
        self.assertEqual(problems, [], "\n".join(problems))

    def test_検査対象が空でない(self):
        # **0件を合格と読まない。** 走査が壊れていれば、何も見ずに緑になる。
        self.assertGreaterEqual(len(list(_python_files())), 10)


if __name__ == "__main__":
    unittest.main()
