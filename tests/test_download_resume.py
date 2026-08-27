# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""取得の再開。**3.9GB が切れたときに、最初からやり直さない。**

利用者の指摘（2026-08-25）で、改造版 LoRA Manager が持っていて Unbake が
持っていなかった機能の1つ。チェックポイントは4GB前後、34GB のものも在るので、
途中で切れて最初からになると実質的に取れない。

**hash の扱いが要。** 続きから引くときは、既に在る分を digest へ入れ直さないと
最後の照合が必ず落ちる——しかも「壊れている」という**間違った理由**で。
"""
import hashlib
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from unbake import download as dl  # noqa: E402


class FakeResponse:
    """`urlopen` の代わり。`Range` を見て続きだけを返す。"""

    def __init__(self, body, *, honor_range=True, request=None):
        self._body = body
        self.headers = {}
        start = 0
        rng = (request.headers if request else {}).get("Range", "") if request else ""
        if honor_range and rng.startswith("bytes="):
            start = int(rng.split("=", 1)[1].split("-", 1)[0])
            self.status = 206
        else:
            self.status = 200
        self._stream = io.BytesIO(body[start:])
        self.headers["Content-Length"] = str(len(body) - start)
        self.headers["Content-Type"] = "application/octet-stream"

    def read(self, size=-1):
        return self._stream.read(size)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class ResumeTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        # **（1MB）より大きくする。** 小さいと1回の read で全部届き、
        # 途中で止められない——つまり**再開を一度も試していない検査**になる。
        self.body = os.urandom(dl.CHUNK * 3 + 1234)
        self.sha = hashlib.sha256(self.body).hexdigest()
        self.target = os.path.join(self.dir, "model.safetensors")
        patcher = mock.patch.object(dl, "safe_target", lambda kind, filename: self.target)
        patcher.start()
        self.addCleanup(patcher.stop)

    @property
    def part(self):
        return self.target + ".unbake-part"

    def _download(self, *, honor_range=True, cancel_after=None):
        seen = {"n": 0}

        def opener(request, timeout=None):
            return FakeResponse(self.body, honor_range=honor_range, request=request)

        def should_cancel():
            seen["n"] += 1
            return cancel_after is not None and seen["n"] > cancel_after

        return dl.download_model(
            url="https://example.invalid/x", kind="checkpoints", filename="model.safetensors",
            sha256=self.sha, opener=opener,
            should_cancel=should_cancel if cancel_after is not None else None,
        )

    def test_一度で落とせる(self):
        out = self._download()
        self.assertTrue(out["ok"])
        self.assertEqual(out["sha256"], self.sha)
        self.assertFalse(os.path.exists(self.part), "終わったのに .part が残っている")

    def test_中断すると途中まで残る(self):
        with self.assertRaises(dl.DownloadError) as caught:
            self._download(cancel_after=1)
        self.assertEqual(caught.exception.code, "canceled")
        # **これが再開の前提。** 消していたら次も最初からになる。
        self.assertTrue(os.path.exists(self.part), "中断で .part を消している（再開できない）")
        self.assertGreater(os.path.getsize(self.part), 0)

    def test_続きから引いて完成する(self):
        with self.assertRaises(dl.DownloadError):
            self._download(cancel_after=1)
        partial = os.path.getsize(self.part)
        self.assertLess(partial, len(self.body), "全部落ちてしまっている（再開を試せない）")

        out = self._download()          # 2回目
        self.assertTrue(out["ok"])
        # **hash が合うこと。** 既存分を digest へ入れ直していないとここで落ちる。
        self.assertEqual(out["sha256"], self.sha)
        with open(self.target, "rb") as f:
            self.assertEqual(f.read(), self.body, "中身が元と違う（二重に書いている）")

    def test_Range_を無視されたら最初から書き直す(self):
        """**断られても、そのまま完成させる**（2026-08-26 実機で必要になった）。

        元は控えを消して `network` の失敗にしていた。だが `200` は「全部を
        送る」という意味なので、**送られてくる中身は正しい**——捨てて失敗に
        する理由が無い。

        実機（Civitai の 31.9 GB のモデル）: 120MB まで落として止め、もう一度
        押すと `Range` を無視された。そこで**控えごと消えて英語の内部文言で
        失敗**——止めた人から見ると、続きから引くつもりが振り出しに戻る。

        追記のままだと前半が二重になるので、**切り詰めて hash も数え直す。**
        """
        with self.assertRaises(dl.DownloadError):
            self._download(cancel_after=1)
        partial = os.path.getsize(self.part)
        self.assertGreater(partial, 0, "控えが無いと、この道を通らない")

        out = self._download(honor_range=False)
        self.assertTrue(out["ok"], "断られただけで失敗にしている")
        # **hash が合うこと。** 数え直していないと、前半が二重に入って落ちる。
        self.assertEqual(out["sha256"], self.sha)
        with open(self.target, "rb") as f:
            self.assertEqual(f.read(), self.body, "中身が元と違う（二重に書いている）")
        self.assertFalse(os.path.exists(self.part), "終わったのに .part が残っている")

    def test_壊れた続きは残さない(self):
        # hash が合わないものを取っておくと、次も同じ理由で落ちる。
        with open(self.part, "wb") as f:
            f.write(b"garbage that is not the model")
        with self.assertRaises(dl.DownloadError) as caught:
            self._download(honor_range=True)
        self.assertIn(caught.exception.code, ("corrupt", "network"))
        self.assertFalse(os.path.exists(self.part))


if __name__ == "__main__":
    unittest.main()
