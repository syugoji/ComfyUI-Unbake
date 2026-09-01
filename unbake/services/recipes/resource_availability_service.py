# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
#
# ComfyUI-Unbake の一部。著作権の所在を明示してあることが、
# 後から別のライセンスを足せる唯一の担保になる。
"""Civitai 上の素材が「そもそも配布されているか」を判定して覚えておく。

再現できないレシピの素材には、ダウンロードで直るものと**何をしても直らないもの**が
混ざっている。後者をダウンロード導線へ流すと、押しても失敗するボタンを出し続ける。

`bd00f21e` は「配布ファイルが1つも無いモデル」を落とす規則を入れたが、判定材料が
`.recipe.json` に焼き付いた `civitai` ブロックしか無かった。実測（2026-08-13・実データ346レシピ）で
**LoRA 1,036件のうちその材料を持つのは1件**、checkpoint も 337件中80件しかない。
規則は正しいのに、9割の素材へは一度も届いていなかった。この service はその材料を
API から取り直し、判定結果だけを設定ディレクトリへ残す。

**判定の根拠は実測（2026-08-13 / civitai.com と civitai.red で一致）:**

| 素材 | `/models/{id}` | `/model-versions/{id}` | 実際のDL | 正しい結論 |
|---|---|---|---|---|
| FLUX `Pro 1.1 Ultra` (618692@1088507) | 200・一覧に載る・files は Training Data のみ | **404** | — | 配布なし |
| FLUX `Krea Dev` (618692@2068000) | 200・一覧に載る・files に Model | **404** | — | 配布あり |
| `Print/Pattern Panties` (603451@674567) | **404** | 200・files に Model(56MB) | **404** | 削除済み |
| 対照 `princess_xl_v2` (@244808) | 200 | 200 | 200 (228MB) | 配布あり |

ここから2つの規則が出る。**版エンドポイントの 404 は配布可否と無関係**（生きた配布版でも返る）。
そして**版の files は嘘をつくことがある**（削除済みモデルの版が 56MB の Model を広告し続ける）。
したがって存在の真実源はモデルページに置き、版の files はモデルが生きている時だけ読む。
"""

from __future__ import annotations

import asyncio
import inspect
import json
import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable
from ...utils.json_io import dump_json_strict, dumps_json_strict

SCHEMA = "lora-manager.civitai-availability"
SCHEMA_VERSION = 1

#: **落としても読み込めない**ファイル種別。ここに無い種別は「読み込める」側に置く。
#:
#: 当初は逆に「読み込める種別の白リスト」で書いていた。実データ512素材を掃引して
#: 実ダウンロードで反証したところ、`Diffusion Model`（12GBの safetensors・実DLは
#: HTTP 200/206）が白リストに無いというだけで「配布なし」に落ちていた
#: （`Krea 2 Turbo` / `redcraft23INT8INT4FP8_30Krea2`）。**白リストは Civitai が
#: 種別を増やすたびに、取れるモデルを黙って遮断する。** 判定の誤りは
#: 「手段を奪う側」へ倒れてはいけないので、黒リストへ反転させた。
#:
#: `web/core/recipeMissingModels.js` の `NON_LOADABLE_FILE_TYPES` と
#: 同一集合であることを `tests/declared_tests_exist_test.mjs` が
#: 両ファイルを読んで固定する（2026-08-28: それまでは**存在しない検査**を
#: 名指ししていた。名前が在ると読んだ人はそこで確かめるのをやめる）。
NON_LOADABLE_FILE_TYPES = frozenset({"training data", "config"})

AVAILABLE = "available"
GENERATION_ONLY = "generation_only"
DELETED = "deleted"
#: **記録が版IDだけで、その版がIDから引けない。** 削除済みとは限らない
#: （生きたモデルの版でも `/model-versions/{id}` が 404 を返すことがある——
#: 実測 2026-08-13 の FLUX `Krea Dev`）。だが**モデルIDが無ければモデルページを
#: 引き直せず**、ダウンロード側 `_get_version_by_id_only` も同じ1本の経路しか
#: 持たないので、**取得は決定的に失敗する**。「配布されていない」とは別の、
#: 「こちらの記録では辿り着けない」という状態。
UNRESOLVABLE = "unresolvable"
UNKNOWN = "unknown"

VERDICTS = (AVAILABLE, GENERATION_ONLY, DELETED, UNRESOLVABLE, UNKNOWN)

#: 「不明」は覚えない。通信断やレート制限のたびに不明が固定されると、
#: 復旧しても判定が古いまま残る。`unresolvable` は Civitai からの明確な応答
#: （404）に基づくので覚えてよい——キーにモデルIDを含むため、後からモデルIDが
#: 記録されれば別のキーとして引き直される。
CACHEABLE_VERDICTS = (AVAILABLE, GENERATION_ONLY, DELETED, UNRESOLVABLE)

DEFAULT_TTL = timedelta(days=7)

MAX_RESOURCES_PER_REQUEST = 64


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _coerce_id(value: Any) -> int | None:
    """`"1088507"` のような文字列 ID も受ける。bool は数値として扱わない。"""

    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, str):
        text = value.strip()
        if text.isdigit():
            number = int(text)
            return number if number > 0 else None
    return None


def cache_key(model_id: int | None, version_id: int | None) -> str:
    return f"{model_id or ''}:{version_id or ''}"


def classify_files(files: Any) -> str:
    """ファイル一覧から配布可否を決める。

    **一覧が無い／空のときは判断しない。** 「配布なし」と誤って断じると、
    取れるはずのモデルまで手段を奪うことになる（`bd00f21e` の判断を引き継ぐ）。
    """

    if not isinstance(files, list) or not files:
        return UNKNOWN
    for entry in files:
        if not isinstance(entry, dict):
            continue
        if str(entry.get("type") or "").strip().lower() not in NON_LOADABLE_FILE_TYPES:
            return AVAILABLE
    return GENERATION_ONLY


def _find_version(model_data: dict[str, Any], version_id: int | None) -> dict[str, Any] | None:
    versions = model_data.get("modelVersions")
    if not isinstance(versions, list):
        return None
    if version_id is None:
        first = versions[0] if versions else None
        return first if isinstance(first, dict) else None
    for entry in versions:
        if isinstance(entry, dict) and _coerce_id(entry.get("id")) == version_id:
            return entry
    return None


class ResourceAvailabilityService:
    """Resolve and remember whether a Civitai resource can be downloaded at all."""

    def __init__(
        self,
        storage_path: str | Path,
        *,
        civitai_client_getter,
        ttl: timedelta = DEFAULT_TTL,
    ) -> None:
        self._path = Path(storage_path)
        self._client_getter = civitai_client_getter
        self._ttl = ttl
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------ store

    def _empty_state(self) -> dict[str, Any]:
        return {"schema": SCHEMA, "schemaVersion": SCHEMA_VERSION, "entries": {}}

    def _read_sync(self) -> dict[str, Any]:
        if not self._path.exists():
            return self._empty_state()
        try:
            payload = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            # 判定は「あると速い」だけの覚え書きなので、壊れていたら捨てて作り直す。
            return self._empty_state()
        if not isinstance(payload, dict) or payload.get("schema") != SCHEMA:
            return self._empty_state()
        if not isinstance(payload.get("entries"), dict):
            return self._empty_state()
        return payload

    def _write_sync(self, payload: dict[str, Any]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temp = self._path.with_name(f".{self._path.name}.tmp-{uuid.uuid4().hex}")
        try:
            with temp.open("w", encoding="utf-8", newline="\n") as stream:
                dump_json_strict(payload, stream, ensure_ascii=False, indent=2, sort_keys=True)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, self._path)
        finally:
            temp.unlink(missing_ok=True)

    def _fresh_entry(self, state: dict[str, Any], key: str) -> dict[str, Any] | None:
        entry = state["entries"].get(key)
        if not isinstance(entry, dict) or entry.get("verdict") not in VERDICTS:
            return None
        checked_at = _parse_timestamp(entry.get("checkedAt"))
        if checked_at is None or _utc_now() - checked_at > self._ttl:
            return None
        return entry

    # ---------------------------------------------------------------- resolve

    async def resolve_many(
        self, resources: Iterable[Any], *, refresh: bool = False
    ) -> dict[str, dict[str, Any]]:
        """Resolve a batch, reusing cached verdicts unless ``refresh`` is set."""

        wanted: list[tuple[str, int | None, int | None]] = []
        seen: set[str] = set()
        for resource in resources:
            if not isinstance(resource, dict):
                continue
            model_id = _coerce_id(resource.get("modelId"))
            version_id = _coerce_id(resource.get("versionId"))
            if model_id is None and version_id is None:
                continue
            key = cache_key(model_id, version_id)
            if key in seen:
                continue
            seen.add(key)
            wanted.append((key, model_id, version_id))
            if len(wanted) >= MAX_RESOURCES_PER_REQUEST:
                break

        async with self._lock:
            state = await asyncio.to_thread(self._read_sync)

        results: dict[str, dict[str, Any]] = {}
        pending: list[tuple[str, int | None, int | None]] = []
        for key, model_id, version_id in wanted:
            cached = None if refresh else self._fresh_entry(state, key)
            if cached is not None:
                results[key] = {**cached, "cached": True}
            else:
                pending.append((key, model_id, version_id))

        if pending:
            resolved = await asyncio.gather(
                *(self._resolve_one(model_id, version_id) for _, model_id, version_id in pending)
            )
            learned: dict[str, dict[str, Any]] = {}
            for (key, _model_id, _version_id), verdict in zip(pending, resolved):
                results[key] = {**verdict, "cached": False}
                if verdict["verdict"] in CACHEABLE_VERDICTS:
                    learned[key] = verdict
            if learned:
                async with self._lock:
                    state = await asyncio.to_thread(self._read_sync)
                    state["entries"].update(learned)
                    await asyncio.to_thread(self._write_sync, state)

        return results

    async def _resolve_one(self, model_id: int | None, version_id: int | None) -> dict[str, Any]:
        try:
            verdict, reason = await self._probe(model_id, version_id)
        except NotImplementedError:
            # **`_probe` の宣言を、ここで取り消さない**（2026-09-01・走査6周目）。
            #
            # `_probe` は「**口が無いなら、無いと言う。`except Exception` に
            # 飲ませると『問い合わせできませんでした』と区別が付かなくなる**」と
            # 書いて `NotImplementedError` を投げる（`I-20260831-36`）。
            # ところが `NotImplementedError` も `Exception` なので、
            # **すぐ下の `except Exception` が飲んで `unknown` へ潰していた**
            # ——`_probe` が分けた2つが、呼び手から見ると同じ `verdict` に戻る。
            #
            # **文言だけ違っても分けたことにならない。** このリポジトリは
            # 何度も「文言は訳されると当たらない。画面は `code` で分類する」と
            # 書いている（`routes.start_download`）。呼び手が枝を切るのは
            # `verdict` なので、そこが同じなら区別は失われている。
            #
            # 既存の検査は `_probe` を**直接**呼んでいたので、この経路を
            # 一度も通っていなかった（`tests/test_service_layer_defects.py`）。
            #
            # 配線前の欠落は利用者の環境の話ではなく**組み立ての誤り**なので、
            # そのまま浮かせる——`test_python_reachability.py` の方針
            # 「配線した人が最初の1回で踏む」と同じ扱いにする。
            raise
        except Exception as exc:  # noqa: BLE001 - 判定不能はそのまま「不明」
            verdict, reason = UNKNOWN, f"判定できませんでした: {exc}"
        return {
            "verdict": verdict,
            "reason": reason,
            "modelId": model_id,
            "versionId": version_id,
            "checkedAt": _utc_now().isoformat(),
        }

    async def _resolve_client(self):
        """`civitai_client_getter` は**同期**で client を返すのがこのリポジトリの契約。

        `base_recipe_routes.py` は `lambda: self.civitai_client` を渡し、既存の利用者
        （`prompt_draft_service` や各 handler）は誰も await していない。初版はここを
        `await self._client_getter()` と書いていて、**fixture 側だけ async だったので
        テストは全て緑のまま、live では判定が丸ごと `unknown` に落ちていた**
        （`object CivitaiClient can't be used in 'await' expression`）。
        両方の形を受けるのは、この食い違いを二度と黙って通さないため。
        """

        client = self._client_getter()
        if inspect.isawaitable(client):
            client = await client
        return client

    async def _probe(self, model_id: int | None, version_id: int | None) -> tuple[str, str]:
        """
        **この関数が呼ぶ口は、このリポジトリに存在しない**
        （2026-08-31・監査 I-20260831-36）。

        下で `client.probe_model` / `client.probe_model_version` を呼んでいるが、
        `grep -rn "def probe_model"` は**0件**で、`ResourceAvailabilityService` を
        組み立てる呼び手も**0件**（`tests/test_python_reachability.py` が
        「入口から到達しない」と宣言している通り）。

        **落ち方が静かなので、実装したつもりで放置されやすい。**
        `_resolve_one` の `except Exception` が `AttributeError` を飲むので、
        配線した瞬間に**全件が「判定できませんでした」（unknown）**になり、
        エラーは1行も出ない。「Civitai へ問い合わせられなかった」と
        「呼ぶ相手が居ない」が同じ顔で出る。

        **配線する前に `probe_model` / `probe_model_version` を実装すること。**
        返す形は `(status, data)` で、`status` は `"ok"` / `"not_found"` /
        それ以外（問い合わせ失敗）。
        """
        client = await self._resolve_client()
        # **口が無いなら、無いと言う。** `except Exception` に飲ませると
        # 「問い合わせできませんでした」と区別が付かなくなる。
        for name in ("probe_model", "probe_model_version"):
            if not callable(getattr(client, name, None)):
                raise NotImplementedError(
                    f"civitai client に {name}() がありません"
                    "（この判定は配線前です。I-20260831-36）"
                )

        if model_id is not None:
            status, model_data = await client.probe_model(model_id)
            if status == "not_found":
                # モデルページが消えている。**版エンドポイントがまだ files を
                # 返していても信じない** — 実測で、削除済みモデルの版が 56MB の
                # Model ファイルを広告し続け、実DLだけが 404 を返した。
                return DELETED, "Civitaiから削除されています"
            if status != "ok" or not isinstance(model_data, dict):
                return UNKNOWN, "Civitaiへ問い合わせできませんでした"

            version = _find_version(model_data, version_id)
            if version is not None:
                verdict = classify_files(version.get("files"))
                if verdict != UNKNOWN:
                    return verdict, self._reason_for(verdict)
                # 一覧の版に files が付いていない形もある。版側で取り直す。
                if version_id is not None:
                    return await self._probe_version_files(client, version_id)
                return UNKNOWN, "配布ファイルの一覧が取得できませんでした"

            if version_id is None:
                return UNKNOWN, "配布ファイルの一覧が取得できませんでした"

            # モデルは生きているのに、その版が一覧に無い。
            status, version_data = await client.probe_model_version(version_id)
            if status == "not_found":
                return DELETED, "このバージョンはCivitaiから削除されています"
            if status != "ok" or not isinstance(version_data, dict):
                return UNKNOWN, "Civitaiへ問い合わせできませんでした"
            verdict = classify_files(version_data.get("files"))
            return verdict, self._reason_for(verdict)

        # 版IDしか無い場合。**版の 404 を削除の根拠にしない**（生きた配布版でも返る）。
        status, version_data = await client.probe_model_version(version_id)
        if status == "not_found":
            # 削除済みとは言えない。だが**モデルIDが無いので引き直す先が無く**、
            # ダウンロード側も同じ1本の経路しか持たない（`_get_version_by_id_only`）。
            # したがって取得は決定的に失敗する。**「確かめられない」ではなく
            # 「取得できない」**なので、`unknown` へ落として待ち行列へ通してはいけない。
            return (
                UNRESOLVABLE,
                "この版はIDから引けません（モデルIDが記録されていないため辿り直せません）",
            )
        if status != "ok" or not isinstance(version_data, dict):
            return UNKNOWN, "Civitaiへ問い合わせできませんでした"
        owner_id = _coerce_id(version_data.get("modelId"))
        if owner_id is not None:
            # 版から辿れたモデルで存在確認をやり直す（削除済みモデルはここで落ちる）。
            return await self._probe(owner_id, version_id)
        verdict = classify_files(version_data.get("files"))
        return verdict, self._reason_for(verdict)

    async def _probe_version_files(self, client, version_id: int) -> tuple[str, str]:
        status, version_data = await client.probe_model_version(version_id)
        if status != "ok" or not isinstance(version_data, dict):
            return UNKNOWN, "配布ファイルの一覧が取得できませんでした"
        verdict = classify_files(version_data.get("files"))
        return verdict, self._reason_for(verdict)

    @staticmethod
    def _reason_for(verdict: str) -> str:
        if verdict == AVAILABLE:
            return "ダウンロードできます"
        if verdict == GENERATION_ONLY:
            return "Civitaiに配布ファイルがありません（生成専用モデル）"
        if verdict == DELETED:
            return "Civitaiから削除されています"
        if verdict == UNRESOLVABLE:
            return "この版はIDから引けません（モデルIDが記録されていないため辿り直せません）"
        return "配布ファイルの一覧が取得できませんでした"
