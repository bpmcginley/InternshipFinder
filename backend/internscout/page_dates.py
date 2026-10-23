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
    def __init__(self, stamp: datetime, path: str):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.stack = []
        self.body = False
        self.title = False
        self.path = path
        day = f"{stamp:%B} {stamp.day}, {stamp.year}"
        # 2026-10-23: match the generator's own count/date sentences, not arbitrary date wording.
        # was: generic "as of DATE" also hid COMPARE_AS_OF and redated unchanged source citations.
        # Revert: remove these sentence rules to count export-label changes as content changes.
        date_text = re.escape(day)
        contexts = []
        if path.startswith("/internships/"):
            # The first listing FAQ answer, whose subject changes with its field/place.
            contexts.append((r"^([\d,]+ open [^.!?]* as of\s+)", r"(?=, from [\d,]+ employers?\.)"))
        if path.startswith("/internships/") and path.endswith("/open/"):
            contexts.append((r"^(As of\s+)", r"(?=, [\d,]+ employers? (?:has|have) opened )"))
        if path == "/about/":
            contexts.extend([
                (r"^(As of\s+)", r"(?=, [\d,]+ open )"),
                # About's opening coverage sentence, not its separate competitor-pricing answer.
                (r"^(InternScout is a free internship search for [^.!?]*, as of\s+)", r"(?=\.)"),
            ])
        if path == "/internships/by-the-numbers/":
            # These exact aggregate sentences are emitted only by numbers_page.
            contexts.extend([
                (r"^(As of\s+)", r"(?=, InternScout lists )"),
                (r"^(On\s+)", r"(?= InternScout listed )"),
                (r"^(InternScout on\s+)", r"(?=: [\d,]+ open )"),
                (r"\b([\d,]+ of them (?:was|were) found in the week to\s+)", r"(?=\.)"),
                (r"\b(Among them, as of\s+)", r"(?=:)"),
                (r"\b(list pay or say they are paid, as of\s+)", r"(?=\.)"),
                (r"\b(an hour, as of\s+)", r"(?=\.)"),
                (r"\b(own applicant tracking systems, as of\s+)", r"(?=;)"),
                (r"^((?:The [\d,]+ largest of the [\d,]+ fields|Every field|The one field), by open roles on\s+)", r"(?=:)"),
                (r"^((?:The [\d,]+ US states with the most open roles|Open roles by US state) on\s+)", r"(?=:)"),
                (r"^(Every figure is counted from the listings open on\s+)", r"(?=, the same export )"),
            ])
        self.routine = [re.compile(prefix + date_text + tail) for prefix, tail in contexts]
        self.updated = re.compile(r"((?:^|[.,]\s+)[Uu]pdated\s+)" + date_text + r"(?=\.)")

    def _text(self, text: str, *, description: bool = False, export_label: bool = False) -> str:
        for pattern in self.routine:
            text = pattern.sub(r"\1[export date]", text)
        # "Updated" is routine only in the common template label or an actual generated listing
        # description. A source citation such as "Source updated DATE" remains a real fact.
        listing_description = (description and self.path.startswith("/internships/")
                               and re.match(r"(?:[\d,]+ |No open |The highest hourly pay listed on )", text))
        if export_label or listing_description:
            text = self.updated.sub(r"\1[export date]", text)
        return " ".join(text.split())

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
            self.parts.append(["description", self._text(a.get("content", ""), description=True)])
        if self.body and not hidden:
            meaningful = {k: " ".join((v or "").split()) for k, v in a.items()
                          if k in {"href", "src", "alt", "aria-label", "placeholder", "datetime", "type", "value"}}
            self.parts.append([tag, meaningful])
        if tag not in _VOID:
            export_label = bool(self.stack and self.stack[-1][2]) or (tag == "p" and "updated" in a.get("class", "").split())
            self.stack.append((tag, hidden, export_label))

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
            text = self._text(data, export_label=bool(self.stack and self.stack[-1][2]))
            if text:
                self.parts.append(["text", text])


def fingerprint(path: str, html: str, stamp: datetime, data=None) -> str:
    parser = _Content(stamp, path)
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
