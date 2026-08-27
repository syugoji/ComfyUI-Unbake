# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**行き先が変わったら鍵を持ち越さない。**

2026-08-26 の実機で踏んだ。Civitai の取得 URL は S3/R2 へ転送する。Python の
既定は**ヘッダをそのまま持ち越す**ので、ストレージ側が `Authorization` を
AWS 署名として読み、``400 InvalidRequest / Missing x-amz-content-sha256``
を返していた。

実測（同じ版で比べた）::

    鍵なし        → HTTP 200（4.18 GB）
    Bearer 付き   → HTTP 400

**鍵を設定している人だけ、すべての取得が失敗していた。** しかも 400 は
404/401/403 のどれでもないので「繋がりませんでした（もう一度試せます）」に
落ち、**何度試しても同じなのに、打つ手が「もう一度試す」に見えた。**
"""
import unittest
import urllib.request

from unbake.download import _DropAuthOnHostChange, _host_of


class _FakeResponse:
    def __init__(self):
        self.headers = {}


def _redirect(from_url, to_url, headers):
    request = urllib.request.Request(from_url, headers=headers)
    handler = _DropAuthOnHostChange()
    return handler.redirect_request(request, _FakeResponse(), 302, "Found", {}, to_url)


class RedirectAuthTest(unittest.TestCase):
    def test_別のホストへ移るときは鍵を落とす(self):
        new = _redirect(
            "https://civitai.com/api/download/models/1",
            "https://bucket.r2.cloudflarestorage.com/x?sig=1",
            {"Authorization": "Bearer ひみつ", "User-Agent": "ComfyUI-Unbake"},
        )
        self.assertIsNotNone(new)
        got = {k.lower(): v for k, v in new.header_items()}
        self.assertNotIn("authorization", got, "鍵を転送先へ持ち越している")
        # **他のヘッダは落とさない。** 落とすと別の不具合になる。
        self.assertIn("user-agent", got)

    def test_同じホストの中なら持ち越す(self):
        # 同じ相手の中での転送は、鍵が要るまま。
        new = _redirect(
            "https://civitai.com/api/download/models/1",
            "https://civitai.com/api/download/models/1?type=Model",
            {"Authorization": "Bearer ひみつ"},
        )
        got = {k.lower(): v for k, v in new.header_items()}
        self.assertIn("authorization", got, "同じ相手なのに鍵を落としている")

    def test_鍵が無ければ何も変わらない(self):
        new = _redirect(
            "https://civitai.com/api/download/models/1",
            "https://example.invalid/x",
            {"User-Agent": "ComfyUI-Unbake"},
        )
        self.assertIsNotNone(new)

    def test_ホストの読み方(self):
        self.assertEqual(_host_of("https://Civitai.COM/a"), "civitai.com")
        # **読めない値は空**（比べる側が「別のホスト」と扱う＝落とす側へ倒れる）。
        self.assertEqual(_host_of("http://[::1"), "")

    def test_落とす経路がこの仕掛けを使っている(self):
        """**仕掛けが在ることと、使われていることは別。**"""
        import inspect

        from unbake import download

        source = inspect.getsource(download.download_model)
        self.assertIn("_build_opener()", source, "既定の urlopen のままになっている")
        self.assertNotIn("urllib.request.urlopen", source)


if __name__ == "__main__":
    unittest.main()
