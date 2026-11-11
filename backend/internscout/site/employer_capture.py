"""Explicit build-time capture opt-in, after successful same-export publication."""

from html.parser import HTMLParser
from pathlib import Path

ATTRIBUTE = ' data-employer-posting-counts="1"'


class _Scripts(HTMLParser):
    def __init__(self, text):
        super().__init__(convert_charrefs=True)
        self.text = text
        self.starts = [0]
        for line in text.splitlines(keepends=True):
            self.starts.append(self.starts[-1] + len(line))
        self.matches = []

    def handle_starttag(self, tag, attrs):
        if tag != "script":
            return
        if any(name == "data-employer-posting-counts" for name, _ in attrs):
            raise ValueError("Capture requires a fresh unmarked page")
        if ("src", "/js/count.js") not in attrs:
            return
        # These are publisher-owned tags, before the ordinary asset-stamping pass.
        if self.get_starttag_text() != '<script defer src="/js/count.js">':
            raise ValueError("Unexpected employer counter script")
        line, column = self.getpos()
        self.matches.append(self.starts[line - 1] + column + len(self.get_starttag_text()) - 1)


def _mark(text):
    parser = _Scripts(text)
    parser.feed(text)
    parser.close()
    if len(parser.matches) != 1:
        raise ValueError("Capture requires exactly one canonical counter script")
    at = parser.matches[0]
    return text[:at] + ATTRIBUTE + text[at:]


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
