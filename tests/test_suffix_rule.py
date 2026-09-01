# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""``ALLOWED_SUFFIXES`` の**意味**を留める（``I-20260831-70``・2026-09-01）。

決めたのは2つ:

(a) この一覧は「**安全な形式**」ではなく「**こちらが扱える形式**」である。
    出典は ComfyUI の ``folder_paths.supported_pt_extensions`` で、**狭めない**。
(b) ``.gguf`` は**通さない**。通すなら kind の対応づけと payload の判定が
    **同時に**要る——片方だけだと「落とせるのに一覧に出ない」を作る。

**(b) は注記でなく機械で留める。** 「同時に要る」と書いてあるだけの約束は、
次に足す人が読まなければ守られない。ここでは *``.gguf`` を足したら
``classify_model_payload`` も知っていること* を条件つきで検査する
——つまり**この検査は ``.gguf`` を禁じていない**。片肺で足すことを禁じている。
"""
import io
import re
import unittest
from pathlib import Path

from unbake.download import ALLOWED_SUFFIXES
from unbake.utils.model_file_names import MODEL_FILE_EXTENSIONS

ROOT = Path(__file__).resolve().parent.parent

#: ComfyUI 0.27.0 の ``folder_paths.supported_pt_extensions``（2026-09-01 実機実測・
#: ``D:/AI/ComfyUI_windows_portable/ComfyUI/folder_paths.py:10``）。
#: **ここを書き換えるときは実機を測り直すこと**——本体が増やしたのに
#: こちらが写していない状態は、この検査からは「一致」に見える。
COMFYUI_SUPPORTED_PT_EXTENSIONS = frozenset({
    ".ckpt", ".pt", ".pt2", ".bin", ".pth", ".safetensors", ".pkl", ".sft",
})


class AllowedSuffixesTest(unittest.TestCase):

    def test_ComfyUI_の集合と一致する(self):
        """**狭めない。** 狭めた分は「落とせないモデル」として利用者に出る。"""
        self.assertEqual(set(ALLOWED_SUFFIXES), set(COMFYUI_SUPPORTED_PT_EXTENSIONS))

    def test_重複が無い(self):
        self.assertEqual(len(ALLOWED_SUFFIXES), len(set(ALLOWED_SUFFIXES)))

    def test_正の一覧の外へ出ない(self):
        """名前を寄せる規則（``I-20260831-69``）とは別の規則だが、**外へは出ない**。"""
        canonical = {"." + ext for ext in MODEL_FILE_EXTENSIONS}
        self.assertLessEqual(set(ALLOWED_SUFFIXES), canonical)

    def test_pickle_を弾いていない(self):
        """**安全の一覧ではない**ことを、中身の側から留める。

        ``.pkl`` だけを弾いて ``.pt`` を通す状態が、この規則の壊れ方だった
        ——**同じ pickle が両側に分かれている**と、次に足す人が判断できない。
        """
        for suffix in (".ckpt", ".pt", ".pt2", ".pth", ".bin", ".pkl"):
            with self.subTest(suffix):
                self.assertIn(suffix, ALLOWED_SUFFIXES)

    def test_注記が安全の一覧だと名乗っていない(self):
        """**綴りを禁じない**（`test_asserting_source_spelling_pins_the_defect`）。

        最初は旧文言「実行できる形式を落とさない」を `assertNotIn` で禁じたが、
        **その旧文言は経緯の説明として引用されている**ので、正しい注記のほうが
        赤くなった。留めるべきは*主張*——「安全の一覧ではない」と
        「出典はここ」の2つが書かれていること。
        """
        source = io.open(ROOT / "unbake" / "download.py", encoding="utf-8").read()
        note = source[source.index("#: 受け取ってよい拡張子"): source.index("ALLOWED_SUFFIXES =")]
        self.assertIn("こちらが扱える形式", note, "一覧の意味が書かれていない")
        self.assertIn("安全の一覧としては成立しない", note,
                      "安全の一覧ではないという主張が無い")
        self.assertIn("supported_pt_extensions", note, "出典が書かれていない")


class GgufCouplingTest(unittest.TestCase):
    """``.gguf`` は**片肺で足せない**。

    足すと決めたときに壊れるのはここではなく、**利用者の一覧**である
    （``ComfyUI-GGUF`` は ``unet_gguf`` / ``clip_gguf`` という別のキーへ登録するので、
    ``get_filename_list("diffusion_models")`` には出てこない）。
    """

    def _validation_source(self):
        return io.open(ROOT / "unbake" / "utils" / "model_file_validation.py",
                       encoding="utf-8").read()

    def test_いまは通していない(self):
        # **決定そのもの**（2026-09-01・案2）。通す判断をしたら、下2つが番をする。
        self.assertNotIn(".gguf", ALLOWED_SUFFIXES)

    def test_通すなら中身の判定も知っていること(self):
        """``classify_model_payload`` が知らない拡張子は ``PAYLOAD_UNKNOWN``。

        つまり **HTML のエラーページを掴んだことに気づけない**——
        この装置が最初に作られた理由（9,603 B の ``<!DOCTYPE html>``）が
        ``.gguf`` にだけ効かない状態になる。
        """
        if ".gguf" not in ALLOWED_SUFFIXES:
            self.skipTest("まだ通していない（通した瞬間にここが番をする）")
        source = self._validation_source()
        self.assertIn('b"GGUF"', source,
                      "gguf を通すなら先頭4バイトの判定が要る")

    def test_通すなら一覧の経路も在ること(self):
        """置き場のフォルダは同じでも、``folder_paths`` の**キーが違う**。"""
        if ".gguf" not in ALLOWED_SUFFIXES:
            self.skipTest("まだ通していない（通した瞬間にここが番をする）")
        models = io.open(ROOT / "unbake" / "models.py", encoding="utf-8").read()
        self.assertTrue(
            re.search(r"unet_gguf|clip_gguf", models),
            "gguf を通すなら unet_gguf / clip_gguf を一覧の経路へ繋ぐこと")


class UnsupportedCodeTest(unittest.TestCase):
    """**「扱えない形式」を「こちらの設定の問題」と言わない。**"""

    def test_印が分かれている(self):
        from unbake.download import DownloadError, safe_target
        with self.assertRaises(DownloadError) as caught:
            safe_target("loras", "x.gguf")
        self.assertEqual(caught.exception.code, "unsupported")
        self.assertNotEqual(caught.exception.code, "setup")

    def test_理由に拡張子が出る(self):
        from unbake.download import DownloadError, safe_target
        with self.assertRaises(DownloadError) as caught:
            safe_target("loras", "x.gguf")
        self.assertIn(".gguf", str(caught.exception))

    def test_対照_名前が空なら別の理由(self):
        from unbake.download import DownloadError, safe_target
        with self.assertRaises(DownloadError) as caught:
            safe_target("loras", "   ")
        self.assertEqual(caught.exception.code, "setup",
                         "空の名前はこちらの設定の話なので setup のまま")


if __name__ == "__main__":
    unittest.main()
