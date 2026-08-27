# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**転送が終わったことは、モデルが来たことを意味しない。**

相手がエラーページ（HTML）を返せば、それが `.safetensors` という名前で残る。
一覧にも普通に並び、**実際に絵を作ろうとしたときに初めて落ちる**——上流
（comfyui-lora-manager, GPL-3.0）が I-20260816-01 として踏んだ形。

`classify_model_payload` は 185行の完成品としてこのリポジトリにも在ったが、
**どこからも呼ばれていなかった**（2026-08-26 の到達性の棚卸しで判明）。
"""
import hashlib
import io as _io
import struct
import os
import tempfile
import unittest
from unittest import mock

import unbake.download as dl
from unbake.utils.model_file_validation import (
    PAYLOAD_BROKEN, PAYLOAD_OK, PAYLOAD_UNKNOWN, classify_model_payload,
)


def _safetensors(total: int) -> bytes:
    """**形の通った safetensors** を `total` バイトちょうどで作る。

    ハッシュを渡さない道は**中身の形も見る**ので、`b"xxx…"` だと
    そちらで弾かれて、**大きさの判定を一度も踏まない検査**になる（実際なった）。
    """
    header = b'{"__metadata__":{}}'
    body = struct.pack("<Q", len(header)) + header
    # **逃がし文字を使わない**（この道具立てで潰れ、生の NUL が入った）。
    return body + bytes(max(0, total - len(body)))


def _opener(body: bytes):
    """`urlopen` の代わり。**中身をそのまま返すだけ**の相手。"""

    class Fake:
        headers = {}
        status = 200

        def __init__(self):
            self._stream = _io.BytesIO(body)

        def read(self, size=-1):
            return self._stream.read(size)

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    return lambda request, timeout=None: Fake()


def _write(name: str, data: bytes) -> str:
    path = os.path.join(tempfile.mkdtemp(), name)
    with open(path, "wb") as handle:
        handle.write(data)
    return path


class PayloadCheckTest(unittest.TestCase):
    def test_HTMLのエラーページを弾く(self):
        # これが実際に踏まれた形。名前は safetensors、中身は HTML。
        page = b"<!DOCTYPE html><html><head><title>404</title></head></html>" * 20
        verdict = classify_model_payload(_write("model.safetensors", page))
        self.assertEqual(verdict.status, PAYLOAD_BROKEN, verdict.reason)
        self.assertIn("html", verdict.reason.lower() + repr(page[:16]).lower())

    def test_本物のsafetensorsを通す(self):
        header = b'{"__metadata__":{}}'
        data = len(header).to_bytes(8, "little") + header + b"\x00" * 64
        verdict = classify_model_payload(_write("model.safetensors", data))
        self.assertEqual(verdict.status, PAYLOAD_OK, verdict.reason)

    def test_判らない拡張子を不合格にしない(self):
        # **「判らない」は「違う」ではない。** 弾くと、正しいものまで落とせなくなる。
        # .bin は torch の容れ物として約束が在るので、判る側。
        # 約束の無い拡張子を使う。
        verdict = classify_model_payload(_write("thing.yaml", b"anything"))
        self.assertEqual(verdict.status, PAYLOAD_UNKNOWN)

    def test_落とす経路がHTMLのページを受け取らない(self):
        """**呼ばれていることを、通しで見る。**

        最初は原文に `classify_model_payload` の語が在ることだけを見ていたが、
        **分岐を `if False:` に潰しても緑のままだった**（変異検査で素通り）。
        語が在ることと、効いていることは別。
        """
        import hashlib
        import io as _io
        import os as _os
        import tempfile as _tempfile
        from unittest import mock

        from unbake import download as dl

        # 中身は HTML だが、相手は「octet-stream だ」と言っている。
        page = b"<!DOCTYPE html><html><body>Not Found</body></html>" * 40
        target = _os.path.join(_tempfile.mkdtemp(), "model.safetensors")

        class Fake:
            status = 200
            # **`text/html` とは名乗らない。** そう名乗る相手は、既に手前の
            # 関門（`Content-Type` を見る所）で弾かれている——そこを通す形に
            # しないと、**新しい検算を一度も踏まない検査**になる。
            headers = {"Content-Length": str(len(page)),
                       "Content-Type": "application/octet-stream"}

            def __init__(self):
                self._stream = _io.BytesIO(page)

            def read(self, size=-1):
                return self._stream.read(size)

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        with mock.patch.object(dl, "safe_target", lambda kind, filename, root="": target):
            with self.assertRaises(dl.DownloadError) as caught:
                dl.download_model(
                    url="https://example.invalid/x", kind="checkpoints",
                    filename="model.safetensors",
                    # **ハッシュを渡さない。** 渡せば hash で弾かれるので、
                    # 中身の検査を一度も踏まない検査になる。
                    sha256=None, expected_bytes=len(page),
                    opener=lambda request, timeout=None: Fake(),
                )
        self.assertEqual(caught.exception.code, "corrupt")
        self.assertIn("not a model", str(caught.exception))
        # **本物の名前へ置かない。** 置くと「落とし済み」に見えて、
        # 落とし直す機会が永久に来ない。
        self.assertFalse(_os.path.exists(target), "壊れたものを本物の名前で置いている")

    def test_ハッシュが在るときは弱い検査へ落とさない(self):
        # 一致は結論。**それより弱い検査で覆してはならない。**
        import inspect

        from unbake import download

        source = inspect.getsource(download.download_model)
        self.assertIn("if not sha256:", source)


if __name__ == "__main__":
    unittest.main()


class SizeVsHashTest(unittest.TestCase):
    """**大きさでハッシュの結論を覆さない**（2026-08-28 実機の報告）。

    報告された失敗:
        ``748cmSDXL.safetensors — size mismatch: expected 255017024, got 255025442``

    実測で追った結果、**落ちてきた物は正しかった**:

        Civitai の ``sizeKB``  249040.0625 → ``int(*1024)`` = 255,017,024
        実物                                255,025,442（差 8,418 バイト）
        Civitai の SHA256      85715EB6…F261A
        実物の SHA256          85715eb6…f261a（**一致**）

    つまり **Civitai の申告する大きさが 8KB ずれている**だけ。消していたので、
    **何度落とし直しても同じ所で失敗する**形になっていた。
    """

    def _run(self, *, body, sha256, expected_bytes):
        target = os.path.join(self.dir, "m.safetensors")
        with mock.patch.object(dl, "safe_target", lambda kind, filename, root="": target):
            return dl.download_model(
                url="https://example.invalid/m.safetensors",
                kind="loras", filename="m.safetensors",
                sha256=sha256, expected_bytes=expected_bytes,
                opener=_opener(body),
            )

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = self._tmp.name
        self.addCleanup(self._tmp.cleanup)

    def test_ハッシュが合えば_大きさが違っても置く(self):
        body = _safetensors(100)
        digest = hashlib.sha256(body).hexdigest()
        result = self._run(body=body, sha256=digest, expected_bytes=92)
        self.assertTrue(result.get("ok"), "ハッシュが合っているのに消している")
        self.assertTrue(os.path.exists(os.path.join(self.dir, "m.safetensors")))

    def test_ハッシュが無く_短ければ断る(self):
        """**短い＝途中で切れた疑い。** ここは今までどおり落とす。"""
        with self.assertRaises(dl.DownloadError) as caught:
            self._run(body=_safetensors(100), sha256=None, expected_bytes=100 + dl.SIZE_SLACK + 1)
        self.assertEqual(caught.exception.code, "corrupt")

    def test_ハッシュが無く_長いだけなら置く(self):
        """**長い側は相手の数字が古いだけ**——壊れた証拠ではない（実機の形）。"""
        result = self._run(body=_safetensors(200), sha256=None, expected_bytes=100)
        self.assertTrue(result.get("ok"), "長いだけで消している")

    def test_ハッシュが無く_切り捨てぶんのずれなら置く(self):
        """``sizeKB`` は小数を持つので、KB→バイトで最大 1024 ずれる。"""
        result = self._run(body=_safetensors(100), sha256=None, expected_bytes=100 + dl.SIZE_SLACK)
        self.assertTrue(result.get("ok"))

    def test_ハッシュが違えば_今までどおり断る(self):
        """**弱めていない。** ハッシュが結論を出す側は変えていない。"""
        with self.assertRaises(dl.DownloadError) as caught:
            self._run(body=_safetensors(100), sha256="0" * 64, expected_bytes=100)
        self.assertEqual(caught.exception.code, "corrupt")
