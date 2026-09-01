# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**参照画像の拡張子が、受け取る・見つける・出す・消すで一致すること**
（2026-09-01・走査10周目）。

同じ一覧が**4箇所**に在り、中身が違っていた:

===========================  ==============================  ==========================
どこ                          何を決める                       実測（直す前）
===========================  ==============================  ==========================
``records._MAGIC``           受け取る（先頭バイトで見分ける）   ``.png .jpg .gif .webp``
``library.PREVIEW_SUFFIXES`` 見つける／消す                    ``.webp .png .jpg .jpeg``
``records.PREVIEW_TYPES``    落とす（Content-Type で決める）    ``.webp .png .jpg``
``routes._CONTENT_TYPES``    出す（HTTP の型）                 ``.webp .png .jpg .jpeg``
===========================  ==============================  ==========================

**`.gif` が「受け取れるのに見つけられない」側に落ちていた。** `store_preview` は
GIF を認めて ``<stem>.gif`` を書くのに、`PREVIEW_SUFFIXES` に無いので

* ``_preview_for()`` が見つけられない → 一覧は ``preview: false``
* ``GET /unbake/record-preview`` は 404
* ``delete_record`` が対の画像として消さない → **孤児がディスクに残る**

の3つが同時に起きる。``records.py`` 自身が「**収まっていないと、落とせても
`_preview_for()` が見つけられない**」と書いているのに、その注記は
``PREVIEW_TYPES``（落とす側）にしか当たっておらず、``sniff_image``（受け取る側）が
外れていた。

**一覧を写し合うのではなく、関係を留める。** どの一覧に何を足しても、
下の4つの関係が崩れたらここが赤くなる。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from unbake import routes  # noqa: E402
from unbake.library import PREVIEW_SUFFIXES  # noqa: E402
from unbake.records import PREVIEW_TYPES, sniff_image  # noqa: E402


#: `sniff_image` が実際に返す拡張子を、**関数を通して**集める。
#: 定数（`_MAGIC`）を読むと、WebP のように分岐で書かれた形を取り落とす。
_SAMPLES = {
    ".png": bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) + b"\x00" * 8,
    ".jpg": bytes([0xFF, 0xD8, 0xFF]) + b"\x00" * 12,
    ".gif": b"GIF89a" + b"\x00" * 8,
    ".webp": b"RIFF" + b"\x00\x00\x00\x00" + b"WEBP" + b"\x00" * 4,
}


def _sniffable() -> set:
    """`sniff_image` が返しうる拡張子（実際に呼んで確かめる）。"""
    found = set()
    for expected, payload in _SAMPLES.items():
        got = sniff_image(payload)
        assert got == expected, f"{expected} の見本を {got!r} と読んだ"
        found.add(got)
    return found


class 参照画像の拡張子がそろっている(unittest.TestCase):
    def test_見本が全部_sniff_image_を通る(self):
        """**前提の確認。** ここが崩れたら下の3つは何も見ていない。"""
        self.assertEqual(_sniffable(), set(_SAMPLES))

    def test_受け取れる物は見つけられる(self):
        missing = sorted(_sniffable() - set(PREVIEW_SUFFIXES))
        self.assertEqual(
            missing, [],
            "書けるのに `_preview_for()` が見つけられない拡張子がある"
            "（一覧に出ず・404 になり・対の画像として消されない）",
        )

    def test_落とせる物は見つけられる(self):
        missing = sorted(set(PREVIEW_TYPES.values()) - set(PREVIEW_SUFFIXES))
        self.assertEqual(missing, [], "落とせるのに見つけられない拡張子がある")

    def test_見つけられる物は出せる(self):
        missing = sorted(set(PREVIEW_SUFFIXES) - set(routes._CONTENT_TYPES))
        self.assertEqual(
            missing, [],
            "ディスクで見つかるのに HTTP で出せない拡張子がある（404 になる）",
        )

    def test_見つけられる物は消される(self):
        """**見つける一覧と消す一覧が同じ物であること。**

        別々になると、一覧から消えたのにディスクへ残る孤児ができる
        ——`records.py` の冒頭が「残すと、次の走査で拾われない孤児が増える」と
        書いている当のこと。**原文ではなく、実際に消して確かめる。**
        """
        import tempfile

        from unbake import records

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            record = root / "rec-1.unbake.json"
            record.write_text('{"id": "rec-1"}', encoding="utf-8")
            # **見つけられる拡張子を全部置く。**
            for suffix in PREVIEW_SUFFIXES:
                (root / f"rec-1{suffix}").write_bytes(b"x")

            class FakeLibrary:
                def raw_row(self, _record_id):
                    return {"id": "rec-1", "path": str(record), "owner": "unbake"}

                def source_dirs(self):
                    return [root]

                def output_dir(self):
                    return root

            class FakeSettings:
                @staticmethod
                def get(key, default=None):
                    return str(root) if key == "record_output_dir" else default

            result = records.delete_record(FakeLibrary(), FakeSettings(), "rec-1")

        left = sorted(
            suffix for suffix in PREVIEW_SUFFIXES
            if f"rec-1{suffix}" not in result["removed"]
        )
        self.assertEqual(
            left, [],
            "見つけられる拡張子なのに対の画像として消されない"
            "（一覧から消えたのにディスクへ残る孤児ができる）",
        )
        self.assertIn("rec-1.unbake.json", result["removed"])

    def test_対照_画像でないものは受け取らない(self):
        self.assertIsNone(sniff_image(b"<!DOCTYPE html><html></html>"))
        self.assertIsNone(sniff_image(b""))
        self.assertIsNone(sniff_image(b"short"))


if __name__ == "__main__":
    unittest.main()
