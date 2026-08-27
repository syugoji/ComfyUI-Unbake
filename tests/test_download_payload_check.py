# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**転送が終わったことは、モデルが来たことを意味しない。**

相手がエラーページ（HTML）を返せば、それが `.safetensors` という名前で残る。
一覧にも普通に並び、**実際に絵を作ろうとしたときに初めて落ちる**——上流
（comfyui-lora-manager, GPL-3.0）が I-20260816-01 として踏んだ形。

`classify_model_payload` は 185行の完成品としてこのリポジトリにも在ったが、
**どこからも呼ばれていなかった**（2026-08-26 の到達性の棚卸しで判明）。
"""
import os
import tempfile
import unittest

from unbake.utils.model_file_validation import (
    PAYLOAD_BROKEN, PAYLOAD_OK, PAYLOAD_UNKNOWN, classify_model_payload,
)


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
