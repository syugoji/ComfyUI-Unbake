# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""モデルを1つだけ落とす。

## 単品だけ作る理由（凍結・2026-08-20）

一括ダウンロードは作らない。実測で、**同じモデルを待っている記録は最大2件**しか
無く、束ねても待ち時間はほぼ変わらない。一方で一括は「どれが落ちて、どれが
落ちなかったか」を人が追えなくする。母数が出てから考える。

## 上流を写していない

フォークの ``downloader.py`` は上流ファイルなので開いていない。ここは
Civitai の公開 API の応答（``files[].downloadUrl`` / ``hashes.SHA256`` /
``sizeKB``）だけを材料に、標準ライブラリで書いてある。

## 危ないのは書き込む先

落とすのは数GBのファイルで、**置き場所を間違えると気づきにくい**。だから:

- 置き場は **ComfyUI が知っている場所だけ**（``folder_paths``）。設定から
  受け取ったパスへは書かない。
- ファイル名は **API が返した名前の basename だけ**を使う。``../`` を含む名前を
  そのまま繋ぐと、モデルの置き場の外へ書ける。
- **既にあるファイルを上書きしない。** 同名の別物を黙って置き換えると、
  「同じ名前なのに別の絵が出る」という一番厄介な壊れ方をする。
- **一時ファイルへ落として、確かめてから置き換える。** 途中で切れたファイルが
  本物の名前で残ると、モデルとして読めないだけでなく「落とし済み」に見える。
- **SHA256 を照合する。** 合わなければ本物の名前へ置かない。
  照合しないと、切れたダウンロードと成功の区別が付かない。
"""

from __future__ import annotations

import hashlib
import logging
import os
import shutil
import tempfile
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, Optional, Sequence, Tuple
from .utils.url_host import host_of, same_host

#: 落として良い置き場。**ここに無い種別は受けない。**
#:
#: **記録器は1つ**（2026-09-01・走査11周目）。同じ名前の `logger` と `LOG` が
#: 並んでおり、`logger` は**一度も使われていなかった**。
LOG = logging.getLogger(__name__)

ALLOWED_KINDS = ("loras", "checkpoints", "embeddings", "vae", "controlnet",
                 "upscale_models", "diffusion_models", "hypernetworks")

#: 受け取ってよい拡張子。**「安全な形式」ではなく「こちらが扱える形式」**
#: （``I-20260831-70``・2026-09-01 決定）。**名前を寄せる規則とは別の規則**
#: （``I-20260831-69``）。
#:
#: 出典は **ComfyUI の ``folder_paths.supported_pt_extensions``**——実機 0.27.0 で
#: ``{.ckpt .pt .pt2 .bin .pth .safetensors .pkl .sft}`` の8種。ここはその写しで、
#: **狭めない**。以前は ``.pt2`` / ``.pkl`` が落ちており、しかも注記が
#: 「実行できる形式を落とさない」と**安全の一覧のように書いてあった**ので、
#: 次に足す人がどちらの規則で判断すればよいか決められなかった。
#:
#: **安全の一覧としては成立しない。** ①``unbake`` は読み込まない——読むのは
#: ComfyUI で、その ComfyUI が pickle を全部受ける ②経路が唯一でない
#: （ComfyUI-Manager でも手置きでも同じ物が入る）③弾いていた ``.pkl`` と
#: 通していた ``.pt`` / ``.ckpt`` / ``.pth`` / ``.bin`` は**同じ pickle** で、
#: 危険度で分かれていなかった。安全の一覧にしようとすると、Civitai の実測で
#: **正当な需要の 4.3%** を切る（全期間DL上位100モデル・1,481版のうち
#: ``.pt`` 55 / ``.ckpt`` 7。embeddings は今も ``.pt`` が普通）。
#:
#: **それでもこの一覧は仕事をしている。** 弾いているものの大半は
#: モデルですらない——今月DL上位100モデル・1,306版のうち ``.zip`` 193 /
#: ``.json`` 52 / ``.txt`` 1。判定しているのは「安全か」ではなく
#: 「**モデルの容れ物か**」である。
#:
#: **``.gguf`` は入れない**（同じ決定）。ComfyUI 本体の集合に無く、
#: ``ComfyUI-GGUF`` は ``unet_gguf`` / ``clip_gguf`` という**別のキー**へ登録する
#: （置き場のフォルダは ``diffusion_models`` / ``text_encoders`` と同じ、キーだけが違う）。
#: だから通すだけでは ``models.installed()``——``folder_paths.get_filename_list(kind)``
#: ——に出ず、**「落とせるのに一覧に出ない」**を作る（``I-20260831-75`` と同じ形）。
#: 通すときは①kind の対応づけ ②``classify_model_payload`` へ GGUF の先頭4バイト
#: （``b"GGUF"``。無いと ``PAYLOAD_UNKNOWN`` で**HTMLエラーページ検査が効かない**）
#: ——が**同時に**要る。需要の実測は 新着198版で0件 / 今月DL上位1,306版で17件
#: (1.3%) / 全期間1,481版で2件 (0.14%)、手元の ``models/`` 454ファイルで0件。
#:
#: ``utils/model_file_names.MODEL_FILE_EXTENSIONS`` の**部分集合**であること
#: （``onnx`` / ``gguf`` は入らない）を
#: ``tests/model_name_rule_is_single_test.mjs`` が留める。
ALLOWED_SUFFIXES = (".safetensors", ".sft", ".ckpt", ".pt", ".pt2",
                    ".pth", ".bin", ".pkl")

#: 申告された大きさとのずれを許す幅。**`sizeKB` は KB なので、
#: バイトへ直す切り捨てで最大 1024 バイトずれる**（それより大きなずれは
#: 相手の数字が古いか、こちらが途中で切れたかのどちらか）。
SIZE_SLACK = 1024

#: 1回に落としてよい上限。**桁を間違えたリンクで数百GBを引かないため。**
MAX_BYTES = 64 * 1024 * 1024 * 1024

# 途中まで引いたものの拡張子。**名前は1箇所で決める**（2026-08-31・
# 監査 I-20260831-26）。容量の判定と再開の読み込みが別々に綴っていると、
# 片方だけ直したときに黙って食い違う。
PART_SUFFIX = ".unbake-part"

#: 読み込みの単位。
CHUNK = 1024 * 1024


class DownloadError(Exception):
    """落とせなかった理由。**握り潰さずに呼び手へ返す。**

    ``code`` は**画面が分類に使う機械可読の印**（2026-08-23 利用者の指示）。
    文言を読んで種類を当てさせない——訳したら当たらなくなるし、
    そもそも「HTTP 404」と「could not reach the Civitai API」が
    **同じこと（もう配布されていない）を指す**とは、文言からは読めない。

    種類:
      ``gone``      … Civitai にもう無い（404・版が引けない）
      ``forbidden``    … 権限が要る（401/403）
      ``early_access`` … まだ有料の早期公開（**鍵では解けない**）
      ``network``   … 繋がらなかった（次に試せば通るかもしれない）
      ``already``   … 置き場に既に在る（失敗ではない）
      ``canceled``  … 人が止めた（失敗ではない）
      ``corrupt``   … 落ちたが中身が合わない
      ``space``     … 置き場が足りない／大きすぎる
      ``setup``     … こちらの設定・環境の問題
      ``unsupported`` … こちらが扱えない形式（**設定では直せない**）

    **``unsupported`` を ``setup`` と混ぜない**（``I-20260831-70``）。
    混ぜていた間、``.gguf`` を頼んだ人には「こちらの設定の問題です」と出ていた
    ——**設定では直せない**ので、この文言は嘘である。
    """

    def __init__(self, message, code="unknown"):
        super().__init__(message)
        self.code = code


def _host_of(url: str) -> str:
    """URL の宛先。**判定は `utils/url_host` の1本**（`I-20260831-73`）。

    ここに手で書き直さないこと——同じ名前で中身の違うものが4本在り、
    13通りの URL のうち**7通りで答えが割れて**いた。
    """
    return host_of(url)


#: 鍵を出してよい相手。**鍵は Civitai のもの**なので、Civitai にしか出さない。
#:
#: `civitai.py` の `DOWNLOAD_HOSTS` と同じ並びだが、**ここは import しない**——
#: あちらは「落として良い相手」で、`use_civarchive` を入れると
#: `huggingface.co` が足される（`civarchive.EXTRA_DOWNLOAD_HOSTS`）。
#: **落として良い相手と、鍵を出してよい相手は別**なので、同じ名前に寄せると
#: 片方を広げた瞬間にもう片方も広がる。
AUTH_HOSTS = ("civitai.com", "civitai.red")


def _may_send_key(url: str, api_key: str) -> bool:
    """この宛先へ鍵を出してよいか。

    **転送のときだけ守っていた**（`_DropAuthOnHostChange`）。**初回の要求には
    その判定が無かった**ので、`use_civarchive` を入れていると
    `civarchive.py` が返した `huggingface.co` のミラーへ
    `Authorization: Bearer <Civitaiのキー>` をそのまま付けて出していた。

    **宛先を決めているのは civarchive.com（第三者）**である。返す URL を
    変えるだけで、こちらの鍵をどこへでも送らせられる形になっていた。
    """
    if not api_key:
        return False
    host = _host_of(url)
    return host in AUTH_HOSTS or any(host.endswith(f".{allowed}") for allowed in AUTH_HOSTS)


class _DropAuthOnHostChange(urllib.request.HTTPRedirectHandler):
    """行き先が変わったら `Authorization` を持ち越さない。

    **2026-08-26 の実機で踏んだ。** Civitai の取得 URL は S3/R2 へ転送する。
    Python の既定は**ヘッダをそのまま持ち越す**ので、ストレージ側が
    `Authorization` を AWS 署名として読み、``400 InvalidRequest /
    Missing x-amz-content-sha256`` を返す。

    実測（同じ版で比べた）::

        鍵なし        → HTTP 200（4.18 GB）
        Bearer 付き   → HTTP 400

    **鍵を設定している人だけ、すべての取得が失敗していた。** しかも 400 は
    404/401/403 のどれでもないので「繋がりませんでした」に落ち、
    **打つ手が「もう一度試す」に見える**（何度試しても同じ）。

    **URL の `?token=` にはしない。** 鍵が履歴・ログ・串へ残る。
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is None:
            return None
        # **`_host_of(a) != _host_of(b)` と書かない。** 両方が読めないとき
        # 偽になり、**読めない URL への転送で鍵を持ち越す**（`I-20260831-73`）。
        if not same_host(newurl, req.full_url):
            # `Request` は鍵を大文字小文字を無視して持つので、両方消す。
            for name in ("Authorization", "authorization"):
                new.headers.pop(name, None)
                new.unredirected_hdrs.pop(name, None)
        return new


def _build_opener() -> Any:
    return urllib.request.build_opener(_DropAuthOnHostChange).open


def _under(path: str, root: str) -> bool:
    """`path` が `root` の下（または root そのもの）か。**大小と区切りを揃えて比べる。**"""
    prefix = os.path.abspath(str(root).replace("\\", "/")).rstrip("/\\").lower()
    full = os.path.abspath(str(path)).lower()
    return full == prefix or full.startswith(prefix + os.sep.lower())


def choose_model_dir(kind: str, paths: Sequence[str], root: str = "") -> Tuple[str, bool]:
    """落とす先を、**ComfyUI が知っている置き場の中から**選ぶ。

    Args:
        kind: 置き場の種類（`ALLOWED_KINDS`）。
        paths: `folder_paths.get_folder_paths(kind)` が返した並び。**先頭が既定。**
        root: 利用者が選んだ根。空なら先頭をそのまま使う。

    Returns:
        `(選んだ置き場, 根に合うものが在ったか)`。

    **並びの外は返さない。** 設定で受け取るのは「どれを選ぶか」であって
    「どこへ書くか」ではない。任意のパスを書ける形にすると、
    **ComfyUI が読まない場所へ落として「落ちているのに不足のまま」**になる
    ——その罠は転送の成功として現れるので、気づくのに時間がかかる
    （`tests/test_model_destination.py` が同じ罠を別の入口で見張っている）。

    合う置き場が無ければ**先頭へ戻す**。ただし戻したことは第2の返り値で伝える
    ——黙って戻すと「Forge へ入れたつもり」のまま気づけない。
    """
    if not paths:
        raise DownloadError(f"ComfyUI has no folder configured for {kind}", "setup")
    wanted = str(root or "").strip()
    if not wanted:
        return paths[0], True
    for path in paths:
        if _under(path, wanted):
            return path, True
    return paths[0], False


def _model_dir(kind: str, root: str = "") -> str:
    """ComfyUI が知っている置き場。**選べるのは、その並びの中だけ。**"""
    if kind not in ALLOWED_KINDS:
        raise DownloadError(f"unsupported kind: {kind}", "setup")
    try:
        import folder_paths  # type: ignore
    except ImportError as error:  # pragma: no cover - ComfyUI の外
        raise DownloadError("folder_paths is not available (not running inside ComfyUI)", "setup") from error
    paths = folder_paths.get_folder_paths(kind)
    chosen, matched = choose_model_dir(kind, paths, root)
    if not matched:
        # **黙って既定へ落とさない。** 落ちた先が違えば、次に探すのは
        # 「なぜ Forge に入っていないのか」で、ここを見に来る人は居ない。
        LOG.warning(
            "download_root %r has no %s folder that ComfyUI reads; using %r",
            root, kind, chosen,
        )
    return chosen


def safe_target(kind: str, filename: str, root: str = "") -> str:
    """置き先を組む。**API が返した名前を、そのまま繋がない。**"""
    base = os.path.basename(str(filename or "").replace("\\", "/")).strip()
    if not base or base in (".", ".."):
        raise DownloadError("the file name is empty", "setup")
    suffix = os.path.splitext(base)[1].lower()
    if suffix not in ALLOWED_SUFFIXES:
        # **`setup` と混ぜない。** 設定を見に行かせても直らない。
        raise DownloadError(
            f"unsupported file type: {suffix or base}", "unsupported")
    base_dir = _model_dir(kind, root)
    target = os.path.abspath(os.path.join(base_dir, base))
    # **必ず置き場の中であること。** basename を取ってあるので理屈では外れないが、
    # 理屈で守るとリンクや正規化の穴で破れる。実際のパスで確かめる。
    if os.path.commonpath([os.path.abspath(base_dir), target]) != os.path.abspath(base_dir):
        raise DownloadError("refusing to write outside the model folder", "setup")
    return target


def download_model(
    *,
    url: str,
    kind: str,
    filename: str,
    sha256: Optional[str] = None,
    expected_bytes: Optional[int] = None,
    api_key: str = "",
    on_progress: Optional[Callable[[int, Optional[int]], None]] = None,
    opener: Optional[Callable[..., Any]] = None,
    should_cancel: Optional[Callable[[], bool]] = None,
    root: str = "",
    target: Optional[str] = None,
) -> Dict[str, Any]:
    """モデルを1つ落とす。

    Args:
        target: 置き先を**呼び手が既に決めている**とき（伴走モデルは
            ComfyUI の `folder_paths` で解決済みの `folder` を持つ）。
            渡さなければ `safe_target(kind, filename, root)` が決める。
            **渡す側が ComfyUI の置き場から取ること**——ここは任意のパスを
            受ける口ではあるが、外から届く値を通す口ではない
            （画面が渡せるのは系統名だけで、パスは渡せない）。

    Returns:
        ``{"ok": True, "path": …, "bytes": …, "sha256": …, "elapsedMs": …}``

    Raises:
        DownloadError: 置き先が作れない・既にある・大きすぎる・hash が合わない
    """
    target = target or safe_target(kind, filename, root)
    if os.path.exists(target):
        # **上書きしない。** 同名の別物へ差し替えると、
        # 「同じ名前なのに別の絵が出る」という一番厄介な壊れ方をする。
        raise DownloadError(f"already there: {os.path.basename(target)}", "already")

    if expected_bytes is not None and expected_bytes > MAX_BYTES:
        raise DownloadError(f"too large: {expected_bytes} bytes", "space")

    # **置き場を先に作る**（2026-09-01・走査11周目）。
    #
    # ここは `shutil.disk_usage` が `os.makedirs` より**前**に在り、
    # ComfyUI が知っているだけでまだ存在しない置き場（`models/hypernetworks` など）
    # では **`FileNotFoundError` が生のまま抜けて**いた——`DownloadError` ではないので、
    # 呼び手の「理由で分ける」仕掛けを素通りする。
    #
    # **回避策は既に呼び手側に在った。** `routes.start_download` は
    # 「**枠を握ったまま落ちない**（`D-20260828-01` E3）。元は `DownloadError` しか
    # 受けていなかった。**置き場が未作成だと `shutil.disk_usage` が
    # `FileNotFoundError` を投げてここを素通り**し、`_downloads[key]` は永久に
    # `running` のまま残る」と書いて `except BaseException` を足している。
    # **真因はこちら側**で、直っていなかった（`workaround_hides_the_real_bug`）。
    #
    # 作るのは書く側の責任にする——`records.fetch_preview` が同じ判断を
    # 「**書く側が置き場を作る**」として先に済ませている。
    try:
        os.makedirs(os.path.dirname(target), exist_ok=True)
    except OSError as error:
        raise DownloadError(
            f"cannot create {os.path.dirname(target)}: {error}", "setup") from error

    if expected_bytes is not None:
        free = shutil.disk_usage(os.path.dirname(target)).free
        # **要るのは残りぶん**（2026-08-31・監査 I-20260831-26）。
        #
        # 既に `.part` へ落ちている分は**もうディスクを食っている**ので、
        # `free` はその分だけ減っている。全量で判定すると
        # 「全量 + 既に落とした分」を要求することになり、**再開が必要なときに
        # だけ拒否される**——31.9GB を 30GB まで落として切れた場合、残りは
        # 1.9GB なのに `free` は数GBしか無く `space` で止まる。押した人には
        # 「容量不足」としか出ず、`.part` を手で消す（＝30GB分を捨てる）以外に
        # 進む手が無い。**大きさの上限（`MAX_BYTES`）は全量のまま**——
        # 置き終わったときの姿は再開かどうかに関係しない。
        already = 0
        try:
            already = os.path.getsize(target + PART_SUFFIX)
        except OSError:
            already = 0
        remaining = max(0, expected_bytes - already)
        # 余裕を少し見る（書き込み中に他が埋めることがある）。
        if free < remaining * 1.1:
            raise DownloadError(f"not enough space: need {remaining}, free {free}", "space")

    started = time.monotonic()
    digest = hashlib.sha256()
    written = 0

    # **途中まで引いたものを、名前で見つけられるようにする。**
    #
    # 元は `mkstemp` の無作為な名前だったので、切れた瞬間に**続きの在処が判らなく
    # なった**——3.9GB の取得が途切れると最初からやり直しになる（実測で
    # チェックポイントは4GB前後、34GB のものも在る）。置き先から決まる名前にすれば、
    # 次に押したときに同じものを指せる。
    temp_name = target + PART_SUFFIX
    resume_from = 0
    if os.path.exists(temp_name):
        try:
            # **既に在る分を hash へ入れ直す。** ここを飛ばすと、
            # 落とし終わったときの照合が必ず落ちる（前半が digest に入っていない）。
            with open(temp_name, "rb") as prior:
                while True:
                    block = prior.read(CHUNK)
                    if not block:
                        break
                    digest.update(block)
                    resume_from += len(block)
        except OSError:
            # 読めないなら、続きにできない。**捨てて最初から**（黙って壊れた分を継がない）。
            _remove(temp_name)
            digest = hashlib.sha256()
            resume_from = 0
        written = resume_from

    headers = {
        "User-Agent": "ComfyUI-Unbake",
        **({"Authorization": f"Bearer {api_key}"} if _may_send_key(url, api_key) else {}),
    }
    if resume_from:
        headers["Range"] = f"bytes={resume_from}-"
    request = urllib.request.Request(url, headers=headers)

    # **追記で開く。** 続きが無いときは新規と同じ。
    handle = os.open(
        temp_name,
        # **追記では開かない。** 追記だと書き込み位置を戻せないので、続きを
        # 断られたときに**開き直すしかなくなる**——開き直すと `with stream` が
        # 使えず、閉じる位置が下の `except` の消す処理より後ろになり、
        # **Windows では `.part` を消せない**（実際にそう書いて、HTML を掴んだ
        # ときの控えが残った）。位置を決めて書く形なら、巻き戻しも切り詰めも
        # 同じ口のままできる。
        os.O_WRONLY | os.O_CREAT | (0 if resume_from else os.O_TRUNC),
    )
    # **開いた口はここで包む。** 元は ``with open_url(...) as response,
    # os.fdopen(handle, "wb") as stream:`` と1行で書いていたので、
    # **接続の側が先に落ちると `os.fdopen` に届かず、生の handle が開いたまま**に
    # なった。Windows では開いているファイルを消せないので ``_remove`` が
    # 黙って失敗し、``.part`` が置き去りになる——実測（2026-08-20）: 34GB の
    # 取得を取り消したあと、0バイトの ``.part`` が残っていた。
    stream = os.fdopen(handle, "wb")
    if resume_from:
        stream.seek(resume_from)
    try:
        open_url = opener or _build_opener()
        with stream, open_url(request, timeout=60) as response:
            # **HTML が返ってきたら、それはモデルではない。**
            #
            # Civitai の取得口は**鍵が無いとログインの画面へ流す**（早期公開や
            # 一部のモデルは、鍵が在っても持ち主の権限が要る）。ここを見ないと、
            # **ログイン画面の HTML が `.safetensors` として置き場へ入る**——
            # hash も大きさも渡されていない呼び方だと誰も気づけない。
            kind_header = ""
            if hasattr(response, "headers"):
                kind_header = str(response.headers.get("Content-Type") or "").lower()
            if kind_header.startswith("text/html"):
                raise DownloadError(
                    "the server returned a web page, not a model"
                    " (a Civitai API key is usually required)",
                    "forbidden",
                )
            # **`Range` を無視されたら、最初からやり直す。**
            #
            # 続きを頼んだのに `200` が返るのは「全部を送る」という意味なので、
            # そのまま追記すると**前半が二重になったファイル**ができる。
            # 大きさも hash も合わなくなるが、**合わない理由が判らない壊れ方**なので
            # ここで気づいて畳む。
            status = int(getattr(response, "status", 0) or getattr(response, "code", 0) or 200)
            if resume_from and status != 206:
                """**断られたら、そのまま最初から書き直す。**

                元は控えを消して失敗にしていた。だが `200` は「全部を送る」
                という意味なので、**送られてくる中身は正しい**——捨てて
                失敗にする理由が無い。

                実測（2026-08-26・Civitai の 31.9 GB のモデル）: 120MB まで
                落として止め、もう一度押すと `Range` を無視された。
                そこで**控えごと消えて「the server ignored the resume
                request; start over」で失敗**——止めた人から見ると、
                続きから引くつもりが**振り出しに戻ったうえに英語で断られる**。

                続きのつもりで書くと前半が二重になるので、**巻き戻して
                切り詰め、hash も数え直す。**
                """
                stream.seek(0)
                stream.truncate()
                digest = hashlib.sha256()
                written = 0
                resume_from = 0
            total = expected_bytes
            length = response.headers.get("Content-Length") if hasattr(response, "headers") else None
            if total is None and length:
                try:
                    # **`Content-Length` は残りの長さ。** 続きから引いているときに
                    # そのまま総量として出すと、進み具合が実際より進んで見える。
                    total = int(length) + resume_from
                except (TypeError, ValueError):
                    total = None
            while True:
                if should_cancel is not None and should_cancel():
                    raise DownloadError("canceled", "canceled")
                chunk = response.read(CHUNK)
                if not chunk:
                    break
                written += len(chunk)
                if written > MAX_BYTES:
                    raise DownloadError(f"too large: passed {MAX_BYTES} bytes", "space")
                digest.update(chunk)
                stream.write(chunk)
                if on_progress is not None:
                    on_progress(written, total)
    except urllib.error.HTTPError as error:
        # **404 / 401 / 403 は続きにしない。** 相手が「無い」「駄目」と言っている
        # ものを取っておくと、置き場に永久に残る。
        _remove(temp_name)
        # **番号で分ける。** 404 は「もう無い」、401/403 は「権限が要る」
        # ——押した人の打つ手が違う（前者は諦める、後者は鍵を確かめる）。
        status = int(getattr(error, "code", 0) or 0)
        kind = "gone" if status == 404 else ("forbidden" if status in (401, 403) else "network")
        raise DownloadError(f"HTTP {status}", kind) from error
    except urllib.error.URLError as error:
        # **通信で切れたものは残す。** ここが再開の要——消すと次も最初からになる。
        raise DownloadError(f"network: {error.reason}", "network") from error
    except DownloadError as error:
        # **人が止めたものも残す。** 押し直せば続きから引ける。
        # 中身が合わない・大きすぎるは残しても意味が無いので捨てる。
        if getattr(error, "code", "") not in ("canceled",):
            _remove(temp_name)
        raise
    except OSError as error:
        _remove(temp_name)
        raise DownloadError(f"{type(error).__name__}: {error}", "setup") from error

    got = digest.hexdigest()
    if sha256 and got.lower() != str(sha256).lower():
        # **合わなければ本物の名前へ置かない。** 置くと、切れたファイルが
        # 「落とし済み」に見えて、次に落とし直す機会が永久に来ない。
        _remove(temp_name)
        raise DownloadError(f"checksum mismatch: expected {sha256}, got {got}", "corrupt")
    if expected_bytes is not None and written != expected_bytes:
        """**大きさでハッシュの結論を覆さない**（2026-08-28 実機の報告）。

        報告された失敗:
            748cmSDXL.safetensors — size mismatch: expected 255017024, got 255025442

        実測で追った結果、**落ちてきた物は正しかった**:

            Civitai の `sizeKB`  249040.0625 → int(*1024) = 255,017,024
            実物                              255,025,442（差 8,418 バイト＝8.22 KB）
            Civitai の SHA256    85715EB6…F261A
            実物の SHA256        85715eb6…f261a（**一致**）
            手元で使っている同じ LoRA も 255,025,442 バイト

        つまり **Civitai の申告する大きさが 8KB ずれている**だけで、中身は本物。
        それを消していたので、**何度落とし直しても同じ所で失敗する**。

        この面には既に同じ決めごとが書いてある（下の `if not sha256:`）——
        **「ハッシュが在るときは呼ばない。一致していれば結論が出ており、
        それより弱い検査で覆してはならない。」** 大きさの検査だけが破っていた。

        ハッシュが無いときは大きさが唯一の手がかりだが、**短い側だけを疑う**。
        長い側は「相手の数字が古い」であって、壊れた証拠ではない。
        `sizeKB` は小数を持つので、KB→バイトの切り捨てで最大 1024 バイトずれる。
        """
        if sha256:
            LOG.info(
                "size differs from the API (%s vs %s) but the checksum matched; keeping it",
                expected_bytes, written,
            )
        elif written + SIZE_SLACK < expected_bytes:
            _remove(temp_name)
            raise DownloadError(
                f"size mismatch: expected {expected_bytes}, got {written}", "corrupt")
        else:
            LOG.info(
                "size differs from the API (%s vs %s); not short, so keeping it",
                expected_bytes, written,
            )
    if written == 0:
        _remove(temp_name)
        raise DownloadError("empty download", "corrupt")

    # **ハッシュが無いときは、中身の形を見る**（2026-08-26 に配線した）。
    #
    # 転送が 200 で終わったことは、**モデルが来たことを意味しない**。相手が
    # エラーページ（HTML）を返せば、それが `.safetensors` という名前で残る
    # ——一覧にも普通に並び、**実際に絵を作ろうとしたときに初めて落ちる**。
    # 上流（comfyui-lora-manager, GPL-3.0）が I-20260816-01 として踏んだ形。
    #
    # `classify_model_payload` は 185行の完成品なのに**どこからも呼ばれて
    # いなかった**（到達性の棚卸しで判明）。
    #
    # **ハッシュが在るときは呼ばない。** 一致していれば結論が出ており、
    # それより弱い検査で覆してはならない。
    if not sha256:
        from .utils.model_file_validation import PAYLOAD_BROKEN, classify_model_payload

        # **拡張子は本物の名前から取る。** 落とし途中の名前は
        # `…​.unbake-part` なので、渡さないと常に `unknown` になる
        # ——検査が在るのに何も見ていない状態になる。
        verdict = classify_model_payload(temp_name, written, name=target)
        # **`unknown` は不合格にしない。** 判る形でないだけで、
        # 「違う」という証拠ではない（拡張子に約束が無いものが在る）。
        if verdict.status == PAYLOAD_BROKEN:
            _remove(temp_name)
            raise DownloadError(
                f"the file is not a model: {verdict.reason}"
                " (the server probably returned an error page)",
                "corrupt",
            )

    os.replace(temp_name, target)
    return {
        "ok": True,
        "path": os.path.basename(target),
        "kind": kind,
        "bytes": written,
        "sha256": got,
        # **照合したかどうかを返す。** 照合していないのに「確かめた」と読ませない。
        "verified": bool(sha256),
        "elapsedMs": int((time.monotonic() - started) * 1000),
    }


def _remove(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass
