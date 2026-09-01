# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**進み具合の応答に、1本ぶんの数字を混ぜない**（`I-20260831-66`）。

`routes.py` には `_download` という「最後に状態が変わった1本」を指す大域が在り、
`download_state()` が **その中身を応答の一番上へ展開**していた。並列に3本
落とすようにした後も残っていたので、`state` / `bytes` / `totalBytes` が
**どれか1本の話**なのに、全体の話に見えていた。

**これは実際に1度、利用者に見える形で壊れている**（`I-20260830-15`）——
1本ぶんの済みバイトを全体の合計で割って「2.0GB / 12.0GB（16%）」と出し
（本当は50%）、走行判定も旧い1本ぶんの `state` を見ていたので
**1本目が終わった時点で、残り2本の最中に表示が空文字**になっていた。

**そのときは読む側を直して逃げた。** 作る側は同じ形のまま残っていたので、
次に `download_state()` を読む人は同じ罠を踏める。ここで**作る側**を留める。
"""
import unittest

from unbake import routes

#: 1本ぶんの控えが持つ鍵。**全体の応答へ出てはいけない。**
PER_DOWNLOAD_KEYS = ("state", "bytes", "totalBytes", "versionId", "filename", "canceled")


class DownloadStateIsFleetwideTest(unittest.TestCase):
    def setUp(self):
        self._saved = dict(routes._downloads)
        routes._downloads.clear()

    def tearDown(self):
        routes._downloads.clear()
        routes._downloads.update(self._saved)

    def _put(self, key, **fields):
        routes._downloads[key] = {
            "state": "running", "versionId": key, "kind": "lora",
            "filename": f"{key}.safetensors", "bytes": 0, "totalBytes": 100,
            "canceled": False, **fields,
        }

    def test_一番上に1本ぶんの数字が出ない(self):
        self._put("1", bytes=50)
        self._put("2", bytes=10)
        state = routes.download_state()
        leaked = [key for key in PER_DOWNLOAD_KEYS if key in state]
        self.assertEqual(
            leaked, [],
            f"1本ぶんの鍵が全体の応答へ出ている（尺度の違う数字が同じ階層に並ぶ）: {leaked}",
        )

    def test_全体の数字はそろっている(self):
        """**対照。** 混ざり物を外したついでに、要る数字まで落としていないこと。"""
        self._put("1", bytes=50)
        self._put("2", bytes=10, totalBytes=None)
        state = routes.download_state()
        self.assertEqual(state["runningCount"], 2)
        self.assertEqual(state["doneBytes"], 60)
        self.assertEqual(state["totalBytesAll"], 100, "総量の判っている分の合計が違う")
        self.assertEqual(state["unknownTotals"], 1, "総量の判らない本数を数えていない")
        self.assertEqual(len(state["running"]), 2)

    def test_1本が終わっても_残りが走っていることが判る(self):
        """`I-20260830-15` の症状そのもの。

        1本目が `done` になった瞬間、旧い応答は一番上の `state` が `done` に
        なっていた。**残り2本は走っている。**
        """
        self._put("1", state="done", bytes=100)
        self._put("2", bytes=10)
        self._put("3", bytes=20)
        state = routes.download_state()
        self.assertEqual(state["runningCount"], 2, "走っている本数が合わない")
        self.assertNotIn("state", state, "終わった1本の状態が全体の状態として出ている")

    def test_中断は走っているものだけに立つ(self):
        """終わった控えへ「中断された」と書かない。

        以前は `_download["canceled"] = True` も書いており、`_download` が
        指すのは**最後に状態が変わった1本**なので、直前に1本終わっていると
        **終わった控えに中断の印が立って**いた。
        """
        self._put("1", state="done", bytes=100)
        self._put("2", bytes=10)
        result = routes.cancel_download()

        self.assertEqual(result["stopped"], ["2"], "止めた相手が違う")
        self.assertTrue(result["canceled"])
        self.assertFalse(
            routes._downloads["1"]["canceled"],
            "終わった控えに中断の印が立っている",
        )
        self.assertTrue(routes._downloads["2"]["canceled"], "走っている控えに印が立っていない")
        leaked = [key for key in PER_DOWNLOAD_KEYS if key in result and key != "canceled"]
        self.assertEqual(leaked, [], f"1本ぶんの鍵が応答へ出ている: {leaked}")

    def test_版を名指しすれば_その1本だけ止める(self):
        """**対照。** 全部止める既定を、名指しの経路まで壊していないこと。"""
        self._put("1")
        self._put("2")
        result = routes.cancel_download("2")
        self.assertEqual(result["stopped"], ["2"])
        self.assertFalse(routes._downloads["1"]["canceled"])

    def test_大域の_download_が残っていない(self):
        """**同じ形が戻ってこないようにする。**"""
        self.assertFalse(
            hasattr(routes, "_download"),
            "`_download` 大域が復活している（1本ぶんの控えを大域で指さない）",
        )


if __name__ == "__main__":
    unittest.main()
