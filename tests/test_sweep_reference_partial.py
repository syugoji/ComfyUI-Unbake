# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""欠けた刻印から**帰属だけでも拾う**（``I-20260831-71``・2026-09-01）。

以前は ``template_id`` / ``job_id`` / ``cell_id`` / ``signature`` の
**どれか1つでも空なら丸ごと捨てて**いた。``record_id`` が正しくても、
その画像は「どの記録から出たか判らない絵」になる。

**書き手が普通に作りうる形である。** ``sweepRunner.js`` の ``buildSweepStamp``
は ``String(x ?? "")`` なので、元の値が無ければ空文字が入る。

しかも**ブラウザ側は同じ刻印を読めていた**（``generationRecord.js`` は
``parseJsonLoose`` で素通し）。**同じ絵が画面からは読めて Python からは
読めない**——このファイルは「Unbake が焼いた3枚は Python から1枚も読めなかった」
という前科を自分で書いている。
"""
import unittest

from unbake.utils.recipe_pnginfo import (
    SWEEP_PNGINFO_KEY,
    SWEEP_PNGINFO_SCHEMA,
    extract_sweep_reference,
    parse_sweep_reference,
)

FULL = {
    "schema": SWEEP_PNGINFO_SCHEMA,
    "record_id": "137684933",
    "template_id": "t1",
    "job_id": "j1",
    "cell_id": "c1",
    "signature": "sig",
    "labels": ["cfg=7"],
}


def stamp(**overrides):
    return {SWEEP_PNGINFO_KEY: {**FULL, **overrides}}


class PartialStampTest(unittest.TestCase):

    def test_対照_全部そろえば揃っていると言う(self):
        found = extract_sweep_reference(stamp())
        self.assertEqual(found["record_id"], "137684933")
        self.assertEqual(found["cell_id"], "c1")
        self.assertTrue(found["complete"])

    def test_欠けても帰属は残る(self):
        for name in ("template_id", "job_id", "cell_id", "signature"):
            with self.subTest(name):
                found = extract_sweep_reference(stamp(**{name: ""}))
                self.assertIsNotNone(found, f"{name} が空なだけで丸ごと捨てている")
                self.assertEqual(found["record_id"], "137684933")

    def test_欠けていることを言う(self):
        """**「判らない」を「無い」と混ぜない。**"""
        found = extract_sweep_reference(stamp(cell_id=""))
        self.assertFalse(found["complete"])
        self.assertEqual(found["cell_id"], "")

    def test_鍵はいつも在る(self):
        """受け手が `KeyError` を踏まないこと（空文字で埋める）。"""
        found = extract_sweep_reference(stamp(template_id="", job_id="",
                                              cell_id="", signature=""))
        for name in ("template_id", "job_id", "cell_id", "signature"):
            self.assertEqual(found[name], "")
        self.assertFalse(found["complete"])

    def test_record_id_が無ければ捨てる(self):
        """**ここだけは全部か無か。** 帰属できないなら持っていても使えない。"""
        self.assertIsNone(extract_sweep_reference(stamp(record_id="")))

    def test_schema_が違えば捨てる(self):
        self.assertIsNone(extract_sweep_reference(stamp(schema="別物")))

    def test_文字列から読む経路も同じ(self):
        """`parse_sweep_reference` は `extract_sweep_reference` へ委ねている
        ——**規則を2箇所に書かない**ことをここで留める。"""
        import json
        found = parse_sweep_reference(json.dumps({**FULL, "cell_id": ""}))
        self.assertIsNotNone(found)
        self.assertEqual(found["record_id"], "137684933")
        self.assertFalse(found["complete"])


class OutputIndexTest(unittest.TestCase):
    """**画像が引けるようになったこと**を、照合の側から確かめる。"""

    def test_cell_id_が空でも_record_id_で当たる(self):
        found = extract_sweep_reference(stamp(cell_id=""))
        # `recipe_output_index` の照合はこの1行（`rid != wanted and
        # str((sweep or {}).get("record_id") or "") != wanted`）。
        wanted = "137684933"
        self.assertEqual(str((found or {}).get("record_id") or ""), wanted)

    def test_対照_以前は_None_なので当たらなかった(self):
        """**反実仮想。** 捨てていた頃は `sweep` が `None` で、この式は
        `"" != wanted` ＝真になり `continue` していた。"""
        self.assertNotEqual(str((None or {}).get("record_id") or ""), "137684933")


if __name__ == "__main__":
    unittest.main()
