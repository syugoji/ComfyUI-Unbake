# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**services 層で、作った合図と立てた印が最後まで保つこと**（2026-09-01・走査7周目）。

3件とも「**片方には当たっている規則が、もう片方に当たっていない**」形だった。

1. `known_model_downloader._size_warning` は「落とした物の大きさが台帳と 5% 以上
   ずれている」を計算して `size_warning` に載せるのに、**`routes.py` の口が落として**
   いた——repo 全体で読み手が0件で、サーバの `logger.warning` にしか残らない。
   伴走モデルは数GBなので、掴み直しの判断材料がここしか無い。
2. `raindrop_sync_service.list_collections` は `I-20260831-38` で「一覧の取得も
   走行中に数える」を入れたが、**時間切れの経路では worker がまだ走っているのに
   印を降ろして**いた。`request_cancel()` は頼むだけで、スレッドは殺せない。
3. `recipe_output_index.get_outputs` は 2026-08-26 に **Sweep の印も照合に使う**
   ようになったが、**件数を数える2箇所は `recipe_id` しか見ていなかった**。

**綴りではなく挙動で見る。**
"""

from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from unbake.services import recipe_output_index as index_module  # noqa: E402
from unbake.services.raindrop_sync_service import (  # noqa: E402
    RaindropSyncError,
    RaindropSyncService,
)


class 大きさの警告が呼び手まで届く(unittest.TestCase):
    """`size_warning` を口が落とさないこと。"""

    def test_台帳とずれていれば作る側が合図を載せる(self):
        from unbake.services import known_model_downloader as downloader

        entry = mock.Mock()
        entry.size_bytes = 1000
        self.assertIsNotNone(downloader._size_warning(entry, 2000))   # 5% 超
        self.assertIsNone(downloader._size_warning(entry, 1040))      # 許容差の中
        entry.size_bytes = None
        self.assertIsNone(downloader._size_warning(entry, 2000))      # 台帳が持たない

    def test_口が合図を落とさない(self):
        """**実物の `companion_download_result` を通す。** 原文は読まない。"""
        from unbake import routes

        entry = mock.Mock()
        entry.key = "flux1_t5xxl_text_encoder"
        entry.filename = "t5xxl.safetensors"
        row = routes.companion_download_result(entry, {
            "success": True,
            "skipped": False,
            "size_bytes": 2000,
            "size_warning": "Downloaded size 2000 differs from the catalog size 1000",
            "expected_size_bytes": 1000,
        })
        self.assertTrue(row["ok"])
        self.assertIsNotNone(
            row.get("sizeWarning"),
            "大きさの警告を口が落としている（作る側は載せているのに読み手が居ない）",
        )
        self.assertEqual(row.get("expectedBytes"), 1000)
        self.assertEqual(row.get("bytes"), 2000)

    def test_対照_ずれが無ければ何も足さない(self):
        from unbake import routes

        entry = mock.Mock()
        entry.key = "k"
        entry.filename = "f.safetensors"
        row = routes.companion_download_result(entry, {"success": True, "size_bytes": 1000})
        self.assertIsNone(row.get("sizeWarning"))

    def test_対照_失敗の理由は今までどおり通る(self):
        from unbake import routes

        entry = mock.Mock()
        entry.key = "k"
        entry.filename = "f.safetensors"
        row = routes.companion_download_result(entry, {
            "success": False, "error": "boom", "page_url": "https://example.invalid/p",
        })
        self.assertFalse(row["ok"])
        self.assertEqual(row["error"], "boom")
        self.assertEqual(row["pageUrl"], "https://example.invalid/p")


class 一覧の走行印は_worker_が降りるまで保つ(unittest.TestCase):
    """`I-20260831-38` の印が、時間切れの経路でも嘘をつかないこと。"""

    @staticmethod
    def _service(runner):
        service = RaindropSyncService.__new__(RaindropSyncService)
        service._listing = False
        service._state = RaindropSyncService._initial_state()
        service._runner = None
        service.resolve_script_path = lambda: Path("dummy.py")
        service._build_environment = lambda **_kwargs: {}
        return service

    def test_時間切れで返っても_worker_が走っている間は走行中のまま(self):
        released = asyncio.Event()

        class SlowRunner:
            def __init__(self, *_args, **_kwargs):
                self.canceled = False

            async def run_list_collections(self, _env):
                await released.wait()
                return 0

            def request_cancel(self):
                self.canceled = True

        service = self._service(SlowRunner)

        async def main():
            with mock.patch(
                "unbake.services.raindrop_sync_service.SyncScriptRunner", SlowRunner
            ):
                with self.assertRaises(RaindropSyncError):
                    await service.list_collections(timeout=0.05)
                # **まだ降りていない。** 印を降ろすと `start()` が通ってしまい、
                # 同梱スクリプトの差し込みが剥がれる（`I-20260831-38`）。
                during = service.is_running()
                released.set()
                for _ in range(100):
                    await asyncio.sleep(0)
                    if not service.is_running():
                        break
                return during, service.is_running()

        during, after = asyncio.run(main())
        self.assertTrue(during, "worker がまだ走っているのに「走っていない」と言っている")
        self.assertFalse(after, "worker が降りたのに走行中のまま（以後 start() が通らない）")

    def test_対照_正常に終われば印は降りる(self):
        class FastRunner:
            def __init__(self, *_args, **_kwargs):
                pass

            async def run_list_collections(self, _env):
                return 0

            def request_cancel(self):
                pass

        service = self._service(FastRunner)

        async def main():
            with mock.patch(
                "unbake.services.raindrop_sync_service.SyncScriptRunner", FastRunner
            ):
                with self.assertRaises(RaindropSyncError):
                    # 一覧が1件も返らないので RaindropSyncError になるが、
                    # 見たいのは印が降りていること。
                    await service.list_collections(timeout=5)
            return service.is_running()

        self.assertFalse(asyncio.run(main()), "正常終了で印が降りていない")


class 引ける絵の数と定義がそろう(unittest.TestCase):
    """`get_outputs` が Sweep の印でも引くなら、数える側も同じ規則を使うこと。"""

    def test_sweep_の印しか無い絵も_indexed_に数える(self):
        entry = (1.0, None, {"record_id": "137684933"})
        self.assertTrue(
            index_module._has_reference(entry),
            "Sweep の印で引ける絵が「参照を持たない」と数えられている",
        )

    def test_対照_recipe_id_が在れば今までどおり数える(self):
        self.assertTrue(index_module._has_reference((1.0, "r-1", None)))

    def test_対照_どちらも無ければ数えない(self):
        self.assertFalse(index_module._has_reference((1.0, None, None)))
        self.assertFalse(index_module._has_reference((1.0, None, {})))
        self.assertFalse(index_module._has_reference((1.0, None, {"record_id": ""})))

    def test_数える所と引く所が同じ答えを出す(self):
        """**同じ控えについて、引けるなら数えられること。**"""
        service = index_module.RecipeOutputIndex(output_dir_getter=lambda: "")
        entries = {
            "a.png": (1.0, None, {"record_id": "137684933"}),
            "b.png": (2.0, "r-1", None),
            "c.png": (3.0, None, None),
        }
        service._entries = entries
        counted = service.get_status()["indexed"]
        retrievable = sum(
            1
            for entry in entries.values()
            if index_module._has_reference(entry)
        )
        self.assertEqual(counted, retrievable)
        self.assertEqual(counted, 2)


if __name__ == "__main__":
    unittest.main()
