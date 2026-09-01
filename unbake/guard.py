"""状態を変える口を、**押した人の画面からしか**届かないようにする。

Copyright (C) 2026 syugoji
SPDX-License-Identifier: GPL-3.0-or-later

## なぜ要るのか

ComfyUI の HTTP は既定で ``0.0.0.0`` に開く。そこへ **JSON を1つ投げるだけで
モデルを消せる口**が生えていた（``POST /unbake/model-delete``）。
ComfyUI-Manager のメンテナから 2026-09-01 に指摘された:

    The `model-delete` route deletes model files and is network-reachable,
    so any page the user visits can delete files.

**指摘は3本のうち1本（``model-delete``）だけを名指ししていたが、
``record-delete`` と ``output-delete`` も同じ形だった。**
守りは口ごとに書かず、**ここ1箇所**に置く。

## 「局所限定」だけでは、言われている攻撃は止まらない

**利用者のブラウザで走る悪意のあるページからの要求は、``127.0.0.1`` から来る。**
だから ``request.remote`` を見るだけでは「any page the user visits」を防げない。
実際に効くのは下の3つで、**役割が違う**:

===========================  ==================================================
局所（``remote`` が loopback）  **同じ LAN の別の機械**からの直接の要求を止める
                             （``0.0.0.0`` に開いているので実在する経路）
出所（``Origin``）             **利用者のブラウザで開かれた別サイト**からの
                             要求を止める。これが指摘された攻撃そのもの
形（``Content-Type``）         ``application/json`` を要求すると、
                             ブラウザは事前確認（preflight）を強いられる。
                             ``text/plain`` なら preflight 無しで飛ばせるので、
                             **これが無いと出所の検査ごと迂回される**
===========================  ==================================================

**3つとも要る。1つでも外すと、外した分の経路が開く。**

## 決めごと

- **``Origin`` が無い要求は通す。** ブラウザは他所からの ``POST`` に必ず付ける。
  無いのは ``curl`` など非ブラウザで、**そこは局所の検査が受け持つ**。
  「無ければ弾く」にすると手元の道具が全部壊れるだけで、攻撃者は困らない。
- **代理（リバースプロキシ・トンネル）越しでは通らなくなる。** ``remote`` が
  代理の住所になるため。**それが指摘の求めているところ**なので、直さない。
- **``X-Forwarded-For`` を見ない。** 送り手が自由に書ける値なので、
  見た瞬間に局所の検査が意味を失う。
"""

from __future__ import annotations

import functools
import ipaddress
from typing import Optional
from urllib.parse import urlsplit

#: 通してよい本文の形。**これ以外は preflight を迂回できてしまう。**
REQUIRED_CONTENT_TYPE = "application/json"


def _is_loopback(remote: Optional[str]) -> bool:
    """``request.remote`` が自分自身か。

    ``::ffff:127.0.0.1`` のような写像された v4 も loopback として扱う
    （``ipaddress`` が ``ipv4_mapped`` で解いてくれる）。
    **判らないものは通さない**——``None`` は偽を返す。
    """
    if not remote:
        return False
    host = remote.strip()
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    # `127.0.0.1:12345` の形で来ることがある（住所と口が繋がっている）
    if host.count(":") == 1 and "." in host:
        host = host.split(":", 1)[0]
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    mapped = getattr(address, "ipv4_mapped", None)
    if mapped is not None:
        address = mapped
    return address.is_loopback


def _same_origin(origin: Optional[str], host: Optional[str]) -> bool:
    """``Origin`` が要求先と同じか。**空の ``Origin`` はここへ来ない。**

    比べるのは ``host:port``。``Origin: null``（sandbox された iframe 等）は
    **同じではない**ものとして扱う。
    """
    if not origin or not host:
        return False
    if origin == "null":
        return False
    parsed = urlsplit(origin)
    if not parsed.netloc:
        return False
    return parsed.netloc.lower() == host.strip().lower()


def refuse_reason(request) -> Optional[str]:
    """通してよければ ``None``、駄目なら**理由**を返す。

    理由を文字列で返すのは、検査が「弾いた」ではなく
    **「どの守りが働いたか」**を見られるようにするため——
    3つのうち1つが死んでも、残り2つが弾いて緑のままになる形を避ける。
    """
    if not _is_loopback(getattr(request, "remote", None)):
        return "this route is local-only"

    headers = getattr(request, "headers", {}) or {}
    origin = headers.get("Origin")
    if origin is not None and not _same_origin(origin, headers.get("Host")):
        return "cross-origin requests are refused"

    content_type = (headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
    if content_type != REQUIRED_CONTENT_TYPE:
        return f"Content-Type must be {REQUIRED_CONTENT_TYPE}"

    return None


def _refusal(reason: str):
    """403 を返す。

    ``routes.py`` の ``json_response`` は**関数の内側**に在って import できない。
    写しを作らず、素の ``aiohttp`` をここで1度だけ使う——返すのは
    ``{"ok": False, "error": ...}`` の固定形で、非有限の float は入りようがない
    （``json_response`` が ``dumps_json_strict`` を通している理由はここには無い）。
    """
    from aiohttp import web

    return web.json_response({"ok": False, "error": reason}, status=403)


def local_only(handler):
    """状態を変える口に付ける。**付け忘れは構造検査が落とす。**

    素の関数として書かず飾りにしたのは、口ごとに ``if`` を書くと
    **書き忘れても動いてしまう**から。飾りなら「付いているか」を
    原文から数えられる。
    """

    @functools.wraps(handler)
    async def guarded(request):
        reason = refuse_reason(request)
        if reason is not None:
            return _refusal(reason)
        return await handler(request)

    guarded.__unbake_local_only__ = True
    return guarded
