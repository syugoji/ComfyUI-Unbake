# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
#
# ComfyUI-Unbake の一部。著作権の所在を明示してあることが、
# 後から別のライセンスを足せる唯一の担保になる。
"""Build a versioned, evidence-backed manifest for recipe replay.

The manifest deliberately separates resources that were demonstrably enabled
for the source image from resources that merely appear in the recipe catalog.
Only the former may be injected into a compatible reconstruction.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from copy import deepcopy
from typing import Any, Iterable

from ...utils.model_file_names import compact_model_name
from ...utils.json_io import dump_json_strict, dumps_json_strict


REPLAY_MANIFEST_SCHEMA = "lora-manager.replay-manifest"
REPLAY_MANIFEST_VERSION = 1
_LORA_TYPES = {"lora", "locon", "lycoris", "hypernet"}
_LORA_TAG_PATTERN = re.compile(
    r"<lora:([^:>]+):\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*>", re.IGNORECASE
)
_RESOURCE_FIELDS = (
    "file_name",
    "filename",
    "name",
    "localPath",
    "file_path",
    "inLibrary",
    "hash",
    "sha256",
    "modelVersionId",
    "modelId",
    "modelName",
    "modelVersionName",
    "isDeleted",
    "exclude",
    "promptAliases",
    "aliases",
    "trainedWords",
    "trained_words",
)


def _finite_number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _linked_constant(value: Any, prompt: dict[str, Any]) -> float | None:
    """配線（``[node_id, slot]``）の先が定数なら、その値を読む。

    読めなければ ``None``（``I-20260831-57``）。`recipeWorkflowBuilder.js` の
    ``constantNumberOf`` と同じ考え方——**1本しか数を持たないノードだけ**を
    定数と見なす。2つ以上あるとどれが出口か決められないので読まない。
    """
    if not isinstance(value, (list, tuple)) or not value:
        return None
    node = prompt.get(str(value[0])) if isinstance(prompt, dict) else None
    inputs = node.get("inputs") if isinstance(node, dict) and isinstance(node.get("inputs"), dict) else None
    if not inputs:
        return None
    if any(isinstance(item, (list, tuple)) for item in inputs.values()):
        return None
    numbers = [
        float(item) for item in inputs.values()
        if isinstance(item, (int, float)) and not isinstance(item, bool) and math.isfinite(float(item))
    ]
    return numbers[0] if len(numbers) == 1 else None


def _strength_of(raw: Any, prompt: dict[str, Any]) -> float | None:
    """強度を1つ読む。**配線なら繋がっている先も見る。**"""
    direct = _finite_number(raw)
    if direct is not None:
        return direct
    return _linked_constant(raw, prompt)


def _normalized_type(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").casefold())


def _basename(value: Any) -> str:
    return str(value or "").replace("\\", "/").rsplit("/", 1)[-1]


def _compact_name(value: Any) -> str:
    return compact_model_name(value)


def _name_tokens(value: Any) -> set[str]:
    generic = {
        "lora",
        "locon",
        "style",
        "model",
        "version",
        "sd",
        "sdxl",
        "xl",
        "pony",
        "illustrious",
        "safetensors",
        "safetensor",
        "checkpoint",
    }
    name = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", _basename(value)).casefold()
    return {
        token
        for token in re.split(r"[^a-z0-9]+", name)
        if len(token) >= 2
        and token not in generic
        and not re.fullmatch(r"v?\d+(?:\.\d+)?", token)
    }


def _bigram_dice(left: str, right: str) -> float:
    if left == right:
        return 1.0
    if len(left) < 2 or len(right) < 2:
        return 0.0
    left_pairs: dict[str, int] = {}
    for index in range(len(left) - 1):
        pair = left[index : index + 2]
        left_pairs[pair] = left_pairs.get(pair, 0) + 1
    intersection = 0
    for index in range(len(right) - 1):
        pair = right[index : index + 2]
        if left_pairs.get(pair, 0) > 0:
            intersection += 1
            left_pairs[pair] -= 1
    return (2 * intersection) / (len(left) + len(right) - 2)


def _name_similarity(left: Any, right: Any) -> float:
    left_compact = _compact_name(left)
    right_compact = _compact_name(right)
    if not left_compact or not right_compact:
        return 0.0
    if left_compact == right_compact:
        return 1.0

    shorter, longer = sorted((left_compact, right_compact), key=len)
    score = 0.0
    if len(shorter) >= 6 and shorter in longer:
        score = 0.82 + (0.16 * (len(shorter) / len(longer)))

    left_tokens = _name_tokens(left)
    right_tokens = _name_tokens(right)
    if left_tokens and right_tokens:
        common = len(left_tokens & right_tokens)
        containment = common / min(len(left_tokens), len(right_tokens))
        jaccard = common / len(left_tokens | right_tokens)
        score = max(score, (0.72 * containment) + (0.28 * jaccard))
    return max(score, _bigram_dice(left_compact, right_compact) * 0.9)


def _candidate_names(resource: dict[str, Any]) -> list[str]:
    values: list[Any] = [
        resource.get("file_name"),
        resource.get("filename"),
        resource.get("name"),
        resource.get("modelName"),
        resource.get("modelVersionName"),
    ]
    for key in ("aliases", "promptAliases"):
        aliases = resource.get(key)
        if isinstance(aliases, list):
            values.extend(aliases)
    return [str(value) for value in values if value]


def _safe_resource(resource: dict[str, Any]) -> dict[str, Any]:
    return {
        field: deepcopy(resource[field])
        for field in _RESOURCE_FIELDS
        if field in resource
    }


def _find_a1111_parameters(recipe: dict[str, Any]) -> str:
    candidates = (
        recipe.get("a1111_parameters"),
        (recipe.get("metadata") or {}).get("a1111_parameters")
        if isinstance(recipe.get("metadata"), dict)
        else None,
        (recipe.get("raw_metadata") or {}).get("parameters")
        if isinstance(recipe.get("raw_metadata"), dict)
        else None,
    )
    return next(
        (value for value in candidates if isinstance(value, str) and value.strip()),
        "",
    )


def _json_after_marker(value: str, marker: str) -> Any:
    match = re.search(
        rf"(?:^|[,\r\n])\s*{re.escape(marker)}\s*:\s*",
        value,
        re.IGNORECASE,
    )
    if not match:
        return None
    fragment = value[match.end() :].lstrip()
    try:
        parsed, _ = json.JSONDecoder().raw_decode(fragment)
    except (json.JSONDecodeError, TypeError, ValueError):
        return None
    return parsed


def _parse_prompt_container(value: Any) -> dict[str, Any] | None:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return None
    if not isinstance(value, dict):
        return None
    if isinstance(value.get("prompt"), dict):
        value = value["prompt"]
    nodes = list(value.values())
    if nodes and all(isinstance(node, dict) and node.get("class_type") for node in nodes):
        return value
    return None


def _find_embedded_prompt(recipe: dict[str, Any]) -> dict[str, Any] | None:
    metadata = recipe.get("metadata") if isinstance(recipe.get("metadata"), dict) else {}
    raw = recipe.get("raw_metadata") if isinstance(recipe.get("raw_metadata"), dict) else {}
    generation = (recipe.get("generation_metadata")
                  if isinstance(recipe.get("generation_metadata"), dict) else {})
    # **JS 側と同じ並びにする**（2026-09-01・走査12周目）。
    #
    # `web/core/recipeWorkflowBuilder.js` の `findEmbeddedPrompt` は候補を
    # **10個**持つが、ここは**先頭7個しか無かった**——足りないのは、
    # あちらのコメントが「**利用者の報告で足した**」と書いている当の3つ:
    #
    #   `generation_metadata.comfy` … Civitai 取り込みの一部は**ここにだけ**
    #       グラフを持つ。実測（手元347件）で**この経路だけを持つのが1件**で、
    #       それは Wan の動画（`WanImageToVideo` → `SaveAnimatedWEBP`）
    #       ——**動画の記録はこの形で来る**ので母数は増える側。
    #   `generation_metadata.comfy_prompt` … 同上。
    #   `prompt` … **こちらが書いた記録**は PNG の `prompt` チャンク
    #       （API 形式のグラフ）をそのままこの名前で持つ。見ないと
    #       「ノード13個の完全なグラフを持つ記録」を素通りする。
    #
    # 見落とすと `source_kind` が `embedded` にならず、
    # `_embedded_lora_evidence` が**1件も証拠を出さない**——
    # 「読めなかった」が「LoRA を使っていない」と同じ顔になる。
    #
    # **文字列のプロンプトは通らない**（`_parse_prompt_container` が
    # 「全部の値が `class_type` を持つ」ことを確かめる）。
    for candidate in (
        recipe.get("comfy"),
        recipe.get("comfy_prompt"),
        recipe.get("workflow"),
        metadata.get("comfy"),
        metadata.get("workflow"),
        raw.get("comfy"),
        raw.get("workflow"),
        generation.get("comfy"),
        generation.get("comfy_prompt"),
        recipe.get("prompt"),
    ):
        prompt = _parse_prompt_container(candidate)
        if prompt:
            return prompt
    return None


def _reachable_nodes(prompt: dict[str, Any]) -> set[str]:
    safe_image_sinks = {
        "saveimage",
        "previewimage",
        "saveanimatedwebp",
        "saveanimatedpng",
        "sdpromptsaver",
    }
    roots = [
        str(node_id)
        for node_id, node in prompt.items()
        if _normalized_type(node.get("class_type")) in safe_image_sinks
    ]
    if not roots:
        # API-format prompts contain only executable nodes. With no recognizable
        # image sink, do not invent reachability evidence.
        return set()
    reachable: set[str] = set()
    pending = roots[:]
    while pending:
        node_id = pending.pop()
        if node_id in reachable or node_id not in prompt:
            continue
        reachable.add(node_id)
        inputs = prompt[node_id].get("inputs")
        if not isinstance(inputs, dict):
            continue
        for value in inputs.values():
            if isinstance(value, list) and len(value) >= 2:
                upstream = str(value[0])
                if upstream in prompt:
                    pending.append(upstream)
    return reachable


def _embedded_lora_evidence(prompt: dict[str, Any]) -> list[dict[str, Any]]:
    reachable = _reachable_nodes(prompt)
    evidence: list[dict[str, Any]] = []
    for node_id, node in prompt.items():
        if str(node_id) not in reachable:
            continue
        node_type = _normalized_type(node.get("class_type"))
        if not (
            node_type == "sdloraloader"
            or node_type.startswith("loraloader")
            or node_type.startswith("loadlora")
        ):
            continue
        mode = str(node.get("mode", "")).casefold()
        if node.get("mode") in {2, 4} or mode in {"bypass", "mute", "never"}:
            continue
        inputs = node.get("inputs") if isinstance(node.get("inputs"), dict) else {}
        name = str(inputs.get("lora_name") or "").strip()
        if not name:
            continue
        # **強度が読めなくても、その LoRA を無かったことにしない**（``I-20260831-57``）。
        #
        # 以前は `_finite_number` が `None` を返した時点で `continue` していた。
        # 強度が**配線（``[node_id, slot]``）で来る**のは ComfyUI では普通の形なので、
        # そのグラフの LoRA は**名前ごと証拠から消えて**いた——落ちるのは強度では
        # なく「このグラフはこの LoRA を使っている」という事実である。
        #
        # 読めるなら読み（繋がっている先が定数のとき）、読めなければ
        # **鍵を置かない**。`null` を置くと下流の `Number(null)` が **0** になり、
        # 「強度0で積む」という嘘に化ける（`Number.isFinite(0)` は true）。
        # 鍵が無ければ `undefined` → `NaN` で、既にある
        # `LORA_STRENGTH_NON_FINITE` の道が正しく走る。
        model_strength = _strength_of(inputs.get("strength_model", inputs.get("strength", 1)), prompt)
        clip_strength = _strength_of(inputs.get("strength_clip", model_strength), prompt)
        item: dict[str, Any] = {
            "source": "embedded_reachable_lora",
            "node_id": str(node_id),
            "name": name,
            "priority": 30,
        }
        if model_strength is not None and clip_strength is not None:
            item["strength_model"] = model_strength
            item["strength_clip"] = clip_strength
            item["strength_known"] = True
        else:
            # **判らないことを名前で言う。** 呼び手が「0」と読めない形にする。
            item["strength_known"] = False
            item["strength_source"] = "link"
        evidence.append(item)
    return evidence


def _a1111_resource_evidence(
    parameters: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    resources = _json_after_marker(parameters, "Civitai resources")
    if not isinstance(resources, list):
        return [], []
    evidence: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for index, resource in enumerate(resources):
        if not isinstance(resource, dict):
            continue
        resource_type = _normalized_type(resource.get("type"))
        air_match = re.fullmatch(
            r"urn:air:[^:]+:(?P<type>[^:]+):civitai:(?P<model_id>\d+)@(?P<version_id>\d+)",
            str(resource.get("air") or ""),
            re.IGNORECASE,
        )
        air_type = _normalized_type(air_match.group("type")) if air_match else ""
        if resource_type and air_type and resource_type != air_type:
            errors.append(
                {
                    "code": "A1111_RESOURCE_IDENTITY_CONFLICT",
                    "message": f"Civitai resourceのtypeとAIRが競合しています（index {index}）。",
                }
            )
            continue
        resource_type = resource_type or air_type
        if resource_type not in _LORA_TYPES:
            continue
        # **強度が読めなくても、その LoRA を無かったことにしない**
        # （`I-20260831-57` を兄弟へも当てた・2026-09-01・走査6周目）。
        #
        # ここは `weight` が読めないと `continue` していた——`I-20260831-57` が
        # `_embedded_lora_evidence` について「**落ちるのは強度ではなく
        # 『このグラフはこの LoRA を使っている』という事実である**」と直した、
        # まさにその形が同じファイルの兄弟に残っていた。
        # A1111 の `Civitai resources` は `weight` を持たない項目を並べうるので、
        # 落とすと**必須 LoRA が証拠から丸ごと消える**（画面には「無い」としか出ない）。
        #
        # 下流は既に強度の無い証拠を扱える——`_strengths_conflict` は
        # `None` を競合に数えず、`ordered` は強度の判っている方を先頭に置き、
        # `expected` は鍵ごと落とす。**`null` を置かない**のも同じ理由で、
        # `Number(null)` が **0** になり「強度0で積む」という嘘に化けるため。
        weight = _finite_number(resource.get("weight"))
        air_model_id = air_match.group("model_id") if air_match else None
        air_version_id = air_match.group("version_id") if air_match else None
        direct_model_id = resource.get("modelId")
        direct_version_id = resource.get("modelVersionId")
        if (
            (direct_model_id not in (None, "") and air_model_id and str(direct_model_id) != air_model_id)
            or (
                direct_version_id not in (None, "")
                and air_version_id
                and str(direct_version_id) != air_version_id
            )
        ):
            errors.append(
                {
                    "code": "A1111_RESOURCE_IDENTITY_CONFLICT",
                    "message": f"Civitai resourceのIDとAIRが競合しています（index {index}）。",
                }
            )
            continue
        if resource_type == "hypernet":
            errors.append(
                {
                    "code": "UNSUPPORTED_REQUIRED_RESOURCE_TYPE",
                    "message": "必須Hypernetworkは標準LoRA Loaderで安全に再構築できません。",
                }
            )
            continue
        item: dict[str, Any] = {
            "source": "a1111_civitai_resources",
            "resource_index": index,
            "name": resource.get("modelVersionName") or resource.get("modelName") or "",
            "model_id": direct_model_id or air_model_id,
            "model_version_id": direct_version_id or air_version_id,
            "hash": resource.get("hash") or resource.get("sha256") or "",
            "priority": 20,
        }
        if weight is not None:
            item["strength_model"] = weight
            item["strength_clip"] = weight
            item["strength_known"] = True
        else:
            # **判らないことを名前で言う。** 呼び手が「0」と読めない形にする
            # （`_embedded_lora_evidence` と同じ形）。
            item["strength_known"] = False
            item["strength_source"] = "a1111_weight_missing"
        evidence.append(item)
    return evidence, errors


def _inline_lora_evidence(recipe: dict[str, Any], parameters: str) -> list[dict[str, Any]]:
    gen_params = recipe.get("gen_params") if isinstance(recipe.get("gen_params"), dict) else {}
    prompt = gen_params.get("prompt")
    text = prompt if isinstance(prompt, str) and prompt.strip() else parameters.split("Negative prompt:", 1)[0]
    evidence: list[dict[str, Any]] = []
    for index, match in enumerate(_LORA_TAG_PATTERN.finditer(text or "")):
        name = match.group(1).strip()
        strength = _finite_number(match.group(2))
        if not name or strength is None:
            continue
        evidence.append(
            {
                "source": "inline_lora_tag",
                "tag_index": index,
                "name": name,
                "strength_model": strength,
                "strength_clip": strength,
                "priority": 10,
            }
        )
    return evidence


def _matching_resources(
    evidence: dict[str, Any], resources: list[dict[str, Any]]
) -> tuple[list[int], str]:
    version_id = evidence.get("model_version_id")
    if version_id not in (None, ""):
        matches = [
            index
            for index, resource in enumerate(resources)
            if str(resource.get("modelVersionId") or "") == str(version_id)
        ]
        if matches:
            return matches, "model_version_id"

    evidence_hash = str(evidence.get("hash") or "").strip().casefold()
    if evidence_hash:
        matches = []
        for index, resource in enumerate(resources):
            resource_hash = str(resource.get("hash") or resource.get("sha256") or "").strip().casefold()
            if resource_hash and (
                resource_hash.startswith(evidence_hash) or evidence_hash.startswith(resource_hash)
            ):
                matches.append(index)
        if matches:
            return matches, "hash"

    name = evidence.get("name")
    compact = _compact_name(name)
    if compact:
        matches = [
            index
            for index, resource in enumerate(resources)
            if compact in {_compact_name(candidate) for candidate in _candidate_names(resource)}
        ]
        if matches:
            return matches, "exact_name"

    if len(compact) >= 6:
        ranked = sorted(
            (
                (
                    max((_name_similarity(name, candidate) for candidate in _candidate_names(resource)), default=0.0),
                    index,
                )
                for index, resource in enumerate(resources)
            ),
            reverse=True,
        )
        if ranked and ranked[0][0] >= 0.62:
            runner_up = ranked[1][0] if len(ranked) > 1 else 0.0
            if ranked[0][0] - runner_up >= 0.12:
                return [ranked[0][1]], "unique_fuzzy_name"
    return [], "none"


def _strengths_conflict(evidence: Iterable[dict[str, Any]]) -> bool:
    """強度が食い違っているか。**判らないものは食い違いに数えない**（``I-20260831-57``）。

    強度を読めなかった証拠（配線で来たもの）は「別の値」ではなく「値が無い」
    ので、競合の根拠にしない——数えると、**読めなかっただけで
    ``LORA_STRENGTH_CONFLICT`` が出る**。
    """
    strengths = {
        (
            round(float(item["strength_model"]), 8),
            round(float(item["strength_clip"]), 8),
        )
        for item in evidence
        if item.get("strength_model") is not None and item.get("strength_clip") is not None
    }
    return len(strengths) > 1


class ReplayManifestService:
    """Create the single Python-owned replay contract consumed by the UI."""

    def build(self, recipe: dict[str, Any]) -> dict[str, Any]:
        resources = [
            resource
            # **`or []` にする**（2026-08-31・監査 I-20260831-37）。
            # `get("loras", [])` は**鍵が在って値が `None`** のとき `None` を返す
            # ので、そのまま回すと `TypeError`。実データには `"loras": null` を
            # 持つレシピが在りうる（Civitai の素の形）。このリポジトリの他所は
            # すべて `get("loras") or []` で書いてあり、ここだけ規則が違っていた。
            for resource in (recipe.get("loras") or [])
            if isinstance(resource, dict) and not resource.get("exclude")
        ]
        parameters = _find_a1111_parameters(recipe)
        embedded = _find_embedded_prompt(recipe)
        evidence: list[dict[str, Any]] = []
        if embedded:
            evidence.extend(_embedded_lora_evidence(embedded))
        a1111_evidence, evidence_errors = _a1111_resource_evidence(parameters)
        evidence.extend(a1111_evidence)
        evidence.extend(_inline_lora_evidence(recipe, parameters))

        groups: dict[str, dict[str, Any]] = {}
        matched_indexes: set[int] = set()
        errors: list[dict[str, Any]] = list(evidence_errors)

        for item in evidence:
            matches, match_kind = _matching_resources(item, resources)
            if len(matches) > 1:
                errors.append(
                    {
                        "code": "LORA_IDENTITY_AMBIGUOUS",
                        "message": f"必須LoRAの候補が複数あります: {item.get('name') or 'Unknown'}",
                        "evidence": deepcopy(item),
                    }
                )
                continue
            if matches:
                index = matches[0]
                matched_indexes.add(index)
                key = f"recipe:{index}"
                resource = resources[index]
                resolution = {"status": "recipe_match", "match": match_kind}
            elif item.get("source") == "inline_lora_tag" and item.get("name"):
                key = f"inline:{_compact_name(item['name'])}"
                resource = {
                    "name": item["name"],
                    "file_name": item["name"],
                    "promptAliases": [item["name"]],
                }
                resolution = {"status": "inline_only", "match": "inline_name"}
            else:
                identity = item.get("model_version_id") or item.get("name") or "unknown"
                key = f"missing:{identity}"
                resource = {
                    "name": item.get("name") or "",
                    "modelVersionId": item.get("model_version_id"),
                    "modelId": item.get("model_id"),
                }
                resolution = {"status": "missing_recipe_resource", "match": "none"}

            group = groups.setdefault(
                key,
                {
                    "resource": _safe_resource(resource),
                    "resolution": resolution,
                    "evidence": [],
                },
            )
            group["evidence"].append(deepcopy(item))

        required_resources: list[dict[str, Any]] = []
        for key, group in groups.items():
            # **強度が判っている証拠を先に置く**（``I-20260831-57``）。
            # `expected` は先頭から採るので、判らないものが先頭に来ると
            # 「判っている値が在るのに使わない」ことになる。
            # 同じ確からしさなら、これまでどおり `priority` の高い順。
            ordered = sorted(
                group["evidence"],
                key=lambda item: (item.get("strength_model") is not None, item["priority"]),
                reverse=True,
            )
            if _strengths_conflict(ordered):
                errors.append(
                    {
                        "code": "LORA_STRENGTH_CONFLICT",
                        "message": f"必須LoRAの強度情報が競合しています: {group['resource'].get('file_name') or group['resource'].get('name') or key}",
                        "evidence": ordered,
                    }
                )
            expected = ordered[0]
            resolution = group["resolution"]
            if resolution["status"] == "missing_recipe_resource":
                errors.append(
                    {
                        "code": "LORA_RESOURCE_NOT_RESOLVED",
                        "message": f"必須LoRAを保存レシピの素材へ一意に対応付けできません: {expected.get('name') or 'Unknown'}",
                        "evidence": deepcopy(expected),
                    }
                )
            required_resources.append(
                {
                    "requirement_id": key,
                    "kind": "lora",
                    "required": True,
                    "resource": group["resource"],
                    "resolution": resolution,
                    # **判らない強度を `null` で置かない**（``I-20260831-57``）。
                    # 鍵ごと無ければ下流は `NaN` として扱い、
                    # `LORA_STRENGTH_NON_FINITE` の道が正しく走る。
                    "expected": {
                        key_name: expected[key_name]
                        for key_name in ("strength_model", "strength_clip")
                        if expected.get(key_name) is not None
                    },
                    "evidence": ordered,
                }
            )

        advisory_resources = [
            {
                "kind": "lora",
                "required": False,
                "reason": "recipe_catalog_only",
                "resource": _safe_resource(resource),
            }
            for index, resource in enumerate(resources)
            if index not in matched_indexes
        ]
        source_kind = "embedded" if embedded else ("a1111" if parameters else "standard")
        manifest: dict[str, Any] = {
            "schema": REPLAY_MANIFEST_SCHEMA,
            "version": REPLAY_MANIFEST_VERSION,
            "source_kind": source_kind,
            "required_resources": required_resources,
            "advisory_resources": advisory_resources,
            "errors": errors,
        }
        canonical = dumps_json_strict(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        manifest["manifest_hash"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        return manifest
