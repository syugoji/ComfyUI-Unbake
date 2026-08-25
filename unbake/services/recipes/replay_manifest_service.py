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
    for candidate in (
        recipe.get("comfy"),
        recipe.get("comfy_prompt"),
        recipe.get("workflow"),
        metadata.get("comfy"),
        metadata.get("workflow"),
        raw.get("comfy"),
        raw.get("workflow"),
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
        model_strength = _finite_number(inputs.get("strength_model", inputs.get("strength", 1)))
        clip_strength = _finite_number(inputs.get("strength_clip", model_strength))
        if not name or model_strength is None or clip_strength is None:
            continue
        evidence.append(
            {
                "source": "embedded_reachable_lora",
                "node_id": str(node_id),
                "name": name,
                "strength_model": model_strength,
                "strength_clip": clip_strength,
                "priority": 30,
            }
        )
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
        weight = _finite_number(resource.get("weight"))
        if weight is None:
            continue
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
        evidence.append(
            {
                "source": "a1111_civitai_resources",
                "resource_index": index,
                "name": resource.get("modelVersionName") or resource.get("modelName") or "",
                "model_id": direct_model_id or air_model_id,
                "model_version_id": direct_version_id or air_version_id,
                "hash": resource.get("hash") or resource.get("sha256") or "",
                "strength_model": weight,
                "strength_clip": weight,
                "priority": 20,
            }
        )
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
    strengths = {
        (
            round(float(item["strength_model"]), 8),
            round(float(item["strength_clip"]), 8),
        )
        for item in evidence
    }
    return len(strengths) > 1


class ReplayManifestService:
    """Create the single Python-owned replay contract consumed by the UI."""

    def build(self, recipe: dict[str, Any]) -> dict[str, Any]:
        resources = [
            resource
            for resource in recipe.get("loras", [])
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
            ordered = sorted(group["evidence"], key=lambda item: item["priority"], reverse=True)
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
                    "expected": {
                        "strength_model": expected["strength_model"],
                        "strength_clip": expected["strength_clip"],
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
