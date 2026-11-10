"""Stamp local script and stylesheet URLs without serializing the surrounding HTML."""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
import hashlib
import html
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import unquote, unquote_plus, urlsplit


class AssetVersionError(ValueError):
    """An asset cannot be versioned safely; messages contain no source URL values."""


@dataclass(frozen=True)
class VersionReport:
    html_files: int
    changed_files: int
    asset_references: int


def _is_link(path: Path) -> bool:
    return path.is_symlink() or bool(getattr(path, "is_junction", lambda: False)())


def _site_files(root: Path) -> tuple[list[Path], set[str]]:
    pending, files, names = [root], [], set()
    while pending:
        folder = pending.pop()
        with os.scandir(folder) as entries:
            for entry in entries:
                path = Path(entry.path)
                if _is_link(path):
                    raise AssetVersionError("Filesystem links are not allowed")
                if entry.is_dir(follow_symlinks=False):
                    pending.append(path)
                elif entry.is_file(follow_symlinks=False):
                    names.add(path.relative_to(root).as_posix())
                    if path.suffix.lower() == ".html":
                        files.append(path)
    return sorted(files), names


def _attribute_span(tag: str, attribute: str) -> tuple[int, int, str]:
    """Locate a real attribute value, skipping names inside other quoted attributes."""
    start = re.match(r"<\s*[^\s/>]+", tag)
    if not start:
        raise AssetVersionError("Malformed asset tag")
    cursor, matches = start.end(), []
    while cursor < len(tag):
        while cursor < len(tag) and tag[cursor].isspace():
            cursor += 1
        if cursor == len(tag) or tag[cursor] == ">" or tag.startswith("/>", cursor):
            break
        name = re.match(r"[^\s=/>]+", tag[cursor:])
        if not name:
            raise AssetVersionError("Malformed asset attribute")
        key = name.group().lower()
        cursor += name.end()
        while cursor < len(tag) and tag[cursor].isspace():
            cursor += 1
        if cursor == len(tag) or tag[cursor] != "=":
            continue
        cursor += 1
        while cursor < len(tag) and tag[cursor].isspace():
            cursor += 1
        if cursor == len(tag):
            raise AssetVersionError("Missing asset attribute value")
        quote = tag[cursor] if tag[cursor] in "\"'" else ""
        if quote:
            begin = cursor + 1
            end = tag.find(quote, begin)
            if end < 0:
                raise AssetVersionError("Unclosed asset attribute")
            cursor = end + 1
        else:
            begin = cursor
            end_match = re.search(r"[\s>]", tag[cursor:])
            end = cursor + end_match.start() if end_match else len(tag)
            cursor = end
        if key == attribute:
            matches.append((begin, end, quote))
    if len(matches) != 1:
        raise AssetVersionError("Missing or duplicate asset attribute")
    return matches[0]


def _version_url(url: str, digest: str) -> str:
    body, fragment_mark, fragment = url.partition("#")
    path, query_mark, query = body.partition("?")
    parts = query.split("&") if query_mark and query else []
    parts = [part for part in parts if unquote_plus(part.partition("=")[0]) != "v"]
    parts.append("v=" + digest)
    return path + "?" + "&".join(parts) + fragment_mark + fragment


def _quoted_url(url: str, quote: str) -> str:
    value = html.escape(url, quote=False)
    if quote:
        return value.replace(quote, "&quot;" if quote == '"' else "&#x27;")
    value = value.replace('"', "&quot;").replace("'", "&#x27;").replace("`", "&#96;")
    return re.sub(r"\s", lambda match: f"&#{ord(match[0])};", value)


class _AssetTags(HTMLParser):
    # HTMLParser handles script/style raw text. Extend that protection to HTML's text-only elements.
    CDATA_CONTENT_ELEMENTS = HTMLParser.CDATA_CONTENT_ELEMENTS + (
        "textarea",
        "title",
        "xmp",
        "iframe",
        "noembed",
        "noframes",
        "plaintext",
    )

    def __init__(
        self, root: Path, path: Path, source: str, hashes: dict[Path, str], names: set[str]
    ):
        super().__init__(convert_charrefs=False)
        self.root, self.path, self.source, self.hashes = root, path, source, hashes
        self.names = names
        self.lines = [0] + [match.end() for match in re.finditer("\n", source)]
        self.edits, self.references, self.plaintext = [], 0, False

    def handle_starttag(self, tag, attrs):
        if self.plaintext:
            return
        if tag == "plaintext":
            self.plaintext = True
            return
        values = {}
        for key, value in attrs:
            values.setdefault(key, value)
        if tag == "base":
            raise AssetVersionError("Base URLs require explicit asset-resolution support")
        attribute = "src" if tag == "script" else None
        if tag == "link" and "stylesheet" in (values.get("rel") or "").lower().split():
            attribute = "href"
        url = values.get(attribute) if attribute else None
        if not url:
            return
        try:
            parsed = urlsplit(url)
        except ValueError:
            raise AssetVersionError("Malformed asset URL") from None
        if parsed.scheme or parsed.netloc or not parsed.path:
            return
        decoded = unquote(parsed.path)
        if "\\" in decoded or "\0" in decoded or decoded.startswith("//"):
            raise AssetVersionError("Unsupported local asset path")
        candidate = (
            self.root / decoded.lstrip("/")
            if decoded.startswith("/")
            else self.path.parent / decoded
        )
        try:
            asset = candidate.resolve(strict=True)
        except (OSError, ValueError):
            raise AssetVersionError("Local asset is missing or invalid") from None
        if not asset.is_relative_to(self.root):
            raise AssetVersionError("Local asset escapes the site directory")
        # Pages is case-sensitive even when the helper runs on Windows.
        logical = Path(os.path.normpath(candidate))
        if logical.relative_to(self.root).as_posix() not in self.names:
            raise AssetVersionError("Local asset is missing or has incorrect case")
        for item in (candidate, *candidate.parents):
            if _is_link(item):
                raise AssetVersionError("Filesystem links are not allowed")
            if item == self.root:
                break
        if not asset.is_file() or asset.suffix.lower() in {".html", ".htm"}:
            raise AssetVersionError("Local asset must be a non-HTML file")
        if asset not in self.hashes:
            self.hashes[asset] = hashlib.sha256(asset.read_bytes()).hexdigest()[:12]
        self.references += 1
        raw = self.get_starttag_text()
        begin, end, quote = _attribute_span(raw, attribute)
        versioned = _version_url(url, self.hashes[asset])
        if versioned == url:
            return
        line, column = self.getpos()
        offset = self.lines[line - 1] + column
        self.edits.append((offset + begin, offset + end, _quoted_url(versioned, quote)))

    def rewritten(self) -> str:
        result = self.source
        for begin, end, value in reversed(self.edits):
            result = result[:begin] + value + result[end:]
        return result


def version_assets(site_dir: str | Path) -> VersionReport:
    """Validate every input before changing files; leave all asset contents untouched."""
    root = Path(site_dir)
    if _is_link(root):
        raise AssetVersionError("Filesystem links are not allowed")
    root = root.resolve(strict=True)
    if not root.is_dir():
        raise AssetVersionError("Site directory is missing")
    files, names = _site_files(root)
    hashes, planned, references = {}, [], 0
    for path in files:
        source = path.read_bytes().decode("utf-8")
        parser = _AssetTags(root, path, source, hashes, names)
        parser.feed(source)
        parser.close()
        rewritten = parser.rewritten()
        references += parser.references
        if rewritten != source:
            planned.append((path, rewritten.encode("utf-8")))
    for path, content in planned:
        path.write_bytes(content)
    return VersionReport(len(files), len(planned), references)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("site_dir", type=Path)
    args = parser.parse_args(argv)
    try:
        report = version_assets(args.site_dir)
    except (AssetVersionError, OSError, UnicodeError) as error:
        message = str(error) if isinstance(error, AssetVersionError) else "Unreadable site input"
        print("Asset versioning failed: " + message, file=sys.stderr)
        return 1
    print(json.dumps(asdict(report), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
