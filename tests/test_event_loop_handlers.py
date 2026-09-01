# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**宣言を守る機械**——重い処理を ComfyUI のイベントループに載せない（`I-20260831-60`）。

`READ.md` の守りごと5は「重い処理を ComfyUI 本体のイベントループに載せない。
``asyncio.to_thread`` を通す」と宣言している。`routes.py` は実際に多くの口で
そうしているが、**2026-08-31 の実測で 25 の口のうち 14 が通っていなかった**。

重かったのは例えば:

- ``GET /unbake/record`` — 未走査なら ``_ensure()`` が全件走査へ落ちる。
  `routes.py` 自身が別の場所で「初回は 5〜6秒」と測っている。
- ``POST /unbake/record-save`` — ファイル書き込み ＋ ``library.scan()`` の全件走査。
- ``GET /unbake/record-preview`` — 画像を丸ごと同期読み。**一覧の升ごとに飛ぶ。**
  兄弟の ``/unbake/record-original`` は前から ``to_thread`` を通していた。

**1つずつ直しても、次に足す口でまた同じことが起きる。** 宣言は検査ではないので、
ここで機械にする——**新しい口を足したら、通すか、通さない理由を書くかのどちらかを
選ばされる**。

**綴りではなく構文木で見る。** ``ast`` で ``@routes.*`` の付いた非同期関数を
数え上げ、その中に ``asyncio.to_thread(...)`` の呼び出しが在るかを見る。
コメントに ``to_thread`` と書いただけでは通らない。
"""
import ast
import io
import unittest
from pathlib import Path

ROUTES = Path(__file__).resolve().parent.parent / "unbake" / "routes.py"

#: **ディスクにも外にも触らない口。** ここへ足すときは理由を書くこと。
#: 理由が「たぶん軽い」なら足さずに ``to_thread`` を通す方が安い。
ALLOWED_WITHOUT_THREAD = {
    "GET /unbake/download":
        "進み具合。`download_state()` は `_downloads` 辞書を錠つきで読むだけで、"
        "ディスクにも外にも触らない（2026-08-31 実測）。",
    "POST /unbake/download-cancel":
        "取り消しの旗を立てるだけ。`cancel_download()` は `_downloads` の各項へ "
        "`canceled` を書くだけで、待つ処理を持たない（2026-08-31 実測）。",
}


def _handlers():
    """``@routes.*`` の付いた非同期関数を、経路つきで返す。"""
    tree = ast.parse(io.open(ROUTES, encoding="utf-8").read())
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.AsyncFunctionDef):
            continue
        for decorator in node.decorator_list:
            if not isinstance(decorator, ast.Call):
                continue
            func = decorator.func
            if not isinstance(func, ast.Attribute):
                continue
            if not (isinstance(func.value, ast.Name) and func.value.id == "routes"):
                continue
            if func.attr not in ("get", "post", "put", "delete"):
                continue
            if not decorator.args or not isinstance(decorator.args[0], ast.Constant):
                continue
            found.append((f"{func.attr.upper()} {decorator.args[0].value}", node))
    return found


def _uses_to_thread(node) -> bool:
    """本体のどこかで ``asyncio.to_thread(...)`` を呼んでいるか。"""
    for inner in ast.walk(node):
        if not isinstance(inner, ast.Call):
            continue
        func = inner.func
        if (isinstance(func, ast.Attribute) and func.attr == "to_thread"
                and isinstance(func.value, ast.Name) and func.value.id == "asyncio"):
            return True
    return False


class EventLoopHandlersTest(unittest.TestCase):
    def test_口を数え上げられている(self):
        """**0件を合格と読まない。**

        構文木の当て方を間違えると、口が1つも取れないまま全部の検査が緑になる。
        件数の下限を置いて、拾えなくなったこと自体を落とす。
        """
        handlers = _handlers()
        self.assertGreaterEqual(
            len(handlers), 20,
            f"@routes.* の口を拾えていない（{len(handlers)}件）。当て方が壊れている",
        )

    def test_ディスクを触る口はすべて_to_thread_を通る(self):
        offenders = [
            route for route, node in _handlers()
            if not _uses_to_thread(node) and route not in ALLOWED_WITHOUT_THREAD
        ]
        self.assertEqual(
            offenders, [],
            "イベントループ上で重い処理をしうる口がある。`to_thread` を通すか、"
            "触らない理由を ALLOWED_WITHOUT_THREAD へ書くこと: " + ", ".join(offenders),
        )

    def test_許した口が実在し_理由が書いてある(self):
        """**免除の一覧が腐らないようにする。**

        経路を消したり改名したりすると、免除だけが残って「次に同じ名前で
        作った口」が黙って免除される。
        """
        routes = {route for route, _ in _handlers()}
        for route, reason in ALLOWED_WITHOUT_THREAD.items():
            with self.subTest(route):
                self.assertIn(route, routes, f"{route}: 免除だけ残って口が無い")
                self.assertGreater(len(reason), 30, f"{route}: 理由が短すぎる")

    def test_許していない口が_実際に通っている(self):
        """**対照。** 免除の外の口が本当に通っていることを、名指しで1つ確かめる。

        上の検査は「違反が0件」しか言わないので、`_uses_to_thread` が常に
        `True` を返すようになっても緑のままになる。
        """
        by_route = dict(_handlers())
        self.assertIn("GET /unbake/record", by_route)
        self.assertTrue(_uses_to_thread(by_route["GET /unbake/record"]))
        # 免除した口は、本当に通っていないこと（免除が空振りしていない）。
        self.assertFalse(_uses_to_thread(by_route["GET /unbake/download"]))


if __name__ == "__main__":
    unittest.main()
