# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**置き場がまだ無いときに、理由の付いた失敗にすること**（2026-09-01・走査11周目）。

`download_model` は `shutil.disk_usage` を `os.makedirs` より**前**に呼んでおり、
ComfyUI が知っているだけでまだ存在しない置き場（`models/hypernetworks` など）では
**`FileNotFoundError` が生のまま抜けて**いた。`DownloadError` ではないので、
呼び手の「理由（`code`）で分ける」仕掛けを素通りする。

**回避策は既に呼び手側に在った。** `routes.start_download` は

> **枠を握ったまま落ちない**（`D-20260828-01` E3）。元は `DownloadError` しか
> 受けていなかった。**置き場が未作成だと `shutil.disk_usage` が
> `FileNotFoundError` を投げてここを素通り**し、`_downloads[key]` は永久に
> `running` のまま残る。走行枠は3本しか無いので、**3回起きると以後は
> `busy` しか返らない**——ComfyUI を再起動するまで1本も落とせない。

と書いて `except BaseException` を足している。**真因はこちら側**で、
呼び手が包んだだけで直っていなかった。

**綴りではなく挙動で見る**——置き場を作らずに呼んで、生の `OSError` が
出ないこと・実際に落ちることを確かめる。
"""

from __future__ import annotations

import hashlib
import io
import struct
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from unbake.download import DownloadError, download_model  # noqa: E402


#: **本物の safetensors の形**にしておく。`sha256` を渡さない呼び方では
#: `classify_model_payload` が先頭バイトを見るので、ただの 0 埋めだと
#: 「モデルではない」で落ちる（＝この検査が見たいものと違う所で赤くなる）。
_HEADER = b"{}"
#: 詰め物は空白で書く。**`\x00` をヒアドキュメント経由で書かないこと**——
#: 生の NUL バイトが原文へ入り、`SyntaxError: source code string cannot contain
#: null bytes` になる（2026-09-01 に実際に踏んだ）。
PAYLOAD = struct.pack("<Q", len(_HEADER)) + _HEADER + b" " * 48


class _Response:
    """`urlopen` の代わり。**中身をそのまま返すだけ**の相手。"""

    def __init__(self, payload: bytes) -> None:
        self._stream = io.BytesIO(payload)
        self.status = 200
        self.headers = {"Content-Type": "application/octet-stream",
                        "Content-Length": str(len(payload))}

    def read(self, size=-1):
        return self._stream.read(size)

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


def _opener(_request, timeout=None):
    return _Response(PAYLOAD)


class 置き場が無くても理由の付いた失敗にする(unittest.TestCase):
    def _target(self, root: Path) -> str:
        """**まだ作られていない**置き場の中のファイル。"""
        return str(root / "hypernetworks" / "x.safetensors")

    def test_置き場が未作成でも落とせる(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = self._target(Path(tmp))
            self.assertFalse(os.path.isdir(os.path.dirname(target)),
                             "前提: 置き場はまだ無い")
            result = download_model(
                url="https://civitai.com/api/download/models/1",
                kind="loras",
                filename="x.safetensors",
                expected_bytes=len(PAYLOAD),   # ← これが `disk_usage` を呼ばせる
                sha256=hashlib.sha256(PAYLOAD).hexdigest(),
                opener=_opener,
                target=target,
            )
            self.assertTrue(result["ok"])
            self.assertTrue(os.path.isfile(target), "本物の名前へ置かれていない")

    def test_生の_OSError_を外へ出さない(self):
        """**理由が付いていない例外を呼び手へ渡さない。**

        ここが生の `FileNotFoundError` だと、呼び手は `code` で分けられない
        ——`routes.start_download` が `except BaseException` を足したのはそのため。
        """
        with tempfile.TemporaryDirectory() as tmp:
            # 置き場の親を**ファイル**にして、`makedirs` を確実に失敗させる。
            blocker = Path(tmp) / "blocked"
            blocker.write_bytes(b"x")
            target = str(blocker / "sub" / "x.safetensors")
            with self.assertRaises(DownloadError) as caught:
                download_model(
                    url="https://civitai.com/api/download/models/1",
                    kind="loras",
                    filename="x.safetensors",
                    expected_bytes=len(PAYLOAD),
                    opener=_opener,
                    target=target,
                )
            self.assertEqual(caught.exception.code, "setup",
                             "理由の種類が付いていない")

    def test_対照_置き場が在るときは今までどおり(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / "loras"
            folder.mkdir()
            target = str(folder / "x.safetensors")
            result = download_model(
                url="https://civitai.com/api/download/models/1",
                kind="loras",
                filename="x.safetensors",
                expected_bytes=len(PAYLOAD),
                opener=_opener,
                target=target,
            )
            self.assertTrue(result["ok"])
            self.assertEqual(result["bytes"], len(PAYLOAD))

    def test_対照_大きさの上限は置き場より先に見る(self):
        """**作る前に断る。** 断ると決まっているものの置き場を作らない。"""
        with tempfile.TemporaryDirectory() as tmp:
            target = self._target(Path(tmp))
            with self.assertRaises(DownloadError) as caught:
                download_model(
                    url="https://civitai.com/api/download/models/1",
                    kind="loras",
                    filename="x.safetensors",
                    expected_bytes=1 << 40,   # MAX_BYTES 超え
                    opener=_opener,
                    target=target,
                )
            self.assertEqual(caught.exception.code, "space")
            self.assertFalse(
                os.path.isdir(os.path.dirname(target)),
                "断るのに置き場だけ作っている",
            )


if __name__ == "__main__":
    unittest.main()
