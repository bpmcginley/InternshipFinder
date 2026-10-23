"""Check a built Pages directory without making network requests."""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit
from xml.etree import ElementTree

SITE = "https://internscout.org"


@dataclass(frozen=True)
class Reference:
    source: str
    target: str
    kind: str
    problem: str = ""


class PageLinks(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.references = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        for key in ("href", "src"):
            if attrs.get(key):
                kind = "canonical" if tag == "link" and "canonical" in attrs.get("rel", "").split() else tag
                self.references.append((attrs[key], kind))


def audit(site_dir: str | Path) -> dict:
    """Resolve internal HTML links, canonicals and sitemap URLs with Pages' clean-URL rules.

    2026-10-23: was: no complete build check. A directory URL without its slash redirects,
    while both /privacy and /privacy.html serve the file directly (checked on the live host).
    Revert: remove the Pages workflow's site_links invocation; eligibility is never changed here.
    """
    root = Path(site_dir)
    # Use a case-sensitive inventory even on Windows: Pages runs on a case-sensitive filesystem.
    files = {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()}
    refs = []
    pages = sorted(p for p in files if p.endswith(".html"))
    for path in pages:
        source = "/" + (path[:-10] if path.endswith("index.html") else path)
        parser = PageLinks()
        parser.feed((root / path).read_text(encoding="utf-8"))
        refs.extend((source, target, kind) for target, kind in parser.references)
    sitemap = root / "sitemap.xml"
    if sitemap.exists():
        for loc in ElementTree.parse(sitemap).iter("{http://www.sitemaps.org/schemas/sitemap/0.9}loc"):
            refs.append(("/sitemap.xml", loc.text or "", "sitemap"))
    checked, problems = 0, []
    for source, target, kind in refs:
        url = urlsplit(urljoin(SITE + source, target))
        if url.scheme not in ("http", "https") or url.netloc != "internscout.org":
            continue
        checked += 1
        path = unquote(url.path or "/").lstrip("/")
        if path in files or (not path.endswith("/") and path + ".html" in files):
            continue
        index = path.rstrip("/") + "/index.html" if path else "index.html"
        if index in files:
            if path and not path.endswith("/"):
                problems.append(Reference(source, target, kind, "directory URL needs a trailing slash"))
            continue
        problems.append(Reference(source, target, kind, "missing target"))
    return {"html_pages": len(pages), "internal_references": checked,
            "missing_references": sum(p.problem == "missing target" for p in problems),
            "redirect_references": sum(p.problem != "missing target" for p in problems),
            "problems": [asdict(p) for p in problems]}


def main(argv=None):
    import sys
    args = sys.argv[1:] if argv is None else argv
    report = audit(args[0] if args else "docs")
    print(json.dumps(report, indent=2))
    return bool(report["problems"])


if __name__ == "__main__":
    raise SystemExit(main())
