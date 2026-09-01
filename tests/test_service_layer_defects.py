# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**入口から到達しないサービス層の欠陥**
（2026-08-31・監査 I-20260831-35, -36, -37, -38）。

`tests/test_python_reachability.py` が宣言している通り、この4件が住む
`raindrop_sync_service` / `resource_availability_service` /
`replay_manifest_service` は**入口から到達しない**。今日の利用者は踏まない。

**それでも直す。** 配線した瞬間に生きるし、どれも「静かに壊れる」形だから
——`NameError`、`AttributeError` を飲む `except`、`None` を回す `for`、
立てない走行印。**気づけない欠陥ほど、配線の前に潰しておく価値がある。**

検査もここに置く。到達しないものを検査しないでおくと、**配線した人が
最初の1回で踏む**。
"""
import asyncio
import unittest
from unittest import mock

from unbake.services.recipes.replay_manifest_service import ReplayManifestService
from unbake.services.recipes.resource_availability_service import (
    ResourceAvailabilityService,
)


class ReplayManifestNoneLorasTest(unittest.TestCase):
    """I-20260831-37: `"loras": null` を回すと TypeError。"""

    def test_loras_が_null_でも組める(self):
        service = ReplayManifestService()
        out = service.build({"id": "r", "loras": None})
        self.assertIsInstance(out, dict)

    def test_対照_loras_が在れば今までどおり読む(self):
        service = ReplayManifestService()
        out = service.build({"id": "r", "loras": [{"file_name": "a.safetensors"}]})
        self.assertIsInstance(out, dict)

    def test_対照_鍵そのものが無くても組める(self):
        service = ReplayManifestService()
        self.assertIsInstance(service.build({"id": "r"}), dict)


def _availability(getter):
    """**組み立て器を通さずに起こす。** この層は入口から到達しないので、
    必須の引数を全部揃えるより、見たい1つだけを差す方が壊れにくい。"""
    service = ResourceAvailabilityService.__new__(ResourceAvailabilityService)
    service._client_getter = getter
    return service


class ResourceAvailabilityContractTest(unittest.TestCase):
    """I-20260831-36: 呼ぶ相手が居ないことを、問い合わせ失敗と混ぜない。"""

    def test_口の無いクライアントなら_そうと判る形で落ちる(self):
        service = _availability(lambda: object())   # probe_* を持たない
        with self.assertRaises(NotImplementedError) as caught:
            asyncio.run(service._probe(123, 456))
        self.assertIn("probe_model", str(caught.exception))

    def test_口が在れば今までどおり進む(self):
        """**対照。** 契約の検査そのものが道を塞いでいないこと。"""
        client = mock.Mock()
        client.probe_model = mock.AsyncMock(return_value=("not_found", None))
        client.probe_model_version = mock.AsyncMock(return_value=("ok", {}))
        service = _availability(lambda: client)
        verdict, _reason = asyncio.run(service._probe(123, None))
        self.assertEqual(verdict, "deleted")


class RaindropListCollectionsTest(unittest.TestCase):
    """I-20260831-35 / -38: 未定義名の参照と、走行印を立てないこと。"""

    def test_未定義の名前を参照していない(self):
        """**原文で見る。** 走らせるには Raindrop のトークンが要る。"""
        import inspect

        from unbake.services import raindrop_sync_service as module

        source = inspect.getsource(module.RaindropSyncService.list_collections)
        for name in ("stderr_raw", "process.returncode"):
            self.assertNotIn(
                name, source,
                "子プロセス時代の取り残しが残っている（NameError になる）: %s" % name)

    def test_一覧の取得中は走行中と数える(self):
        from unbake.services import raindrop_sync_service as module

        service = module.RaindropSyncService.__new__(module.RaindropSyncService)
        service._state = {"status": "idle"}
        service._listing = False
        self.assertFalse(service.is_running())
        service._listing = True
        self.assertTrue(
            service.is_running(),
            "一覧の取得中に start() が通る（走行中の差し込みが剥がれる）")

    def test_対照_同期の走行中も今までどおり数える(self):
        from unbake.services import raindrop_sync_service as module

        service = module.RaindropSyncService.__new__(module.RaindropSyncService)
        service._state = {"status": "running"}
        service._listing = False
        self.assertTrue(service.is_running())


if __name__ == "__main__":
    unittest.main()
