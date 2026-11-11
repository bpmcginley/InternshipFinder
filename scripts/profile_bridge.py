"""Generate the ordered dashboard and extension profile bridge declarations."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path("shared/profile_bridge.json")
DASHBOARD = Path("docs/js/core.js")
BACKGROUND = Path("extension/background/index.js")
GENERATOR = Path("scripts/profile_bridge.py")


def dashboard_property(field: dict) -> str:
    key = field["key"]
    if field["kind"] == "regions":
        return f'{key}: [...(p.{key} || []), ...(p.remote ? ["REMOTE"] : [])]'
    default = '""' if field["kind"] == "text" else "[]"
    return f"{key}: p.{key} || {default}"


def background_property(field: dict) -> str:
    key = field["key"]
    if field["kind"] == "text":
        return f'{key}: str(p.{key}, {field["width"]})'
    width = f', {field["width"]}' if "width" in field else ""
    return f'{key}: strs(p.{key}, {field["items"]}{width})'


def dashboard_lines(fields: list[dict]) -> list[str]:
    properties = [dashboard_property(field) for field in fields]
    lines = [
        "  const bridgeProfile = p => ({",
        "    " + ", ".join(properties[:4]) + ",",
        "    // was: states: demandStates(p). That now leaves provinces out (for the Worker), and the extension's",
        "    // copy is read back into this page, so it gets every picked state and province.",
    ]
    if rest := properties[4:]:
        lines.append("    " + ", ".join(rest) + ",")
    return [*lines, "  });"]


def background_lines(fields: list[dict]) -> list[str]:
    properties = [background_property(field) for field in fields]
    first = "  return { " + ", ".join(properties[:4])
    rest = [first + ",", "    " + ", ".join(properties[4:]) + " };"] if properties[4:] else [first + " };"]
    return [
        "function cleanProfile(p) {",
        '  if (!p || typeof p !== "object") return null;',
        *rest,
        "}",
    ]


def replace_declaration(
    source: bytes, path: Path, lines: list[str], body_indent: int
) -> bytes:
    start, *_, end = (line.encode("utf-8") for line in lines)
    anchor = rb"^" + re.escape(start) + rb"(?=\r?$)"
    if len(re.findall(anchor, source, re.MULTILINE)) != 1:
        raise ValueError(f"expected exactly one profile bridge declaration in {path.as_posix()}")
    span = (
        anchor + rb"(?:\r?\n" + b" " * body_indent + rb"[^\r\n]*)+"
        rb"\r?\n" + re.escape(end) + rb"(?=\r?$)"
    )
    match = re.search(span, source, re.MULTILINE)
    if match is None:
        raise ValueError(f"incomplete profile bridge declaration in {path.as_posix()}")
    newline = b"\r\n" if b"\r\n" in match[0] else b"\n"
    replacement = newline.join(line.encode("utf-8") for line in lines)
    return source[: match.start()] + replacement + source[match.end() :]


def generated_copies(root: Path) -> dict[Path, tuple[bytes, bytes]]:
    fields = json.loads((root / SOURCE).read_text(encoding="utf-8"))
    keys = [field["key"] for field in fields]
    if not keys or len(set(keys)) != len(keys):
        raise ValueError("profile bridge contract needs distinct keys")
    if any(not re.fullmatch(r"[a-z][a-z_]*", key) for key in keys):
        raise ValueError("invalid profile bridge key")
    if any(field["kind"] not in {"text", "list", "regions"} for field in fields):
        raise ValueError("invalid profile bridge field kind")
    declarations = [
        (DASHBOARD, dashboard_lines(fields), 4),
        (BACKGROUND, background_lines(fields), 2),
    ]
    copies = {}
    for path, lines, indent in declarations:
        original = (root / path).read_bytes()
        copies[path] = original, replace_declaration(original, path, lines, indent)
    return copies


def check_copies(copies: dict[Path, tuple[bytes, bytes]]) -> None:
    stale = [path.as_posix() for path, (original, generated) in copies.items() if original != generated]
    if stale:
        raise ValueError(
            f"stale profile bridge declaration in {', '.join(stale)}; "
            "run python scripts/profile_bridge.py"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if a checked-in copy is stale")
    args = parser.parse_args()
    try:
        copies = generated_copies(ROOT)
        if args.check:
            check_copies(copies)
            return
        for path, (original, generated) in copies.items():
            if original != generated:
                (ROOT / path).write_bytes(generated)
    except (OSError, ValueError) as exc:
        parser.exit(1, f"{exc}\n")


if __name__ == "__main__":
    main()
