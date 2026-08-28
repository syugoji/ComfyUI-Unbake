"""ComfyUI-Unbake — ComfyUI カスタムノードの入口。

Copyright (C) 2026 syugoji
SPDX-License-Identifier: GPL-3.0-or-later

**キャンバスノードはちょうど1個だけ登録する**（`D-20260829-02`）。
この拡張の中心は今もパネルで、グラフはそのパネルが生成する——ノードを出すのは
**ComfyUI で唯一の自動増殖経路が「共有された workflow.json に載っていること」だから**で、
Manager が見るのは `node.type` だけなので、0 個の拡張はその連鎖に原理的に乗れない。

**表はここで組まない**（`unbake/nodes.py` が正本）。ここで `= {}` と書き直すと、
あちらを直しても ComfyUI へ届かない——`tests/comfy_package_test.mjs` が
「入口が表を自前で定義し直していないこと」まで見ている。
"""

try:
    from .unbake.nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
except ImportError:
    # **入口を素の module として取り込む読まれ方がある**（pytest はここに
    # `__init__.py` が在るせいで、入口自体を `__init__` という名前で読み込む）。
    # そのとき相対輸入は成立しないが、**空の表で代用しない**——代用すると
    # 「ノードが1個も出ない状態」が検査では緑になる。指す先は同じ1つのまま。
    from unbake.nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

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
