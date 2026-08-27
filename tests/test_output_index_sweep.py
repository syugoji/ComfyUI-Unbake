# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**Unbake が出した絵を、Unbake の口から引けること**（2026-08-26 実機）。

索引は画像から2種類の印を読む:

    recipe_id     LoRA Manager が焼くレシピ参照
    unbake_sweep  Unbake が自分で投げるときに焼く印（`record_id` を持つ）

ところが照合は `recipe_id` としか比べていなかった。`sweep` は読んで控えにも
入れているのに**一度も照合に使っていない**ので、**Unbake 自身が出した絵は
1枚も引けなかった**——この関数の説明が「自分が Sweep で回した分がここに
貯まる」と言っているまさにその分が、丸ごと落ちていた。

実測: `civitai_137684933_00002_.png` は
`unbake_sweep = {..., "record_id": "137684933"}` を持つのに、
`/unbake/outputs?id=137684933` は 0 件を返した。
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from unbake.services import recipe_output_index as roi  # noqa: E402


def sweep_stamp(record_id):
    """実物の形（`sweepRunner.js` の `buildSweepStamp` が焼くもの）。"""
    return {
        "schema": "unbake.sweep", "version": 1, "record_id": record_id,
        "template_id": "replay-1", "job_id": "j1", "cell_id": "c1", "signature": "s1",
    }


class SweepStampLookupTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        for name in ("own.png", "recipe.png", "other.png", "bare.png"):
            with open(os.path.join(self.dir, name), "wb") as f:
                f.write(b"x")
        self.index = roi.RecipeOutputIndex(output_dir_getter=lambda: self.dir)

        def fake_recipe(path):
            # LoRA Manager の参照を持つのは1枚だけ。
            return {"recipe_id": "rec-1"} if path.endswith("recipe.png") else None

        def fake_sweep(path):
            if path.endswith("own.png"):
                return sweep_stamp("137684933")
            if path.endswith("other.png"):
                return sweep_stamp("999")
            return None

        for name, fake in (("read_recipe_reference_from_image", fake_recipe),
                           ("read_sweep_reference_from_image", fake_sweep)):
            patcher = mock.patch.object(roi, name, fake)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_自分が出した絵を引ける(self):
        got = self.index.get_outputs("137684933")
        self.assertEqual([item["filename"] for item in got], ["own.png"],
                         "Sweep の印で引けていない")
        # **印そのものも返す。** どの回のどのセルかは呼び手が使う。
        self.assertEqual(got[0]["sweep"]["record_id"], "137684933")

    def test_別の記録の絵は混ぜない(self):
        self.assertEqual(self.index.get_outputs("999"),
                         [item for item in self.index.get_outputs("999")])
        got = self.index.get_outputs("999")
        self.assertEqual([item["filename"] for item in got], ["other.png"])

    def test_レシピ参照は今までどおり引ける(self):
        got = self.index.get_outputs("rec-1")
        self.assertEqual([item["filename"] for item in got], ["recipe.png"],
                         "元から引けていた道を壊している")

    def test_印の無い絵は誰にも紐づかない(self):
        for wanted in ("137684933", "rec-1", "999"):
            self.assertNotIn("bare.png",
                             [item["filename"] for item in self.index.get_outputs(wanted)])

    def test_空のIDでは何も返さない(self):
        self.assertEqual(self.index.get_outputs(""), [])


if __name__ == "__main__":
    unittest.main()
