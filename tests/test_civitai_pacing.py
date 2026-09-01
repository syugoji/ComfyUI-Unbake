# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""Civitai へ**続けて投げるときに間隔を空ける**ことを確かめる。

**綴りではなく挙動を見る。** 「`_pace()` を呼んでいる」を原文の照合で留めると、
同じ保証をより良い形で得る変更が規約違反になる（`tests/test_redirect_auth.py` が
`inspect.getsource` でその形になっている）。ここでは**実際に時間が経つこと**だけを見る。

守りたいのは3つ:

1. **単発は遅くしない。** 1回だけの問い合わせに待ちを足さない。
2. **続けて投げたら空く。** ここが無いと `download-plan` の60件が無間隔で飛ぶ。
3. **同時に来ても一列に並ぶ。** 眠りを錠の外に出すと、待っている全員が同じ
   「前回時刻」を読んで**同時に起き**、間隔を空けたつもりのものがバーストに化ける。
   同梱の `civitai_recipe_sync` の `_rate_wait_for_slot()` が実際にそうなっている。
   ここは `asyncio.to_thread` の worker が同時に来るので、同じ罠が在る。
"""

from __future__ import annotations

import os
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from unbake import civitai  # noqa: E402


class _Interval:
    """`CIVITAI_MIN_INTERVAL_SEC` を差し替え、前回時刻を消してから戻す。"""

    def __init__(self, seconds):
        self._seconds = seconds
        self._before = None
        self._had = False

    def __enter__(self):
        self._had = civitai.MIN_INTERVAL_ENV in os.environ
        self._before = os.environ.get(civitai.MIN_INTERVAL_ENV)
        if self._seconds is None:
            os.environ.pop(civitai.MIN_INTERVAL_ENV, None)
        else:
            os.environ[civitai.MIN_INTERVAL_ENV] = str(self._seconds)
        civitai._LAST_REQUEST_AT = None
        return self

    def __exit__(self, *_exc):
        if self._had:
            os.environ[civitai.MIN_INTERVAL_ENV] = self._before
        else:
            os.environ.pop(civitai.MIN_INTERVAL_ENV, None)
        civitai._LAST_REQUEST_AT = None
        return False


class 間隔の読み方(unittest.TestCase):
    def test_未設定なら既定(self):
        with _Interval(None):
            self.assertEqual(
                civitai.min_request_interval(), civitai.DEFAULT_MIN_REQUEST_INTERVAL_SEC
            )

    def test_ゼロは利用者の選択として尊重する(self):
        # **「空けない」は壊れた値ではない。** 既定へ倒すと設定が効かなくなる。
        with _Interval(0):
            self.assertEqual(civitai.min_request_interval(), 0.0)

    def test_読めない値と負の数は既定へ倒す(self):
        # **問い合わせを止めない。** 設定が壊れていても動く側に倒す。
        for bad in ("abc", "", "-1"):
            with _Interval(bad):
                self.assertEqual(
                    civitai.min_request_interval(),
                    civitai.DEFAULT_MIN_REQUEST_INTERVAL_SEC,
                    f"{bad!r} を既定へ倒していない",
                )


class 間隔を空ける(unittest.TestCase):
    def test_最初の1回は待たない(self):
        """**覆えていない分岐がある。**

        `_pace()` の `if _LAST_REQUEST_AT is not None:` を外して
        `(_LAST_REQUEST_AT or 0.0)` にしても、**この検査は通ってしまう**
        （2026-09-01・変異で実測）。`time.monotonic()` は起動からの秒数で、
        実測値は **161,194**——初回の `wait` は `interval - 161194` ＝必ず大きな負になり、
        眠らないからである。**等価変異ではない**（`time.monotonic() < interval`、
        つまり起動から1秒以内にプロセスが始まれば差が出る）が、
        ComfyUI が動いている状況では**到達しない**。

        数を合わせるために作り物の検査を足さない。ここは「初回に待たない」という
        **挙動**だけを見ており、その挙動は現に守られている。
        """
        with _Interval(0.30):
            started = time.monotonic()
            civitai._pace()
            elapsed = time.monotonic() - started
        self.assertLess(elapsed, 0.15, "単発の問い合わせに待ちを足している")

    def test_続けて投げると間隔が空く(self):
        with _Interval(0.15):
            civitai._pace()
            started = time.monotonic()
            civitai._pace()
            elapsed = time.monotonic() - started
        self.assertGreaterEqual(
            elapsed, 0.12, "2回目が無間隔で飛んでいる（上限を切っても投げすぎは防げない）"
        )

    def test_ゼロなら空けない(self):
        with _Interval(0):
            civitai._pace()
            started = time.monotonic()
            civitai._pace()
            elapsed = time.monotonic() - started
        self.assertLess(elapsed, 0.05, "空けない設定なのに待っている")

    def test_同時に来ても一列に並ぶ(self):
        """**眠りが錠の外に出ていないか。**

        錠の外だと4本とも同じ「前回時刻」を読んで**同じ時刻に起きる**ので、
        取れた時刻がほぼ一点に集まる。錠の中なら間隔ぶんずつ散らばる。
        """
        interval = 0.08
        threads = 4
        stamps = []
        guard = threading.Lock()
        ready = threading.Barrier(threads)

        def one():
            ready.wait()
            civitai._pace()
            with guard:
                stamps.append(time.monotonic())

        with _Interval(interval):
            civitai._pace()  # 前回時刻を作る（これが無いと全員が素通りする）
            workers = [threading.Thread(target=one) for _ in range(threads)]
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join()

        self.assertEqual(len(stamps), threads)
        span = max(stamps) - min(stamps)
        self.assertGreaterEqual(
            span,
            interval * (threads - 1) * 0.7,
            "同時に来た問い合わせが一点に集まっている＝眠りが錠の外に出ている",
        )


class 連射する口が実際にこれを通る(unittest.TestCase):
    """**仕掛けが在ることと、使われていることは別。**

    `download-plan` は `resolve_version` を最大60回続けて呼ぶ。そこが素通りだと
    仕掛けは在るのに 429 を踏む。**原文を読まずに、実際に2回引いて時間を見る。**
    """

    class _Response:
        def __init__(self, body):
            self._body = body

        def read(self):
            return self._body

        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

    def test_版の解決を続けると間隔が空く(self):
        body = b'{"id": 1, "files": [], "model": {"type": "LORA"}}'
        real = civitai.urllib.request.urlopen
        civitai.urllib.request.urlopen = lambda request, timeout=30: self._Response(body)
        try:
            with _Interval(0.15):
                civitai.resolve_version("12345")
                started = time.monotonic()
                civitai.resolve_version("12346")
                elapsed = time.monotonic() - started
        finally:
            civitai.urllib.request.urlopen = real
        self.assertGreaterEqual(
            elapsed, 0.12, "続けて版を解決しても間隔が空いていない"
        )


if __name__ == "__main__":
    unittest.main()
