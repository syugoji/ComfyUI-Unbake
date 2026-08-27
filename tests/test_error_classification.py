# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**打つ手の違う失敗を、同じ顔で出さない。**

2026-08-26 の変異検査で生き残った箇所（＝どの検査も見ていなかった）に
足したもの。潰しても緑のままだった:

  - `download.py:261`  HTTP の番号から種類を決める分岐
  - `model_file_validation.py:191`  hash の照合
  - `known_model_downloader.py:102`  置き場の候補を絞る条件

番号の読み違いは**失敗としては現れない**——「もう無い」と「鍵が要る」を
取り違えても、画面には同じ「落とせません」が出るだけなので気づけない。
"""
import io
import os
import tempfile
import unittest
import urllib.error
from unittest import mock

from unbake import download as dl
from unbake.utils.model_file_validation import (
    HASH_MATCH, HASH_MISMATCH, HASH_UNVERIFIABLE, compare_sha256,
)


class ErrorKindTest(unittest.TestCase):
    def setUp(self):
        self.target = os.path.join(tempfile.mkdtemp(), "m.safetensors")
        patcher = mock.patch.object(dl, "safe_target", lambda kind, filename, root="": self.target)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _download_with(self, status):
        def opener(request, timeout=None):
            raise urllib.error.HTTPError(
                "https://civitai.com/x", status, "boom", {}, io.BytesIO(b""))

        with self.assertRaises(dl.DownloadError) as caught:
            dl.download_model(url="https://civitai.com/x", kind="loras",
                              filename="m.safetensors", opener=opener)
        return caught.exception.code

    def test_404はもう無い(self):
        # **打つ手は「諦める」。** 鍵を確かめさせても意味が無い。
        self.assertEqual(self._download_with(404), "gone")

    def test_401と403は権限(self):
        for status in (401, 403):
            with self.subTest(status=status):
                self.assertEqual(self._download_with(status), "forbidden")

    def test_その他の番号は通信の失敗(self):
        # **次に試せば通るかもしれない側へ倒す。** 「もう無い」と言うと、
        # 一時的な不調で記録を諦めることになる。
        for status in (500, 502, 429):
            with self.subTest(status=status):
                self.assertEqual(self._download_with(status), "network")


class HashCompareTest(unittest.TestCase):
    def test_一致と不一致と照合不能を分ける(self):
        good = "ab" * 32
        self.assertEqual(compare_sha256(good, good), HASH_MATCH)
        self.assertEqual(compare_sha256(good, "cd" * 32), HASH_MISMATCH)
        # **「照合できない」を「一致」に混ぜない。** 混ぜると、
        # 確かめていないものを「確かめた」と言うことになる。
        self.assertEqual(compare_sha256(good, ""), HASH_UNVERIFIABLE)
        self.assertEqual(compare_sha256("", good), HASH_UNVERIFIABLE)

    def test_大文字小文字を同じものと読む(self):
        self.assertEqual(compare_sha256("AB" * 32, "ab" * 32), HASH_MATCH)


class FolderCandidatesTest(unittest.TestCase):
    def test_存在しない置き場を候補にしない(self):
        from unbake.services.known_model_downloader import _folder_candidates

        real = tempfile.mkdtemp()
        with mock.patch("unbake.services.known_model_downloader.folder_paths") as fake:
            fake.get_folder_paths.return_value = [real, os.path.join(real, "無い"), "", None]
            got = _folder_candidates("loras")
        # **無い場所を候補に残すと、そこへ置いたつもりで落ちる。**
        self.assertEqual(got, [real])


if __name__ == "__main__":
    unittest.main()
