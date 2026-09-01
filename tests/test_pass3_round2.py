# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**走査3周目・選別2巡目で確定した分**（2026-08-31）。

- ``originals`` が 429 を「原寸が無い」と読まない
- ``originals`` が原寸を頼む（縮んだ URL をそのまま控えない）
- ``model_previews`` が飛ばされた先も確かめる
"""
import unittest
from unittest import mock

from unbake import originals
from unbake.model_previews import fetch_preview
from unbake.civitai import RATE_LIMIT_FLAG


class FullSizeUrlTest(unittest.TestCase):
    """API が返す ``url`` は縮んだ版を指していることがある。"""

    def test_変換指定を原寸へ替える(self):
        self.assertEqual(
            originals.full_size_url("https://image.civitai.com/uuid/width=450/x.jpeg"),
            "https://image.civitai.com/uuid/original=true/x.jpeg")

    def test_品質や最適化の指定も替える(self):
        for part in ("quality=90", "optimized=true", "original=false"):
            with self.subTest(part):
                got = originals.full_size_url(f"https://image.civitai.com/u/{part}/x.jpeg")
                self.assertEqual(got, "https://image.civitai.com/u/original=true/x.jpeg")

    def test_知らない形は触らない(self):
        """**組み替えて 404 を作らない。** 下で元の URL へ落とすので、触らないほうが安全。"""
        for url in ("https://image.civitai.com/uuid/x.jpeg", "", "not a url"):
            with self.subTest(url):
                self.assertEqual(originals.full_size_url(url), url)


class OriginalsRateLimitTest(unittest.TestCase):
    """**上限に当たったことを「無い」と混ぜない。**

    ``civitai._get_json`` は 429/503 のとき**辞書を返す**ので、
    ``isinstance(payload, dict)`` だけでは通ってしまい、``items`` が無いので
    ``None``＝「原寸が無い」になる。``is_rate_limited`` はその取り違えを
    1箇所へ閉じるために在るのに、ここは輸入すらしていなかった。
    """

    LIMITED = {RATE_LIMIT_FLAG: True, "retryAfter": 12}

    def test_上限のときは投げる(self):
        with mock.patch.object(originals, "_get_json", return_value=self.LIMITED):
            with self.assertRaises(originals.RateLimited) as caught:
                originals.original_url("123", "civitai.com")
        self.assertEqual(caught.exception.retry_after, 12)

    def test_呼び手は待てと言う(self):
        with mock.patch.object(originals, "_get_json", return_value=self.LIMITED), \
             mock.patch.object(originals, "cached", return_value=None), \
             mock.patch.object(originals, "image_id_of", return_value="123"), \
             mock.patch.object(originals, "domain_of", return_value="civitai.com"):
            out = originals.get("rec", "https://civitai.com/images/123")
        self.assertFalse(out["ok"])
        self.assertEqual(out["code"], "rate_limited")
        self.assertEqual(out["retryAfter"], 12)
        self.assertNotIn("could not resolve", out["error"])

    def test_対照_本当に無いときは今までどおり(self):
        with mock.patch.object(originals, "_get_json", return_value={"items": []}):
            self.assertIsNone(originals.original_url("123", "civitai.com"))

    def test_対照_在れば返す(self):
        payload = {"items": [{"url": "https://image.civitai.com/u/width=450/x.jpeg"}]}
        with mock.patch.object(originals, "_get_json", return_value=payload):
            got = originals.original_url("123", "civitai.com")
        # **ここでは書き換えない。** 書き換えと落とし直しは `get()` が持つ。
        self.assertEqual(got, "https://image.civitai.com/u/width=450/x.jpeg")


class _Response:
    def __init__(self, landed, body=b"\x89PNG\r\n\x1a\n"):
        self._landed = landed
        self._body = body
        self.headers = {"Content-Type": "image/png"}

    def geturl(self):
        return self._landed

    def read(self, _size=None):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class PreviewRedirectTest(unittest.TestCase):
    """**飛ばされた先も確かめる。**

    41行の注記は「API が返した URL でも行き先は確かめる」と言っているのに、
    見ていたのは最初の URL のホストだけだった。兄弟の ``records.fetch_preview``
    は前から ``response.geturl()`` を照合している。
    """

    VERSION = {"images": [{"type": "image",
                           "url": "https://image.civitai.com/u/orig/x.jpeg"}]}

    def _fetch(self, landed):
        with mock.patch("unbake.model_previews._get_json", return_value=self.VERSION), \
             mock.patch("unbake.model_previews.file_sha256", return_value="0" * 64), \
             mock.patch("unbake.model_previews._remember_miss"), \
             mock.patch("unbake.model_previews.cached_preview", return_value=None):
            # **名前は他の検査と被らせない。** `cached_preview` は利用者の
            # user ディレクトリを見るので、ありふれた名前だと**別の検査が
            # 焼いた見本**を拾って `from: "cache"` で早退する（実際に踏んだ）。
            return fetch_preview("loras", "unbake-redirect-probe.safetensors", __file__,
                                 opener=lambda *a, **k: _Response(landed))

    def test_別のホストへ飛ばされたら受け取らない(self):
        out = self._fetch("https://evil.example.com/x.jpeg")
        self.assertFalse(out["ok"])
        self.assertIn("redirected", out["error"])

    def test_対照_同じホストの中ならこれまでどおり(self):
        out = self._fetch("https://image.civitai.com/u/width=450/x.jpeg")
        self.assertNotIn("redirected", str(out.get("error") or ""))


if __name__ == "__main__":
    unittest.main()
