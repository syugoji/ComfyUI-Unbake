# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**走査3周目・選別3巡目で確定した分**（2026-08-31）。

どれも「**調べたが要らなかった**」と「**こちらが知らない／読めない**」を
1つに潰していた欠陥である。潰すと、利用者には**答えが出たように見える**。

- 伴走の表に無い系統を「何も要りません」と返す
- 名前が1つに決まったのに実体へ辿れない回を ``one`` と名乗る
- 静止画が無い理由3通りを、全部「動画しか無い」として**永久に**覚える
- 曖昧の件数を書いた注記が古い
"""
import io
import re
import unittest
from pathlib import Path
from unittest import mock

from unbake import models
from unbake.civitai import DIFFUSION_MODEL_BASE_MODELS
from unbake.model_previews import still_image_miss, pick_still_image
from unbake.services.known_model_catalog import companions_for, knows_companions

ROOT = Path(__file__).resolve().parent.parent


class CompanionCoverageTest(unittest.TestCase):
    """**「表に無い」を「何も要らない」と言わない。**"""

    def test_表に在る系統は知っていると言う(self):
        known = [b for b in DIFFUSION_MODEL_BASE_MODELS if knows_companions(b)]
        self.assertGreater(len(known), 0, "表が空＝検査が何も測っていない")
        for base in known:
            with self.subTest(base):
                self.assertTrue(companions_for(base), f"{base}: 知っているのに空")

    def test_表に無い系統は知らないと言う(self):
        unknown = [b for b in DIFFUSION_MODEL_BASE_MODELS if not knows_companions(b)]
        # 2026-08-31 実測で 42 系統中 26。**0 になったら検査が空振りしている。**
        self.assertGreater(len(unknown), 0, "表に無い系統が1つも無い＝空振り")
        for base in unknown:
            with self.subTest(base):
                self.assertEqual(companions_for(base), [])
                self.assertFalse(knows_companions(base))

    def test_知らないと空は見分けが付く(self):
        """**これが本体。** どちらも `companions_for` は空を返す。"""
        self.assertEqual(companions_for("Wan Video"), [])
        self.assertFalse(knows_companions("Wan Video"))
        self.assertFalse(knows_companions(None))
        self.assertFalse(knows_companions("   "))


class ResolveUnreadableTest(unittest.TestCase):
    """**名前が1つに決まっても、実体へ辿れなければ ``one`` ではない。**"""

    def _resolve(self, path):
        with mock.patch.object(models, "installed", return_value=["a.safetensors"]), \
             mock.patch.object(models, "full_path", return_value=path):
            return models.resolve("loras", "a.safetensors")

    def test_辿れなければ_unreadable(self):
        found = self._resolve(None)
        self.assertEqual(found["state"], "unreadable")
        self.assertEqual(found["path"], None)
        self.assertEqual(found["matches"], ["a.safetensors"])

    def test_対照_辿れれば_one(self):
        found = self._resolve("D:/models/a.safetensors")
        self.assertEqual(found["state"], "one")
        self.assertEqual(found["path"], "D:/models/a.safetensors")

    def test_消す口は無いと混ぜない(self):
        with mock.patch.object(models, "installed", return_value=["a.safetensors"]), \
             mock.patch.object(models, "full_path", return_value=None):
            with self.assertRaises(models.ModelError) as caught:
                models.delete("loras", "a.safetensors")
        message = str(caught.exception)
        self.assertIn("found the name but not the file", message)
        self.assertNotIn("not installed", message)


class StillImageMissTest(unittest.TestCase):
    """**「無い」の理由を1つに潰さない。**

    ``cached_miss`` は短絡するので、一度覚えると**画面から戻せない**。
    覚えてよいのは「本当に動画しか無い」ときだけ。
    """

    def test_動画しか無いなら覚えてよい(self):
        version = {"images": [{"type": "video", "url": "https://image.civitai.com/u/orig"}]}
        self.assertEqual(still_image_miss(version), "no-still-image")

    def test_知らないホストは覚えない側(self):
        version = {"images": [{"type": "image", "url": "https://cdn.example.com/x.jpeg"}]}
        self.assertEqual(still_image_miss(version), "unknown-image-host")

    def test_URLが空のときも別に言う(self):
        version = {"images": [{"type": "image", "url": ""}]}
        self.assertEqual(still_image_miss(version), "no-image-url")

    def test_対照_取れるなら理由は無い(self):
        version = {"images": [{"type": "image",
                               "url": "https://image.civitai.com/u/orig/x.jpeg"}]}
        self.assertIsNone(still_image_miss(version))
        self.assertTrue(pick_still_image(version))

    def test_覚えるのは動画のときだけ(self):
        """**これが本体。** 知らないホストを覚えると、配信元が1つ増えた日に
        全部のモデルが永久に「見本なし」になる。"""
        source = io.open(ROOT / "unbake" / "model_previews.py", encoding="utf-8").read()
        body = source[source.index("def fetch_preview"):]
        body = body[: body.index("\ndef ")]
        # **注記は呼び出しに数えない。** 429 の説明が `_remember_miss` へ
        # 言及しているので、素で数えると2件になり、しかも**注記のほうが先**に
        # 来るので「守りの前に呼んでいる」と誤読する（実際にそう落ちた）。
        body = re.sub(r"(?m)^\s*#.*$", "", body)
        remembers = re.findall(r"_remember_miss\(([^)]*)\)", body)
        self.assertEqual(len(remembers), 1, f"覚える所が1つでない: {remembers}")
        guard = body[: body.index("_remember_miss")]
        self.assertIn('reason == "no-still-image"', guard,
                      "理由を見ずに覚えている")


class AmbiguityNoteTest(unittest.TestCase):
    """注記の数字が、実装の扱いと食い違わないこと。"""

    def test_古い件数を残さない(self):
        """**部分削除は等価変異である。**

        1文だけ消しても、続く「ただし**9組とも大きさが一致**」が残るので
        情報は届く——だから緑のままでよい。段落を丸ごと消すと赤くなることは
        反実仮想で確かめてある（2026-08-31）。
        """
        source = io.open(ROOT / "unbake" / "models.py", encoding="utf-8").read()
        head = source[: source.index("ALLOWED_KINDS")]
        self.assertIn("曖昧 1", head, "元の実測を消さない（いつの数字かが読めなくなる）")
        self.assertIn("9組", head, "数え直した結果が書かれていない")
        self.assertIn("大きさが一致", head, "9組が複製であることが書かれていない")


if __name__ == "__main__":
    unittest.main()
