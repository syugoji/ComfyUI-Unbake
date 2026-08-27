# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**買っていないものを「鍵が要る」と言わない。**

2026-08-26 に上流（comfyui-lora-manager, GPL-3.0）との差分を調べて見つけた。
こちらは 401/403 をまとめて「Civitai の API キーが要る」と言っていたが、
早期公開のモデルは**鍵が在っても買っていなければ落とせない**。
**打つ手が違う案内は、時間を捨てさせる。**
"""
import unittest
from datetime import datetime, timedelta, timezone

from unbake.civitai import early_access_until, resolve_version


def _version(**extra):
    base = {
        "id": 1, "name": "v1", "baseModel": "SDXL 1.0",
        "model": {"type": "Checkpoint", "name": "x"},
        "files": [{
            "type": "Model", "name": "x.safetensors", "primary": True, "sizeKB": 1024,
            "downloadUrl": "https://civitai.com/api/download/models/1",
            "hashes": {"SHA256": "AB" * 32},
        }],
    }
    base.update(extra)
    return base


class EarlyAccessTest(unittest.TestCase):
    def test_これからのものは有料と言う(self):
        soon = (datetime.now(timezone.utc) + timedelta(days=7)).isoformat().replace("+00:00", "Z")
        self.assertIsNotNone(early_access_until({"earlyAccessEndsAt": soon}))

    def test_終わったものを有料と言わない(self):
        """**日付を見ずに拾うと、もう買う必要が無いモデルまで有料と言う。**"""
        past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat().replace("+00:00", "Z")
        self.assertIsNone(early_access_until({"earlyAccessEndsAt": past}))

    def test_印が無ければ何も言わない(self):
        self.assertIsNone(early_access_until({}))
        self.assertIsNone(early_access_until({"earlyAccessEndsAt": ""}))

    def test_読めない日付を終わったと読まない(self):
        # 早期公開だとは判っている。**判らないほうへ倒して、黙って通さない。**
        self.assertIsNotNone(early_access_until({"earlyAccessEndsAt": "いつか"}))

    def test_解決の時点で理由を返す(self):
        soon = (datetime.now(timezone.utc) + timedelta(days=3)).isoformat().replace("+00:00", "Z")
        got = resolve_version("1", fetch=lambda url, api_key="", **_: _version(earlyAccessEndsAt=soon))
        self.assertFalse(got["ok"])
        # **`forbidden` と分ける。** 画面は `forbidden` を「鍵を確かめて
        # ください」と訳すので、まとめると打つ手の違う案内が出る。
        self.assertEqual(got["code"], "early_access")
        # **鍵の話をしない。** 打つ手は「買う」であって「鍵を入れ直す」ではない。
        self.assertNotIn("api key", got["error"].lower())
        self.assertIn("early access", got["error"].lower())

    def test_終わっていれば普通に解決する(self):
        past = (datetime.now(timezone.utc) - timedelta(days=400)).isoformat().replace("+00:00", "Z")
        got = resolve_version("1", fetch=lambda url, api_key="", **_: _version(earlyAccessEndsAt=past))
        self.assertTrue(got["ok"], got)

    def test_印の無い版を止めない(self):
        got = resolve_version("1", fetch=lambda url, api_key="", **_: _version())
        self.assertTrue(got["ok"], got)


if __name__ == "__main__":
    unittest.main()
