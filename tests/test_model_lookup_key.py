# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**名前を引くための鍵が、両言語で同じ答えを出す**（`I-20260831-69`）。

一覧の同値は `tests/declared_tests_exist_test.mjs` が両ファイルを読んで固定し、
JS 側の挙動は `tests/model_name_rule_is_single_test.mjs` が留める。
ここは **Python 側の挙動**——同じ入力に同じ鍵が出ることを、綴りではなく値で見る。

規則が3箇所に手書きされていたときは、``.gguf`` を Python が ``x`` で索引し
JS が ``xgguf`` で引いていた。**同じ表を2つの言語で持つ以上、両側の挙動を
別々に留めないと、片側だけ直しても気づけない。**
"""
import unittest

from unbake.utils.model_file_names import (
    MODEL_FILE_EXTENSIONS,
    compact_model_name,
    model_lookup_key,
)


class ModelLookupKeyTest(unittest.TestCase):
    def test_境界で割れていた綴りが同じ鍵になる(self):
        for name in ("x.gguf", "x.pt2", "x.pkl", "x.onnx", "x.safetensors"):
            with self.subTest(name):
                self.assertEqual(model_lookup_key(name), "x")

    def test_フォルダを落として小文字にする(self):
        self.assertEqual(model_lookup_key("Some\\Folder\\X.SAFETENSORS"), "x")
        self.assertEqual(model_lookup_key("some/folder/X.ckpt"), "x")

    def test_名前の一部を拡張子と読み違えない(self):
        """`splitext` を使うとここが割れる（実データの checkpoint 名）。"""
        self.assertEqual(model_lookup_key("re-mixmain.fp16"), "re-mixmain.fp16")
        self.assertEqual(model_lookup_key("ink-style_A3.1_XL"), "ink-style_a3.1_xl")
        self.assertEqual(
            model_lookup_key("ink-style_A3.1_XL.safetensors"), "ink-style_a3.1_xl"
        )

    def test_空や未指定でも落ちない(self):
        for value in (None, "", "   "):
            with self.subTest(repr(value)):
                self.assertEqual(model_lookup_key(value), "")

    def test_一覧の全部が落ちる(self):
        """**一覧に足したのに落ちない、を防ぐ。**"""
        for ext in MODEL_FILE_EXTENSIONS:
            with self.subTest(ext):
                self.assertEqual(model_lookup_key(f"model.{ext}"), "model")

    def test_対照_compact_は記号も落とす(self):
        """`model_lookup_key` と `compact_model_name` を取り違えない。

        前者は**索引の鍵**（記号を残す）、後者は**綴りの揺れを吸収する鍵**。
        同じにすると `ink-style_A3.1_XL` のような名前が別物になる。
        """
        self.assertEqual(model_lookup_key("R-ESRGAN 4x+.pth"), "r-esrgan 4x+")
        self.assertEqual(compact_model_name("R-ESRGAN 4x+.pth"), "resrgan4x")


if __name__ == "__main__":
    unittest.main()
