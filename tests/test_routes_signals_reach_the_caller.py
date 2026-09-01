# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**読み手が居る値を、作る側が実際に載せていること**（2026-09-01・走査5周目）。

`tests/produced_signal_is_consumed_test.mjs` が留めているのは
「**作る側が載せた鍵に読み手が居るか**」。ここが留めるのは**その逆向き**——
**読み手が居るのに作る側が載せていない**。逆向きはあちらでは原理的に捕まらない
（載っていない鍵は、あの走査の出発点にならない）。

実際に2つ在った。どちらも「渡す口が層をまたいで揃っているのに、最後の1つで消える」形:

1. `GET /unbake/civitai-version` が `code` を載せていなかった。
   `web/unbake.js` の `if (body?.code === 'rate_limited')` は
   「**上限に当たったことは言う。黙ると『版が消えた』と読まれる**」という
   注記つきで書かれているのに、**この分岐は生まれてから一度も発火していない。**
2. `_download_file_for_environment` の `on_progress` の条件が**逆**で、
   `progress_callback` が**渡された時にだけ捨てられて**いた。
   `known_model_downloader` → `UnbakeEnvironment.download_file` と3層を通って
   届く値が、最後の1行で必ず消えていた。

**綴りではなく挙動で書く。** 「応答に `code` という鍵が在る」ではなく
「**上限に当たった応答と、版が消えた応答を呼び手が見分けられる**」を見る。
"""

from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from unbake import routes  # noqa: E402


def _settings_without_key():
    settings = mock.Mock()
    settings.get.return_value = ""
    return settings


class 引けなかった理由が呼び手まで届く(unittest.TestCase):
    """`resolve_version` は上限と消滅を `code` で分ける。口がそれを落とさないこと。"""

    LIMITED = {
        "ok": False,
        "error": "the Civitai API asked us to slow down; try again in 7 seconds",
        "code": "rate_limited",
        "retryAfter": 7,
    }
    GONE = {
        "ok": False,
        "error": "could not reach the Civitai API for this version",
        "code": "gone",
    }

    def _view(self, resolved):
        """**実物の `civitai_version_view` を通す。** 組み立て直さない。"""
        with mock.patch.object(routes, "resolve_version", return_value=resolved), \
             mock.patch.object(routes, "get_settings", side_effect=_settings_without_key):
            return routes.civitai_version_view("123")

    def test_上限と消滅を呼び手が見分けられる(self):
        limited = self._view(self.LIMITED)
        gone = self._view(self.GONE)
        self.assertFalse(limited.get("ok"))
        self.assertFalse(gone.get("ok"))
        # **文言では分けない**（訳されると当たらない）。
        self.assertNotEqual(
            limited.get("code"), gone.get("code"),
            "上限に当たったことと版が消えたことが、呼び手から同じに見える",
        )

    def test_待てば通るなら何秒かを渡す(self):
        self.assertEqual(self._view(self.LIMITED).get("retryAfter"), 7)

    def test_引けたときは中身を返す(self):
        ok = {
            "ok": True, "filename": "x.safetensors", "kind": "loras",
            "sha256": "a" * 64, "bytes": 123, "name": "X",
        }
        with mock.patch.object(routes, "resolve_version", return_value=ok), \
             mock.patch.object(routes, "get_settings", side_effect=_settings_without_key):
            got = routes.civitai_version_view("456")
        self.assertTrue(got.get("ok"))
        self.assertEqual(got.get("filename"), "x.safetensors")
        self.assertEqual(got.get("versionId"), "456")

    def test_数でない版IDは外へ問い合わせない(self):
        called = []

        def spy(*args, **kwargs):
            called.append(args)
            return {"ok": True}

        with mock.patch.object(routes, "resolve_version", side_effect=spy), \
             mock.patch.object(routes, "get_settings", side_effect=_settings_without_key):
            got = routes.civitai_version_view("abc")
        self.assertFalse(got.get("ok"))
        self.assertEqual(called, [], "数でない版IDで外へ問い合わせている")


class 伴走の取得の進みが呼び手へ戻る(unittest.TestCase):
    """`progress_callback` が実際に呼ばれること。"""

    @staticmethod
    def _run(callback, *, steps=((1024, 4096), (4096, 4096))):
        """**実物の `_download_file_for_environment` を通す。**

        `download_model` だけ差し替える——あれは worker スレッドから
        同期で `on_progress` を呼ぶので、その形をそのまま真似る。
        """
        def fake_download_model(**kwargs):
            on_progress = kwargs.get("on_progress")
            if on_progress is not None:
                for written, total in steps:
                    on_progress(written, total)
            return {"ok": True, "path": kwargs.get("target")}

        async def main():
            with mock.patch.object(routes, "download_model", side_effect=fake_download_model), \
                 mock.patch.object(routes, "get_settings", side_effect=_settings_without_key):
                result = await routes._download_file_for_environment(
                    "https://example.invalid/x.safetensors",
                    "/tmp/x.safetensors",
                    progress_callback=callback,
                )
                # `run_coroutine_threadsafe` は投げ返すだけなので、ループが回る隙を作る。
                for _ in range(50):
                    await asyncio.sleep(0)
                return result

        return asyncio.run(main())

    def test_渡した進みの受け手が実際に呼ばれる(self):
        got = []

        async def callback(written, total):
            got.append((written, total))

        result = self._run(callback)
        self.assertEqual(result[0], True, "取得そのものが失敗している")
        self.assertEqual(
            got, [(1024, 4096), (4096, 4096)],
            "進みの受け手が呼ばれていない（条件が逆で、渡された時だけ捨てていた）",
        )

    def test_受け手が居なくても取得は通る(self):
        self.assertEqual(self._run(None)[0], True)

    def test_受け手が投げても取得を止めない(self):
        """**観測側の失敗で本体を止めない。** 進みが出なくなるだけにする。"""
        async def broken(_written, _total):
            raise RuntimeError("boom")

        self.assertEqual(
            self._run(broken)[0], True,
            "進みの受け手の失敗が取得を巻き込んでいる",
        )


if __name__ == "__main__":
    unittest.main()
