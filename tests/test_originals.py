# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**元画像の原寸**（`unbake/originals.py`・120行）に検査が1本も無かった。

`D-20260828-01` 群C。この口は `routes.py:1092` から実際に繋がっていて、
押されると外へ問い合わせに行く。**外へ出る口が無検査**だと、次の3つが
静かに壊れる:

  1. **取ってあるのに取りに行く** … 同じ絵は変わらないのに毎回外へ出る
  2. **Civitai でない記録で外へ出る** … ローカルの画像は原寸が手元に在る
  3. **`.red` を `.com` へ丸める** … 実測で出典の 326/340 件が `.red` 側

どれも「動いているように見える」形で壊れるので、実測で固定しておく。
"""
import os
import re
import tempfile
import unittest
from pathlib import Path

from unbake import originals


class ImageIdTest(unittest.TestCase):
    def test_comとredの両方から画像IDを取る(self):
        self.assertEqual(originals.image_id_of("https://civitai.com/images/140604778"), "140604778")
        self.assertEqual(originals.image_id_of("https://civitai.red/images/77742180"), "77742180")

    def test_civitai以外はNone(self):
        """**ここが None なら外へ出ない。** ローカルの画像に原寸取得は要らない。"""
        self.assertIsNone(originals.image_id_of("D:/out/ComfyUI_00444_.png"))
        self.assertIsNone(originals.image_id_of(None))
        self.assertIsNone(originals.image_id_of("https://example.com/images/1"))


class DomainTest(unittest.TestCase):
    def test_redを既定へ丸めない(self):
        """実測で出典の **326/340 件が `.red`**。丸めると全部が別ホストへ飛ぶ。"""
        self.assertEqual(originals.domain_of("https://civitai.red/images/1"), "civitai.red")
        self.assertEqual(originals.domain_of("https://civitai.com/images/1"), "civitai.com")

    def test_判らないときは既定のホスト(self):
        self.assertEqual(originals.domain_of(""), originals.API_HOSTS[0])


class CachedTest(unittest.TestCase):
    """**取ってあるかどうか**。拡張子は取ったときに決まるので順に探す。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._before = os.environ.get("UNBAKE_SETTINGS_DIR")
        os.environ["UNBAKE_SETTINGS_DIR"] = self._tmp.name
        originals.originals_dir().mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        if self._before is None:
            os.environ.pop("UNBAKE_SETTINGS_DIR", None)
        else:
            os.environ["UNBAKE_SETTINGS_DIR"] = self._before
        self._tmp.cleanup()

    def test_無ければNone(self):
        self.assertIsNone(originals.cached("rec-1"))

    def test_置いてあれば見つける(self):
        target = originals.originals_dir() / "rec-1.png"
        target.write_bytes(b"x")
        self.assertEqual(originals.cached("rec-1"), target)

    def test_使えない字は落として探す(self):
        """置き場に書ける名前と、記録の id は同じとは限らない。"""
        safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", "a/b:c")
        (originals.originals_dir() / f"{safe}.webp").write_bytes(b"x")
        self.assertIsNotNone(originals.cached("a/b:c"))

    def test_名前が空になるならNone(self):
        self.assertIsNone(originals.cached("///"))


class GetTest(unittest.TestCase):
    """**投げない。** 取れないのは普通に起きる（消された・年齢制限・鍵が要る）。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._before = os.environ.get("UNBAKE_SETTINGS_DIR")
        os.environ["UNBAKE_SETTINGS_DIR"] = self._tmp.name
        originals.originals_dir().mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        if self._before is None:
            os.environ.pop("UNBAKE_SETTINGS_DIR", None)
        else:
            os.environ["UNBAKE_SETTINGS_DIR"] = self._before
        self._tmp.cleanup()

    def test_取ってあれば外へ出ない(self):
        (originals.originals_dir() / "rec-1.png").write_bytes(b"x")
        called = []
        before = originals.original_url
        originals.original_url = lambda *a, **k: called.append(a) or "https://x/y.png"
        try:
            got = originals.get("rec-1", "https://civitai.red/images/1")
        finally:
            originals.original_url = before
        self.assertTrue(got["ok"])
        self.assertTrue(got["cached"])
        self.assertEqual(called, [], "取ってあるのに外へ問い合わせている")

    def test_civitai以外は外へ出ない(self):
        called = []
        before = originals.original_url
        originals.original_url = lambda *a, **k: called.append(a) or None
        try:
            got = originals.get("rec-2", "D:/out/ComfyUI_00444_.png")
        finally:
            originals.original_url = before
        self.assertFalse(got["ok"])
        self.assertEqual(got["error"], "not from civitai")
        self.assertEqual(called, [], "手元の画像のために外へ出ている")

    def test_idが無ければ何もしない(self):
        self.assertFalse(originals.get("", "https://civitai.red/images/1")["ok"])


class OriginalUrlTest(unittest.TestCase):
    def test_数字でない画像IDは問い合わせない(self):
        called = []
        before = originals._get_json
        originals._get_json = lambda *a, **k: called.append(a) or {}
        try:
            self.assertIsNone(originals.original_url("abc", "civitai.red"))
        finally:
            originals._get_json = before
        self.assertEqual(called, [], "数字でない id で問い合わせている")

    def test_問い合わせにwithMetaとnsfwを落とさない(self):
        """**どちらも無いと 200 のまま中身が空**で返り、「無い」と誤読する（実測2回）。"""
        seen = {}
        before = originals._get_json

        def fake(url, api_key=""):
            seen["url"] = url
            return {"items": [{"url": "https://image.civitai.com/full.png"}]}

        originals._get_json = fake
        try:
            got = originals.original_url("140604778", "civitai.red")
        finally:
            originals._get_json = before
        self.assertEqual(got, "https://image.civitai.com/full.png")
        self.assertIn("withMeta=true", seen["url"])
        self.assertIn("nsfw=X", seen["url"])
        self.assertIn("civitai.red", seen["url"])

    def test_空の応答はNone(self):
        before = originals._get_json
        originals._get_json = lambda *a, **k: {"items": []}
        try:
            self.assertIsNone(originals.original_url("1", "civitai.red"))
        finally:
            originals._get_json = before


if __name__ == "__main__":
    unittest.main()
