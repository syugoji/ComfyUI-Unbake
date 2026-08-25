"""ComfyUI-Unbake — ComfyUI カスタムノードの入口。

Copyright (C) 2026 syugoji
SPDX-License-Identifier: GPL-3.0-or-later

**キャンバスノードは1つも登録しない。** この拡張が出すのはパネルで、
グラフはそのパネルが生成する。`NODE_CLASS_MAPPINGS` が空でも
ComfyUI Manager は配れる（`ComfyUI-Custom-Scripts` が同じ形）。
"""

NODE_CLASS_MAPPINGS: dict = {}
NODE_DISPLAY_NAME_MAPPINGS: dict = {}

#: ComfyUI がここを静的配信し、直下の `*.js` を拡張として読み込む。
WEB_DIRECTORY = "./web"

#: HTTP の口が登録できたか。**登録できなくても起動は止めない**
#: ——設定画面が出ないことより、ComfyUI が起動しない方がはるかに困る。
#: 失敗したことは黙って飲まず、起動ログへ1行残す。
try:
    from .unbake.routes import register_routes

    ROUTES_REGISTERED = register_routes()
    if not ROUTES_REGISTERED:
        print("[Unbake] HTTP の口を登録できませんでした（記録の読み取りと設定画面は使えません）")
except Exception as _error:  # pragma: no cover - 宿主側の事情で起こる
    ROUTES_REGISTERED = False
    print(f"[Unbake] HTTP の口の登録で例外: {type(_error).__name__}: {_error}")

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
    "ROUTES_REGISTERED",
]
