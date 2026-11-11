"""Explicit build-time capture opt-in, after successful same-export publication."""

from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote

ATTRIBUTE = ' data-employer-posting-counts="1"'


class _Scripts(HTMLParser):
    def __init__(self, text):
        super().__init__(convert_charrefs=True)
        # HTMLParser counts LF only, not Unicode line/paragraph separators or CR.
        self.starts = [0] + [i + 1 for i, char in enumerate(text) if char == "\n"]
        self.matches = []
        self.pending = None

    def _counter(self, value):
        if not isinstance(value, str):
            return False
        # Deliberately lexical and conservative, not a Python approximation of browser URL
        # authority parsing. Any potential counter filename must use the one exact tag,
        # including foreign hosts, slash-heavy/encoded hosts and cache-versioned aliases.
        value = unquote(value).replace("\\", "/")
        value = value.replace("\t", "").replace("\r", "").replace("\n", "").strip()
        return "count.js" in value.lower()

    def handle_starttag(self, tag, attrs):
        if tag != "script":
            return
        if any(name == "data-employer-posting-counts" for name, _ in attrs):
            raise ValueError("Capture requires a fresh unmarked page")
        if not any(name == "src" and self._counter(value) for name, value in attrs):
            return
        # These are publisher-owned tags, before the ordinary asset-stamping pass.
        if self.get_starttag_text() != '<script defer src="/js/count.js">':
            raise ValueError("Unexpected employer counter script")
        line, column = self.getpos()
        self.pending = self.starts[line - 1] + column + len(self.get_starttag_text()) - 1

    def handle_endtag(self, tag):
        if tag == "script" and self.pending is not None:
            self.matches.append(self.pending)
            self.pending = None


def _mark(text):
    parser = _Scripts(text)
    parser.feed(text)
    parser.close()
    if parser.pending is not None or len(parser.matches) != 1:
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
        parser = HTMLParser(convert_charrefs=True)

        def check(tag, attrs):
            if tag == "script" and any(name == "data-employer-posting-counts" for name, _ in attrs):
                raise ValueError("Capture requires a fresh unmarked publication target")

        parser.handle_starttag = check
        parser.feed(target.read_bytes().decode("utf-8"))
        parser.close()


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
        prepared.append((target, _mark(text).encode("utf-8")))
    for target, raw in prepared:
        target.write_bytes(raw)
