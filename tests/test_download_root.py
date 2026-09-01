# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**落とす先を選べるようにした**（2026-08-28 利用者の指示）。

利用者は Forge と ComfyUI で同じモデルの木を共有していて、不足モデルを
**Forge 側へ落としたい**。実測（`extra_model_paths.yaml`）では Forge の置き場は
既に ComfyUI へ登録されているので、**ComfyUI が知っている置き場の並びの中に
Forge が居る**——選ぶ相手はその並びで足りる。

**任意のパスは受け取らない。** 受け取ると
**ComfyUI が読まない場所へ落として「落ちているのに不足のまま」**になる。
その罠は転送の成功として現れるので、気づくのに時間がかかる
（同じ罠を `test_model_destination.py` が別の入口で見張っている）。
"""
import os
import unittest

from unbake.download import DownloadError, choose_model_dir, safe_target

COMFY = os.path.abspath("C:/comfy/models/loras")
FORGE = os.path.abspath("D:/AI/forge/webui/models/Lora")
LYCO = os.path.abspath("D:/AI/forge/webui/models/LyCORIS")
PATHS = [COMFY, FORGE, LYCO]


class ChooseModelDirTest(unittest.TestCase):
    def test_空なら既定の置き場(self):
        """**今までの動きを変えない。** 何も設定していない人には影響が無い。"""
        chosen, matched = choose_model_dir("loras", PATHS, "")
        self.assertEqual(chosen, COMFY)
        self.assertTrue(matched)

    def test_根を指定すると_その下の置き場が選ばれる(self):
        chosen, matched = choose_model_dir("loras", PATHS, "D:/AI/forge/webui")
        self.assertEqual(chosen, FORGE, "Forge 側が選ばれていない")
        self.assertTrue(matched)

    def test_同じ根に複数あるときは並びの先を採る(self):
        """**Forge の下に Lora と LyCORIS が両方居る**（実測の形）。
        どちらでも読めるので、`extra_model_paths.yaml` の並び順に従う。"""
        chosen, _ = choose_model_dir("loras", PATHS, "D:/AI/forge")
        self.assertEqual(chosen, FORGE)

    def test_置き場そのものを指しても選べる(self):
        chosen, matched = choose_model_dir("loras", PATHS, LYCO)
        self.assertEqual(chosen, LYCO)
        self.assertTrue(matched)

    def test_合う置き場が無ければ既定へ戻り_戻したと言う(self):
        """**黙って戻さない。** 戻したことを言わないと、落ちた先が違っても
        「なぜ Forge に入っていないのか」を調べる人はここへ来ない。"""
        chosen, matched = choose_model_dir("loras", PATHS, "E:/どこにも無い")
        self.assertEqual(chosen, COMFY)
        self.assertFalse(matched, "戻したことが伝わらない")

    def test_並びの外は決して返さない(self):
        """**これが本体。** 設定で受け取るのは「どれを選ぶか」であって
        「どこへ書くか」ではない。"""
        for root in ("E:/somewhere", "C:/Windows", "..", "/", "D:/AI"):
            chosen, _ = choose_model_dir("loras", PATHS, root)
            self.assertIn(chosen, PATHS, f"並びの外を返した: {root} -> {chosen}")

    def test_大小と区切りの違いを吸収する(self):
        """Windows の実際の入力は、区切りも大小も揃っていない。"""
        for root in (r"d:\AI\forge\webui", "D:/AI/FORGE/webui", "D:/AI/forge/webui/"):
            chosen, matched = choose_model_dir("loras", PATHS, root)
            self.assertEqual(chosen, FORGE, f"揃えられていない: {root}")
            self.assertTrue(matched)

    def test_似た名前の隣を巻き込まない(self):
        """`D:/AI/forge` を指定して `D:/AI/forge2` を選ばない
        ——前方一致だけで見ると隣の木を掴む。"""
        near = os.path.abspath("D:/AI/forge2/models/Lora")
        chosen, matched = choose_model_dir("loras", [COMFY, near], "D:/AI/forge")
        self.assertEqual(chosen, COMFY, "隣の木を掴んでいる")
        self.assertFalse(matched)

    def test_置き場が1つも無ければ断る(self):
        with self.assertRaises(DownloadError):
            choose_model_dir("loras", [], "")


#: Forge（A1111 系）の実際の並び。**実測 2026-08-28**——利用者の
#: `extra_model_paths.yaml` を ComfyUI に読ませて `get_folder_paths()` を引いた結果で、
#: 8種類すべてが Forge の下へ解決した。**`embeddings` だけ `models/` の下に無い**
#: （`webui/embeddings/`）ので、「根 + models + 種類」で組み立てる実装は必ず外す。
FORGE_ROOT = "D:/AI/forge/webui"
FORGE_LAYOUT = {
    "loras": "models/Lora",
    "checkpoints": "models/Stable-diffusion",
    "embeddings": "embeddings",
    "vae": "models/VAE",
    "controlnet": "models/ControlNet",
    "upscale_models": "models/ESRGAN",
    "diffusion_models": "models/Stable-diffusion",
    "hypernetworks": "models/hypernetworks",
}


class EveryKindTest(unittest.TestCase):
    """**どの種類でも Forge 側が選ばれること。**

    SDXL でも Illustrious でも、記録が要求するのは種類（`checkpoints` /
    `loras` / `embeddings` …）であって、モデルの系統ではない。だから
    **種類ごとに1つずつ確かめれば、系統は問わない。**
    """

    def test_全ての種類が根の下へ解決する(self):
        from unbake.download import ALLOWED_KINDS

        for kind in ALLOWED_KINDS:
            with self.subTest(kind=kind):
                self.assertIn(kind, FORGE_LAYOUT, "実測の並びに無い種類が増えている")
                comfy = os.path.abspath(f"C:/comfy/models/{kind}")
                forge = os.path.abspath(os.path.join(FORGE_ROOT, FORGE_LAYOUT[kind]))
                chosen, matched = choose_model_dir(kind, [comfy, forge], FORGE_ROOT)
                self.assertTrue(matched, f"{kind} が既定へ戻っている")
                self.assertEqual(chosen, forge, f"{kind} が Forge 側を選んでいない")

    def test_embeddings_は_models_の下に無くても選べる(self):
        """**ここだけ形が違う。** `webui/embeddings/` で、`models/` を経由しない。"""
        comfy = os.path.abspath("C:/comfy/models/embeddings")
        forge = os.path.abspath("D:/AI/forge/webui/embeddings")
        chosen, matched = choose_model_dir("embeddings", [comfy, forge], FORGE_ROOT)
        self.assertTrue(matched)
        self.assertEqual(chosen, forge)

    def test_見張りが生きているか(self):
        """**検出器の生死。** 根が合わなければ、どの種類も既定へ戻るはず。"""
        from unbake.download import ALLOWED_KINDS

        for kind in ALLOWED_KINDS:
            comfy = os.path.abspath(f"C:/comfy/models/{kind}")
            forge = os.path.abspath(os.path.join(FORGE_ROOT, FORGE_LAYOUT[kind]))
            chosen, matched = choose_model_dir(kind, [comfy, forge], "E:/無い")
            self.assertFalse(matched)
            self.assertEqual(chosen, comfy)


class SafeTargetTest(unittest.TestCase):
    """`safe_target` は `folder_paths` を要るので、ここでは形だけ確かめる。"""

    def test_根の引数を受け取る(self):
        import inspect

        sig = inspect.signature(safe_target)
        self.assertIn("root", sig.parameters, "落とす先の根を渡せない")
        self.assertEqual(sig.parameters["root"].default, "",
                         "既定が空でないと、設定していない人の動きが変わる")


class WiringTest(unittest.TestCase):
    """**鎖が繋がっているか。** どれか1本切れても「設定は在るのに効かない」になる。

    **原文の綴りを照合しない**（2026-09-01・走査15周目）。ここは元は
    `assertIn("key: 'download_root'", text)` と `assertIn('get_settings().get("download_root"', text)`
    で JS と Python の**書き方そのもの**を留めていた。守りたいのは
    「設定した根が実行器まで届くこと」なので、綴りを留めると
    **書き方を良くした瞬間に赤くなり、鎖が切れても書き方さえ残れば緑**になる。
    片方は関係（JS が宣言する鍵 ⊆ サーバが知っている鍵）で、
    もう片方は**実際に呼んで受け取った引数**で見る。
    """

    def test_既定値がある(self):
        from unbake.settings import KNOWN_KEYS

        self.assertIn("download_root", KNOWN_KEYS, "保存しても次に読めない")
        self.assertEqual(KNOWN_KEYS["download_root"], "", "既定は空（今までの動き）")

    def test_設定の面が宣言する鍵は_すべてサーバが知っている(self):
        """**関係で見る。** どちらの綴りが変わっても、鎖が繋がっていれば緑。"""
        import re
        from pathlib import Path

        from unbake.settings import KNOWN_KEYS

        text = (Path(__file__).resolve().parents[1]
                / "web/panel/settingsView.js").read_text(encoding="utf-8")
        # 引用符はどちらでもよい（書き方は留めない）。
        keys = set(re.findall(r"""\{\s*key:\s*['"]([a-z_]+)['"]""", text))

        # **検出器が生きていることを先に見る。** 正規表現が当たらなくなると
        # 空集合はどんな包含も満たすので、**何も見ていないのに緑**になる。
        self.assertGreaterEqual(len(keys), 15,
                                f"設定の面から鍵を1つも読めていない（{len(keys)}件）")
        self.assertIn("download_root", keys, "設定の面から変えられない")

        unknown = sorted(keys - set(KNOWN_KEYS))
        self.assertEqual(unknown, [],
                         f"面には出るがサーバが知らない設定がある: {unknown}"
                         " — 保存はできても次に読めない")

    def test_落とす道が根を実行器へ渡す(self):
        """**呼んで確かめる。** 原文に `root=` と書いてあることは、
        その値が渡ることを意味しない。"""
        from unbake import routes

        seen = {}

        def fake_download_model(**kwargs):
            seen.update(kwargs)
            return {"ok": True, "path": "C:/x/y.safetensors", "bytes": 1}

        settings = {"download_root": "D:/AI/forge/webui", "civitai_api_key": ""}
        originals = (routes.download_model, routes.resolve_version, routes.get_settings)
        routes.download_model = fake_download_model
        routes.resolve_version = lambda *a, **k: {
            "ok": True, "url": "https://example.invalid/x", "kind": "loras",
            "filename": "y.safetensors", "bytes": 1,
        }
        routes.get_settings = lambda: settings
        try:
            routes._downloads.clear()
            result = routes.start_download("12345")
        finally:
            routes.download_model, routes.resolve_version, routes.get_settings = originals
            routes._downloads.clear()

        self.assertTrue(result.get("ok"), f"落とせていない: {result}")
        self.assertEqual(seen.get("root"), "D:/AI/forge/webui",
                         "設定した根が実行器へ届いていない")

    def test_対照_根が空なら空のまま渡る(self):
        """**空を勝手に埋めない。** 埋めると、設定していない人の動きが変わる。"""
        from unbake import routes

        seen = {}
        originals = (routes.download_model, routes.resolve_version, routes.get_settings)
        routes.download_model = lambda **kwargs: (seen.update(kwargs) or {"ok": True})
        routes.resolve_version = lambda *a, **k: {
            "ok": True, "url": "https://example.invalid/x", "kind": "loras",
            "filename": "y.safetensors", "bytes": 1,
        }
        routes.get_settings = lambda: {}
        try:
            routes._downloads.clear()
            routes.start_download("12345")
        finally:
            routes.download_model, routes.resolve_version, routes.get_settings = originals
            routes._downloads.clear()

        self.assertEqual(seen.get("root"), "", "空の根が空で渡っていない")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
