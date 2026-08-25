"""同期スクリプトを**同一プロセス内で**動かす。

Copyright (C) 2026 syugoji
SPDX-License-Identifier: GPL-3.0-or-later

**なぜ子プロセスをやめたか。** Comfy Registry の自動走査が v0.1.0 と v0.1.1 を
`Flagged` にした。理由は通知されないが、0.1.1 で「設定から来た任意のパスを実行する」
分岐を消しても結果が変わらなかったので、**`create_subprocess_exec` そのもの**が
引っかかっていると判断した。カスタムノードが Python の子プロセスを起こす形は、
走査器から見れば任意コード実行と区別が付かない。

**同梱スクリプトは1文字も変えない。** `civitai-recipe-sync/civitai_image_download.py`
は MIT で別途単体配布もしているので、こちらの都合で分岐させると両方が腐る。
代わりに**読み込み方と差し替え方**でつじつまを合わせる。

---

## 3つの仕掛け

### 1. 実行のたびに「新しいモジュール」として読み直す

スクリプトは **`RAINDROP_TOKEN` や `RECIPE_DIR` を読み込み時に確定する**
（module 直下の代入・約20個）。一度 import して使い回すと、**利用者が設定を
変えても初回の値のまま**動く。しかも失敗せず、古い場所へ書きに行く。

`importlib.util.spec_from_file_location` で毎回**別のモジュール実体**を作る。
`importlib.reload` ではないので、前回の名前空間は一切残らない。

### 2. `emit_event` と `print` を**モジュール大域へ**差し込む

進捗は `emit_event()`、人向けログは素の `print()` で出ている。子プロセスの頃は
標準出力を読んで拾っていたが、同一プロセスで `sys.stdout` を差し替えると
**ComfyUI の他のスレッドの出力まで巻き込む**。

**モジュール大域は組み込みを隠す**ので、`mod.print = ...` と置くだけで
そのモジュール内の `print()` だけが差し替わる。`sys.stdout` は触らない。

### 3. 中断は `emit_event` の呼び出し点で見る

子プロセスならプロセスを終わらせれば済んだ。同一プロセスでは協調するしかない。
`emit_event` はスクリプト内に **16箇所**あり、うち `item_started` は
**画像1枚ごとのループの中**なので、画像単位で止まれる。
**即座には止まらない**——1枚の取得が終わるまでは進む。

---

## 環境変数について（**ここが唯一の副作用**）

スクリプトは「環境変数 > config.json > 既定値」で設定を読み、**読み込み後にも
`os.environ` を見る箇所がある**（`CIVITAI_REIMPORT_BATCH_SIZE`）。だから実行中は
親プロセスの `os.environ` に置くしかない。

- 同期は排他（`is_running()`）なので、同時に2つが環境を奪い合うことはない
- **置いた鍵は必ず元へ戻す**（元が無ければ削除する）。`finally` で行う
- 秘匿値（トークン・APIキー）が `os.environ` に載る時間は実行中だけ
"""

from __future__ import annotations

import asyncio
import importlib.util
import os
import sys
import threading
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, Optional


class SyncCancelled(Exception):
    """利用者が中断した。**失敗ではない**ので、呼び手はそう扱うこと。"""


class SyncScriptRunner:
    """同梱スクリプトを同一プロセスで動かす。

    Args:
        script_path: `civitai_image_download.py` の絶対パス。
        on_event: 進捗イベント1件ごとに呼ばれる（`dict`）。
        on_log: 人向けログ1行ごとに呼ばれる（`str`）。
    """

    def __init__(
        self,
        script_path: Path,
        *,
        on_event: Callable[[Dict[str, Any]], None],
        on_log: Callable[[str], None],
    ) -> None:
        self._script_path = Path(script_path)
        self._on_event = on_event
        self._on_log = on_log
        self._cancel = threading.Event()

    def request_cancel(self) -> None:
        """次の区切りで止まるよう頼む。**即座には止まらない。**"""
        self._cancel.set()

    def cancel_requested(self) -> bool:
        return self._cancel.is_set()

    # ------------------------------------------------------------------
    # 実行
    # ------------------------------------------------------------------

    async def run_sync(self, env: Dict[str, str], *, unattended: bool = False) -> int:
        """本体を回す。戻り値は終了コード相当（0 が成功）。"""
        argv = ["--events", "--non-interactive"]
        if unattended:
            argv.append("--unattended")
        return await self._call_in_thread(env, "main", argv)

    async def run_list_collections(self, env: Dict[str, str]) -> int:
        """コレクション一覧だけを取る。"""
        return await self._call_in_thread(
            env, "run_list_collections", ["--events", "--non-interactive"]
        )

    async def _call_in_thread(self, env: Dict[str, str], func_name: str, argv: list) -> int:
        """**別スレッドで動かす。** スクリプトは同期的で、そのまま呼ぶと
        ComfyUI の event loop を止めてしまう（画面が固まる）。"""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._call_blocking, env, func_name, argv)

    # ------------------------------------------------------------------
    # ここから下は worker スレッドで動く
    # ------------------------------------------------------------------

    def _call_blocking(self, env: Dict[str, str], func_name: str, argv: list) -> int:
        with _temporary_environ(env):
            module = self._load_fresh_module()
            self._patch(module)
            self._apply_cli_flags(module, argv)
            func = getattr(module, func_name, None)
            if not callable(func):
                raise AttributeError(
                    f"同梱スクリプトに {func_name}() がありません（配布物が壊れています）"
                )
            result = func()
        # `main()` は None を返すことがある。**None を失敗にしない。**
        if result is None:
            return 0
        try:
            return int(result)
        except (TypeError, ValueError):
            return 0

    def _load_fresh_module(self):
        """**毎回まっさらな実体として読む。** 前回の設定を持ち越さない。

        モジュール名を毎回変えるのは、`sys.modules` に居座らせないため。
        `sys.modules` へは登録しない——登録すると次回 import が古い方を掴む。
        """
        if not self._script_path.is_file():
            raise FileNotFoundError(
                f"同梱スクリプトが見つかりません: {self._script_path}"
            )
        name = f"_unbake_rdsync_{uuid.uuid4().hex}"
        spec = importlib.util.spec_from_file_location(name, str(self._script_path))
        if spec is None or spec.loader is None:
            raise ImportError(f"同梱スクリプトを読み込めません: {self._script_path}")
        module = importlib.util.module_from_spec(spec)
        # **`__main__` にしない。** すると末尾の `sys.exit()` と `input()` が動く。
        module.__name__ = name
        spec.loader.exec_module(module)
        return module

    @staticmethod
    def _apply_cli_flags(module, argv: list) -> None:
        """**CLI 引数の解釈を、素通りさせない。**

        `apply_cli_flags()` はスクリプトの `if __name__ == "__main__":` の中でしか
        呼ばれていない（2756行）。`main()` を直接呼ぶだけだと**一度も走らない**。

        素通りさせると壊れるのは進捗表示ではなく**規約遵守**である:

            if UNATTENDED and AUTO_DOWNLOAD_MISSING_LORAS:
                # Civitai ToS §11.9（自動化による統計の操作の禁止）
                AUTO_DOWNLOAD_MISSING_LORAS = False

        無人同期で不足 LoRA を自動取得すると、**人が見ていないところで
        ダウンロード数へ加算される**。スクリプトはそれを避けるためにここで
        止めているので、呼ばなければ規約違反の側へ倒れる。**しかも無言で。**

        引数の解釈自体はスクリプト側の責任なので、こちらでは真似しない
        （真似すると2箇所に規則ができて、片方だけ直る日が来る）。
        """
        apply = getattr(module, "apply_cli_flags", None)
        if not callable(apply):
            raise AttributeError(
                "同梱スクリプトに apply_cli_flags() がありません（配布物が壊れています）"
            )
        apply(list(argv))

    def _patch(self, module) -> None:
        """出口を差し替える。**`sys.stdout` は触らない。**"""
        original_emit = getattr(module, "emit_event", None)

        def emit_event(event: str, **fields: Any) -> None:
            # **中断はここで見る。** 例外を投げてスクリプトの外まで浮かせる。
            if self._cancel.is_set():
                raise SyncCancelled("利用者が中断しました")
            payload: Dict[str, Any] = {"event": event}
            payload.update(fields)
            try:
                self._on_event(payload)
            except Exception:
                # **観測側の失敗で本体を止めない。** 進捗が出ないだけにする。
                pass

        def patched_print(*args: Any, **kwargs: Any) -> None:
            # `print` の意味を変えすぎない——`file=` を明示した呼び出しは素通しする。
            if kwargs.get("file") not in (None, sys.stdout):
                _builtin_print(*args, **kwargs)
                return
            sep = kwargs.get("sep", " ")
            text = sep.join(str(a) for a in args)
            for line in text.splitlines() or [""]:
                try:
                    self._on_log(line)
                except Exception:
                    pass

        module.emit_event = emit_event
        module.print = patched_print
        # 元の実装は捨てない（差し替えたことを外から確かめられるように残す）
        module._unbake_original_emit_event = original_emit


_builtin_print = print


class _temporary_environ:
    """指定の環境変数を**実行中だけ**置き、必ず元へ戻す。

    **元が無かった鍵は削除する**（空文字で残すと「設定済みだが空」に見え、
    スクリプト側の「環境変数 > config.json」の順序が狂う）。
    """

    def __init__(self, values: Dict[str, str]) -> None:
        self._values = dict(values or {})
        self._saved: Dict[str, Optional[str]] = {}

    def __enter__(self) -> "_temporary_environ":
        for key, value in self._values.items():
            self._saved[key] = os.environ.get(key)
            os.environ[key] = str(value)
        return self

    def __exit__(self, *exc: Any) -> None:
        for key, previous in self._saved.items():
            if previous is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = previous
        return None
