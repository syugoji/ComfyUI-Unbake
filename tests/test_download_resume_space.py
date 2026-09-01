# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**再開に要るのは残りぶんの容量**（2026-08-31・監査 I-20260831-26）。

`download_model` の空き容量検査は `temp_name` の存在確認より**前**に走り、
常に `expected_bytes` 全量の110%を要求していた。既に `.part` へ落ちている分は
**ディスクを消費済み**なので、その分だけ `free` は減っている——つまり
「全量 + 既に落とした分」を持っていないと通らない。

**再開が必要なときにだけ拒否される**、という形になる。コメントが実測として
挙げている 31.9GB のチェックポイントを 30GB まで落として切れた場合、
残りは 1.9GB なのに `.part` が 30GB 食っているので `free` は数GBしかなく、
`free < 31.9GB * 1.1` で `DownloadError(code='space')`。押した人には
「容量不足」としか出ず、**`.part` を手で消す（＝30GB分を捨てる）以外に進む手が無い**。

上限（`MAX_BYTES`）の判定は全量のままにする——**置き終わったときの大きさ**は
再開かどうかに関係しないので。

**この検査は `.part` を実際には書かない。** 上限が 64GiB なので素直に書くと
検査がディスクを埋める（これを書いている最中に 12.9GB と 15GB の残骸を2回作り、
2回とも手で消した）。存在させるだけにして、**大きさを見に行く所を差し替える**。
"""
import os
import shutil
import tempfile
import unittest
from unittest import mock

from unbake.download import MAX_BYTES, DownloadError, download_model

PART_SUFFIX = ".unbake-part"


class ResumeSpaceTest(unittest.TestCase):
    def setUp(self):
        self._root = tempfile.mkdtemp()
        self._dir = os.path.join(self._root, "loras")
        os.makedirs(self._dir, exist_ok=True)
        self._target = os.path.join(self._dir, "big.safetensors")
        self.addCleanup(shutil.rmtree, self._root, True)

    def _run(self, *, expected, part_bytes, free):
        """`.part` が `part_bytes` だけ在り、空きが `free` の状態で押す。"""
        part = self._target + PART_SUFFIX
        if part_bytes:
            with open(part, "wb") as handle:
                handle.write(b"\0")          # 存在させるだけ（大きさは下で偽装）

        usage = shutil.disk_usage(self._dir)
        fake_usage = type(usage)(usage.total, usage.used, free)
        real_getsize = os.path.getsize

        def sized(path):
            if os.path.abspath(path) == os.path.abspath(part):
                return part_bytes
            return real_getsize(path)

        def opener(*_args, **_kwargs):
            # **容量の門を抜けたことの印。** 実際の取得へは進ませない。
            raise AssertionError("門を通った")

        with mock.patch.object(shutil, "disk_usage", return_value=fake_usage), \
                mock.patch.object(os.path, "getsize", side_effect=sized):
            return download_model(
                url="https://example.invalid/big.safetensors",
                kind="loras", filename="big.safetensors",
                root=self._root, target=self._target,
                expected_bytes=expected, opener=opener,
            )

    def test_残りぶんが入るなら再開できる(self):
        """**これが本体。** 残り314,697バイトに対して944,091バイト空いている。"""
        with self.assertRaises(AssertionError) as caught:
            self._run(expected=3_146_962, part_bytes=2_832_265, free=944_091)
        self.assertIn("門を通った", str(caught.exception),
                      "残りが入るのに容量不足で止めている")

    def test_残りぶんも入らないなら今までどおり断る(self):
        """**対照。** 門そのものを外したのではない。"""
        with self.assertRaises(DownloadError) as caught:
            self._run(expected=3_146_962, part_bytes=2_832_265, free=1_000)
        self.assertEqual(caught.exception.code, "space")

    def test_対照_途中まで落ちていなければ全量で判定する(self):
        with self.assertRaises(DownloadError) as caught:
            self._run(expected=3_146_962, part_bytes=0, free=944_091)
        self.assertEqual(caught.exception.code, "space")

    def test_対照_全量が上限を超えるものは再開でも断る(self):
        """**大きさの上限は残りで測らない。** 置き終わった姿は同じなので。"""
        with self.assertRaises(DownloadError) as caught:
            self._run(expected=MAX_BYTES + 1, part_bytes=1_000, free=10 ** 15)
        self.assertEqual(caught.exception.code, "space")
        self.assertIn("too large", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
