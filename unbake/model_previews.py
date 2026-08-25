"""導入済みモデルの見本画像を、**必要最低限だけ**自前で集める。

Copyright (C) 2026 syugoji
SPDX-License-Identifier: GPL-3.0-or-later

---

**役割分担をはっきりさせる。** 見本を網羅的に集めるのは LoRA Manager の仕事で、
あちらは全モデルぶんを落として動画も静止画も持つ。ここがやるのは
**Unbake の画面で今まさに要る1枚**を、無ければ取りに行くことだけ。

だから **models フォルダへは1バイトも書かない。** 書くと、

- LoRA Manager が同じ名前で落としてきたときにどちらが勝つか判らない
- あちらの走査が「自分が置いた覚えのないファイル」を拾う
- 消すときにどちらの持ち物か判らない

ので、こちらの取り分は **ComfyUI の user ディレクトリの下**へ置く。
:func:`preview_path` は**上流のファイルを先に見る**——LM が持っていれば
そちらを出す（完全版が勝つ）。

**動画は見本にしない。** Civitai の見本は先頭が動画のことがあり
（``type: "video"``）、``<img>`` へ入れても何も出ない。静止画だけを選ぶ
——**「先頭を取る」と書くと、動画のモデルだけ黙って空になる。**
"""

from __future__ import annotations

import hashlib
import os
import tempfile
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional

from .civitai import API_HOSTS, _get_json

#: 見本を置いてよい型。**中身の型で決める**（拡張子は名乗りにすぎない）。
PREVIEW_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp")

#: 取りに行ってよい配信元。**API が返した URL でも行き先は確かめる。**
IMAGE_HOSTS = ("image.civitai.com",)

#: 見本1枚の上限。これを超えるものは見本ではない。
MAX_PREVIEW_BYTES = 12 * 1024 * 1024

#: 探しに行ったが**無かった**ことを覚えておく印。
#: 無いモデルを開くたびに Civitai へ問い合わせ直さないため。
MISS_SUFFIX = ".miss"


def cache_dir() -> Path:
    """こちらの取り分の置き場。**models フォルダの外。**"""
    base: Optional[str] = None
    try:
        import folder_paths  # type: ignore

        getter = getattr(folder_paths, "get_user_directory", None)
        if callable(getter):
            base = getter()
    except Exception:
        base = None
    if not base:
        base = os.environ.get("UNBAKE_SETTINGS_DIR") or tempfile.gettempdir()
    return Path(base) / "unbake" / "model-previews"


def _cache_key(kind: str, name: str) -> str:
    """置き場の中の名前。**モデル名をそのままファイル名にしない**
    ——区切り・記号・長さのどれもこちらの都合で壊れる。
    """
    digest = hashlib.sha1(f"{kind}\n{name}".encode("utf-8")).hexdigest()
    return f"{kind}-{digest}"


def cached_preview(kind: str, name: str) -> Optional[Path]:
    """こちらが集めた見本。無ければ None。"""
    root = cache_dir()
    key = _cache_key(kind, name)
    for suffix in PREVIEW_SUFFIXES:
        candidate = root / f"{key}{suffix}"
        if candidate.is_file():
            return candidate
    return None


def cached_miss(kind: str, name: str) -> bool:
    """**探して無かった**ことを覚えているか。"""
    return (cache_dir() / f"{_cache_key(kind, name)}{MISS_SUFFIX}").is_file()


def _remember_miss(kind: str, name: str, reason: str) -> None:
    root = cache_dir()
    root.mkdir(parents=True, exist_ok=True)
    try:
        (root / f"{_cache_key(kind, name)}{MISS_SUFFIX}").write_text(reason, encoding="utf-8")
    except OSError:
        pass


def file_sha256(path: Path, chunk: int = 1 << 20) -> str:
    """ファイルの SHA256。**実測 325 MB で 0.24 秒**なので、押された分だけなら十分速い。"""
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(chunk), b""):
            digest.update(block)
    return digest.hexdigest()


def _host_of(url: str) -> str:
    text = str(url or "")
    if "://" not in text:
        return ""
    return text.split("://", 1)[1].split("/", 1)[0].lower()


def pick_still_image(version: Dict[str, Any]) -> Optional[str]:
    """見本にできる**静止画**の URL。

    **先頭を取らない。** Civitai の見本は先頭が動画のことがあり、``<img>`` へ
    入れても何も出ない。``type`` が ``image`` のものだけを選び、1枚も無ければ None。
    """
    for item in version.get("images") or []:
        if not isinstance(item, dict):
            continue
        if str(item.get("type", "image")).lower() != "image":
            continue
        url = str(item.get("url") or "")
        if _host_of(url) in IMAGE_HOSTS:
            return _thumbnail_url(url)
    return None


def _thumbnail_url(url: str) -> str:
    """見本は**小さいもので足りる。**

    Civitai が返すのは原寸（``…/orig``）で、実測すると1枚 2.5〜3.6 MB あった。
    画面で使うのは 84px の枠なので、原寸を集めると**400本で数百MB**になる。
    配信側が幅の指定を受けるので、そこだけ差し替える。
    """
    if url.endswith("/orig"):
        return url[: -len("orig")] + "width=450"
    return url


def _suffix_of(url: str, content_type: str) -> str:
    lowered = str(content_type or "").lower()
    if "png" in lowered:
        return ".png"
    if "webp" in lowered:
        return ".webp"
    if "jpeg" in lowered or "jpg" in lowered:
        return ".jpg"
    tail = os.path.splitext(str(url or "").split("?", 1)[0])[1].lower()
    return tail if tail in PREVIEW_SUFFIXES else ".jpg"


def fetch_preview(
    kind: str,
    name: str,
    model_path: Path,
    *,
    api_key: str = "",
    opener: Optional[Any] = None,
) -> Dict[str, Any]:
    """見本を1枚だけ取りに行く。**models フォルダへは書かない。**

    Returns:
        ``{"ok": True, "path": …, "from": "civitai"}`` か
        ``{"ok": False, "error": …}``。**投げない**（呼び手が理由を画面へ出す）。
    """
    existing = cached_preview(kind, name)
    if existing is not None:
        return {"ok": True, "path": str(existing), "from": "cache"}

    try:
        sha = file_sha256(model_path)
    except OSError as error:
        return {"ok": False, "error": f"{type(error).__name__}: {error}"}

    version = _get_json(
        f"https://{API_HOSTS[0]}/api/v1/model-versions/by-hash/{sha}", api_key
    )
    if not isinstance(version, dict):
        # **取れなかったことを「無い」と混ぜない。** 覚えておくのは
        # 「探して無かった」ときだけで、届かなかったのは次に再試行してよい。
        return {"ok": False, "error": "could not reach the Civitai API for this hash"}

    url = pick_still_image(version)
    if not url:
        # 動画しか無いモデルはここへ来る。**次から問い合わせない。**
        _remember_miss(kind, name, "no-still-image")
        return {"ok": False, "error": "this model has no still image to use as a preview"}

    request = urllib.request.Request(url, headers={"User-Agent": "ComfyUI-Unbake"})
    open_url = opener or urllib.request.urlopen
    try:
        with open_url(request, timeout=30) as response:
            content_type = ""
            if hasattr(response, "headers"):
                content_type = response.headers.get("Content-Type") or ""
            body = response.read(MAX_PREVIEW_BYTES + 1)
    except Exception as error:  # noqa: BLE001 - 理由をそのまま返す
        return {"ok": False, "error": f"{type(error).__name__}: {error}"}

    if not body:
        return {"ok": False, "error": "empty preview"}
    if len(body) > MAX_PREVIEW_BYTES:
        return {"ok": False, "error": f"preview too large (> {MAX_PREVIEW_BYTES} bytes)"}

    root = cache_dir()
    root.mkdir(parents=True, exist_ok=True)
    target = root / f"{_cache_key(kind, name)}{_suffix_of(url, content_type)}"
    handle, temp_name = tempfile.mkstemp(dir=str(root), prefix=".unbake-preview-", suffix=".part")
    stream = os.fdopen(handle, "wb")
    try:
        with stream:
            stream.write(body)
        os.replace(temp_name, target)
    except OSError as error:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        return {"ok": False, "error": f"{type(error).__name__}: {error}"}
    return {"ok": True, "path": str(target), "from": "civitai"}


# --- 見本が動画だったとき（2026-08-22 利用者の指示）--------------------------
#
# **動画しか無いモデルが、画面で無地になっていた。** 実測（2026-08-22・手元の実データ）:
#
#     checkpoints 100件: 画像 91 / **動画だけ 9** / 無し 0
#     loras       481件: 画像 447 / **動画だけ 30** / 無し 4
#
# 合わせて **39件が絵で選べない**。`_CONTENT_TYPES` は画像しか返さないので、
# 動画を持っているモデルは「見本が無い」のと同じ扱いになっていた。
#
# **静止画を作って持つ。** 動画をそのまま画面へ流すと、一覧に何十本も並んだ動画が
# 同時に再生され、選ぶどころではなくなる（帯域も食う）。1コマ抜いて画像として置く。

#: 見本として扱う動画。LoRA Manager が置くのはこの4つ（実測）。
VIDEO_SUFFIXES = (".mp4", ".webm", ".gif", ".mov")


def video_beside(model: Path) -> Optional[Path]:
    """モデルの隣にある動画の見本。**画像を先に探した後で呼ぶこと。**"""
    for suffix in VIDEO_SUFFIXES:
        for candidate in (model.with_suffix(suffix), model.with_suffix(f".preview{suffix}")):
            if candidate.is_file():
                return candidate
    return None


def still_from_video(video: Path, target: Path) -> Optional[Path]:
    """動画から1コマ抜いて ``target`` へ PNG で置く。**投げない。**

    **外部プロセスを起こさない。** `ffmpeg` を呼ぶ形にすると、入っていない環境で
    黙って無地に戻る（しかも理由が出ない）。代わりに **PyAV** を使う——ComfyUI の
    ``requirements.txt`` に ``av>=16.0.0`` として在り、本体の ``comfy_extras`` が
    5箇所で ``import av`` している（実測 2026-08-22）＝**宿主が持っている**。

    **`cv2` は当てにしない。** site-packages には在るが ``requirements.txt`` に無く、
    別の拡張が持ち込んだものかもしれない。**名前だけ見て「宿主が持っている」と
    決めない**——そこを緩めると、他人の環境で黙って無地に戻る。

    **最初のコマを採る。** 「一番よく写っているコマ」を選ぼうとすると、何を良いと
    するかを決める必要が出てきて、見本1枚のためには重すぎる。
    """
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        return None

    # PyAV。ComfyUI の依存に元から入っている（`requirements.txt` の `av>=16.0.0`）。
    try:
        import av  # type: ignore

        with av.open(str(video)) as container:
            stream = next((s for s in container.streams if s.type == "video"), None)
            if stream is not None:
                for frame in container.decode(stream):
                    frame.to_image().save(str(target), format="PNG")
                    return target if target.is_file() else None
    except Exception:
        pass

    # **読めなければ何も作らない。** 「見本が無い」へ落ちるだけで、今までと同じ。
    return None


def still_for(kind: str, name: str, model: Path) -> Optional[Path]:
    """動画しか無いモデルの静止画。**一度作ったら作り直さない。**

    置き場は :func:`cache_dir`（``<user>/unbake/model-previews``）で、
    **models フォルダへは1バイトも書かない**——上流の見本とぶつからない。
    """
    root = cache_dir()
    target = root / f"{_cache_key(kind, name)}.still.png"
    if target.is_file():
        return target
    video = video_beside(model)
    if video is None:
        return None
    return still_from_video(video, target)
