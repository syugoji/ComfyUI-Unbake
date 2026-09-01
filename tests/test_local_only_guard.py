# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""状態を変える口が、押した人の画面からしか届かないこと（`I-20260901-22`）。

ComfyUI-Manager のメンテナから 2026-09-01 に指摘を受けた:

    The `model-delete` route deletes model files and is network-reachable,
    so any page the user visits can delete files.

**指摘は ``model-delete`` 1本だけを名指ししていたが、``record-delete`` と
``output-delete`` も同じ形だった。** だから守りは口ごとに書かず1箇所へ置き、
**付け忘れをここで落とす**。

検査は2種類ある。**どちらか片方だと足りない**:

1. **構造** — ``@routes.post`` の全部に ``@local_only`` が付いているか。
   これは**配線しか見ない**（`structural_check_proves_wiring_not_effect`）。
2. **挙動** — ``refuse_reason()`` が3つの守りをそれぞれ働かせるか。
   **守りを1つずつ落として、その1つだけで弾かれることを見る**——
   3つとも見ずに「弾かれた」だけを見ると、**2つ死んでも緑のまま**になる。
"""
import ast
import unittest
from pathlib import Path

from unbake.guard import REQUIRED_CONTENT_TYPE, refuse_reason

ROUTES = Path(__file__).resolve().parent.parent / "unbake" / "routes.py"


class _Request:
    """``aiohttp`` の要求の代わり。**構築器を通す**ので、実物が持つ属性と食い違わない。"""

    def __init__(self, remote="127.0.0.1", origin=None, host="127.0.0.1:8188",
                 content_type=REQUIRED_CONTENT_TYPE):
        self.remote = remote
        headers = {}
        if host is not None:
            headers["Host"] = host
        if origin is not None:
            headers["Origin"] = origin
        if content_type is not None:
            headers["Content-Type"] = content_type
        self.headers = headers


def _post_routes():
    """``@routes.post`` の付いた関数を、経路と飾りの一覧つきで返す。

    **綴りではなく構文木で見る。** コメントに ``local_only`` と書いただけでは通らない。
    """
    tree = ast.parse(ROUTES.read_text(encoding="utf-8"))
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)):
            continue
        path = None
        names = []
        for deco in node.decorator_list:
            if isinstance(deco, ast.Call) and isinstance(deco.func, ast.Attribute):
                if (isinstance(deco.func.value, ast.Name)
                        and deco.func.value.id == "routes"
                        and deco.func.attr == "post"
                        and deco.args
                        and isinstance(deco.args[0], ast.Constant)):
                    path = deco.args[0].value
            elif isinstance(deco, ast.Name):
                names.append(deco.id)
            elif isinstance(deco, ast.Attribute):
                names.append(deco.attr)
        if path is not None:
            found.append((path, names))
    return found


class LocalOnlyWiring(unittest.TestCase):
    """構造——**付け忘れた口をここで落とす。**"""

    def test_every_post_route_is_guarded(self):
        routes = _post_routes()
        # **0件を合格と読まない。** 数え方が壊れたら、付け忘れも一緒に消える。
        self.assertGreaterEqual(len(routes), 10,
                                "POST の口が数えられていない（数え方が壊れている）")
        missing = [path for path, names in routes if "local_only" not in names]
        self.assertEqual(missing, [], f"守りの付いていない POST の口: {missing}")

    def test_the_three_delete_routes_exist_and_are_guarded(self):
        """**名指しされた3本は、消えても改名されても落ちる。**"""
        guarded = {path for path, names in _post_routes() if "local_only" in names}
        for path in ("/unbake/model-delete", "/unbake/record-delete",
                     "/unbake/output-delete"):
            self.assertIn(path, guarded)


class RefuseReason(unittest.TestCase):
    """挙動——**3つの守りを1つずつ確かめる。**"""

    def test_the_panels_own_request_is_allowed(self):
        """**対照。** これが通らないなら、守りではなく面を壊している。"""
        self.assertIsNone(refuse_reason(
            _Request(origin="http://127.0.0.1:8188", host="127.0.0.1:8188")))

    def test_origin_absent_is_allowed(self):
        """``curl`` 等。**局所の検査が受け持つ**ので、ここでは弾かない。"""
        self.assertIsNone(refuse_reason(_Request(origin=None)))

    def test_remote_host_is_refused(self):
        """同じ LAN の別の機械。**`0.0.0.0` に開いているので実在する経路。**"""
        self.assertEqual(refuse_reason(_Request(remote="192.168.1.42")),
                         "this route is local-only")

    def test_unknown_remote_is_refused(self):
        """判らないものは通さない。"""
        self.assertEqual(refuse_reason(_Request(remote=None)),
                         "this route is local-only")

    def test_cross_origin_from_the_browser_is_refused(self):
        """**指摘された攻撃そのもの。** 局所の検査は通ってしまうことに注意——
        悪意のあるページは利用者のブラウザで走るので、要求は ``127.0.0.1`` から来る。
        """
        request = _Request(remote="127.0.0.1", origin="https://evil.example",
                           host="127.0.0.1:8188")
        self.assertEqual(refuse_reason(request), "cross-origin requests are refused")

    def test_null_origin_is_refused(self):
        """sandbox された iframe の ``Origin: null``。**同じ出所ではない。**"""
        self.assertEqual(refuse_reason(_Request(origin="null")),
                         "cross-origin requests are refused")

    def test_same_host_different_port_is_refused(self):
        """**口が違えば別の出所。** ``127.0.0.1:9999`` の頁は届かせない。"""
        self.assertEqual(
            refuse_reason(_Request(origin="http://127.0.0.1:9999", host="127.0.0.1:8188")),
            "cross-origin requests are refused")

    def test_plain_text_body_is_refused(self):
        """**これが無いと出所の検査ごと迂回される。**

        ``text/plain`` は「単純な要求」なので preflight が起きず、
        ブラウザは ``Origin`` を付けたまま送ってしまう——のではなく、
        **送れてしまう経路が残る**。だから形も見る。
        """
        self.assertEqual(refuse_reason(_Request(content_type="text/plain")),
                         f"Content-Type must be {REQUIRED_CONTENT_TYPE}")

    def test_missing_content_type_is_refused(self):
        self.assertEqual(refuse_reason(_Request(content_type=None)),
                         f"Content-Type must be {REQUIRED_CONTENT_TYPE}")

    def test_content_type_with_charset_is_allowed(self):
        """``application/json; charset=utf-8`` は同じ形である。"""
        self.assertIsNone(refuse_reason(
            _Request(content_type="application/json; charset=utf-8")))

    def test_ipv6_loopback_is_allowed(self):
        self.assertIsNone(refuse_reason(_Request(remote="::1", host="[::1]:8188",
                                                 origin="http://[::1]:8188")))

    def test_mapped_ipv4_loopback_is_allowed(self):
        """``::ffff:127.0.0.1``。**写像された v4 も自分自身である。**"""
        self.assertIsNone(refuse_reason(_Request(remote="::ffff:127.0.0.1")))

    def test_forwarded_for_is_not_consulted(self):
        """**送り手が自由に書ける値を見ない。**

        見た瞬間に局所の検査が意味を失う——攻撃者が
        ``X-Forwarded-For: 127.0.0.1`` と書けば通ってしまう。
        """
        request = _Request(remote="192.168.1.42")
        request.headers["X-Forwarded-For"] = "127.0.0.1"
        self.assertEqual(refuse_reason(request), "this route is local-only")


if __name__ == "__main__":
    unittest.main()
