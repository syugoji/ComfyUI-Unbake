# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**名指しした絵だけ生の値を読む口**（`I-20260829-01`）。

起動時の走査は印だけを取る。`prompt`（実行グラフ）は転送の 97% を占めるのに、
実データで帰属を1件も増やしていなかった——だが「何が違うか」の表示には要る。
そこで**記録を開いた時に、その記録の絵のぶんだけ**読む。

ここで守るのは3つ。どれも、崩れても画面は普通に見える:

1. **頼んだ鍵だけを返す。** 返しすぎると起動時に落としたはずの転送が戻る。
2. **置き場の外は読まない。** 記録に書かれた文字列は検証していない値なので、
   `..` や絶対パスで抜けられると「絵を読む」口が任意のファイルを読む口になる。
3. **控えは足す（入れ替えない）。** 呼び手ごとに欲しい鍵が違うので、
   入れ替えると印→`prompt`→印…と交互に読み直しが起き、控えが一度も効かない。
"""
from __future__ import annotations

import os
import sys
import tempfile
import re
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from unbake import outputs as outputs_module  # noqa: E402


def write_png(path: str, chunks: dict) -> None:
    """テキストチャンク付きの PNG を1枚書く（実物と同じ `pnginfo` 経路）。"""
    from PIL import Image
    from PIL.PngImagePlugin import PngInfo

    info = PngInfo()
    for key, value in chunks.items():
        info.add_text(key, value)
    Image.new("RGB", (2, 2), (1, 2, 3)).save(path, pnginfo=info)


class ReadRawForTest(unittest.TestCase):
    def setUp(self):
        # **置き場の「親」に、実在する読まれてはいけない絵を置く。**
        #
        # 別の一時ディレクトリへ置くと、`..` で辿っても**そもそも存在しない**ので
        # 「置き場の外だから断った」ではなく「無いから断った」で受かってしまう。
        # 実際その形で書いており、**置き場の判定を丸ごと外しても検査が緑のまま**
        # だった（変異検査が捕まえた）。辿れる位置に実在させて初めて検査になる。
        self.base = tempfile.mkdtemp()
        self.dir = os.path.join(self.base, "output")
        self.sub = os.path.join(self.dir, "batch")
        os.makedirs(self.sub, exist_ok=True)
        write_png(os.path.join(self.dir, "a.png"),
                  {"prompt": '{"1":{}}', "unbake_sweep": '{"record_id":"r1"}'})
        write_png(os.path.join(self.sub, "b.png"), {"prompt": '{"2":{}}'})
        self.outside = self.base
        write_png(os.path.join(self.base, "secret.png"), {"prompt": "SECRET"})

        self._saved = outputs_module._default_output_dir
        outputs_module._default_output_dir = lambda: self.dir
        outputs_module.reset_output_scanner()
        outputs_module.get_output_scanner(output_dir_getter=lambda: self.dir)

    def tearDown(self):
        outputs_module._default_output_dir = self._saved
        outputs_module.reset_output_scanner()

    def test_reads_named_files_only(self):
        found = outputs_module.read_raw_for(
            [{"subfolder": "", "filename": "a.png"},
             {"subfolder": "batch", "filename": "b.png"}],
            ["prompt"],
        )
        self.assertEqual(sorted(found), ["/a.png", "batch/b.png"])
        self.assertEqual(found["/a.png"]["prompt"], '{"1":{}}')
        self.assertEqual(found["batch/b.png"]["prompt"], '{"2":{}}')

    def test_returns_only_the_requested_keys(self):
        """**返しすぎない。** 起動時に落とした転送がここで戻ってはいけない。"""
        found = outputs_module.read_raw_for([{"filename": "a.png"}], ["prompt"])
        self.assertEqual(list(found["/a.png"]), ["prompt"])

    def test_unknown_keys_fall_back_to_all_known_keys(self):
        """宣言に無い鍵は無視される（呼び手が鍵を増やせない）。"""
        found = outputs_module.read_raw_for([{"filename": "a.png"}], ["nope"])
        self.assertIn("prompt", found["/a.png"])

    def test_the_escape_target_really_exists(self):
        """**逃走先が実在すること。** 無ければ「置き場の外」の検査にならない。"""
        self.assertTrue(os.path.isfile(os.path.join(self.base, "secret.png")))
        self.assertFalse(
            os.path.realpath(os.path.join(self.base, "secret.png"))
            .startswith(os.path.realpath(self.dir) + os.sep))

    def test_refuses_paths_outside_the_output_dir(self):
        # **`..` で辿れて、しかも実在する**もの。これだけが置き場の判定を通る。
        traversals = [
            {"subfolder": "..", "filename": "secret.png"},
            {"subfolder": "batch/../..", "filename": "secret.png"},
            {"subfolder": "../" * 6, "filename": "secret.png"},
        ]
        for item in traversals:
            with self.subTest(item=item):
                self.assertEqual(outputs_module.read_raw_for([item], ["prompt"]), {})

        # 名前に区切りや絶対パスを混ぜる形。**別のガードが受け持つ**ので分けて置く
        # ——1つの検査に混ぜると、どちらが効いているのか分からなくなる。
        names = [
            {"subfolder": "", "filename": os.path.join(self.base, "secret.png")},
            {"subfolder": "", "filename": "../secret.png"},
            {"subfolder": "", "filename": "..\\secret.png"},
        ]
        for item in names:
            with self.subTest(item=item):
                self.assertEqual(outputs_module.read_raw_for([item], ["prompt"]), {})

    def test_missing_file_is_absent_not_empty(self):
        """**「読んだが空」と「そもそも無い」を混ぜない。**"""
        self.assertEqual(outputs_module.read_raw_for([{"filename": "none.png"}], ["prompt"]), {})

    def test_cache_keeps_both_key_sets(self):
        """控えは**足す**。入れ替えると交互の呼び出しで毎回読み直しになる。"""
        scanner = outputs_module.get_output_scanner()
        first = scanner.page(offset=0, limit=10, keys=("unbake_sweep",))
        self.assertEqual(first["opened"], 2, "1回目で開いた枚数が想定と違う")

        # `prompt` は控えに無いので読み直す。
        outputs_module.read_raw_for([{"filename": "a.png"}], ["prompt"])

        # **ここが要点。** 入れ替えていたら印がもう一度読み直しになる。
        again = scanner.page(offset=0, limit=10, keys=("unbake_sweep",))
        self.assertEqual(again["opened"], 0, "印の控えが消えている（入れ替えている）")

        both = scanner.read_raw_cached(os.path.join(self.dir, "a.png"),
                                       ("prompt", "unbake_sweep"))
        self.assertEqual(sorted(both), ["prompt", "unbake_sweep"])


class RawKeysContractTest(unittest.TestCase):
    """**JS 側の `STAMP_SOURCES` と対。**

    起動時の走査は「`RAW_KEYS` から `prompt` を除いた分」を頼む。
    サーバが鍵を1つ足したとき、JS 側が取り落とすと帰属が黙って減るので、
    ここで対応を固定する（JS 側は `stamp_keys_match_server_test.mjs`）。

    **相手の表を読む。写し取らない**（2026-09-01・走査8周目）。
    ここは期待値を `["lora_manager_recipe", ...]` という**リテラル**で持っており、
    docstring が「JS 側と対」と言っているのに**どちらの側も読んでいなかった**。
    JS 側は `unbake/outputs.py` の原文を読んで比べているので、**同じ不変条件が
    2通りで書かれ、片方だけが相手を見ている**状態だった。
    印を1つ足すと、実装2箇所に加えて**このリテラルも**直す必要があり、
    直し忘れると「対応が固定されている」と言いながら赤くなるだけになる。
    """

    #: JS 側の印の表。`['key', [...]]` の並びから鍵だけを取る。
    STAMP_SOURCES_JS = Path(__file__).resolve().parent.parent / "web" / "core" / "outputAttribution.js"

    def _js_stamp_keys(self):
        source = self.STAMP_SOURCES_JS.read_text(encoding="utf-8")
        block = re.search(
            r"const STAMP_SOURCES = Object\.freeze\(\[(.*?)^\]\);",
            source,
            re.DOTALL | re.MULTILINE,
        )
        self.assertIsNotNone(block, "JS 側の STAMP_SOURCES が読めない（形が変わった）")
        keys = re.findall(r"^\s*\['([^']+)',", block.group(1), re.MULTILINE)
        self.assertTrue(keys, "JS 側の STAMP_SOURCES から鍵を1つも取れない")
        return sorted(keys)

    def test_prompt_is_the_only_non_stamp_key(self):
        self.assertIn("prompt", outputs_module.RAW_KEYS,
                      "サーバ側に prompt が無い（前提が変わっている）")
        self.assertEqual(
            sorted(set(outputs_module.RAW_KEYS) - {"prompt"}),
            self._js_stamp_keys(),
            "印の鍵が JS 側の表とずれている",
        )


if __name__ == "__main__":
    unittest.main()
