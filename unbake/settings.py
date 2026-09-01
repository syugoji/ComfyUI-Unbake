"""設定の保管。**秘密の値は書けるが読み出せない。**

Copyright (C) 2026 syugoji
SPDX-License-Identifier: GPL-3.0-or-later

置き場は ComfyUI の user ディレクトリ。**リポジトリの中には置かない**
——置くと、設定した瞬間にトークンが git の管理下へ入る。

この層の要点は1つで、**秘密の値を HTTP へ返さない**ことである。

画面から「入っているかどうか」は分かる必要があるが、**値そのものは要らない。**
返すと、

- ブラウザの開発者ツール・拡張・同じページで動く他のカスタムノードから読める
- 画面の状態としてメモリに残り、スクリーンショットや録画に写る
- 「一度入れた鍵を確認のために表示する」という導線が、そのまま漏洩経路になる

ので、:func:`public_view` は ``{"set": true, "length": 40}`` の形しか出さない。
Python 側のサービス（Raindrop 同期など）は :meth:`FileSettings.get` で生の値を
取れる——**プロセスの中と外で見える範囲を変える**のがこの分け方の全部である。

**「設定されていない」と「空文字を設定した」を混ぜない。** 混ぜると、
消したつもりの鍵が残っているのか消えたのかが画面から判らなくなる。
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any, Dict, Iterable, Optional
from .utils.json_io import dump_json_strict, dumps_json_strict

try:  # ComfyUI 本体が提供する。
    import folder_paths  # type: ignore
except ImportError:  # pragma: no cover - ComfyUI の外で読まれたとき
    folder_paths = None  # type: ignore

#: HTTP へ生の値を出さない鍵。**ここへ足し忘れると黙って漏れる**ので、
#: 新しい鍵を足すときは必ず :data:`KNOWN_KEYS` と一緒に見ること。
SECRET_KEYS = frozenset({"raindrop_token", "civitai_api_key"})

#: 画面が設定できる鍵と、その既定値。**知らない鍵は保存しない**
#: ——受け取ったものを何でも書くと、設定ファイルが野放図に育つ。
KNOWN_KEYS: Dict[str, Any] = {
    # 記録の読み取り元（複数可）。LoRA Manager の recipes フォルダなど。
    "record_source_dirs": [],
    # Unbake が作った記録の保存先。**読み取り元とは分ける。**
    "record_output_dir": "",
    # 外部サービス。
    "civitai_api_key": "",
    "raindrop_token": "",
    "raindrop_collection_id": "",

    # **`donate_url` は置かない**（2026-08-24 に撤去）。
    #
    # 送り先が決まり、**通しで実測して通った**（支払い・着金とも2本）ので、
    # 設定で持つ理由が消えた。**空にできる欄を残すほうが害**——
    # 「まだ決めていない」という嘘の状態を作れてしまう。
    # 送り先は `web/panel/donateView.js` の表が持つ（フォークはそこを書き換える）。
    #
    # 実測（US$1 あたり）: ko-fi $0.61 / PayPal 直リンク $0.66。差の $0.05 は ko-fi の取り分5%。
    # 「支援が0だった」を「需要が0だった」と読まないこと自体は変わらない。詳しくは `D-20260820-03`。

    # --- 表示（工程4・裁定⑥）------------------------------------------
    #
    # **モードを足さない。** 「compact モード」のような切替を作ると、
    # 密度が2つの実装に割れて「同じコンポーネントを両方の器へ差す」が崩れる。
    # ここは**閾値**で持つ——器の幅がこれを下回ったら詰める、という1本の規則。
    "compact_width": 520,
    # **行数の上限は 2026-08-25 に撤去した**（利用者の判断）。既定は 0＝「切らない」で、
    # 正の数にすると**利用者が一度嫌った挙動**（途中で切って残りを全画面へ送る）へ
    # 戻すだけの設定だった。狭いときも全部描いて、器の中でスクロールさせる。

    # **成人向けの関門は 2026-08-25 に撤去した**（利用者の判断）。
    # 手元の記録を画面へ送るかどうかだけを止める仕掛けで、Civitai API とは
    # 無関係だった（API へは常に ``nsfw=X`` を付けて完全な結果を取っている）。
    # 既定は開いたままだったので、外しても動きは変わらない。
    # 戻すなら: `mature_gate_level` / `mature_unrated_policy` と
    # `RecordLibrary.is_gated` を復活させる（git 履歴に残してある）。

    # 商用可否を一覧に出すか。**出すときは判定日を必ず併記する**
    # （345件すべて 2026-08-14 の一度きりの分類なので、日付が無いと
    # 「今の分類」と読まれる）。
    "show_commercial_ok": True,

    # 消えたモデルを、受け皿（civarchive.com）から拾い直すか。**既定は OFF。**
    #
    # 2026-08-26 利用者の指示。切ってある理由を書いておく——**既定に戻せる
    # ようにするには、なぜ切ってあるかが判っている必要がある。**
    #
    # 1. **第三者へ問い合わせが飛ぶ。** どの版を探しているかが Civitai では
    #    ない相手に伝わる。既定で外へ増やさない。
    # 2. **作者が意図的に消したものが含まれる。** 消した理由はこちらからは
    #    判らない。拾い直すかは使う人が決める。
    # 3. **落とす相手が増える**（`huggingface.co`）。「知らない相手からは
    #    落とさない」という約束を、開けると決めた人の環境だけで緩める。
    # 「落とせば試せる」ものだけを見る絞り込み（2026-08-26 利用者の指示）。
    # お気に入りと同じく**開き直しても覚えている**——同じ帯に並んでいる
    # 操作なのに片方だけ忘れるのは揃わない。
    "downloadable_only": False,

    # ノードが要る記録だけを見る絞り込み（2026-08-28 利用者の指示）。
    # モデルの絞り込みと**別に持つ**——打つ手が違うので、混ぜると
    # 「落としたのに直らない」を探すことになる。
    "needs_node_only": False,

    "use_civarchive": False,

    # 消す前に確認を出すか。**既定は出す。**
    #
    # 「二度と表示しない」を選べるようにしたのは利用者の指示（2026-08-22）だが、
    # **切ったことを取り消せる場所が要る**ので、ここを設定として持つ
    # ——確認そのものの中でしか切り替えられないと、切った瞬間に戻す口が消える。
    #
    # **切っても結果は黙らせない。** 確認を出さないことと、何が起きたかを
    # 伝えないことは別で、消したものは履歴へ必ず出す。
    "confirm_before_delete": True,

    # 再現の後に見比べの面を自分から開くか（2026-08-28 利用者の指示・既定は開く）。
    #
    # **切るのは「勝手に開く」だけ。** 絵を押して開く道は切らない
    # ——あれは押した人が今それを見たいと言っているので、設定で塞ぐ物ではない。
    #
    # **切っても黙らない。** 作り直していない回は見比べを開くことが唯一の答え
    # だったので、切ってあるときは下へ一言出して「もう1枚出す」へ案内する。
    "show_compare": True,

    # お気に入り。**上流の `.recipe.json` は書き換えない**ので、印はこちらに持つ。
    # 上流が既に立てている印は尊重し、こちらの印と OR で見る。
    "favorite_ids": [],
    # **外した印。** 上流が立てているぶんを打ち消す名簿
    # （2026-08-22 利用者の指示で「上流の印も外せる」ようにした）。
    #
    # **ここへ書き忘れると、外れたように見えて次の走査で戻る。** 知らない鍵は
    # 保存しない規則なので、画面が送っても**黙って捨てられる**——実際にそうなり、
    # 「チェックを外してもお気に入り表示が消えない」と報告された。
    "unfavorite_ids": [],

    # 見た目のテーマ。暗い4つ（宿主・琥珀・朱・苔）と明るい1つ（紙）。
    #
    # **既定は宿主に合わせる**（2026-08-22 利用者の指示）。ComfyUI と LoRA Manager が
    # 黒×青なので、その中に置かれる面が別系統の色だと浮く。元の既定（琥珀）は
    # `amber` として残してあり、選び直せる。
    "theme": "host",

    # 判定の色。``"default"`` は緑／橙／赤。
    # ``"deuteranopia"`` は**青／黄／赤**——緑と赤が同じに見える人が最も多く
    # （日本人男性の約5%）、その2色で「再現できる／できない」を分けていた。
    # 明るさも変えてあるので、白黒の画面でも順序が読める。
    "verdict_palette": "default",

    # お気に入り・「落とせば試せる」にも色帯を出すか。**既定は切**
    # （2026-08-26 利用者の指示）。判定の3色に黄と青が加わると一覧が
    # 賑やかになる。切っていても印（★ / ⤓）と件数は出るので、
    # **読めなくなるものは無い。**
    "extra_bands": False,

    # 一覧の見せ方。**モードではなく器**——記録も絞り込みも並びも共通で、
    # 変わるのは並べ方だけ（密度は今までどおり器の幅が決める）。
    # ``"table"`` = 字で比べる ／ ``"tiles"`` = 絵で選ぶ。
    #
    # **既定はタイル**（2026-08-28 利用者の指示）。この道具で最初にすることは
    # 「どの記録を再現するか選ぶ」で、**選ぶ手掛かりは絵**である。
    # 表は名前と判定で**比べる**ための器なので、後から切り替えれば足りる。
    #
    # **既に切り替えた人は変わらない**——保存された値が優先されるので、
    # ここが効くのは**入れたばかりの環境**だけ。
    "list_view": "tiles",

    # 不足モデルを落とす先の根（2026-08-28 利用者の指示・空＝ComfyUI の既定）。
    #
    # **任意のパスではない。** ここで指定するのは「ComfyUI が知っている置き場の
    # うち、どれを選ぶか」で、合う置き場が無ければ既定へ戻る（戻したことは記録へ出す）。
    # 任意の場所へ書ける形にすると、**ComfyUI が読まない所へ落として
    # 「落ちているのに不足のまま」**になる——転送は成功するので気づきにくい。
    #
    # 例: Forge と共有しているなら ``D:/AI/forge/webui``。
    # その置き場が `extra_model_paths.yaml` で ComfyUI に登録されていることが前提。
    "download_root": "",
    # タイルの**大きさ**。0 は「幅に合わせる」（既定）、1 が最大で 4 が最小。
    #
    # **列数ではなく大きさで持つ。** 列数で固定すると、全画面で横に広げたときに
    # 1枚が際限なく大きくなるか、右が余るかのどちらかになる（実機で後者が起きた）。
    # 大きさで持てば、**広い画面では列が自動で増える**——1枚の見え方は変わらない。
    "tile_size": 0,

    # 拡張機能 Dark Reader に「このページは自前で暗い」と伝えるか（2026-08-24）。
    #
    # **実測で色が書き換えられていた**——後ろ布は ``rgba(8,5,3,0.18)`` の指定に対して
    # ``rgb(74,81,83)``（不透明のグレー）、箱は ``#212124`` に対して ``rgb(30,32,33)``。
    # 半透明の重ねが潰れるので、**重ねた面が「背景が単色」に見える**。
    # CSS では直せない（どんな色を書いても同じ変換を受ける）。
    #
    # **⚠️ 効く範囲は ComfyUI 全体**——``<meta>`` は文書に1つしか無い。
    # 明るいテーマの ComfyUI を Dark Reader で暗くして使っている人は、ここを切る。
    "disable_dark_reader": True,

    # 見た目を厚くするか（2026-08-24 利用者の指示）。
    #
    # **切れることを先に決めてから足した。** 影・浮き上がり・動きは
    # 好みが割れるうえ、**弱い機械では動きが素直に重さになる**。
    # 旗を1本にして、リッチな指定を全部その下へ閉じ込めてある
    # ——切ったときの見た目が「元のまま」であることを、構造で保証するため。
    "rich_ui": True,

    # 画面の作り（2026-08-25 利用者の指示）。
    #
    # ``classic`` = 今までの面（平らな紙に線で仕切る）。
    # ``prism``   = テーマ2（暗い硝子の層を重ね、光で仕切る）。
    #
    # **既定は classic のまま。** テーマ2は「却下する可能性がある」前提で
    # 作ったので、選ばれていない間は**紙も読み込まない**——捨てるときは
    # この項目と ``web/panel/skin*.js|css`` を消せば跡が残らない。
    # **ここに許可一覧を持たない。** ``theme`` などと違い、この値は素の文字列として
    # 預かるだけで、正誤の判定は画面側（``web/panel/skin.js`` の ``SKINS``）が持つ。
    # 二重に持つと**紙を足した日に片方だけ増えて**、選んでも効かない状態になる
    # ——実際、テーマ3・4はこの作りのおかげで**再起動なしで**選べるようになった。
    # 知らない値は画面側が ``classic`` へ倒すので、綴り違いで面が消えることも無い。
    "ui_skin": "classic",

    # サイドバーを**重ねて**出すか（2026-08-25 利用者の指示）。
    #
    # ComfyUI は自分の器（``.side-bar-panel``・実測 v1.42.15 で
    # ``min-width: 312px`` / ``width: 370px``）へ面を差し込み、その器が
    # **横の並びで場所を取る**——だから広げると Job Queue などが切れる。
    # 入れると器を並びから外して重ねるので、**右端は動かない**。
    # 左のツール群の上には被らない（Unbake を閉じる釦が消えるため）。
    "sidebar_overlay": True,

    # 重ねたときの幅(px)。**0（や未設定）は窓に合わせる**
    # （``clamp(320px, 42vw, 720px)``）。中身の最小幅は 285px で、
    # それを割る値は受けない——器だけ細くなって中で横に溢れる。
    "sidebar_width": 0,

    # 大きすぎる再現を、何メガピクセルまでで縮めるか（2026-08-25 利用者の指示）。
    #
    # **0 は「記録どおり」。** 実測（`civitai_87384188`）で、2段目 2560x3712 は
    # 分割復号にしても VAE が読み込みと解放を往復して**進まなくなった**
    # ——中断が効かず再起動でしか戻らず、その記録では絵が1枚も出ない。
    # **小さくても出るほうが、出ないより使える。**
    "replay_max_megapixels": 4.5,

    # 一覧の絞り込み（2026-08-24 利用者の指示で残すようにした）。
    #
    # **元は「絞り込みは保存しない」と決めていた。** だが実機では
    # **開き直すたびに絞り込み直す**ことになり、並び替えや見せ方を残しているのと
    # 揃わない——同じ帯に並んでいる操作なのに、片方だけ忘れる。
    #
    # ``hidden_verdicts``: 隠している判定の一覧（``reproducible`` など）。
    # **「見せる方」ではなく「隠す方」を持つ**——判定の種類が増えた日に、
    # 見せる方で持っていると**新しい判定が既定で隠れる**。
    "hidden_verdicts": [],
    # お気に入りだけを見るか。
    "favorites_only": False,

    # 並び替えとモデル順。
    "sort_key": "modified",
    # 並びの向き。**既定は鍵ごとの自然な向き**（日付なら新しい順）。
    # 画面の▼/▲と同じ値で、どちらから変えても同じところに入る。
    "sort_descending": False,
    "group_by_checkpoint": False,

    # 表示言語。**空は「宿主に合わせる」**（ComfyUI の `Comfy.Locale` を読む）。
    #
    # 元は「独自の切替を足さない」と決めていた——足すと
    # 「アプリは日本語なのにこのパネルだけ英語」が作れてしまうため。
    # だが**宿主と別の言語で読みたい**という要望が実際に出た（2026-08-20）ので、
    # **既定を「宿主に合わせる」に固定したまま**選べるようにする。
    # 既定のままなら以前と1文字も変わらない。
    "language": "",
}

#: 判定の配色に使える値。
VERDICT_PALETTES = ("default", "deuteranopia")

#: 選べるテーマ。**色相は 0〜115 から採る**——上流のアクセントから 60度以上
#: 離すという決めごとがあり、`theme_distinctness_test.mjs` が全部の宣言を見ている。
THEMES = ("amber", "ember", "moss", "paper")

#: 一覧の見せ方に使える値。**知らない値は既定へ戻す**（素通しすると
#: 画面側が黙って表へ落ち、「設定したのに効かない」になる）。
LIST_VIEWS = ("table", "tiles")

#: 選べる言語。**空は「宿主に合わせる」。**
#:
#: `web/i18n/index.js` の `LOCALES` と同じ12言語で、ComfyUI の `Comfy.Locale` の
#: 選択肢に揃えてある。**知らない値を素通しさせない**——素通しすると画面側が
#: 黙って英語へ落ち、「設定したのに効かない」という原因の読めない形になる。
LANGUAGES = (
    "", "en", "zh", "zh-TW", "ru", "ja", "ko", "fr", "es", "ar", "tr", "pt-BR", "fa",
)

_FILE_NAME = "unbake.settings.json"


def user_root() -> Path:
    """ComfyUI の user ディレクトリ。**リポジトリの外。**

    設定も記録も見本もここの下に置く。**解決は1箇所に閉じる**——2箇所で
    別々に組むと、片方だけが別の場所を指したときに「書けているのに読めない」
    という形で壊れる（実際に一度そうなった: 保存の既定と走査の既定が
    食い違い、**ディスクには在るのに一覧へ出てこなかった**）。
    """
    base: Optional[str] = None
    if folder_paths is not None:
        getter = getattr(folder_paths, "get_user_directory", None)
        if callable(getter):
            try:
                base = getter()
            except Exception:
                base = None
    if not base:
        # ComfyUI の外（テスト・スタンドアロン）。**カレントには置かない。**
        base = os.environ.get("UNBAKE_SETTINGS_DIR") or tempfile.gettempdir()
    return Path(base)


def default_records_dir() -> Path:
    """``record_output_dir`` を設定していないときの記録の置き場。

    **書く側と読む側がここを共有する。** 片方だけが知っている既定は、
    「保存できたのに一覧に出ない」という一番読みにくい形で壊れる。
    """
    return user_root() / "unbake" / "records"


def settings_path() -> Path:
    """設定ファイルの場所。**リポジトリの外**。"""
    return user_root() / _FILE_NAME


class FileSettings:
    """``get(key, default)`` を満たす設定。JSON ファイルへ保存する。"""

    def __init__(self, path: Optional[Path] = None) -> None:
        self._path = Path(path) if path is not None else settings_path()
        self._values: Dict[str, Any] = {}
        self._loaded = False

    # -- 読み ---------------------------------------------------------

    @property
    def path(self) -> Path:
        return self._path

    def load(self) -> "FileSettings":
        """ファイルを読む。**壊れていても例外にしない**——設定が1つ壊れた
        だけで拡張ごと起動しないのは割に合わない。読めなかったことは
        :attr:`load_error` に残す（黙って既定へ落ちない）。
        """
        self.load_error: Optional[str] = None
        self._values = {}
        self._loaded = True
        try:
            raw = self._path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return self
        except (OSError, ValueError) as error:
            # **`ValueError` を落とさない**（2026-08-31・監査 I-20260831-13）。
            # `UnicodeDecodeError` は `ValueError` の一種で **`OSError` ではない**
            # ので、ここを `OSError` だけにしていると素通りして
            # `register_routes()` まで届き、**`/unbake/*` が1本も登録されない**。
            # `__init__.py` の `except Exception` が飲むので ComfyUI 自体は起動し、
            # **パネルだけが 404 で死ぬ**——しかも `get_settings()` は例外で
            # `_settings` を代入できないため、**再起動しても永久に復旧しない**。
            # 踏み方は「メモ帳の ANSI で保存し直して置き場に日本語を入れる」だけ。
            self.load_error = f"{type(error).__name__}: {error}"
            return self
        try:
            parsed = json.loads(raw)
        except ValueError as error:
            self.load_error = f"JSON: {error}"
            return self
        if not isinstance(parsed, dict):
            self.load_error = "JSON: 最上位がオブジェクトではない"
            return self
        self._values = {k: v for k, v in parsed.items() if k in KNOWN_KEYS}
        return self

    def get(self, key: str, default: Any = None) -> Any:
        """生の値。**プロセスの中でだけ使う**（HTTP へは出さない）。"""
        if not self._loaded:
            self.load()
        if key in self._values:
            return self._values[key]
        if default is not None:
            return default
        return KNOWN_KEYS.get(key, default)

    # -- 書き ---------------------------------------------------------

    def update(self, values: Dict[str, Any]) -> Dict[str, Any]:
        """知っている鍵だけを書き換えて保存する。

        **秘密の鍵に空文字を渡すと消える。** 「変更しない」は鍵を
        送らないことで表す——空文字を「変更しない」の意味にすると、
        消す手段が無くなる。
        """
        if not self._loaded:
            self.load()
        rejected = [key for key in values if key not in KNOWN_KEYS]
        for key, value in values.items():
            if key not in KNOWN_KEYS:
                continue
            self._values[key] = _coerce(key, value)
        self.save()
        return {"saved": [k for k in values if k in KNOWN_KEYS], "rejected": rejected}

    def save(self) -> None:
        """書き出す。**途中で落ちても元のファイルを壊さない**（一時ファイル→置換）。"""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        payload = dumps_json_strict(self._values, ensure_ascii=False, indent=2, sort_keys=True)
        handle, temp_name = tempfile.mkstemp(
            dir=str(self._path.parent), prefix=".unbake-settings-", suffix=".tmp"
        )
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as stream:
                stream.write(payload)
            _restrict(temp_name)
            os.replace(temp_name, self._path)
        except BaseException:
            try:
                os.unlink(temp_name)
            except OSError:
                pass
            raise
        _restrict(str(self._path))

    # -- 画面へ出す形 -------------------------------------------------

    def public_view(self) -> Dict[str, Any]:
        """画面へ返す形。**秘密の値は出さない。**

        秘密の鍵は ``{"set": bool, "length": int}`` に置き換える。
        長さを出すのは、貼り付けが途中で切れた事故を見分けるため
        （実測でブックマークレットの貼り付けが無言で切れた例がある）。
        """
        view: Dict[str, Any] = {}
        for key in KNOWN_KEYS:
            value = self.get(key)
            if key in SECRET_KEYS:
                text = str(value or "")
                view[key] = {"set": bool(text), "length": len(text)}
            else:
                view[key] = value
        return view


def _coerce(key: str, value: Any) -> Any:
    """既定値の型へ寄せる。**型が変わると読み手が黙って壊れる。**

    **真偽値と整数をここで受ける。** 元は文字列とリストしか寄せておらず、
    それ以外は素通しだった——``"false"`` を送ると**文字列として保存され、
    読み手には真として届く**（空でない文字列だから）。設定が効かないのに
    エラーも出ない形なので、型を足す前に真偽値の項目を作ってはいけない。
    """
    default = KNOWN_KEYS[key]
    if isinstance(default, bool):
        # bool は int の下位型なので、**list/str より先に見る。**
        if isinstance(value, str):
            text = value.strip().lower()
            if text in ("true", "1", "yes", "on"):
                return True
            if text in ("false", "0", "no", "off", ""):
                return False
            return bool(default)
        return bool(value)
    if isinstance(default, int):
        try:
            return int(value)
        except (TypeError, ValueError):
            # **既定へ戻す。** 読めない値を素通しすると、閾値の比較が
            # 黙って常に偽になる（文字列と数の比較）。
            return int(default)
    if isinstance(default, float):
        # **浮動小数の枝が無かった**（2026-08-31・監査 I-20260831-32）。
        # 既定が float の鍵は `replay_max_megapixels` ただ1つで、どの枝にも
        # 当たらず末尾の `return value` に落ちていた——画面のフォームは
        # `String(input.value).trim()` を送るので、ディスクには `"8.5"` という
        # **文字列**で残る。以後 `type=number` の欄へ当てられず空表示になり、
        # `collect()` は空を送らない規則なので上書きもできず、
        # **再現の上限は黙って既定へ戻り続ける**。
        try:
            return float(value)
        except (TypeError, ValueError):
            return float(default)
    if key == "language":
        text = str(value or "").strip()
        # 大小の揺れだけは受ける（`ja-JP` のような表記は受けない——
        # 受けると「12言語のどれか」という約束がここで崩れる）。
        for code in LANGUAGES:
            if code and text.lower() == code.lower():
                return code
        return ""
    if key == "theme":
        text = str(value or "").strip().lower()
        return text if text in THEMES else str(default)
    if key == "verdict_palette":
        text = str(value or "").strip().lower()
        return text if text in VERDICT_PALETTES else str(default)
    if key == "list_view":
        text = str(value or "").strip().lower()
        return text if text in LIST_VIEWS else str(default)
    if isinstance(default, list):
        if isinstance(value, str):
            items: Iterable[str] = value.splitlines()
        elif isinstance(value, (list, tuple)):
            items = [str(item) for item in value]
        else:
            items = []
        return [item.strip() for item in items if str(item).strip()]
    if isinstance(default, str):
        return str(value if value is not None else "").strip()
    return value


def _restrict(path: str) -> None:
    """本人だけが読めるようにする。**できない OS では黙って続ける**
    ——ここで例外にすると、権限を落とせない環境で設定そのものが使えなくなる。
    """
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
