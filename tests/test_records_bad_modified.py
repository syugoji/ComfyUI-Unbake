# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**壊れた1件で一覧を全滅させない**（2026-08-31・監査 I-20260831-29）。

`_index` の行は `"modified": data.get("modified") or modified` で作られる。
左辺はレシピ JSON 由来なので**任意の型が来る**——文字列の日付、辞書、真偽値。
一方 `list()` は `-(row.get("modified") or 0)` で並べ替えるので、
数でない値が1つでも混じると **`TypeError` で `/unbake/records` が全件 500**
になる。1件の壊れたレシピが、他の何百件も道連れにする。

**落ちどころが悪い。** 一覧はパネルの入口なので、開いた瞬間に何も出ない。
利用者からは「拡張が壊れた」に見えるが、直すべきは1つのファイルだけである。

**取り込みの時点で数へ寄せる。** 並べ替え側だけを防御すると、数でない値が
そのまま画面まで流れて「日付の欄が辞書」のような別の壊れ方になる。
"""
import json
import os
import tempfile
import unittest

from unbake.library import RecordLibrary


class _Settings:
    """書庫が読む最小の設定。**実物と同じ `get(key, default)` だけ持つ。**"""

    def __init__(self, values):
        self._values = dict(values)

    def get(self, key, default=None):
        return self._values.get(key, default)


def write(dirpath, name, payload):
    path = os.path.join(dirpath, name)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)
    return path


class BadModifiedTest(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.mkdtemp()

    def _library(self):
        return RecordLibrary(_Settings({"record_source_dirs": [self._dir]}))

    def test_modified_が文字列でも一覧が返る(self):
        """**これが本体。** 1件の壊れた値で全件を落とさない。"""
        write(self._dir, "good.recipe.json", {"id": "good", "title": "good", "modified": 1000})
        write(self._dir, "bad.recipe.json",
              {"id": "bad", "title": "bad", "modified": "2026-01-01T00:00:00Z"})

        rows, total = self._library().summaries(offset=0, limit=50)

        self.assertEqual(total, 2, "壊れた1件で全件が落ちている")
        ids = sorted(row["id"] for row in rows)
        self.assertEqual(ids, ["bad", "good"], "壊れた行だけ落としている（黙って消さない）")

    def test_modified_が辞書や真偽値でも落ちない(self):
        write(self._dir, "a.recipe.json", {"id": "a", "title": "a", "modified": {"when": "later"}})
        write(self._dir, "b.recipe.json", {"id": "b", "title": "b", "modified": True})
        write(self._dir, "c.recipe.json", {"id": "c", "title": "c", "modified": [1, 2]})

        rows, total = self._library().summaries(offset=0, limit=50)
        self.assertEqual(total, 3)
        for row in rows:
            self.assertIsInstance(
                row.get("modified"), (int, float, type(None)),
                "数でない値が画面まで流れている: %r" % (row.get("modified"),))

    def test_数の文字列は数として読む(self):
        """**捨てるのではなく寄せる。** 実際に順番へ効く値なので。"""
        write(self._dir, "x.recipe.json", {"id": "x", "title": "x", "modified": "1500"})
        write(self._dir, "y.recipe.json", {"id": "y", "title": "y", "modified": 900})
        rows, _ = self._library().summaries(offset=0, limit=50)
        self.assertEqual([row["id"] for row in rows], ["x", "y"],
                         "数の文字列を捨てて、並び順が狂っている")

    def test_対照_普通の記録は今までどおり新しい順(self):
        write(self._dir, "old.recipe.json", {"id": "old", "title": "old", "modified": 100})
        write(self._dir, "new.recipe.json", {"id": "new", "title": "new", "modified": 200})
        rows, total = self._library().summaries(offset=0, limit=50)
        self.assertEqual(total, 2)
        self.assertEqual([row["id"] for row in rows], ["new", "old"])


if __name__ == "__main__":
    unittest.main()
