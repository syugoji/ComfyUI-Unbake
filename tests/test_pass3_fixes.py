# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**走査3周目で確定した分**（2026-08-31）。

- ``usage()`` がプロンプトへ直書きされた LoRA を数える
- 見本の URL を、変換指定がどの区画に在っても縮める
"""
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from unbake import models
from unbake.library import RecordLibrary
from unbake.model_previews import _thumbnail_url


RECORD = (
    '{"id": "%s", "title": "%s", "checkpoint": "base.safetensors",'
    ' "loras": %s, "gen_params": {"prompt": "%s"}}'
)


class PromptWrittenLoraTest(unittest.TestCase):
    """**「使用0件」と出たモデルが、実は使われている**を作らない。

    ``usage()`` は削除の前に「何件が使っているか」を見せる口である。
    構造化された ``loras`` にしか現れない前提だったので、
    ``<lora:名前:強さ>`` と本文へ書いただけの記録を1件も数えていなかった
    ——**外れる向きが一番悪い**（消してよいと読める）。
    """

    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.root = Path(self._tmp.name)
        # 構造化された並びには入っていない。**本文にだけ在る。**
        (self.root / "a.recipe.json").write_text(
            RECORD % ("a", "a", "[]", "1girl, <lora:ZodaPlus:0.8>, standing"),
            encoding="utf-8")
        # 構造化された並びに在る（従来から数えられていた側）。
        (self.root / "b.recipe.json").write_text(
            RECORD % ("b", "b", '[{"file_name": "ZodaPlus.safetensors"}]', "1girl"),
            encoding="utf-8")
        # どちらでもない。
        (self.root / "c.recipe.json").write_text(
            RECORD % ("c", "c", "[]", "1girl"), encoding="utf-8")
        self.library = RecordLibrary({"record_source_dirs": [str(self.root)]})
        self.library.scan()

    def tearDown(self):
        self._tmp.cleanup()

    def test_本文に直書きされたLoRAを数える(self):
        out = models.usage(self.library, "ZodaPlus.safetensors")
        ids = sorted(row["id"] for row in out["records"])
        self.assertEqual(ids, ["a", "b"], f"数え落としている: {out}")
        self.assertEqual(out["count"], 2)

    def test_どちらの経路で当たったかを言う(self):
        out = models.usage(self.library, "ZodaPlus")
        kinds = {row["id"]: row["as"] for row in out["records"]}
        self.assertEqual(kinds.get("a"), "prompt-lora")
        self.assertEqual(kinds.get("b"), "lora")

    def test_対照_使っていない記録は数えない(self):
        out = models.usage(self.library, "SomethingElse.safetensors")
        self.assertEqual(out["count"], 0, f"当たってはいけない: {out}")

    def test_要約が本文のLoRAを持っている(self):
        """**切る前の全文から取る。** 要約の `prompt` は 400字で切ってある。"""
        row = self.library.raw_row("a")
        self.assertEqual(row["prompt_loras"], ["ZodaPlus"])
        self.assertEqual(self.library.raw_row("c")["prompt_loras"], [])

    def test_長い本文の後ろに在っても拾う(self):
        """要約の `prompt` を読んでいたら、ここで落ちる。"""
        (self.root / "d.recipe.json").write_text(
            RECORD % ("d", "d", "[]", "x" * 900 + ", <lora:FarAway:1>"),
            encoding="utf-8")
        self.library.scan()
        self.assertEqual(self.library.raw_row("d")["prompt_loras"], ["FarAway"])
        self.assertEqual(models.usage(self.library, "FarAway.safetensors")["count"], 1)


class ThumbnailUrlTest(unittest.TestCase):
    """**縮める所を末尾に限らない。**

    元は ``url.endswith("/orig")`` だけを見ていたので、変換指定が途中の区画に
    在る形では一度も縮まず、**原寸を集め続けて**いた（実測で1枚 2.5〜3.6MB）。
    """

    def test_途中の区画でも縮める(self):
        self.assertEqual(
            _thumbnail_url("https://image.civitai.com/uuid/orig/00001.jpeg"),
            "https://image.civitai.com/uuid/width=450/00001.jpeg")

    def test_original_指定も縮める(self):
        self.assertEqual(
            _thumbnail_url("https://image.civitai.com/uuid/original=true,q=90/x.jpeg"),
            "https://image.civitai.com/uuid/width=450/x.jpeg")

    def test_対照_末尾の形はこれまでどおり(self):
        self.assertEqual(
            _thumbnail_url("https://image.civitai.com/uuid/orig"),
            "https://image.civitai.com/uuid/width=450")

    def test_知らない形は触らない(self):
        """**組み替えて 404 を作るより、原寸を1枚落とすほうが軽い。**"""
        for url in ("https://image.civitai.com/uuid/width=450/x.jpeg",
                    "https://example.com/a/b.png", ""):
            with self.subTest(url):
                self.assertEqual(_thumbnail_url(url), url)

    def test_originals_のような語を巻き込まない(self):
        url = "https://image.civitai.com/originals/x.jpeg"
        self.assertEqual(_thumbnail_url(url), url)


if __name__ == "__main__":
    unittest.main()
