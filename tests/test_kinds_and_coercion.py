# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**落とせるものは消せる／設定の型は寄せる**
（2026-08-31・監査 I-20260831-34, I-20260831-32）。

## 種別の一覧が2つに割れていた（-34）

`models.py` のコメントは「`download.py` と同じ並び」と書いているが、実際は
**`hypernetworks` が落とす側にだけ在った**（8種 対 7種）。2026-08-26 に
`civitai.py` の `KIND_OF_TYPE` へ hypernetwork を足したとき、片方だけが
更新された。

害は非対称そのもの——Civitai の Hypernetwork は**落とせるのに消せない**。
削除計画が `unsupported kind` で 400 を返し、画面は「入っていません」と出して
削除ボタンを押せないままにする。見本も使用件数も引けない。

**一覧を突き合わせる検査を置く。** コメントで「同じ並び」と書いても守られない
ことが実証されたので、機械で留める。

## `_coerce` に float の枝が無かった（-32）

`bool → int → 列挙 → list → str` の順に見るが **float の枝が無い**。
既定が float の鍵は `replay_max_megapixels` ただ1つで、どの枝にも当たらず
末尾の `return value` に落ちるため、**届いた値がそのまま保存される**。

画面のフォームは `String(input.value).trim()` を送るので、ディスクには
`"8.5"` という**文字列**で残る。以後 `type=number` の欄へ当てられず空表示に
なり、`collect()` は空を送らない規則なので上書きもできず、**再現の上限は
黙って既定へ戻り続ける**。
"""
import unittest

from unbake import download, models
from unbake.settings import KNOWN_KEYS, _coerce


class AllowedKindsTest(unittest.TestCase):
    # **「一致」から「包含」へ変えた**（2026-08-31・3周目）。
    #
    # 元は `models.ALLOWED_KINDS == download.ALLOWED_KINDS` を要求していたが、
    # **落とす口は2つある**——既知モデル台帳は `download.ALLOWED_KINDS` を
    # 通らない別の口を持っており、その置き場（`text_encoders` /
    # `ultralytics_bbox`）を触れる側へ入れると等号が壊れる。
    # 守りたいのは等号ではなく「**落とせるものは必ず消せる**」なので、
    # 向きのある2本（下）へ置き換えた。

    def test_空振り検出_一覧が痩せていない(self):
        # 両方が空になっても「一致」してしまうので、下限を置く。
        self.assertGreaterEqual(len(models.ALLOWED_KINDS), 7, "種別の一覧が痩せている")

    def test_hypernetworks_が両方に在る(self):
        """欠けていた当の1件を名指しで留める。"""
        self.assertIn("hypernetworks", download.ALLOWED_KINDS)
        self.assertIn("hypernetworks", models.ALLOWED_KINDS)

    def test_台帳が書く置き場も触れる種別に入っている(self):
        """**書く側は2つある**（2026-08-31・3周目）。

        既知モデル台帳は `download.ALLOWED_KINDS` を通らない別の落とし口を
        持っている（`known_model_downloader` が `entry.folder` を直に使う）。
        上の「両者の一致」だけを見ていたので、**3つ目の書き手が見えず**、
        `text_encoders` 10件・`ultralytics_bbox` 1件が
        「落とせるのに消せない」状態で残っていた。
        """
        from unbake.services.known_model_catalog import KNOWN_MODELS

        folders = sorted({entry.folder for entry in KNOWN_MODELS})
        self.assertGreaterEqual(len(folders), 3, f"台帳の置き場を数えられていない: {folders}")
        missing = [f for f in folders if f not in models.ALLOWED_KINDS]
        self.assertEqual(
            missing, [],
            f"台帳が書くのに触れない置き場が在る（落とせるのに消せない）: {missing}",
        )

    def test_落とせる種別は触れる種別の一部である(self):
        """向きを言い切る。**触れる側が広いのは正しい**（台帳のぶんが増える）。"""
        outside = [k for k in download.ALLOWED_KINDS if k not in models.ALLOWED_KINDS]
        self.assertEqual(outside, [], f"落とせるのに消せない種別が在る: {outside}")


class CoerceFloatTest(unittest.TestCase):
    KEY = "replay_max_megapixels"

    def test_既定が浮動小数の鍵が実在する(self):
        """**空振り検出。** この鍵が消えたら、下の検査は何も測らない。"""
        default = KNOWN_KEYS[self.KEY]
        self.assertIsInstance(default, float)
        self.assertNotIsInstance(default, bool)

    def test_数の文字列は数へ寄せる(self):
        """**これが本体。** 画面のフォームは文字列を送る。"""
        self.assertEqual(_coerce(self.KEY, "8.5"), 8.5)
        self.assertIsInstance(_coerce(self.KEY, "8.5"), float)

    def test_読めない値は既定へ倒す(self):
        for bad in ("not a number", {"a": [1, 2]}, [1, 2], None):
            got = _coerce(self.KEY, bad)
            self.assertIsInstance(
                got, float, "読めない値がそのまま保存されている: %r → %r" % (bad, got))
            self.assertEqual(got, KNOWN_KEYS[self.KEY])

    def test_対照_数はそのまま通る(self):
        self.assertEqual(_coerce(self.KEY, 6), 6.0)
        self.assertEqual(_coerce(self.KEY, 6.25), 6.25)

    def test_対照_ほかの型の鍵を壊していない(self):
        # 整数・真偽値・文字列の枝が今までどおりであること。
        for key, value, want in [
            ("replay_max_pixels", "1024", 1024),
            ("confirm_before_delete", "false", False),
            ("record_output_dir", 123, "123"),
        ]:
            if key not in KNOWN_KEYS:
                continue
            self.assertEqual(_coerce(key, value), want, "鍵 %s の寄せ方が変わっている" % key)


if __name__ == "__main__":
    unittest.main()
