"""Dates for meaningful page changes, independent of page selection and sitemap membership."""
from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import date, datetime, timezone
from html.parser import HTMLParser

# 2026-10-23: first_seen misses corrections and closures, and dates unchanged pricing copy whenever
# an unrelated role arrives. Persist semantic content hashes between fresh Pages builds instead.
# Revert: remove the page_dates calls and workflow manifest fetch to restore first_seen dates.
FILE = "data/page-content-dates.json"
VERSION = 1
_HASH = re.compile(r"[0-9a-f]{64}\Z")
_PATH = re.compile(r"/(?:[a-zA-Z0-9_-]+/)*\Z|/[a-zA-Z0-9_-]+\.html\Z")
_PAID = re.compile(r"<!--paid-->.*?<!--/paid-->", re.S)
_VOID = frozenset({"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"})
# The dashboard renders these public listing fields after loading JSON. Scan bookkeeping, descriptions
# not exported to its cards and build timestamps do not describe a visible change. Revert: omit home_rows.
_HOME_FIELDS = ("id", "company_name", "title", "field_tags", "regions", "salary", "term", "stage",
                "years", "posted_at", "first_seen", "apply_url", "is_remote", "insights")


def _day(value, ceiling: str) -> str | None:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return None
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        return None
    return value if parsed.isoformat() <= ceiling else None


def read(site_dir: str, ceiling: str) -> dict:
    """A missing, malformed or unrelated manifest never controls dates or filesystem paths."""
    try:
        with open(os.path.join(site_dir, FILE), encoding="utf-8") as f:
            raw = f.read(5_000_001)
        if len(raw) > 5_000_000:
            return {}
        obj = json.loads(raw)
    except (OSError, ValueError, UnicodeError, RecursionError):
        return {}
    if (not isinstance(obj, dict) or type(obj.get("version")) is not int or obj["version"] != VERSION
            or not isinstance(obj.get("pages"), dict)):
        return {}
    return {path: row for path, row in obj["pages"].items()
            if isinstance(path, str) and _PATH.fullmatch(path) and isinstance(row, dict)
            and isinstance(row.get("digest"), str) and _HASH.fullmatch(row["digest"])
            and _day(row.get("lastmod"), ceiling)}


class _Content(HTMLParser):
    def __init__(self, stamp: datetime):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.stack = []
        self.body = False
        self.title = False
        day = f"{stamp:%B} {stamp.day}, {stamp.year}"
        # Only export-date labels are routine. Posting dates, opening dates, comparator source dates
        # and relative freshness/count changes remain significant. was: every new first_seen dated it.
        date_text = re.escape(day)
        self.routine = re.compile(
            r"\b(updated\s+|as of\s+|week to\s+|InternScout on\s+|open roles on\s+|listings open on\s+|"
            r"open roles by US state on\s+|"
            r"on\s+(?=" + date_text + r"\s+InternScout listed\b))" + date_text, re.I)

    def _text(self, text: str) -> str:
        return " ".join(self.routine.sub(r"\1[export date]", text).split())

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "body":
            self.body = True
        if tag == "title":
            self.title = True
        hidden = bool(self.stack and self.stack[-1][1]) or tag in {"script", "style", "template"}
        hidden = hidden or "hidden" in a or a.get("aria-hidden") == "true" or (tag == "input" and a.get("type") == "hidden")
        hidden = hidden or bool(re.search(r"display\s*:\s*none|visibility\s*:\s*hidden", a.get("style", ""), re.I))
        if tag == "meta" and a.get("name", "").lower() == "description":
            self.parts.append(["description", self._text(a.get("content", ""))])
        if self.body and not hidden:
            meaningful = {k: self._text(v or "") for k, v in a.items()
                          if k in {"href", "src", "alt", "aria-label", "placeholder", "datetime", "type", "value"}}
            self.parts.append([tag, meaningful])
        if tag not in _VOID:
            self.stack.append((tag, hidden))

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                break
        if tag == "title":
            self.title = False
        if tag == "body":
            self.body = False

    def handle_data(self, data):
        if (self.body or self.title) and not (self.stack and self.stack[-1][1]):
            text = self._text(data)
            if text:
                self.parts.append(["text", text])


def fingerprint(path: str, html: str, stamp: datetime, data=None) -> str:
    parser = _Content(stamp)
    parser.feed(_PAID.sub("", html))
    # The URL is part of the identity: copying a record from another page cannot preserve its date.
    payload = json.dumps([VERSION, path, parser.parts, data], ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def observed_day() -> str:
    """UTC observation day, separate from the export's possibly older data timestamp."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def refresh(site_dir: str, pages: list[dict], stamp: datetime, home: str = "",
            home_start: str = "<!-- browse:start -->", home_end: str = "<!-- browse:end -->",
            home_rows: list[dict] = (), home_floor: str | None = None) -> tuple[dict, str | None]:
    """Update date values only. Page membership, indexing decisions and paid boxes are untouched."""
    today = observed_day()
    ceiling = max(stamp.strftime("%Y-%m-%d"), today)
    previous = read(site_dir, ceiling)
    records = {}

    def record(path: str, content: str, fallback=None, data=None, live_floor=None) -> str:
        digest = fingerprint(path, content, stamp, data)
        old = previous.get(path, {})
        floor = max(_day(old.get("lastmod"), ceiling) or "", _day(live_floor, ceiling) or "") or None
        # Migration uses the existing sitemap-derived floor once; after that only a changed digest
        # advances the date. was: max(first_seen, live lastmod) on every build.
        if old:
            mod = floor if old.get("digest") == digest and floor else max(today, floor or "")
        else:
            mod = max(_day(fallback, ceiling) or today, _day(live_floor, ceiling) or "")
        records[path] = {"digest": digest, "lastmod": mod}
        return mod

    for p in pages:
        mod = record(p["path"], p["html"], p.get("lastmod"), live_floor=p.get("lastmod_floor"))
        p["lastmod"] = mod
        # CollectionPage and Dataset dates follow the same observed content change as the sitemap.
        # No other structured-data properties, including temporalCoverage, are changed here.
        p["html"] = re.sub(r'("dateModified"\s*:\s*)"[^"\\]*"', lambda m: m[1] + json.dumps(mod), p["html"])

    home_mod = None
    try:
        with open(os.path.join(site_dir, "index.html"), encoding="utf-8") as f:
            text = f.read()
        start, end = text.find(home_start), text.find(home_end)
        if home and 0 <= start < end:
            text = text[:start + len(home_start)] + home + text[end:]
        rows = [{key: row.get(key) for key in _HOME_FIELDS} for row in home_rows]
        rows.sort(key=lambda row: str(row.get("id") or ""))
        home_mod = record("/", text, next((p["lastmod"] for p in pages if p["path"] == "/internships/"), None),
                          rows, home_floor)
    except (OSError, UnicodeError):
        pass
    return {"version": VERSION, "pages": records}, home_mod


def write(site_dir: str, manifest: dict) -> None:
    path = os.path.join(site_dir, FILE)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(manifest, f, sort_keys=True, separators=(",", ":"))
        f.write("\n")
