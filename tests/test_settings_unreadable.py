# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**読めない設定ファイルで拡張ごと死なせない**（2026-08-31・監査 I-20260831-13）。

`FileSettings.load()` の docstring は「**壊れていても例外にしない**——設定が1つ
壊れただけで拡張ごと起動しないのは割に合わない」と約束している。ところが
`read_text` の失敗を `FileNotFoundError` と `OSError` でしか受けていなかったので、
**`UnicodeDecodeError` だけが素通り**していた（`ValueError` の一種であって
`OSError` ではない）。

**素通りの行き先が悪い。** 例外は `register_routes()` まで届き、`@routes.get` を
1つも通る前に `install_default_environment()` → `get_settings()` で落ちる。
`__init__.py` の `except Exception` が飲むので **ComfyUI 自体は起動する**が、
**`/unbake/*` が全て 404 になってパネルが完全に死ぬ**。しかも `get_settings()` は
例外で `_settings` を代入できないので、**再起動しても毎回同じ所で落ち、
ファイルを直すまで永久に復旧しない**。

踏み方は難しくない——利用者がメモ帳の「ANSI」（日本語 Windows では cp932）で
保存し直し、`record_output_dir` に日本語を入れるだけ。

**JSON 構文エラーは元から正しく捕まっていた**ので、ここは対照つきで留める
（片方だけ見ると「例外を握り潰した」と「本当に読めた」が見分けられない）。
"""
import json
import os
import tempfile
import unittest

from unbake.settings import FileSettings


class UnreadableSettingsFileTest(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.mkdtemp()

    def _write(self, data: bytes) -> str:
        path = os.path.join(self._dir, "unbake.settings.json")
        with open(path, "wb") as handle:
            handle.write(data)
        return path

    def test_非UTF8で保存された設定でも例外にしない(self):
        """**これが本体。** cp932 で保存し直した設定を読ませる。"""
        body = json.dumps({"record_output_dir": "D:/AI/記録"}, ensure_ascii=False)
        settings = FileSettings(self._write(body.encode("cp932")))

        settings.load()  # 例外を投げたらここで落ちる

        self.assertIsNotNone(
            settings.load_error,
            "読めなかったのに load_error が空＝黙って既定へ落ちている",
        )
        self.assertIn("Decode", settings.load_error or "")

    def test_読めなくても既定へ落ちて値は引ける(self):
        """**例外にしないだけでは足りない。** 後続が使える形で返ること。"""
        settings = FileSettings(self._write("{}".encode("utf-16")))
        settings.load()
        self.assertEqual(settings.get("record_output_dir", "既定"), "既定")

    def test_対照_JSON構文エラーは元から捕まっている(self):
        """**対照。** 片方だけだと「捕まえた」と「読めた」が見分けられない。"""
        settings = FileSettings(self._write(b"{oops}"))
        settings.load()
        self.assertIsNotNone(settings.load_error)
        self.assertTrue((settings.load_error or "").startswith("JSON:"))

    def test_対照_読める設定はそのまま読める(self):
        """**対照。** 直したことで正常系を壊していないこと。"""
        body = json.dumps({"record_output_dir": "D:/AI/records"})
        settings = FileSettings(self._write(body.encode("utf-8")))
        settings.load()
        self.assertIsNone(settings.load_error)
        self.assertEqual(settings.get("record_output_dir"), "D:/AI/records")


if __name__ == "__main__":
    unittest.main()
