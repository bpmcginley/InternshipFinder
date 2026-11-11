"""Project one complete, already-public organic employer set to Worker catalog bytes."""

from __future__ import annotations

import json
import re

from .site.source import employer_key

_MAX_KEYS = 10_000
_MAX_KEY_BYTES = 200
_MAX_SAFE_INTEGER = 9_007_199_254_740_991
_BAD_KEY_CHARACTERS = re.compile(r"[\x00-\x1f\x7f\ud800-\udfff]")
# Match String.prototype.trim, including BOM and excluding Python-only whitespace.
_JS_TRIM = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def build_employer_catalog(
    names: list[str] | tuple[str, ...], *, complete: bool, max_bytes: int
) -> bytes:
    """Return compact deterministic JSON, or reject the entire projection."""
    if (
        complete is not True
        or not isinstance(names, (list, tuple))
        or not names
        or type(max_bytes) is not int
        or not 0 < max_bytes <= _MAX_SAFE_INTEGER
    ):
        raise ValueError("Employer catalog requires complete names and an explicit byte bound")

    keys = set()
    for name in names:
        if (
            not isinstance(name, str)
            or not name.strip(_JS_TRIM)
            or _BAD_KEY_CHARACTERS.search(name)
        ):
            raise ValueError("Invalid public employer name")
        key = employer_key(name)
        # A valid Unicode scalar string of <=200 UTF-8 bytes also has <=200 UTF-16 units.
        if (
            not key
            or key != key.strip(_JS_TRIM)
            or _BAD_KEY_CHARACTERS.search(key)
            or len(key.encode("utf-8")) > _MAX_KEY_BYTES
        ):
            raise ValueError("Employer key is outside the Worker grammar")
        keys.add(key)
        if len(keys) > _MAX_KEYS:
            raise ValueError("Employer catalog exceeds the Worker key count")
    raw = json.dumps(sorted(keys), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(raw) > max_bytes:
        raise ValueError("Employer catalog exceeds byte bound")
    return raw
