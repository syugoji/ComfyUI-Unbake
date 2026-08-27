"""記録の書庫。**設定されたフォルダを走査して、記録を並べる。**

Copyright (C) 2026 syugoji
SPDX-License-Identifier: GPL-3.0-or-later

これが入るまで、Unbake の一覧は**落としたものしか出せなかった**。346件を毎回
落とすわけにはいかないので、実際には使えない。ここが「自分のレシピが最初から出る」
状態を作る。

---

**フォルダが正。API は補助。**（2026-08-20 決定）

供給元は2つある。

1. **設定されたフォルダの ``*.recipe.json``**（LoRA Manager の recipes など）
2. 稼働中の LoRA Manager の API

2つ在ると、食い違ったときにどちらが正かを毎回決めることになる。決め方を実装の
あちこちに散らすと、**同じ記録が画面のどこで見たかによって別の値を持つ**という、
再現を扱う道具としては最悪の状態になる。だからここで1回だけ決める:

- **フォルダに在る記録は、フォルダの値をそのまま使う。API は一切上書きしない。**
- API が返した記録のうち、**フォルダに無い id だけ**を足す。
- 記録には必ず ``source`` を持たせる（``"folder"`` / ``"lora-manager"``）。
  **どこから来たかが読めなければ、食い違いは「無かったこと」になる。**

---

**参照画像はパスで渡さない。** ``?path=`` を受けると、それは走査対象の外へ
出られる口になる（``../``・UNC・シンボリックリンク）。ここは走査で作った索引を
持っているので、**画面へは id だけを渡し、パスの解決はこちら側でやる。**
塞ぐのではなく、渡さない。
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .settings import default_records_dir

#: 記録の本体。
RECIPE_SUFFIX = ".recipe.json"

#: Unbake 自身が保存した記録。**拡張子を分ける**——同じ `.recipe.json` で書くと、
#: LoRA Manager のレシピ置き場へ紛れ込んだときに向こうの一覧へ現れ、
#: 「Unbake はレシピ編集器ではない」という決めごとが実ファイルの側から崩れる。
#: 中身の形は同じなので、読む側は1本の要約器で足りる。
UNBAKE_SUFFIX = ".unbake.json"

#: 走査で拾う拡張子。**長い方を先に見る**——`.json` で終わる2つを扱うので、
#: 短い方から当てると id の切り出しがずれる。
RECORD_SUFFIXES = (RECIPE_SUFFIX, UNBAKE_SUFFIX)


def suffix_of(name: str) -> Optional[str]:
    """記録として扱う拡張子。当てはまらなければ ``None``。"""
    text = str(name or "")
    for suffix in RECORD_SUFFIXES:
        if text.endswith(suffix):
            return suffix
    return None

#: 対の参照画像として認める拡張子。**先に見つかった1つを使う。**
PREVIEW_SUFFIXES = (".webp", ".png", ".jpg", ".jpeg")

#: 1回の走査で読むファイル数の上限。**無制限にしない**——設定を打ち間違えて
#: ドライブの根を指したときに、起動が終わらなくなる。
MAX_FILES = 20000


class RecordLibrary:
    """設定されたフォルダの記録を索引する。"""

    def __init__(self, settings) -> None:
        self._settings = settings
        self._index: Dict[str, Dict[str, Any]] = {}
        self._scanned = False
        self.scan_errors: List[str] = []

    # -- 走査 ---------------------------------------------------------

    def source_dirs(self) -> List[Path]:
        """読み取り元。**保存先は含めない**——分けたのが決定なので、
        ここで混ぜると分けた意味が消える。呼び手が明示的に足す。
        """
        raw = self._settings.get("record_source_dirs", []) or []
        if isinstance(raw, str):
            raw = [raw]
        out: List[Path] = []
        for item in raw:
            text = str(item or "").strip()
            if not text:
                continue
            path = Path(text)
            if path not in out:
                out.append(path)
        return out

    def output_dir(self) -> Optional[Path]:
        """Unbake が書いた記録の置き場。**設定が空でも `None` にしない。**

        空を `None` にしていたせいで、**保存はできるのに走査がそこを見ず、
        ディスクに在る記録が一覧へ一度も出てこなかった**（2026-08-22 実機で判明。
        node の検査は毎回 `record_output_dir` を明示していたので全部緑だった）。
        既定は `settings.default_records_dir()` で、書く側と同じ1箇所から取る。
        """
        text = str(self._settings.get("record_output_dir", "") or "").strip()
        return Path(text) if text else default_records_dir()

    def output_dir_is_default(self) -> bool:
        """置き場が既定か（＝利用者が設定していないか）。

        **既定のフォルダが無いことは異常ではない。** 一度も保存していなければ
        存在しないので、走査の失敗として数えると「設定したのに0件」の理由を
        読む欄が、毎回この1行で埋まる。"""
        return not str(self._settings.get("record_output_dir", "") or "").strip()

    def scan(self, *, include_output: bool = True) -> "RecordLibrary":
        """索引を作り直す。**読めなかったものを黙って捨てない。**"""
        self._index = {}
        self.scan_errors = []
        seen_files = 0

        roots = list(self.source_dirs())
        output = self.output_dir()
        if include_output and output is not None and output not in roots:
            roots.append(output)

        for root in roots:
            if not root.is_dir():
                # **既定の置き場が無いのは異常ではない**（一度も保存していないだけ）。
                # ここを失敗として数えると、理由の欄が毎回この1行で埋まる。
                if root == output and self.output_dir_is_default():
                    continue
                # **「設定したのに0件」の理由が読めるようにする。**
                self.scan_errors.append(f"{root}: フォルダが見つかりません")
                continue
            try:
                entries = sorted(os.scandir(root), key=lambda e: e.name)
            except OSError as error:
                self.scan_errors.append(f"{root}: {type(error).__name__}: {error}")
                continue
            for entry in entries:
                if seen_files >= MAX_FILES:
                    self.scan_errors.append(
                        f"{root}: 上限 {MAX_FILES} 件で打ち切りました（設定を絞ってください）"
                    )
                    break
                if not entry.is_file() or suffix_of(entry.name) is None:
                    continue
                seen_files += 1
                path = Path(entry.path)
                record_id, summary = _summarize(path)
                if record_id is None:
                    self.scan_errors.append(f"{entry.name}: {summary}")
                    continue
                # 同じ id が2つの元に在るときは**先に出た方を残す**（設定の並び順が優先）。
                if record_id in self._index:
                    continue
                summary["source"] = "output" if (output is not None and path.parent == output) else "folder"
                # **書いた主体を残す。** 削除の口はこれを見て、
                # 「Unbake が書いたもの」と「LoRA Manager が書いたもの」を
                # 画面へ別のものとして出す（消せるかどうかではなく、**何を消すのか**が違う）。
                summary["owner"] = "unbake" if path.name.endswith(UNBAKE_SUFFIX) else "lora-manager"
                summary["preview"] = _preview_for(path) is not None
                self._index[record_id] = summary
        self.fill_base_models()
        self._scanned = True
        return self

    def fill_base_models(self, lookup=None) -> int:
        """記録が持っていない土台のモデルを、**手元のモデルの情報から補う**。

        **推測はしない。** LoRA Manager がモデルの隣へ置いた
        ``<モデル>.metadata.json`` の ``base_model`` をそのまま読む
        ——実測（2026-08-25・350件）で17件が ``base_model`` を持たず、
        タイル左上の札が空のままだった。そのうち ``hassakuXLIllustrious_v13StyleA``
        と ``waiIllustriousSDXL_v150`` は、**手元の metadata が両方とも
        ``"Illustrious"`` と書いていた**——名前から当てる必要は無かった。

        補った行には ``base_model_source`` を残す。**記録が持っていた値と、
        こちらが後から足した値を混ぜない**ため（記録を書き換えてはいない）。

        Args:
            lookup: 名前→土台のモデルを返す関数（検査用の差し替え口）。

        Returns:
            補えた件数。**0 は「引けなかった」と「そもそも欠けていない」の両方**
            なので、呼び手が意味を決める。
        """
        if lookup is None:
            from . import model_index

            lookup = model_index.base_model_for
        filled = 0
        for row in self._index.values():
            if str(row.get("base_model") or "").strip():
                continue
            name = row.get("checkpoint")
            if not name:
                continue
            try:
                value = lookup(name)
            except Exception:  # pragma: no cover - 索引側の事情で一覧を落とさない
                continue
            if not value:
                continue
            row["base_model"] = str(value)
            row["base_model_source"] = "model-index"
            filled += 1
        return filled

    def _ensure(self) -> None:
        if not self._scanned:
            self.scan()

    # -- 取り出し -----------------------------------------------------

    #: 画面へ渡さない鍵。**索引の中では要るが、外へ出す理由が1つも無い。**
    #:
    #: 実測（2026-08-20・稼働中の口）で ``/unbake/records`` は
    #: **346行すべてに絶対パス**を載せて返していた
    #: （``D:\AI\forge\webui\models\Lora\recipes\...``）。
    #: 参照画像を id でしか引けなくした（``?path=`` を作らなかった）のと同じ理由で、
    #: **パスは渡さない**。渡してしまえば、塞いだ口の外側から同じ情報が読める。
    INTERNAL_KEYS = ("path",)

    def summaries(self, *, offset: int = 0, limit: int = 200) -> Tuple[List[Dict[str, Any]], int]:
        """一覧用の要約。**本体は返さない**——346件ぶんのグラフを1回で
        送ると数十MBになり、画面が固まる。必要になった1件だけ本体を取る。

        **内部だけの鍵を落としてから返す。** 索引は実体のパスを持っているが、
        画面はそれを一度も使わない（本体も参照画像も id で引く）。
        """
        self._ensure()
        rows = sorted(self._index.values(), key=lambda row: (-(row.get("modified") or 0), row["id"]))
        total = len(rows)
        start = max(0, int(offset))
        end = start + max(0, int(limit))
        return [self._public(row) for row in rows[start:end]], total

    def _public(self, row: Dict[str, Any]) -> Dict[str, Any]:
        """外へ出してよい形。**元の行は書き換えない**（索引が壊れる）。

        """
        out = {key: value for key, value in row.items() if key not in self.INTERNAL_KEYS}
        return out

    def rows(self) -> List[Dict[str, Any]]:
        """索引の全行。**数えるための口。**

        「このモデルを何件が使っているか」は**画面に出ているかとは無関係**
        ——絞り込みで消えている記録を数から落とすと、
        消してよい件数が実際より少なく見える。
        """
        self._ensure()
        return list(self._index.values())

    def raw_row(self, record_id: str) -> Optional[Dict[str, Any]]:
        """索引の行そのもの。**`path` を持つ唯一の口。**

        画面へは出さない（`_public` が落としている）。使うのは
        ディスクを触る側——消す前に「どのファイルか」を確かめるのに要る。
        呼び手はここで得たパスを**そのまま消さず、走査対象の中に在ることを
        確かめてから**消すこと（`records.delete_record` がやっている）。
        """
        self._ensure()
        row = self._index.get(str(record_id))
        return dict(row) if row is not None else None

    def forget(self, record_id: str) -> bool:
        """索引から1件落とす。**ディスクは触らない。**

        消した直後に走査し直すと 346件を読み直すことになるので、
        消せたことが分かっている1件だけを索引から外す。
        """
        return self._index.pop(str(record_id), None) is not None

    def record(self, record_id: str) -> Optional[Dict[str, Any]]:
        """記録の本体。無ければ None。"""
        self._ensure()
        row = self._index.get(str(record_id))
        if row is None:
            return None
        try:
            data = json.loads(Path(row["path"]).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if isinstance(data, dict):
            data.setdefault("id", record_id)
        return data

    def preview_path(self, record_id: str) -> Optional[Path]:
        """参照画像の実体。**索引に在る記録の対だけを返す。**

        画面から届くのは id だけで、パスは一切受け取らない。走査した記録の
        隣に在るファイルしか返さないので、``../`` を組み立てる余地が無い。

        """
        self._ensure()
        row = self._index.get(str(record_id))
        if row is None:
            return None
        return _preview_for(Path(row["path"]))

    def known_ids(self) -> List[str]:
        self._ensure()
        return list(self._index)

    def add_supplement(self, rows: List[Dict[str, Any]]) -> int:
        """LoRA Manager から来た記録のうち、**フォルダに無い id だけ**を足す。

        **上書きはしない。** フォルダが正という決めごとがここで守られる。
        戻り値は実際に足した件数（0 なら補助は何も足していない、と言える）。
        """
        self._ensure()
        added = 0
        for row in rows or []:
            record_id = str(row.get("id") or "").strip()
            if not record_id or record_id in self._index:
                continue
            self._index[record_id] = {
                "id": record_id,
                "title": str(row.get("title") or record_id),
                "path": None,
                "modified": row.get("modified"),
                "source": "lora-manager",
                "owner": "lora-manager",
                "preview": False,
                "base_model": row.get("base_model"),
                "lora_count": len(row.get("loras") or []),
                # **形を揃える。** フォルダ由来と同じ鍵を持たせないと、画面側が
                # 「無い」と「そもそも来ていない」を区別できない。補助由来には
                # 手作業の値が付かないので、全部 None を明示する。
                "has_graph": False,
                "has_ui_graph": False,
                "civitai_image_id": None,
                "favorite": False,
                "license": None,
                "commercial_ok": None,
                "license_source_url": None,
                "license_checked_at": None,
                "preview_nsfw_level": None,
            }
            added += 1
        return added


def _is_api_graph(value) -> bool:
    """API 形式のグラフか。**こちらが書いた記録は `prompt` に持つ。**

    上流のレシピは `comfy_prompt` に持つが、ComfyUI の出力を落とし込んで作った
    記録は PNG の `prompt` チャンクをそのままこの名前で持つ。片方しか見ていな
    かったので、**ノード13個の完全なグラフを持つ記録が `has_graph: false` と
    出ていた**（2026-08-23 利用者の指摘）。

    **文字列のプロンプトを取り違えない。** 値が全部 `class_type` を持つ
    ときだけグラフと認める。
    """
    if not isinstance(value, dict) or not value:
        return False
    return all(isinstance(node, dict) and "class_type" in node for node in value.values())


def _is_ui_graph(value) -> bool:
    """画面へそのまま開ける形か。**`nodes` の並びを持つ。**"""
    return isinstance(value, dict) and isinstance(value.get("nodes"), list)


def _gen_from_record_shape(data: Dict[str, Any]) -> Dict[str, Any]:
    """条件が直下に在る記録から、レシピと同じ形の辞書を作る。

    **名前が違うだけのものを揃える**（記録は ``cfg``、レシピは ``cfg_scale``）。
    無い項目は入れない——``None`` を並べると「在るが空」と見分けが付かない。
    """
    width = data.get("width")
    height = data.get("height")
    gen: Dict[str, Any] = {}
    for target, source in (
        ("prompt", "positive"),
        ("negative_prompt", "negative"),
        ("seed", "seed"),
        ("steps", "steps"),
        ("cfg_scale", "cfg"),
        ("sampler", "sampler"),
        ("scheduler", "scheduler"),
    ):
        value = data.get(source)
        if value is not None and value != "":
            gen[target] = value
    if isinstance(width, int) and isinstance(height, int) and width > 0 and height > 0:
        gen["size"] = f"{width}x{height}"
    return gen


def _summarize(path: Path) -> Tuple[Optional[str], Any]:
    """1件ぶんの要約。読めなければ ``(None, 理由)``。"""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        return None, f"{type(error).__name__}: {error}"
    except ValueError as error:
        return None, f"JSON: {error}"
    if not isinstance(data, dict):
        return None, "JSON: 最上位がオブジェクトではない"

    suffix = suffix_of(path.name) or RECIPE_SUFFIX
    record_id = str(data.get("id") or path.name[: -len(suffix)]).strip()
    if not record_id:
        return None, "id が無い"

    gen = data.get("gen_params") if isinstance(data.get("gen_params"), dict) else {}
    if not gen:
        # **こちらが画像から作った記録は、条件が直下に在る。**
        #
        # 記録の形（`positive` / `seed` / `cfg` / `width` が直下）と
        # レシピの形（`gen_params` にまとまる）の2つが在り、ここは
        # **レシピの形しか読めなかった**。そのため自作 PNG を取り込むと、
        # 一覧の行だけが seed も steps も空になり、
        #   * 判定が実際より低く出る（読み直すと上がる＝食い違いが見える）
        #   * その行から再現を押しても、条件が無いので絵が出ない
        # という形で表に出た（2026-08-24 実機 `ComfyUI_00444_`）。
        # **境界で1度だけ揃える**（JS 側の `toRecipeShape` と同じ考え）。
        gen = _gen_from_record_shape(data)
    checkpoint = data.get("checkpoint")
    checkpoint_name = None
    if isinstance(checkpoint, dict):
        # **`modelName` も読む。** 実データに `{modelName, type}` だけを持つ記録が在り
        # （`Civitai_Recipe_115941302`）、ここが空になると帰属の突き合わせで
        # **一番強い手掛かりが「未知」として飛ばされる**——別の土台で出た絵が
        # 7枚ぶら下がっていた。本体側（`outputFingerprint`）と同じ順で読む。
        checkpoint_name = (
            checkpoint.get("file_name")
            or checkpoint.get("name")
            or checkpoint.get("modelName")
        )
    elif isinstance(checkpoint, str):
        checkpoint_name = checkpoint

    try:
        modified = path.stat().st_mtime
    except OSError:
        modified = None

    return record_id, {
        "id": record_id,
        "title": str(data.get("title") or record_id),
        "path": str(path),
        "modified": data.get("modified") or modified,
        "base_model": data.get("base_model"),
        "checkpoint": checkpoint_name,
        "lora_count": len(data.get("loras") or []),
        # **グラフを持っているか。** 持っていれば「捕捉」、無ければ「組む」必要がある
        # ——実測で持っているのは 346件中 48件（14%）だけなので、一覧で見分けたい。
        "has_graph": bool(data.get("comfy_prompt")) or _is_api_graph(data.get("prompt")),
        # **UI グラフは別の列にする。** ``comfy_prompt`` は API 形式のグラフで、
        # ``comfy_workflow`` は ComfyUI の画面へそのまま開ける形。実データ346件では
        # 前者48件・後者36件で、**36件は両方持っている**（後者だけを持つ記録は0件）。
        # だから2つを OR で潰すと ``has_graph`` は48のままで、**画面に開ける36件を
        # 見分けられない**という元の問題が何も解けない。列を分けるのが答え。
        "has_ui_graph": bool(data.get("comfy_workflow")) or _is_ui_graph(data.get("workflow")),
        "seed": gen.get("seed"),
        "prompt": str(gen.get("prompt") or "")[:400],
        # --- 指紋が比べる項目 ----------------------------------------------
        #
        # **要約を2回目に広げた理由。** 出た絵を記録へ帰属させるとき、画面が
        # 持っているのはこの要約だけである。ここに比べる項目が無いと、
        # 比べられる本数が1本しか無くて**帰属が全件0になる**——実際にそうなった
        # （node で3,065枚を推定できたのに、画面では0枚だった。**検査に
        # フルのレシピを渡していて、製品が渡している形と違った**）。
        #
        # 選んだのは、正解つきの対で一致率が高かった4本と、識別に効く LoRA。
        # `steps` 98.8% / `cfg_scale` 96.4% / `sampler` 96.4% / `loras` 77.1%。
        "steps": gen.get("steps"),
        "cfg_scale": gen.get("cfg_scale"),
        "sampler": gen.get("sampler"),
        "size": gen.get("size"),
        "negative_prompt": str(gen.get("negative_prompt") or "")[:400],
        # **本体は送らない**ので、名前と効き目だけ。
        "loras": [
            {
                "file_name": lora.get("file_name") or lora.get("name"),
                "strength": lora.get("strength_model", lora.get("strength")),
            }
            for lora in (data.get("loras") or [])
            if isinstance(lora, dict)
        ],
        # **出典の画像ID。** Raindrop の一覧から「もう取り込んだか」を判断するのに要る。
        # **URL そのものは出さない**（要約に長い文字列を増やさない）。実データ346件の
        # うち340件が `civitai.(com|red)/images/<id>` の形で出典を持つ。
        "civitai_image_id": _civitai_image_id(data.get("source_path")),
        # **出典の URL も返す**（2026-08-26 の実機検証で必要になった）。
        #
        # 元は「要約に長い文字列を増やさない」として画像IDだけにしていたが、
        # そのせいで**画面の記録は出典を1つも持たない**（`origin.url` が
        # 常に `null`）状態だった。結果、URL を開く口は一度も出ず、
        # 「出典から読み直す」も対象0件で終わった。
        # 実データで1件あたり 45文字ほど・200行で 9KB 程度なので、
        # 落とすことによる害の方が大きい。
        "source_path": data.get("source_path") or None,
        # --- 利用者が既に払った手作業 --------------------------------------
        # **ここが「ディスク → 画面」の関所。** 下の5項目はディスクの
        # ``*.recipe.json`` に既に入っているのに、要約が12項目しか返さないせいで
        # 画面に一度も届いていなかった（実測: ``favorite: true`` 64件・
        # ライセンス4列 各345件・NSFW格付け344件）。
        #
        # **判定はしない・出すだけ。** ライセンスも格付けも供給元は LoRA Manager と
        # 外部スクリプトで、Unbake は分類器を持たない。だから ``license_checked_at``
        # を必ず一緒に返す——**いつの分類かが読めない値は、読んだ人を誤らせる**
        # （実データは345件すべて 2026-08-14 の一度きり）。
        "favorite": bool(data.get("favorite")),
        "license": _clip(data.get("license"), 200),
        "commercial_ok": _text_or_none(data.get("commercial_ok")),
        "license_source_url": _text_or_none(data.get("license_source_url")),
        "license_checked_at": _text_or_none(data.get("license_checked_at")),
        # 数値のまま返す（閾値で比べるのは画面側）。**無いことを 0 にしない**
        # ——0 は「安全と判定された」で、None は「一度も判定されていない」。
        # 混ぜると、格付けの無い記録が全部「安全」に化ける。
        "preview_nsfw_level": _level_or_none(data.get("preview_nsfw_level")),
    }


def _civitai_image_id(source_path: Any) -> Optional[str]:
    """出典 URL から画像 ID を取り出す。**ドメインは `.com` / `.red` の両方。**"""
    match = re.search(r"civitai\.(?:com|red)/images/(\d+)", str(source_path or ""))
    return match.group(1) if match else None


def _clip(value: Any, limit: int) -> Optional[str]:
    """長い文言を要約向けに切る。**空は None**（空文字と未設定を混ぜない）。"""
    text = str(value or "").strip()
    if not text:
        return None
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _text_or_none(value: Any) -> Optional[str]:
    text = str(value or "").strip()
    return text or None


def _level_or_none(value: Any) -> Optional[int]:
    """格付けは数値だけ受ける。**読めない値を 0 に丸めない。**"""
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _preview_for(recipe_path: Path) -> Optional[Path]:
    """``<name>.recipe.json`` / ``<name>.unbake.json`` の対になる画像。"""
    suffix = suffix_of(recipe_path.name) or RECIPE_SUFFIX
    stem = str(recipe_path)[: -len(suffix)]
    for suffix in PREVIEW_SUFFIXES:
        candidate = Path(stem + suffix)
        if candidate.is_file():
            return candidate
    return None
