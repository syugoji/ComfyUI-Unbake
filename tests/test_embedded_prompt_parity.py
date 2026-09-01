# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**埋め込みグラフの探し先が、JS と Python でそろっていること**
（2026-09-01・走査12周目）。

同じ「記録のどこにグラフが入っているか」という知識が2箇所に在り、
**Python 側が3つ足りなかった**——しかも足りないのは、JS のコメントが
「**利用者の報告で足した**」と書いている当の3つだった:

* ``generation_metadata.comfy`` … Civitai 取り込みの一部は**ここにだけ**持つ。
  実測（手元347件）で**この経路だけを持つのが1件**——Wan の動画で、
  **動画の記録はこの形で来る**ので母数は増える側。
* ``generation_metadata.comfy_prompt`` … 同上。
* ``prompt`` … **こちらが書いた記録**（PNG の `prompt` チャンク）。

見落とすと ``source_kind`` が ``embedded`` にならず、
``_embedded_lora_evidence`` が**1件も証拠を出さない**
——「読めなかった」が「LoRA を使っていない」と同じ顔になる。

**一覧を写し合うのではなく、JS の原文から読んで突き合わせる**
（``tests/stamp_keys_match_server_test.mjs`` と
``tests/test_output_raw_reads.py`` が印の鍵について同じことをしている）。
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from unbake.services.recipes import replay_manifest_service as service  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
BUILDER = ROOT / "web" / "core" / "recipeWorkflowBuilder.js"

#: 最小の API 形式グラフ。**全部の値が `class_type` を持つ**こと。
GRAPH = {"3": {"class_type": "KSampler", "inputs": {"seed": 1}}}


def _js_candidates() -> set:
    """JS の `findEmbeddedPrompt` が見る場所を、**原文から**読む。

    返すのは ``"comfy"`` / ``"metadata.comfy"`` のような**経路の文字列**。
    """
    source = BUILDER.read_text(encoding="utf-8")
    block = re.search(
        r"function findEmbeddedPrompt\(recipe\) \{(.*?)\n\}", source, re.DOTALL)
    assert block, "JS 側の findEmbeddedPrompt が読めない（形が変わった）"
    found = re.findall(r"recipe\?\.([A-Za-z_?.]+)", block.group(1))
    return {path.replace("?.", ".") for path in found}


def _python_candidates() -> set:
    """Python の `_find_embedded_prompt` が見る場所を、**実際に通して**確かめる。

    原文を読まない——`recipe` の入れ子を1つずつ作って、拾えるかで判定する。
    """
    found = set()
    for path in _js_candidates():
        parts = path.split(".")
        recipe: dict = {}
        cursor = recipe
        for name in parts[:-1]:
            cursor[name] = {}
            cursor = cursor[name]
        cursor[parts[-1]] = GRAPH
        if service._find_embedded_prompt(recipe) is not None:
            found.add(path)
    return found


class 埋め込みグラフの探し先がそろっている(unittest.TestCase):
    def test_JS_の一覧が読める(self):
        """**前提の確認。** ここが崩れたら下の突き合わせは何も見ていない。"""
        js = _js_candidates()
        self.assertGreaterEqual(len(js), 7, "JS 側の候補が少なすぎる（読めていない）")
        self.assertIn("comfy", js)
        self.assertIn("prompt", js)

    def test_JS_が見る場所は_Python_も見る(self):
        missing = sorted(_js_candidates() - _python_candidates())
        self.assertEqual(
            missing, [],
            "JS が見ている場所を Python が見ていない"
            "（`source_kind` が embedded にならず、LoRA の証拠が1件も出ない）",
        )

    def test_利用者の報告で足した3つが通る(self):
        """**実測で1件しか無い経路でも落とさない**（動画の記録はこの形で来る）。"""
        for recipe in (
            {"generation_metadata": {"comfy": GRAPH}},
            {"generation_metadata": {"comfy_prompt": GRAPH}},
            {"prompt": GRAPH},
        ):
            with self.subTest(recipe=sorted(recipe)):
                self.assertIsNotNone(
                    service._find_embedded_prompt(recipe),
                    "この経路だけを持つ記録のグラフを見落としている",
                )

    def test_対照_文字列のプロンプトは通らない(self):
        """`prompt` は本文のこともある。**取り違えない。**"""
        self.assertIsNone(service._find_embedded_prompt({"prompt": "a photo of a cat"}))
        self.assertIsNone(service._find_embedded_prompt({"prompt": {"a": {"b": 1}}}))

    def test_対照_従来の経路は今までどおり(self):
        for recipe in (
            {"comfy": GRAPH},
            {"comfy_prompt": GRAPH},
            {"workflow": GRAPH},
            {"metadata": {"comfy": GRAPH}},
            {"raw_metadata": {"workflow": GRAPH}},
        ):
            with self.subTest(recipe=sorted(recipe)):
                self.assertIsNotNone(service._find_embedded_prompt(recipe))


if __name__ == "__main__":
    unittest.main()
