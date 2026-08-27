# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""消えたモデルの受け皿（civarchive.com）。**既定では使わない。**

2026-08-26 利用者の指示で足した。下の形は**実物**（`/api/models/665047?
modelVersionId=753328` の応答）を縮めたもの。

**既定が OFF であること自体を検査で固定する。** 既定は「そのうち誰かが
変える」ものなので、変えたときに気づける場所が要る。
"""
import unittest

from unbake.civarchive import EXTRA_DOWNLOAD_HOSTS, pick_download_url, resolve_version
from unbake.civitai import DOWNLOAD_HOSTS
from unbake.settings import KNOWN_KEYS

ALLOWED = set(DOWNLOAD_HOSTS) | set(EXTRA_DOWNLOAD_HOSTS)

#: 実測（2026-08-26）を縮めたもの。
REAL = {
    "id": 665047, "name": "WUKONG Flux v1", "type": "LORA",
    "version": {
        "id": 753328,
        "civitai_model_id": 665047,
        "civitai_model_version_id": 753328,
        "name": "v3.0", "baseModel": "Flux.1 D",
        "allow_download": True,
        "trigger": ["wukong"],
        "files": [{
            "name": "wukong_v3.0.safetensors",
            "sizeKB": 671363.765625,
            "sha256": "f8" * 32,
            "is_primary": True,
            "downloadUrl": "https://civitai.com/api/download/models/753328",
            "mirrors": [
                {"source": "civitai", "url": "https://civitai.com/api/download/models/753328"},
                {"source": "huggingface",
                 "url": "https://huggingface.co/yehonghao/fluxwukong/resolve/main/wukong_v3.0.safetensors"},
            ],
        }],
    },
}


class CivArchiveTest(unittest.TestCase):
    def test_既定は切ってある(self):
        # **開けるのは使う人。** 第三者へ問い合わせが飛び、落とす相手も増える。
        self.assertIs(KNOWN_KEYS["use_civarchive"], False)

    def test_実物の形から落とせる先を組める(self):
        got = resolve_version(665047, 753328, allowed_hosts=ALLOWED,
                              fetch=lambda url, **_: REAL)
        self.assertIsNotNone(got)
        self.assertEqual(got["filename"], "wukong_v3.0.safetensors")
        self.assertEqual(got["sha256"], "f8" * 32)
        self.assertEqual(got["source"], "civarchive")
        self.assertEqual(got["modelType"], "LORA")
        # 大きさは KB で来る。**そのまま渡すと 1000分の1 になる。**
        self.assertEqual(got["bytes"], int(671363.765625 * 1024))

    def test_許していない相手からは落とさない(self):
        # **「知らない相手からは落とさない」を、開けても外さない。**
        entry = {"mirrors": [{"url": "https://evil.example/x.safetensors"}],
                 "downloadUrl": "https://evil.example/y.safetensors"}
        self.assertIsNone(pick_download_url(entry, ALLOWED))

    def test_httpは受けない(self):
        entry = {"mirrors": [{"url": "http://civitai.com/api/download/models/1"}]}
        self.assertIsNone(pick_download_url(entry, ALLOWED))

    def test_別の版を掴まない(self):
        """**引数を無視して既定の版を返されても気づけること。**"""
        other = {**REAL, "version": {**REAL["version"], "civitai_model_version_id": 999}}
        self.assertIsNone(resolve_version(665047, 753328, allowed_hosts=ALLOWED,
                                          fetch=lambda url, **_: other))

    def test_作者が配布を止めていれば拾わない(self):
        stopped = {**REAL, "version": {**REAL["version"], "allow_download": False}}
        self.assertIsNone(resolve_version(665047, 753328, allowed_hosts=ALLOWED,
                                          fetch=lambda url, **_: stopped))

    def test_モデルIDが無ければ引かない(self):
        # 入口がモデルIDを求める。**無いのに問い合わせを飛ばさない。**
        called = []
        self.assertIsNone(resolve_version(None, 753328, allowed_hosts=ALLOWED,
                                          fetch=lambda url, **_: called.append(url)))
        self.assertEqual(called, [], "手がかりが無いのに外へ問い合わせている")

    def test_応答が壊れていても投げない(self):
        for bad in (None, {}, {"version": None}, {"version": {}}, "文字列"):
            with self.subTest(bad=bad):
                self.assertIsNone(resolve_version(1, 2, allowed_hosts=ALLOWED,
                                                  fetch=lambda url, **_: bad))


class SwitchTest(unittest.TestCase):
    def test_切ってあれば外へ問い合わせない(self):
        from unbake.civitai import _try_civarchive
        called = []
        self.assertIsNone(_try_civarchive(1, 2, False, lambda url, **_: called.append(url)))
        self.assertEqual(called, [], "設定が切ってあるのに外へ問い合わせている")

    def test_開けてあれば置き場まで決まる(self):
        from unbake.civitai import _try_civarchive
        got = _try_civarchive(665047, 753328, True, lambda url, **_: REAL)
        self.assertIsNotNone(got)
        self.assertEqual(got["kind"], "loras")

    def test_種類が判らなければ拾わない(self):
        # **置き場を推測してどこかへ置くよりは、落とせないと言うほうがよい。**
        from unbake.civitai import _try_civarchive
        unknown = {**REAL, "type": "Wildcards"}
        self.assertIsNone(_try_civarchive(665047, 753328, True, lambda url, **_: unknown))


if __name__ == "__main__":
    unittest.main()
