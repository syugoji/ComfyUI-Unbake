# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""宛先の判定を1本に留める（``I-20260831-73``・2026-09-01）。

**同じ名前・同じ役目・違う中身が4本在り、13通りの URL のうち7通りで答えが
割れて**いた。ここで留めるのは3つ:

1. 判定が**1箇所**であること（手で書き直したら赤くなる）
2. ``urlparse`` の読みと **``urllib`` が実際に繋ぐ先**が一致したときだけ通す
3. 2つの URL を比べるときは :func:`same_host`——``host_of(a) == host_of(b)`` は
   **両方が読めないとき真**になる
"""
import io
import re
import unittest
from pathlib import Path

from unbake.utils.url_host import host_of, same_host

ROOT = Path(__file__).resolve().parent.parent


class HostOfTest(unittest.TestCase):

    def test_普通の_URL_は通る(self):
        for url, want in (
            ("https://civitai.com/x", "civitai.com"),
            ("http://civitai.com/x", "civitai.com"),
            ("https://CIVITAI.COM/x", "civitai.com"),
            ("https://image.civitai.com/y", "image.civitai.com"),
            # **本物なのに `netloc` 版は弾いていた**（port が残るため）。
            ("https://civitai.com:443/x", "civitai.com"),
        ):
            with self.subTest(url):
                self.assertEqual(host_of(url), want)

    def test_読み方が割れる_URL_は空(self):
        """**空＝どの許可一覧とも一致しない**ので、閉じる側へ外れる。"""
        for url in (
            # `hostname` は `civitai.com%40evil.com` と読むが、
            # **`urllib` は `%40` を戻して evil.com へ繋ぐ**。
            "https://civitai.com%40evil.com/x",
            # `hostname` は **`civitai.com`** と読む——`civitai.py` の経路では
            # **許可一覧に一致して通っていた**。実際の宛先は違う。
            "https://evil.com\\@civitai.com/x",
            "https://civitai.com\t@evil.com/x",
            "https://civitai.com\n@evil.com/x",
            "https://civitai.com\r@evil.com/x",
        ):
            with self.subTest(url):
                self.assertEqual(host_of(url), "")

    def test_userinfo_が在れば空(self):
        """**期待は実測から書く。**

        最初は「正しい宛先 `evil.com` を返せばよい」と書いて赤くなった——
        実際は ``Request(...).host`` が **userinfo ごと** ``civitai.com@evil.com``
        を返すので、``hostname``（``evil.com``）と一致せず空になる。
        urllib はその名前をそのまま DNS へ問うので、**閉じる側で正しい**。
        """
        for url in ("https://civitai.com@evil.com/x",
                    "https://civitai.com:pw@evil.com/x"):
            with self.subTest(url):
                self.assertEqual(host_of(url), "")

    def test_区切りの細工は本当の宛先を返す(self):
        """``#`` / ``?`` が先に来ると ``@`` は userinfo ではない。

        ここは空でなく **``evil.com``** が正しい——呼び手の許可一覧が弾く。
        """
        for url in ("https://evil.com#@civitai.com/x",
                    "https://evil.com?@civitai.com/x"):
            with self.subTest(url):
                self.assertEqual(host_of(url), "evil.com")

    def test_扱わない仕組みは空(self):
        for url in ("//civitai.com/x", "ftp://civitai.com/x",
                    "javascript:alert(1)", "civitai.com/x", "", None):
            with self.subTest(url):
                self.assertEqual(host_of(url), "")


class SameHostTest(unittest.TestCase):
    """**読めない側が在れば偽。** これを間違えると番人が消える。"""

    def test_同じなら真(self):
        self.assertTrue(same_host("https://civitai.com/a", "https://civitai.com:443/b"))

    def test_違えば偽(self):
        self.assertFalse(same_host("https://civitai.com/a", "https://evil.com/b"))

    def test_読めない側が在れば偽(self):
        self.assertFalse(same_host("https://civitai.com/a", "ftp://civitai.com/b"))
        self.assertFalse(same_host("ftp://x/a", "ftp://x/b"),
                         "両方読めないときに真になってはいけない")
        self.assertFalse(same_host("", ""))

    def test_素の比較なら通ってしまうことを見せる(self):
        """**対照。** これが `same_host` を分けた理由。"""
        self.assertEqual(host_of("ftp://x/a"), host_of("ftp://x/b"))  # どちらも ""
        self.assertFalse(same_host("ftp://x/a", "ftp://x/b"))


class SingleImplementationTest(unittest.TestCase):
    """**手で書き直したら赤くなる。**

    `I-20260831-69`（拡張子の一覧が5つ）と同じ型で、**次に1つ直しても
    残りは古いまま**になる。増えたことを機械が言う。
    """

    SOURCES = ("civitai.py", "civarchive.py", "download.py", "model_previews.py")

    def _code(self, name):
        text = io.open(ROOT / "unbake" / name, encoding="utf-8").read()
        # 注記は数えない（経緯の説明が旧実装を引用している）。
        return re.sub(r'(?m)^\s*#.*$', '', re.sub(r'"""[\s\S]*?"""', '', text))

    def test_宛先を手で切っていない(self):
        for name in self.SOURCES:
            with self.subTest(name):
                code = self._code(name)
                self.assertNotIn('split("://"', code,
                                 "URL を手で切っている（`utils/url_host` を使う）")
                self.assertNotRegex(code, r"urlparse\([^)]*\)\.netloc",
                                    "netloc で宛先を判定している")
                self.assertNotRegex(code, r"urlparse\([^)]*\)\.hostname",
                                    "hostname だけで宛先を判定している")

    def test_全員が同じ1本を通る(self):
        for name in self.SOURCES:
            with self.subTest(name):
                code = self._code(name)
                self.assertIn("from .utils.url_host import", code,
                              "共通の判定を輸入していない")
                self.assertRegex(code, r"def _host_of[\s\S]{0,200}?return host_of\(",
                                 "`_host_of` が共通の1本へ委ねていない")

    def test_転送の判定が素の比較でない(self):
        code = self._code("download.py")
        self.assertIn("same_host(", code, "転送先の照合が `same_host` を通っていない")
        self.assertNotRegex(code, r"_host_of\([^)]*\)\s*!=\s*_host_of\(",
                            "素の比較へ戻っている（両方読めないとき番人が消える）")


if __name__ == "__main__":
    unittest.main()
