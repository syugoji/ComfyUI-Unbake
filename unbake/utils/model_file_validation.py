# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
#
# ComfyUI-Unbake の一部。著作権の所在を明示してあることが、
# 後から別のライセンスを足せる唯一の担保になる。
"""Verify that a finished download actually contains a model file.

Downloads used to be accepted on HTTP status alone.  A provider that answers
``200`` with an HTML error page therefore had that HTML written to disk under
the model's name.  Two such files (9,603 B and 9,625 B, both beginning with
``<!DOCTYPE html><``) were found in the local library on 2026-08-16.

The failure is silent: the file exists, so it is listed by the manager and by
ComfyUI's combo boxes, and a dry-run injection check passes because the name
resolves.  Only a real generation run fails, with
``SafetensorError: Error while deserializing header: header too large``.

Three checks are provided, ordered by strength:

1. :func:`compare_sha256` — the provider's SHA256.  A match is conclusive and
   nothing weaker may overrule it; a mismatch is conclusive the other way.
   A hash that cannot be used is reported as ``HASH_UNVERIFIABLE`` and never as
   a match, so "could not verify" is never mistaken for "verified".
2. :func:`classify_model_payload` — the leading bytes must match the container
   the extension promises.  This is the check that catches an HTML error page.
3. :func:`compare_declared_size` — the bytes on disk against the size the
   provider declared.

Size alone is never evidence of breakage: legitimately small models exist (the
DISTS weights are 12 KB).  Judgements are made on shape, not on size.
"""

from __future__ import annotations

import os
import struct
from dataclasses import dataclass
from typing import Optional, Tuple

# The union below is ComfyUI's ``folder_paths.supported_pt_extensions``
# (measured against 0.27.0).  Keep this the single place the split between the
# two container formats is written down; the extension lists elsewhere in the
# codebase are still being consolidated (I-20260816-02).
SAFETENSORS_EXTENSIONS: Tuple[str, ...] = (".safetensors", ".sft")
TORCH_EXTENSIONS: Tuple[str, ...] = (".ckpt", ".pt", ".pt2", ".bin", ".pth", ".pkl")
MODEL_EXTENSIONS: Tuple[str, ...] = SAFETENSORS_EXTENSIONS + TORCH_EXTENSIONS

# Upper bound for a safetensors header length declaration.  Real headers are a
# few hundred KB; a declaration beyond this is a misread of foreign bytes.
MAX_SAFETENSORS_HEADER_BYTES = 64 * 1024 * 1024

# Payload verdicts.
PAYLOAD_OK = "ok"
PAYLOAD_BROKEN = "broken"
PAYLOAD_UNKNOWN = "unknown"

# Hash verdicts.
HASH_MATCH = "match"
HASH_MISMATCH = "mismatch"
HASH_UNVERIFIABLE = "unverifiable"

# Relative tolerance for the declared-size comparison.  Providers report sizes
# in kilobytes, so rounding accounts for at most one KiB of difference; 1% is
# far above that and far below the difference a wrong payload produces (an HTML
# error page against a model is three orders of magnitude).
DECLARED_SIZE_TOLERANCE_RATIO = 0.01
DECLARED_SIZE_TOLERANCE_BYTES = 1024


@dataclass(frozen=True)
class PayloadVerdict:
    """Result of inspecting the leading bytes of a downloaded file."""

    status: str
    reason: str = ""

    @property
    def is_broken(self) -> bool:
        return self.status == PAYLOAD_BROKEN


def _is_full_sha256(value: str) -> bool:
    return len(value) == 64 and all(char in "0123456789abcdef" for char in value)


def normalize_sha256(value: object) -> str:
    """Lowercase and strip a hash, returning '' when it is not a usable SHA256."""

    text = str(value or "").strip().lower()
    return text if _is_full_sha256(text) else ""


def classify_model_payload(
    file_path: str, size: Optional[int] = None
) -> PayloadVerdict:
    """Judge a file by its container's leading bytes.

    The file is never read past its first bytes and is never deserialized.

    Returns ``PAYLOAD_UNKNOWN`` for extensions this function does not know how
    to judge; callers must treat that as "no evidence", not as a pass.
    """

    extension = os.path.splitext(file_path)[1].lower()
    if extension not in MODEL_EXTENSIONS:
        return PayloadVerdict(PAYLOAD_UNKNOWN, "extension carries no container contract")

    try:
        if size is None:
            size = os.path.getsize(file_path)
        with open(file_path, "rb") as handle:
            head = handle.read(16)

            if extension in SAFETENSORS_EXTENSIONS:
                if len(head) < 8:
                    return PayloadVerdict(
                        PAYLOAD_BROKEN, f"shorter than a header length ({size} bytes)"
                    )
                (header_length,) = struct.unpack("<Q", head[:8])
                if header_length == 0:
                    return PayloadVerdict(PAYLOAD_BROKEN, "header length is zero")
                if (
                    header_length > MAX_SAFETENSORS_HEADER_BYTES
                    or header_length + 8 > size
                ):
                    preview = head.decode("ascii", "replace")
                    return PayloadVerdict(
                        PAYLOAD_BROKEN,
                        f"declared header length {header_length:,} exceeds the file "
                        f"({size:,} bytes); starts with {preview!r}",
                    )
                handle.seek(8)
                if handle.read(1) != b"{":
                    preview = head.decode("ascii", "replace")
                    return PayloadVerdict(
                        PAYLOAD_BROKEN,
                        f"header is not JSON; starts with {preview!r}",
                    )
                return PayloadVerdict(PAYLOAD_OK)

            # Torch containers: either the ZIP serialization or a legacy pickle.
            if head[:4] == b"PK\x03\x04":
                return PayloadVerdict(PAYLOAD_OK)
            if head[:1] == b"\x80":
                return PayloadVerdict(PAYLOAD_OK, "legacy pickle serialization")
            preview = head.decode("ascii", "replace")
            return PayloadVerdict(
                PAYLOAD_BROKEN,
                f"neither a zip nor a pickle; starts with {preview!r}",
            )
    except OSError as exc:
        return PayloadVerdict(PAYLOAD_UNKNOWN, f"unreadable: {exc}")


def compare_declared_size(actual_size: int, declared_size: Optional[int]) -> bool:
    """Whether ``actual_size`` is close enough to the provider's declared size.

    Returns ``True`` when there is nothing to compare against, so the caller
    must not read this as a positive verification.
    """

    if not declared_size or declared_size <= 0:
        return True
    tolerance = max(
        DECLARED_SIZE_TOLERANCE_BYTES,
        int(declared_size * DECLARED_SIZE_TOLERANCE_RATIO),
    )
    return abs(actual_size - declared_size) <= tolerance


def compare_sha256(actual: object, expected: object) -> str:
    """Compare two hashes, keeping "cannot compare" distinct from "matches".

    Hashing itself is left to the caller so that the codebase keeps a single
    implementation (``py.utils.file_utils.calculate_sha256``, which is async and
    avoids polluting the OS page cache with gigabytes of model weights).
    """

    expected_hash = normalize_sha256(expected)
    if not expected_hash:
        return HASH_UNVERIFIABLE
    actual_hash = normalize_sha256(actual)
    if not actual_hash:
        return HASH_UNVERIFIABLE
    return HASH_MATCH if actual_hash == expected_hash else HASH_MISMATCH
