"""Explicit build-time capture opt-in, after successful same-export publication."""

from html.parser import HTMLParser
from pathlib import Path
import posixpath
from urllib.parse import unquote, urljoin, urlsplit

ATTRIBUTE = ' data-employer-posting-counts="1"'


class _Scripts(HTMLParser):
    def __init__(self, text, page="/"):
        super().__init__(convert_charrefs=True)
        # HTMLParser counts LF only, not Unicode line/paragraph separators or CR.
        self.starts = [0] + [i + 1 for i, char in enumerate(text) if char == "\n"]
        self.page = page
        self.matches = []
        self.pending = None

    def _counter(self, value):
        if not isinstance(value, str):
            return False
        # Resolve first, so query strings, absolute URLs and relative aliases cannot hide
        # another copy of the first-party counter from the exact serialization check.
        value = value.strip(" \t\r\n\x00").replace("\t", "").replace("\r", "").replace("\n", "")
        url = urlsplit(urljoin("https://internscout.org" + self.page, value.replace("\\", "/")))
        normalized = posixpath.normpath("/" + unquote(url.path).lstrip("/"))
        return url.hostname == "internscout.org" and normalized == "/js/count.js"

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


def _mark(text, page="/"):
    parser = _Scripts(text, page)
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
        parent = target.relative_to(root).parent.as_posix()
        page = "/" if parent == "." else "/" + parent + "/"
        prepared.append((target, _mark(text, page).encode("utf-8")))
    for target, raw in prepared:
        target.write_bytes(raw)
