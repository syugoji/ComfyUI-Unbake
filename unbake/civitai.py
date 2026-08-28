# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""Civitai の版1件を、**落としてよい形へ解決する**。

## なぜサーバ側にも問い合わせが要るのか

同じ問い合わせは ``web/core/civitaiClient.js`` にもある。あちらは**表示のため**で、
ここは**「何を落としてよいか」を決める境界**である。

画面から URL を受け取って落とすと、画面へ細工をした人が任意の場所から
ファイルを引ける口になる。だから落とす側は**版IDだけ**を受け、
自分で公開 API を引いて、**返ってきた URL しか使わない**。
ホストも Civitai であることを確かめる。

**これは正規化の二重化ではない。** 二重に持つと食い違うのは「同じ値を作る規則」で、
ここが持っているのは「何を信じるか」という別の判断である。

## 上流を写していない

フォークの ``civitai_client.py`` は上流ファイルなので開いていない。
材料は公開 API の応答だけ（実測 2026-08-20）。
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

#: 問い合わせてよいホスト。**手元の記録の出典は `.red` が326/340件。**
API_HOSTS = ("civitai.com", "civitai.red")

#: 落として良いホスト。**API が返した URL でも、ここに無ければ使わない。**
DOWNLOAD_HOSTS = ("civitai.com", "civitai.red")

#: モデルの種別 → ComfyUI の置き場。**判らない種別は落とさない。**
KIND_OF_TYPE = {
    "lora": "loras",
    "locon": "loras",
    "dora": "loras",
    "checkpoint": "checkpoints",
    "textualinversion": "embeddings",
    "vae": "vae",
    "controlnet": "controlnet",
    "upscaler": "upscale_models",
    # `models/hypernetworks` は ComfyUI 本体が持っていて `HypernetworkLoader` が
    # 読む（実測 2026-08-26・folder_paths.py）。**入れ忘れていた**ので、
    # Hypernetwork は「対応していない型」として拒んでいた。
    "hypernetwork": "hypernetworks",
}

#: **Civitai が「Checkpoint」と呼ぶが、ComfyUI では `UNETLoader` で読むもの。**
#:
#: 2026-08-26 に実測して見つけた穴。Anima / Krea 2 / Z-Image は Civitai 上の
#: `type` がどれも `Checkpoint` なので `models/checkpoints/` へ落ちるが、
#: こちらが組むワークフローは `UNETLoader` を出す——読み口が見るのは
#: `models/unet/` なので、**落とした直後にまだ「不足」と表示される**。
#: 利用者の `anima_baseV10.safetensors` が `models/unet/Anima/anime/` に
#: 在ったのは、手で置き直したから。
#:
#: `recipeWorkflowBuilder.js` のコメントは「バックエンドが既に系統で決めている」
#: と書いていたが、**指している定数はこのリポジトリに無かった**——上流
#: （comfyui-lora-manager, GPL-3.0）の仕掛けを、移したつもりで移せていなかった。
#: 一覧は上流 `py/utils/constants.py` の `DIFFUSION_MODEL_BASE_MODELS` に倣う。
DIFFUSION_MODEL_BASE_MODELS = frozenset([
    "Anima",
    # Flux 系（DiT。ComfyUI では UNETLoader で読む）
    "Flux.1 D", "Flux.1 S", "Flux.1 Krea", "Flux.1 Kontext",
    "Flux.2 D", "Flux.2 Klein 9B", "Flux.2 Klein 9B-base",
    "Flux.2 Klein 4B", "Flux.2 Klein 4B-base",
    # UNet ではない画像拡散モデル
    "AuraFlow", "Chroma", "HiDream", "Hunyuan 1", "Kolors", "Lumina",
    "PixArt a", "PixArt E",
    # 動画拡散モデル
    "CogVideoX", "Hunyuan Video", "LTXV", "LTXV2", "LTXV 2.3", "Mochi", "SVD",
    "Wan Video", "Wan Video 1.3B t2v", "Wan Video 14B t2v",
    "Wan Video 14B i2v 480p", "Wan Video 14B i2v 720p",
    "Wan Video 2.2 TI2V-5B", "Wan Video 2.2 I2V-A14B", "Wan Video 2.2 T2V-A14B",
    "Wan Video 2.5 T2V", "Wan Video 2.5 I2V",
    # その他
    "Ernie", "Ernie Turbo", "Nucleus", "Qwen", "ZImageBase", "ZImageTurbo",
    "Krea 2",
])

#: Civitai がファイルそのものへ付ける種別のうち、拡散モデルを指すもの。
#: **こちらが `baseModel` の一覧より先に見る**——一覧は人が足す物なので
#: 新しい系統が出ると必ず遅れるが、この印は投稿された値そのもの。
DIFFUSION_FILE_TYPES = ("UNet", "Diffusion Model")


def early_access_until(version: Dict[str, Any]) -> Optional[str]:
    """まだ有料の早期公開なら、いつまでかを返す。**過ぎていれば None。**

    2026-08-26 に上流（comfyui-lora-manager, GPL-3.0）との差分を調べて見つけた。
    こちらは 401/403 をまとめて「鍵が要る」と言っていたが、早期公開のモデルは
    **鍵が在っても買っていなければ落とせない**——**鍵を入れ直させる案内は、
    打つ手が違うので時間を捨てさせる**。

    **終わった日付を「まだ有料」と読まない。** `earlyAccessEndsAt` は過去の
    ものも残るので、日付を見ずに拾うと**もう買える必要が無いモデル**まで
    「有料」と言うことになる。
    """
    raw = str(version.get("earlyAccessEndsAt") or "").strip()
    if not raw:
        return None
    from datetime import datetime, timezone

    try:
        ends = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        # **読めない日付を「終わった」と読まない。** 早期公開だとは判っている。
        return raw
    if ends.tzinfo is None:
        ends = ends.replace(tzinfo=timezone.utc)
    if ends <= datetime.now(timezone.utc):
        return None
    return ends.date().isoformat()


def _is_diffusion_model(version: Dict[str, Any]) -> bool:
    """この「Checkpoint」は、実は `models/unet` 側か。"""
    for item in version.get("files") or []:
        if str((item or {}).get("type") or "") in DIFFUSION_FILE_TYPES:
            return True
    return str(version.get("baseModel") or "") in DIFFUSION_MODEL_BASE_MODELS


def _get_json(url: str, api_key: str = "", timeout: int = 30) -> Optional[Dict[str, Any]]:
    request = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "User-Agent": "ComfyUI-Unbake",
        **({"Authorization": f"Bearer {api_key}"} if api_key else {}),
    })
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        # **上限に当たったことを「見つからない」と混ぜない。**
        #
        # ここは元々 `URLError` を全部握って ``None`` を返していたので、
        # 429 も「版が消えた」も同じ顔で出ていた。**打つ手が正反対**
        # （前者は待つ、後者は諦める）なのに、画面はどちらも「もう引けない」と言う。
        # しかも黙って続けると、上限に当たり続けたまま叩き続けることになる。
        if error.code in (429, 503):
            retry_after = 0
            try:
                retry_after = int(str(error.headers.get("Retry-After", "")).strip() or 0)
            except (TypeError, ValueError):
                retry_after = 0
            logger.warning("civitai rate limited (%s), retry after %ss", error.code, retry_after)
            return {RATE_LIMIT_FLAG: True, "retryAfter": max(0, retry_after)}
        logger.debug("civitai request failed: %s", error)
        return None
    except (urllib.error.URLError, ValueError, OSError) as error:
        logger.debug("civitai request failed: %s", error)
        return None


#: 上限に当たったことを示す印。**`_get_json` の戻りは dict なので、
#: 素直に `isinstance(payload, dict)` だけを見ると「引けた」と読める。**
RATE_LIMIT_FLAG = "__unbake_rate_limited__"


def is_rate_limited(payload: Any) -> bool:
    """この応答は「上限に当たった」か。

    **読む所を1つにする。** 印の綴りを各所で手書きすると、片方だけ直り
    もう片方が「引けた」と読み続ける——実際に `model_previews.py` がそうなっていて、
    **429 を「見本が無いモデル」として永久に焼いていた**（`D-20260828-01` E4）。
    """
    return isinstance(payload, dict) and bool(payload.get(RATE_LIMIT_FLAG))


def _try_civarchive(model_id, version_id, allowed: bool, fetch, kind=None) -> Optional[Dict[str, Any]]:
    """消えた版を受け皿から拾い直す。**設定で開けてあるときだけ。**

    **`kind` はこちらで決めない。** 受け皿は Civitai と同じ `model.type` を
    返さないので、呼び手が種類を渡していればそれを使い、無ければ置き場が
    決められない——その場合は拾えたことにしない（**置き場を推測して
    どこかへ置くよりは、落とせないと言うほうがよい**）。
    """
    if not allowed:
        return None
    from .civarchive import EXTRA_DOWNLOAD_HOSTS, resolve_version as _archive

    found = _archive(
        model_id, version_id,
        allowed_hosts=set(DOWNLOAD_HOSTS) | set(EXTRA_DOWNLOAD_HOSTS),
        fetch=fetch,
    )
    if not found:
        return None

    resolved_kind = kind or KIND_OF_TYPE.get(str(found.get("modelType") or "").lower())
    if not resolved_kind:
        # **置き場を推測してどこかへ置くよりは、落とせないと言うほうがよい。**
        return None
    if resolved_kind == "checkpoints" and str(found.get("baseModel") or "") in DIFFUSION_MODEL_BASE_MODELS:
        # Civitai 経由と同じ振り替え——**受け皿から来ても置き場の決め方は変えない。**
        resolved_kind = "diffusion_models"
    return {**found, "kind": resolved_kind}


def _primary_file(version: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """落とすべきファイル1つ。**`primary` を優先する。**

    版には本体の他に学習の設定や画像が付いていることがあり、
    最初の1つを取ると本体でない物を落とす。
    """
    files = version.get("files") or []
    for file in files:
        if file.get("primary"):
            return file
    for file in files:
        if str(file.get("type", "")).lower() == "model":
            return file
    return files[0] if files else None


def _host_of(url: str) -> str:
    try:
        return (urllib.parse.urlparse(url).hostname or "").lower()
    except ValueError:
        return ""


def resolve_version(
    version_id: str,
    *,
    kind: Optional[str] = None,
    host: str = API_HOSTS[0],
    api_key: str = "",
    fetch: Optional[Any] = None,
    model_id: Optional[Any] = None,
    allow_civarchive: bool = False,
    civarchive_fetch: Optional[Any] = None,
) -> Dict[str, Any]:
    """版IDから、落とすのに要るものを揃える。

    Returns:
        ``{"ok": True, "url", "filename", "kind", "bytes", "sha256", "name"}``
        または ``{"ok": False, "error": …}``。**投げない**（呼び手が理由を画面へ出す）。
    """
    version_id = str(version_id or "").strip()
    if not version_id.isdigit():
        return {"ok": False, "error": "versionId must be a number", "code": "setup"}
    api_host = host if host in API_HOSTS else API_HOSTS[0]

    getter = fetch or _get_json
    version = getter(f"https://{api_host}/api/v1/model-versions/{version_id}", api_key)
    if is_rate_limited(version):
        # **待てば通るものを「もう引けない」と言わない。**
        wait = int(version.get("retryAfter") or 0)
        return {
            "ok": False,
            "error": (
                f"the Civitai API asked us to slow down; try again in {wait} seconds"
                if wait else "the Civitai API asked us to slow down; try again shortly"
            ),
            "code": "rate_limited",
            "retryAfter": wait,
        }
    if not isinstance(version, dict):
        # **設定で開けてあるときだけ、受け皿を見る**（2026-08-26 利用者の指示）。
        #
        # 既定は OFF。開けていなければここは素通りして、今までどおり
        # 「もう引けない」とだけ言う——**外へ問い合わせを増やさない。**
        rescued = _try_civarchive(model_id, version_id, allow_civarchive, civarchive_fetch, kind)
        if rescued:
            return rescued
        # **取れなかったことを「存在しない」と混ぜない。**
        #
        # ただし**打つ手は同じ**（2026-08-23 利用者の指示で分類を付けた）。
        # 版が消えていても、鍵が無くて見えなくても、繋がらなくても、
        # ここからは区別が付かない——`gone` と呼んで「もう引けない」とだけ言う。
        # 区別が要るなら、そこは口の側（HTTP の番号）が持っている。
        return {
            "ok": False,
            "error": "could not reach the Civitai API for this version",
            "code": "gone",
        }

    file = _primary_file(version)
    if not file:
        return {"ok": False, "error": "this version has no downloadable file", "code": "gone"}

    resolved_kind = kind or KIND_OF_TYPE.get(str((version.get("model") or {}).get("type", "")).lower())
    # **落とす前に置き場を決め直す。** 種別が Checkpoint でも、読み口が
    # `UNETLoader` なら `models/unet` へ置かないと「落としたのに不足」になる。
    if not kind and resolved_kind == "checkpoints" and _is_diffusion_model(version):
        resolved_kind = "diffusion_models"
    if not resolved_kind:
        return {
            "ok": False,
            "error": f"unsupported model type: {(version.get('model') or {}).get('type')}",
            "code": "setup",
        }

    # **買っていないものを「鍵が要る」と言わない。** 引く前に判る。
    until = early_access_until(version)
    if until:
        return {
            "ok": False,
            "error": (
                f"this version is in early access until {until};"
                " it can only be downloaded after buying it on Civitai"
            ),
            # **`forbidden` と分ける。** 画面は `forbidden` を「鍵を確かめて
            # ください」と訳すので、まとめると**打つ手の違う案内**が出る。
            "code": "early_access",
            "earlyAccessUntil": until,
        }

    url = str(file.get("downloadUrl") or "")
    if _host_of(url) not in DOWNLOAD_HOSTS:
        # **API が返した URL でも、行き先は確かめる。**
        return {
            "ok": False,
            "error": f"refusing to download from {_host_of(url) or 'an unknown host'}",
            "code": "setup",
        }

    size_kb = file.get("sizeKB")
    try:
        size_bytes = int(float(size_kb) * 1024) if size_kb is not None else None
    except (TypeError, ValueError):
        size_bytes = None

    hashes = file.get("hashes") or {}
    return {
        "ok": True,
        "url": url,
        "filename": file.get("name"),
        "kind": resolved_kind,
        "bytes": size_bytes,
        # **無いこともある。** その場合は照合しないことを呼び手へ伝える
        # （`download_model` は `verified` で返す）。
        "sha256": hashes.get("SHA256"),
        "name": version.get("name"),
        "modelName": (version.get("model") or {}).get("name"),
        "baseModel": version.get("baseModel"),
    }
