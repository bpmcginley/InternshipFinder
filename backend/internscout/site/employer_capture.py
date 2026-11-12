"""Explicit build-time capture opt-in, after successful same-export publication."""

from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote

ATTRIBUTE = ' data-employer-posting-counts="1"'
MARKER = "data-employer-posting-counts"
CANONICAL = '<script defer src="/js/count.js">'
DASHBOARD_COMMENT = '''<!-- Cloudflare Web Analytics: page views only. No cookies, no local storage, no fingerprinting,
     and nothing that identifies a visitor; see privacy.html. The token is public by design.
     js/count.js (2026-09-30) is the exact counter, since Cloudflare samples. The landing pages copy
     both tags from here (backend/internscout/seo_pages.py beacon_from).
     "spa": false (2026-10-14, U10): the dashboard now keeps its filters in the address with
     history.replaceState, and the beacon's default single-page-app mode would count every filter change
     as another page view (and send the search text with it). With it off, a page load is one view. -->'''
DASHBOARD_REPLACEMENT = DASHBOARD_COMMENT.replace("js/count.js", "The first-party script")


def _normalized(value):
    # Deliberately independent of URL authorities, attributes and HTML comment grammar.
    value = unquote(unescape(value)).replace("\\", "/")
    return value.replace("\t", "").replace("\r", "").replace("\n", "").lower()


def _potential_counter(value):
    return isinstance(value, str) and "count.js" in _normalized(value)


class _Scripts(HTMLParser):
    def __init__(self, text):
        super().__init__(convert_charrefs=True)
        # HTMLParser counts LF only, not Unicode line/paragraph separators or CR.
        self.starts = [0] + [i + 1 for i, char in enumerate(text) if char == "\n"]
        self.matches = []
        self.pending = None

    def handle_starttag(self, tag, attrs):
        if tag != "script":
            return
        if any(name == "data-employer-posting-counts" for name, _ in attrs):
            raise ValueError("Capture requires a fresh unmarked page")
        if not any(name == "src" and _potential_counter(value) for name, value in attrs):
            return
        # These are publisher-owned tags, before the ordinary asset-stamping pass.
        if self.get_starttag_text() != CANONICAL:
            raise ValueError("Unexpected employer counter script")
        line, column = self.getpos()
        self.pending = self.starts[line - 1] + column + len(self.get_starttag_text()) - 1

    def handle_endtag(self, tag):
        if tag == "script" and self.pending is not None:
            self.matches.append(self.pending)
            self.pending = None


def _mark(text):
    if MARKER in text.lower():
        raise ValueError("Capture requires a fresh unmarked page")
    if _normalized(text).count("count.js") != 1 or text.count(CANONICAL) != 1:
        raise ValueError("Capture requires exactly one raw canonical counter script source")
    parser = _Scripts(text)
    parser.feed(text)
    parser.close()
    expected = text.index(CANONICAL) + len(CANONICAL) - 1
    if parser.pending is not None or parser.matches != [expected]:
        raise ValueError("Capture requires exactly one canonical counter script")
    at = parser.matches[0]
    return text[:at] + ATTRIBUTE + text[at:]


def require_unmarked(root: Path) -> None:
    """Reused targets must not carry activation, even on pages absent from this build.

    Fail before staging/rendering rather than silently publishing a stale opted-in page.
    A caller can supply a fresh staged destination; no cleanup or deletion is inferred here.
    """
    targets = [root / "index.html"]
    for target in (root / "internships").rglob("*"):
        if target.is_symlink() or target.is_junction():
            raise ValueError("Capture preflight requires regular published pages")
        if target.suffix.lower() == ".html":
            targets.append(target)
    for target in targets:
        if not target.exists():
            continue
        if target.is_symlink() or target.is_junction() or not target.is_file():
            raise ValueError("Capture preflight requires regular published pages")
        # Intentionally independent of HTMLParser: browser-active malformed comments/end tags
        # can hide a script from that parser. Even a marker in inert text fails closed here.
        if MARKER in target.read_bytes().decode("utf-8").lower():
            raise ValueError("Capture requires a fresh unmarked publication target")


def stamp(root: Path, pages: list[dict]) -> None:
    """Only dashboard and this build's annotated organic internship pages; no directory scan.

    The caller must have completed employer_publication.prepare and the ordinary publisher.
    Validate every target before any capture write. A later I/O failure fails the whole build;
    nothing may publish that failed artifact. Content dates/feed/widget bytes remain untouched.
    """
    targets = {root / "index.html"}
    for page in pages:
        path = page["path"]
        if not path.startswith("/internships/") or ' data-employer-key="' not in page["html"]:
            continue
        parts = path.strip("/").split("/")
        if any(part in {"", ".", ".."} or "\\" in part for part in parts):
            raise ValueError("Invalid employer capture page path")
        targets.add(root.joinpath(*parts, "index.html"))
    prepared = []
    for target in sorted(targets):
        if target.is_symlink() or target.is_junction() or not target.is_file():
            raise ValueError("Capture requires regular published pages")
        text = target.read_bytes().decode("utf-8")
        if target == root / "index.html":
            # Exact known non-visible dashboard comment only; normal/annotation-only builds
            # never run this pass. Do not exempt it from the subsequent whole-document guard.
            for ending in ("\n", "\r\n"):
                old = DASHBOARD_COMMENT.replace("\n", ending)
                if old in text:
                    text = text.replace(old, DASHBOARD_REPLACEMENT.replace("\n", ending), 1)
                    break
        prepared.append((target, _mark(text).encode("utf-8")))
    for target, raw in prepared:
        target.write_bytes(raw)
