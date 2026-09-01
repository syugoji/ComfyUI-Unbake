# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
#
# ComfyUI-Unbake の一部。著作権の所在を明示してあることが、
# 後から別のライセンスを足せる唯一の担保になる。
"""URL の宛先を1箇所で決める（``I-20260831-73``・2026-09-01）。

**同じ名前・同じ役目・違う中身が4本在った。** すべて信用の境界を守る側:

===========================  ==========================================
``civitai.py``               ``urlparse(...).hostname``（userinfo も port も落ちる）
``civarchive.py``            ``urlparse(...).netloc``（どちらも残る）
``download.py``              ``urlparse(...).netloc``
``model_previews.py``        手で切った文字列（``split("://")`` → ``split("/")``）
===========================  ==========================================

13通りの URL で測ると **7通りで3者が食い違った**（2026-09-01 実測）。
``I-20260831-69``（拡張子の一覧が5つ）と同じ型で、**次に1つ直しても残りは古いまま**。

**どれも正しくなかった。** ここで測ったのは「``urlparse`` が何と言うか」ではなく
「**``urllib`` が実際にどこへ繋ぐか**」である:

- ``https://civitai.com%40evil.com/x`` … ``hostname`` は
  ``civitai.com%40evil.com`` と読むが、``Request(...).host`` は
  ``%40`` を戻して **``civitai.com@evil.com``＝evil.com へ繋ぐ**
- ``https://evil.com\\@civitai.com/x`` … ``hostname`` は **``civitai.com``**
  と読む——**許可一覧に入っているので通っていた**（``civitai.py`` の経路）。
  実際の宛先は ``evil.com\\@civitai.com`` で、この名前は DNS で解けないから
  *結果的に*繋がらなかっただけである。**穴を実演できたわけではないが、
  番人が訊かれたのと違う問いに答えていた。**

だから **2つの読み方が一致したときだけ**ホスト名を返し、割れたら空を返す
（＝呼び手はどの許可一覧とも一致しないので**閉じる側へ外れる**）。
"""

from __future__ import annotations

import urllib.parse
import urllib.request

#: ここが扱う仕組み。**他のものは宛先を判定しない**——``ftp:`` や
#: ``javascript:`` は「ホストが読めた」ことに意味が無い。
ALLOWED_SCHEMES = ("http", "https")


def _strip_port(value: str) -> str:
    """``host:port`` から port を落とす。``[::1]:8080`` も扱う。"""
    text = str(value or "")
    if text.startswith("["):
        end = text.find("]")
        return text[1:end] if end >= 0 else text
    return text.rsplit(":", 1)[0] if ":" in text else text


def host_of(url: object) -> str:
    """URL が**実際に繋ぐ先**のホスト名（小文字）。判らなければ空。

    **空は「別のホスト」として扱うこと。** 「同じかどうか判らない」を
    「同じ」と読むと、番人が居ないのと変わらなくなる——特に
    *2つの URL を比べる*場面では、``host_of(a) == host_of(b)`` が
    **両方とも空のときに真になる**。比べる側は下の :func:`same_host` を使う。
    """
    text = str(url or "")
    try:
        parsed = urllib.parse.urlparse(text)
        name = (parsed.hostname or "").lower()
        scheme = (parsed.scheme or "").lower()
    except ValueError:
        return ""
    if not name or scheme not in ALLOWED_SCHEMES:
        return ""
    try:
        # **``urllib`` 自身に訊く。** ここが「実際の宛先」の唯一の出典で、
        # ``%40`` の復号や区切りの解釈は ``urlparse`` と一致しない。
        actual = urllib.request.Request(text).host or ""
    except ValueError:
        return ""
    return name if _strip_port(actual).lower() == name else ""


def same_host(left: object, right: object) -> bool:
    """2つの URL が同じ宛先を指すか。**読めない側が在れば偽。**

    ``host_of(a) == host_of(b)`` と書かないこと——**両方が読めないとき真**に
    なる。転送先を確かめる場面でそれをやると、**読めない URL への転送で
    鍵を持ち越す**（``download.py`` の ``_DropAuthOnHostChange``）。
    """
    a = host_of(left)
    return bool(a) and a == host_of(right)
