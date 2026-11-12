"""Generate the vocabulary declarations consumed by the classic browser scripts."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "backend" / "internscout" / "vocabulary.json"


def quote(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def entries(pairs: list[list[str]]) -> list[str]:
    return [f"{key}: {quote(label)}" for key, label in pairs]


def groups(items: list[str], widths: tuple[int, ...]) -> list[str]:
    lines = []
    offset = 0
    for width in widths:
        if offset >= len(items):
            break
        lines.append(", ".join(items[offset : offset + width]))
        offset += width
    if offset < len(items):
        lines.append(", ".join(items[offset:]))
    return lines


def object_block(name: str, pairs: list[list[str]], widths: tuple[int, ...]) -> str:
    rows = "".join(f"    {line},\n" for line in groups(entries(pairs), widths))
    return f"  const {name} = {{\n{rows}  }};"


def array_block(name: str, pairs: list[list[str]], widths: tuple[int, ...]) -> str:
    values = ["[" + ", ".join(map(quote, pair)) + "]" for pair in pairs]
    return f"  const {name} = [" + ",\n    ".join(groups(values, widths)) + "];"


def declarations(data: dict) -> dict[str, dict[str, str]]:
    field_object = "{ " + ", ".join(entries(data["field_display_overrides"])) + " };"
    baseline = "[" + ", ".join(map(quote, data["baseline_states"])) + "]"
    return {
        "core/profile.mjs": {
            "US_STATES": object_block("US_STATES", data["us_places"], (7, 7, 7, 6, 6, 6, 6, 6, 1)),
            "CA_PROVINCES": object_block("CA_PROVINCES", data["canadian_provinces"], (6, 4, 3)),
            "BASELINE": "  const BASELINE = (C.baselineStates && C.baselineStates.length) ? "
            f"C.baselineStates : {baseline};",
            "YEARS": array_block("YEARS", data["years"], (6,)),
            "STAGES": array_block("STAGES", data["stages"], (4, 3)),
            "FIELD_NAMES": f"  const FIELD_NAMES = {field_object}",
        },
        "buy.js": {"FIELD_NAMES": f"  var FIELD_NAMES = {field_object}"},
    }


def replace_declarations(original: bytes, blocks: dict[str, str]) -> bytes:
    updated = original
    for name, declaration in blocks.items():
        # End at the declaration's semicolon, ignoring semicolons in strings.
        # Fail on duplicate anchors before matching the declaration body.
        anchor = rb"^  (?:const|var) " + name.encode() + rb" = "
        anchors = list(re.finditer(anchor, updated, re.MULTILINE))
        if len(anchors) != 1:
            raise ValueError(f"expected exactly one declaration for {name}")
        anchor_end = anchors[0].end()
        body = re.compile(
            rb'(?:[^;"\r\n]|"(?:\\.|[^"\\\r\n])*"|\r?\n(?: {4}|  (?=\};)))*;(?=\r?$)',
            re.MULTILINE,
        )
        match = body.match(updated, anchor_end)
        if match is None:
            raise ValueError(f"expected a complete declaration for {name}")
        start, end = anchors[0].start(), match.end()
        line_end = b"\r\n" if b"\r\n" in updated[start : end + 2] else b"\n"
        replacement = declaration.encode("utf-8").replace(b"\n", line_end)
        updated = updated[:start] + replacement + updated[end:]
    return updated


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if the generated declarations are stale")
    args = parser.parse_args()
    data = json.loads(SOURCE.read_text(encoding="utf-8"))
    changed = {}
    for filename, blocks in declarations(data).items():
        path = ROOT / "docs" / "js" / filename
        original = path.read_bytes()
        try:
            updated = replace_declarations(original, blocks)
        except ValueError as exc:
            parser.exit(1, f"{path.relative_to(ROOT)}: {exc}\n")
        if updated != original:
            changed[path] = updated
    if args.check and changed:
        names = ", ".join(path.relative_to(ROOT).as_posix() for path in changed)
        parser.exit(1, f"stale vocabulary in {names}; run python scripts/generate_vocabulary.py\n")
    for path, updated in changed.items():
        path.write_bytes(updated)


if __name__ == "__main__":
    main()
