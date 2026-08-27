# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**取り込み直しで記録を置き換えられること。**

2026-08-26 の実機検証で塞がった。上書きしない決まりは手で直した内容を守る
ためだったが、そのせいで**取り出しを直しても記録が古いまま**になる。実機の
`civitai_139981506` は版IDも hash も持たない古い形のままで、**版IDが無いので
永久に落とせない**——取り込み直しても直らなかった。

**元は `.bak` へ退ける。** 置き換えを取り返しの付かない操作にしない。
"""
import json
import tempfile
import unittest
from pathlib import Path

from unbake.library import UNBAKE_SUFFIX
from unbake.records import save_record


class FakeSettings:
    def __init__(self, root):
        self._root = str(root)

    def get(self, key, default=None):
        if key in ("record_output_dir", "records_dir"):
            return self._root
        return default


def _recipe(**extra):
    base = {"id": "civitai_1", "title": "civitai_1",
            "checkpoint": {"file_name": "a.safetensors"}, "loras": [],
            "gen_params": {"prompt": "p"}}
    base.update(extra)
    return base


class ReplaceTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.settings = FakeSettings(self.root)

    def _path(self):
        return self.root / ("civitai_1" + UNBAKE_SUFFIX)

    def test_既定では上書きしない(self):
        self.assertTrue(save_record(self.settings, _recipe())["ok"])
        again = save_record(self.settings, _recipe(title="別"))
        self.assertFalse(again["ok"])
        self.assertEqual(again["error"], "already saved")
        self.assertEqual(json.loads(self._path().read_text(encoding="utf-8"))["title"], "civitai_1")

    def test_頼めば置き換える(self):
        save_record(self.settings, _recipe())
        got = save_record(
            self.settings,
            _recipe(checkpoint={"file_name": "a.safetensors", "modelVersionId": 123,
                                "evidence": "versionId"}),
            replace=True,
        )
        self.assertTrue(got["ok"], got)
        self.assertTrue(got["replaced"], "置き換えたことを返していない")
        body = json.loads(self._path().read_text(encoding="utf-8"))
        # **これが要点。** 版IDが入らないと、この記録は永久に落とせない。
        self.assertEqual(body["checkpoint"]["modelVersionId"], 123)

    def test_元を消さずに退ける(self):
        save_record(self.settings, _recipe(title="手で直した題"))
        save_record(self.settings, _recipe(title="読み直した題"), replace=True)
        backup = self._path().with_name(self._path().name + ".bak")
        self.assertTrue(backup.exists(), "元の記録を消している（取り返しが付かない）")
        self.assertEqual(json.loads(backup.read_text(encoding="utf-8"))["title"], "手で直した題")

    def test_控えは走査に引っかからない(self):
        # `.bak` が一覧へ出ると、同じ記録が二重に並ぶ。
        save_record(self.settings, _recipe())
        save_record(self.settings, _recipe(), replace=True)
        found = sorted(p.name for p in self.root.glob("*" + UNBAKE_SUFFIX))
        self.assertEqual(found, ["civitai_1" + UNBAKE_SUFFIX])

    def test_新しく書いたときは置き換えたと言わない(self):
        got = save_record(self.settings, _recipe(), replace=True)
        self.assertTrue(got["ok"])
        self.assertFalse(got["replaced"], "新規なのに置き換えたと言っている")

    def test_控えは1つだけ残す(self):
        save_record(self.settings, _recipe(title="1"))
        save_record(self.settings, _recipe(title="2"), replace=True)
        save_record(self.settings, _recipe(title="3"), replace=True)
        backup = self._path().with_name(self._path().name + ".bak")
        # **溜め込まない。** 直前の1つだけで足りる（何世代も要るなら別の仕掛け）。
        self.assertEqual(json.loads(backup.read_text(encoding="utf-8"))["title"], "2")
        self.assertEqual(len(list(self.root.glob("*.bak"))), 1)


if __name__ == "__main__":
    unittest.main()
