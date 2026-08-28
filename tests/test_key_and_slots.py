# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""外へ出す物と、握ったまま離さない物（`D-20260828-01` 群E の Python 側）。

- **E1**: Civitai の鍵が `huggingface.co` へ送られていた
- **E2**: 環境が据えられておらず、伴走モデルの取得が全件 500
- **E3**: `DownloadError` 以外の例外で取得枠が永久に埋まる
- **E4**: 429 を「見本が無い」として `.miss` へ永久に焼く

どれも**成功しているように見える形**で壊れる。E1 は転送も画面も正常、
E3 は「取得中」と出続ける、E4 は静かに二度と取りに行かなくなる。
"""
import os
import tempfile
import unittest

from unbake import download as dl
from unbake import model_previews
from unbake.civitai import RATE_LIMIT_FLAG, is_rate_limited


class KeyDestinationTest(unittest.TestCase):
    """**鍵は Civitai のもの。** 宛先を第三者に決めさせない。"""

    def test_civitaiには出す(self):
        self.assertTrue(dl._may_send_key("https://civitai.com/api/download/models/1", "k"))
        self.assertTrue(dl._may_send_key("https://civitai.red/api/download/models/1", "k"))

    def test_ミラーには出さない(self):
        """`use_civarchive` を入れると `huggingface.co` が落とし先に足される。

        **その URL を決めているのは civarchive.com（第三者）**なので、
        返す URL を変えるだけでこちらの鍵をどこへでも送らせられる形だった。
        """
        self.assertFalse(dl._may_send_key("https://huggingface.co/x/y.safetensors", "k"))
        self.assertFalse(dl._may_send_key("https://example.com/y.safetensors", "k"))

    def test_紛らわしい名前に出さない(self):
        """**後ろ一致だけで許さない。** `evil-civitai.com` は別人。"""
        self.assertFalse(dl._may_send_key("https://evil-civitai.com/x", "k"))
        self.assertFalse(dl._may_send_key("https://civitai.com.example.net/x", "k"))

    def test_下位ドメインは同じ持ち主(self):
        self.assertTrue(dl._may_send_key("https://cdn.civitai.com/x", "k"))

    def test_鍵が無ければ何もしない(self):
        self.assertFalse(dl._may_send_key("https://civitai.com/x", ""))

    def test_実際の要求ヘッダに鍵が乗らない(self):
        """**判定だけでなく、出て行く物を見る。**"""
        seen = {}

        class _Response:
            status = 200
            headers = {"Content-Type": "application/octet-stream", "Content-Length": "4"}

            def read(self, _size=None):
                if seen.get("done"):
                    return b""
                seen["done"] = True
                return b"data"

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

        def opener(request, timeout=None):
            seen["headers"] = dict(request.headers)
            return _Response()

        with tempfile.TemporaryDirectory() as root:
            target = os.path.join(root, "x.safetensors")
            try:
                dl.download_model(
                    url="https://huggingface.co/x/y.safetensors",
                    kind="loras", filename="x.safetensors",
                    api_key="secret-key", opener=opener, target=target,
                )
            except dl.DownloadError:
                # 4バイトの偽物なので中身の検査で落ちる。**見たいのは
                # 「出て行った要求」**で、落とし切れたかどうかではない。
                pass
        header_names = {name.lower() for name in seen.get("headers", {})}
        self.assertNotIn("authorization", header_names,
                         "Civitai の鍵をミラーへ送っている")


class RateLimitTest(unittest.TestCase):
    """**429 は「無い」ではない。** 打つ手が正反対（待つ／諦める）。"""

    def test_印を持つ応答を上限として読む(self):
        self.assertTrue(is_rate_limited({RATE_LIMIT_FLAG: True, "retryAfter": 30}))
        self.assertFalse(is_rate_limited({"id": 1}))
        self.assertFalse(is_rate_limited(None))

    def test_上限のときは見本の不在として焼かない(self):
        """`.miss` に焼かれると `cached_miss` が短絡し、**二度と取りに行かない**。

        起きる形: Sweep のモデル選択で by-hash を十数件連射 → 429 →
        **残り全部が「見本の無いモデル」になる**。UI から戻す手段は無い。
        """
        remembered = []
        before_json = model_previews._get_json
        before_miss = model_previews._remember_miss
        before_sha = model_previews.file_sha256
        model_previews._get_json = lambda *a, **k: {RATE_LIMIT_FLAG: True, "retryAfter": 42}
        model_previews._remember_miss = lambda *a, **k: remembered.append(a)
        model_previews.file_sha256 = lambda *_a, **_k: "0" * 64
        try:
            got = model_previews.fetch_preview("loras", "m.safetensors", "m.safetensors")
        finally:
            model_previews._get_json = before_json
            model_previews._remember_miss = before_miss
            model_previews.file_sha256 = before_sha
        self.assertFalse(got["ok"])
        self.assertTrue(got.get("rateLimited"), f"上限だと言っていない: {got}")
        self.assertEqual(got.get("retryAfter"), 42)
        self.assertEqual(remembered, [], "上限を「見本が無い」として焼いている")


class DownloadSlotTest(unittest.TestCase):
    """**枠を握ったまま落ちない。** 3回起きると以後 `busy` しか返らない。"""

    def setUp(self):
        from unbake import routes

        self.routes = routes
        routes._downloads.clear()

    def tearDown(self):
        self.routes._downloads.clear()

    def test_想定外の例外でも枠を返す(self):
        """置き場が未作成だと `shutil.disk_usage` が `FileNotFoundError` を投げる。

        元は `except DownloadError` しか無く、**素通りして 500**。
        `_downloads[versionId]` は永久に `running` のままだった。
        """
        routes = self.routes
        before_resolve = routes.resolve_version
        before_download = routes.download_model
        routes.resolve_version = lambda *a, **k: {
            "ok": True, "url": "https://civitai.com/x", "kind": "loras",
            "filename": "x.safetensors", "bytes": 1, "sha256": None,
        }

        def boom(**_kwargs):
            raise FileNotFoundError("no such directory")

        routes.download_model = boom
        try:
            with self.assertRaises(FileNotFoundError):
                routes.start_download("999")
        finally:
            routes.resolve_version = before_resolve
            routes.download_model = before_download
        state = routes._downloads.get("999") or {}
        self.assertNotEqual(state.get("state"), "running",
                            "枠が `running` のまま残っている（以後 busy しか返らない）")
        self.assertEqual(state.get("code"), "unexpected")


class EnvironmentTest(unittest.TestCase):
    """**据える場所がどこにも無かった**ので、伴走モデルの取得が全件 500 だった。"""

    def test_据える口が在り二重には据えない(self):
        from unbake import environment, routes

        environment.reset_environment()
        try:
            routes.install_default_environment()
            first = environment.require_environment()
            self.assertTrue(first.has_downloader, "落とす口が据わっていない")
            routes.install_default_environment()
            self.assertIs(environment.require_environment(), first,
                          "据え直している（検査が入れた環境を黙って壊す）")
        finally:
            environment.reset_environment()

    def test_登録の入口が環境を据える(self):
        """口を登録する側と同じ場所で据える。**口が在るのに環境が無い**を作らない。"""
        import inspect

        from unbake import routes

        source = inspect.getsource(routes.register_routes)
        self.assertIn("install_default_environment()", source)


if __name__ == "__main__":
    unittest.main()
