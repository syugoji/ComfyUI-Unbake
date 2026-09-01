# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""Raindrop のブックマークを**一覧するだけ**。

## 「あとで読む箱」（裁定⑦・2026-08-20）

用途は取得ではなく**先送り**である。Civitai で気に入った絵を見つけた時点では
ComfyUI を起動していないので、その場でブックマークだけしておき、あとで
Unbake が回収する。だからここが要るのは**一覧**だけで、レシピを作る力は要らない。
作るのは既に在る Civitai の経路（`web/core/civitaiClient.js`）がやる。

## `raindrop_sync_service.py` を配線しなかった理由

同梱の ``unbake/services/raindrop_sync_service.py`` は Raindrop の
クライアントではなく、**同梱スクリプト ``civitai_image_download.py`` を走らせる実行器**
である（``resolve_script_path()`` が ``civitai_recipe_sync/civitai_image_download.py``
を探す）。配線すると2つ壊れる:

**「別プロセスで起動する」と書いていたのを直した**（2026-09-01・走査4周目）。
0.1.2 以降は ``sync_script_runner.py`` が**同一プロセスで import** している。
``raindrop_sync_service.py`` の冒頭は「**別プロセスだから arm's-length**」という
論拠が**もう使えない**ことを書き、**将来この境界を読む人がその消えた論拠で
判断しないため**にわざわざ残してある——ところが「なぜ配線しなかったか」を
知りたい人が最初に開くのはこちらなので、**注意書きの在る所と、読まれる所が
違っていた**。同じ主張は NOTICE でも一度嘘になっている（``I-20260831-09``）。
なお同梱の ``civitai_recipe_sync/README.md`` にも同じ論拠が残っているが、
あちらは MIT の別配布物で**1文字も変えない**約束なのでここからは直せない。

1. 同梱していない外部スクリプトへ依存する——**独立した拡張ではなくなる**
2. そのスクリプトは ``.recipe.json`` を書く（実測で書き込み5箇所）——
   **Unbake は書き戻さない**という決めごとに正面から反する

だからここは新しく、**読むだけ**の小さなものを書いた。

## 書かない・秘密を返さない

- 取得だけ。Raindrop へ書き戻さない（ブックマークを消したり動かしたりしない）
- 鍵はサーバの設定から取り、**応答へ載せない**
- 返すのは ``link`` / ``title`` / ``created`` / ``cover`` だけ。ブックマークには
  個人的なメモが付くことがあるので、**要らないものは持ち出さない**
  （表紙は「どれか」を見分けるために要るので通す。ただし http(s) のみ）

## 確かめていないこと

**本物のアカウントでは一度も通していない**（手元に鍵が設定されていない）。
応答の形は公開ドキュメントに基づく。鍵を入れて一度通すまで、ここは未検証である。
"""

from __future__ import annotations

import json
import logging
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

API_ROOT = "https://api.raindrop.io/rest/v1"

#: 1回に取る件数。Raindrop の上限に合わせる。
PER_PAGE = 50

#: 全部読むときのページ数の上限。**無限には回さない。**
#:
#: 50件×200ページ＝10,000件。手元の箱は349件（実測 2026-08-23）なので7周で終わる。
#: 越えたときは黙って切らず、``truncated`` を立てて呼び手へ伝える。
MAX_PAGES = 200

#: 出典として拾うホスト。**`.red` も見る**（手元の記録の出典は326/340件が `.red`）。
CIVITAI_IMAGE = re.compile(r"civitai\.(?:com|red)/images/(\d+)")


def _get_json(url: str, token: str, timeout: int = 30) -> Optional[Dict[str, Any]]:
    request = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "User-Agent": "ComfyUI-Unbake",
        "Authorization": f"Bearer {token}",
    })
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, ValueError, OSError) as error:
        logger.debug("raindrop request failed: %s", error)
        return None


def _http_url(value) -> str:
    """http(s) のときだけ通す。**それ以外は空**（面へ渡すのは絵の在り処だけ）。"""
    text = str(value or "").strip()
    return text if text.startswith(("http://", "https://")) else ""


def list_bookmarks(
    *,
    token: str,
    collection_id: str = "0",
    page: int = 0,
    all_pages: bool = False,
    fetch: Optional[Callable[..., Any]] = None,
) -> Dict[str, Any]:
    """ブックマークを返す。既定は1ページ分。

    ``collection_id`` の ``0`` は「すべて」（Raindrop の決めごと）。

    ``all_pages`` を立てると**箱の全部**を返す（2026-08-23 利用者の指示）。
    Raindrop の ``perpage`` は 50 が上限なので、こちらでページを繰る。
    実測（手元の箱）で 349件＝7周。**上限 :data:`MAX_PAGES` で止め、
    止めたことは ``truncated`` で伝える**——黙って切ると「これで全部」と読まれる。

    Returns:
        ``{"ok": True, "items": [...], "count": n, "page": p}`` または
        ``{"ok": False, "error": …}``。**投げない。**
    """
    if not str(token or "").strip():
        # **鍵が無いことと、0件だったことを混ぜない。**
        return {"ok": False, "error": "no-token", "items": [], "count": 0}

    collection = str(collection_id or "0").strip() or "0"
    if not re.fullmatch(r"-?\d+", collection):
        return {"ok": False, "error": "collection must be a number", "items": [], "count": 0}

    getter = fetch or _get_json
    first = max(0, int(page))
    items: List[Dict[str, Any]] = []
    count: Any = None
    truncated = False
    at = first

    while True:
        query = urllib.parse.urlencode({"perpage": PER_PAGE, "page": at})
        payload = getter(f"{API_ROOT}/raindrops/{collection}?{query}", token)
        if not isinstance(payload, dict):
            # **取れなかったことを「0件」と混ぜない。**
            if items:
                # 途中まで取れているなら、それは返す。**取れた分まで捨てない。**
                truncated = True
                break
            return {"ok": False, "error": "could not reach Raindrop", "items": [], "count": 0}

        if count is None:
            count = payload.get("count")
        batch = payload.get("items") or []
        for entry in batch:
            link = str(entry.get("link") or "")
            match = CIVITAI_IMAGE.search(link)
            items.append({
                # **要らないものを持ち出さない。** メモやタグは取らない。
                "link": link,
                "title": str(entry.get("title") or ""),
                "created": entry.get("created"),
                # 表紙（2026-08-25 利用者の指摘）。**画面は最初から絵を出す作り**
                # だったのに、ここが送っていなかったので**一度も出ていなかった**
                # ——片側だけ配線された状態。メモやタグと違い、表紙は
                # 「どのブックマークか」を見分けるためのもので、持ち出す理由がある。
                #
                # **http(s) だけ通す**（`_http_url`——絵の在り処に既にある判定を
                # そのまま使う。同じ判定を2つ持つと必ず食い違う）。
                # `data:` や `javascript:` を `src` へ渡す道を作らない。
                "cover": _http_url(entry.get("cover")),
                # 取り込み済みかの判定は画面側でやる（書庫の要約と突き合わせる）。
                "civitaiImageId": match.group(1) if match else None,
            })

        if not all_pages:
            break
        # 1件も返らないのに足りていない＝口の側が進まない。**回り続けない。**
        if not batch:
            break
        if isinstance(count, int) and len(items) >= count:
            break
        at += 1
        if at - first >= MAX_PAGES:
            truncated = True
            break

    return {
        "ok": True,
        "items": items,
        "count": count,
        "page": first,
        "perPage": PER_PAGE,
        # **全部読んだのか、途中で止めたのか。** 読む側が「これで全部」と
        # 言えるかどうかがここで決まる。
        "all": bool(all_pages),
        "truncated": truncated,
    }
