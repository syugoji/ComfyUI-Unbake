# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
#
# ComfyUI-Unbake の一部。著作権の所在を明示してあることが、
# 後から別のライセンスを足せる唯一の担保になる。
"""Strict JSON writers for anything that lands on disk.

JSON has no ``NaN`` / ``Infinity`` literal.  Python's ``json`` module emits
them anyway (``allow_nan=True`` is the default) and reads them back without
complaint, so a file written with a plain ``json.dump`` can be perfectly
round-trippable in Python while every other language refuses it --
JavaScript's ``JSON.parse`` throws ``Unexpected token 'N'``.

That is not hypothetical here.  Recipes embed the source image's ComfyUI
prompt verbatim, and nodes that want to re-run on every execution report
``IS_CHANGED`` as ``float('nan')`` (WAS Node Suite's text nodes and
``WidgetToString`` do exactly this).  The value travelled from the image
metadata into ``*.recipe.json`` untouched, and 2 of 346 local recipes ended
up unreadable outside Python.

The revision store guards itself (``revision_service._canonical``), and this
module is the same guarantee for the recipe files themselves.

**The HTTP layer did not** (2026-09-01).  This paragraph used to claim "the API
layer already guards itself (``recipe_handlers._json_safe``)", but
``recipe_handlers`` is a *fork* module and does not exist in this repository --
so the sentence asserted a guarantee with nothing behind it.  Measured: all 46
``web.json_response`` calls in ``routes.py`` used the default ``json.dumps``
(``allow_nan=True``), and ``read_record`` reaches ``json.loads`` on the PNG
``prompt`` chunk, which *accepts* ``NaN``.  ``routes.register_routes`` now wraps
every response in :func:`dumps_json_strict`.
"""

from __future__ import annotations

import json
import math
from typing import Any, IO


def replace_non_finite(value: Any) -> Any:
    """Return a copy of ``value`` with ``NaN`` / ``±Infinity`` replaced by ``None``.

    ``null`` is chosen over ``0``: the original value is genuinely outside
    what JSON can express, and a number would claim a measurement that was
    never taken.  Types the encoder cannot handle are passed through
    unchanged so that ``json.dump`` still raises ``TypeError`` for them --
    this helper only takes a position on non-finite floats.
    """

    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {key: replace_non_finite(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [replace_non_finite(item) for item in value]
    return value


def dumps_json_strict(value: Any, **kwargs: Any) -> str:
    """``json.dumps`` that can never produce a non-standard literal."""

    kwargs.pop("allow_nan", None)
    return json.dumps(replace_non_finite(value), allow_nan=False, **kwargs)


def dump_json_strict(value: Any, file_obj: IO[str], **kwargs: Any) -> None:
    """``json.dump`` that can never produce a non-standard literal.

    ``allow_nan=False`` is redundant after :func:`replace_non_finite` and is
    kept on purpose: if a future float subclass slips past the sanitiser the
    write fails loudly instead of writing a file only Python can read.
    """

    kwargs.pop("allow_nan", None)
    json.dump(replace_non_finite(value), file_obj, allow_nan=False, **kwargs)
