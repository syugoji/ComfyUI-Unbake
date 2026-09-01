# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**出力索引は2本同時に叩かれる**（2026-08-31・監査 I-20260831-14）。

`RecipeOutputIndex._entries` は素の dict で、`refresh()` が書き（代入と pop）
`get_outputs()` が回すのに、**排他が一切無かった**——ファイルに `threading` の
import すら無かった。

**単一スレッドの想定が成り立たない。** `routes.py` の `/unbake/outputs` は
`await asyncio.to_thread(record_outputs, …)` で**スレッドプールへ流す**ので、
2本同時に来ると別スレッドで走る。呼び手も JS 側に2箇所あり（`comfyHost.js` の
出力読み込みと読み直し）、Sweep 面を開いたまま再現を押すと重なる。

結果は `RuntimeError: dictionary changed size during iteration` で **500**。
既存の検査は `tests/test_output_index_sweep.py` が単一スレッドで印の照合を
見るだけなので、この形は1本も見ていない。

**直し方の意図**: 走査は遅い I/O を含むので、鍵を持ったまま歩かない。
古い索引の写しを見ながら新しい dict を組み、**最後に差し替える**。
読む側は写しを1回取ってから I/O へ入る。走査どうしは別の鍵で直列化して、
後から来た走査が先の結果を取りこぼさないようにする。
"""
import os
import tempfile
import threading
import time
import unittest
from unittest import mock

from unbake.services import recipe_output_index as roi


class OutputIndexConcurrencyTest(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.mkdtemp()
        # **枚数が要る。** 数枚だと反復が一瞬で終わり、書き換えと重ならない。
        for i in range(600):
            with open(os.path.join(self._dir, "img%05d.png" % i), "wb") as handle:
                handle.write(b"x")
        self._index = roi.RecipeOutputIndex(output_dir_getter=lambda: self._dir)
        # 画像の中身は読ませない（この検査で見たいのは索引の排他だけ）。
        patches = [
            mock.patch.object(roi, "read_recipe_reference_from_image",
                              lambda path: {"recipe_id": "rec-1"}),
            mock.patch.object(roi, "read_sweep_reference_from_image", lambda path: None),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        self._index.refresh()

    def test_同時に2本走らせても落ちない(self):
        """**これが本体。** 片方が書き換えている最中に、もう片方が反復する。"""
        errors = []
        stop = threading.Event()
        counter = [0]
        guard = threading.Lock()

        def worker(name):
            while not stop.is_set():
                with guard:
                    counter[0] += 1
                    n = counter[0]
                # 走査の途中で顔ぶれが変わる状況を作る（実機では絵が焼き上がる）。
                with open(os.path.join(self._dir, "new%06d.png" % n), "wb") as handle:
                    handle.write(b"x")
                try:
                    self._index.get_outputs("rec-1", refresh=True)
                except Exception as error:  # noqa: BLE001 - 何が出ても記録する
                    errors.append((name, type(error).__name__, str(error)))
                    return

        threads = [threading.Thread(target=worker, args=("t%d" % i,)) for i in range(2)]
        for thread in threads:
            thread.start()
        time.sleep(6)
        stop.set()
        for thread in threads:
            thread.join(20)

        self.assertEqual(errors, [], "同時に叩くと落ちる（HTTP では 500 になる）")

    def test_対照_単独なら今までどおり引ける(self):
        """**対照。** 排他を足したことで、普通の呼びを壊していないこと。"""
        rows = self._index.get_outputs("rec-1", refresh=True)
        self.assertEqual(len(rows), 600)
        self.assertTrue(all(row["filename"].endswith(".png") for row in rows))
        # 新しい順に並んでいること（並べ替えは索引の契約）。
        modified = [row["modified"] for row in rows]
        self.assertEqual(modified, sorted(modified, reverse=True))

    def test_対照_消えたファイルは索引から落ちる(self):
        """**対照。** 差し替え方式にしたので、消えたものが残らないこと。"""
        self.assertEqual(len(self._index.get_outputs("rec-1", refresh=True)), 600)
        for i in range(100):
            os.remove(os.path.join(self._dir, "img%05d.png" % i))
        self.assertEqual(len(self._index.get_outputs("rec-1", refresh=True)), 500)
        self.assertEqual(self._index.get_status()["tracked"], 500)


if __name__ == "__main__":
    unittest.main()
