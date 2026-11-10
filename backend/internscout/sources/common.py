"""Helpers shared by the ATS fetchers."""
from __future__ import annotations
import html
from collections import Counter
import re
from datetime import timezone

import httpx

from ..config import USER_AGENT
from ..geo import REMOTE_RE, _NON_US, state_of

# 2026-10-23: retain complete fetched text until export extracts eligibility (DQ-1).
# was: DESC_CHARS = 4000, which could cut a graduation range halfway through.
# Public descriptions remain capped by export_static.DESC_CHARS.
# Revert: restore the adapter caps (reintroduces false eligibility blockers).


class RobotsDisallowed(Exception):
    """A board whose host tells us in robots.txt not to read it.

    Raised instead of returning nothing so the run can tell "the employer said no" apart from
    "the board was empty today", and so the board ages out of the registry the way a dead one does.
    """


ROBOTS_TIMEOUT = 8.0
_ROBOTS: dict[str, list[tuple[str, str]]] = {}


def robots_rules(text: str, ua: str = USER_AGENT) -> list[tuple[str, str]]:
    """The Allow/Disallow lines of the robots.txt group that applies to us.

    A group is a run of User-agent lines and the rules under them, so consecutive User-agent lines
    share one group and the next User-agent after a rule starts a new one. A group that names us
    beats the catch-all. Most hosts publish only a catch-all, but not all: SmartRecruiters names
    LinkedInBot, and only LinkedInBot, as the one crawler allowed to read /v1/companies/.
    """
    groups: dict[str, list[tuple[str, str]]] = {}
    agents: list[str] = []
    fresh = True
    for line in text.splitlines():
        field, _, value = line.split("#", 1)[0].partition(":")
        field, value = field.strip().lower(), value.strip()
        if field == "user-agent":
            if not fresh:
                agents, fresh = [], True
            agents.append(value.lower())
        elif field in ("allow", "disallow") and agents:
            fresh = False
            for a in agents:
                groups.setdefault(a, []).append((field, value))
    for name, rules in groups.items():
        if name != "*" and name and name in ua.lower():
            return rules
    return groups.get("*", [])


def robots_blocks(rules: list[tuple[str, str]], path: str) -> bool:
    """Whether those rules close this path: longest match wins, and a tie goes to Allow."""
    match, blocked = "", False
    for field, value in rules:
        if not value or not path.startswith(value):
            continue
        if len(value) > len(match) or (len(value) == len(match) and field == "allow"):
            match, blocked = value, field == "disallow"
    return blocked


def robots_allows(c, base: str, path: str) -> bool:
    """Whether the host at `base` ("https://careers-sig.icims.com") lets us request `path`.

    One fetch per host per run, cached, because most ATSes give each employer its own host and a
    host serves several paths. A host that serves no robots.txt forbids nothing, and neither does
    one that answers with a web page instead of a robots file, which two of ours do.
    """
    if base not in _ROBOTS:
        try:
            r = c.get(f"{base}/robots.txt", timeout=ROBOTS_TIMEOUT)
            body = r.text if r.status_code == 200 else ""
            if "<html" in body[:400].lower():
                body = ""
            _ROBOTS[base] = robots_rules(body)
        except Exception:
            _ROBOTS[base] = []   # nothing said is nothing forbidden
    return not robots_blocks(_ROBOTS[base], path)


def require_robots(c, base: str, path: str, token: str) -> None:
    """Stop before the first job request when the host tells us not to read this board.

    Most ATSes hand each employer its own host, so the file is the employer speaking, exactly as
    on Workday: 13 iCIMS tenants answer `User-agent: * / Disallow: /` - Charles Schwab, Bio-Rad,
    Schneider Electric, SIG, Uber's university site, Toll Brothers, the rest - while their
    neighbours serve the iCIMS default, which names the login and referral paths and opens the
    rest. SmartRecruiters is the other shape: one file on the API host shared by every employer
    on it, closing /v1/companies/ to everyone but LinkedInBot.
    """
    if not robots_allows(c, base, path):
        raise RobotsDisallowed(token)


def html_to_text(s: str | None) -> str:
    if not s:
        return ""
    s = html.unescape(s)  # Greenhouse double-escapes its HTML
    s = re.sub(r"<(br|/p|/li|/h\d|/div)\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    s = re.sub(r"[ \t\xa0]+", " ", s)
    return re.sub(r"\n\s*\n+", "\n", s).strip()


def stamp_board_newest(items: list[dict], dates) -> list[dict]:
    """Write the date of the board's newest posting, of any kind, onto each of its items.

    `dates` is every date the board's list call gave, internships or not, in whatever form the ATS
    uses. normalize() reads the stamp to tell an evergreen requisition on a board that is still being
    added to from a posting on a board nobody has touched in years (see normalize._zombie).
    """
    from ..normalize import _to_dt      # here, not at the top: normalize pulls in classify and region
    newest = None
    for d in dates:
        dt = _to_dt(d)
        if dt is None:
            continue
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        if newest is None or dt > newest:
            newest = dt
    if newest is not None:
        for it in items:
            it["board_newest"] = newest.isoformat()
    return items


def board_item(co: dict, *, source: str, title: str, locations: list, url: str | None,
               apply_url: str | None = None, posted_at=None, description: str = "",
               employment_type: str = "") -> dict:
    return {
        "company_name": co["name"],
        "title": title or "",
        "locations": seed_location(co, [l for l in locations if l]),
        "season": None, "year": None,
        "url": url,
        "apply_url": apply_url or url,
        "posted_at": posted_at,
        "description": description or "",  # was: [:DESC_CHARS]; see retention rule above
        "employment_type": employment_type or "",
        "active": True,
        "source": source,
        "source_url": url,
        "sector": co.get("sector"),
    }


def seed_location(co: dict, locations: list) -> list:
    """Add the employer's own place to a posting that named no state.

    A campus writes its locations the way it says them out loud - "Amherst Campus", "RIT Main
    Location", "L - 2 West 13th Street" - and every one of those reads as no US location at all,
    so the posting is dropped before it is ever tagged or shown. Where a seed entry says the one
    place its employer is, that place is appended, and the campus string stays in front of it so
    the card still shows the building a student would walk to.

    It is only ever consulted when nothing in the posting named a state, named somewhere abroad
    (Parsons has a Paris campus) or said remote, so neither a second office nor a work-from-home
    posting can be dragged home by it. And only a seed can set it - a prober's guess about where a
    company sits is not the same kind of fact.
    """
    where = co.get("location")
    if not where or any(state_of(l) or _NON_US.search(l) or REMOTE_RE.search(l) for l in locations):
        return locations
    return locations + [where]


def reported_count(value) -> int | None:
    """A result total as an API reported it, or None when it is missing or not a whole number.

    A scan only proves it read a whole board (or a whole search) when the rows it fetched add up
    to the total the API said there were. A total that is absent, negative or not a number proves
    nothing, so it is None rather than 0: 0 would read as "an empty board, fully read".
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def rows_of(payload, key: str) -> list | None:
    """payload[key] when it is a list of objects, else None (a shape we cannot count on)."""
    rows = payload.get(key) if isinstance(payload, dict) else None
    if isinstance(rows, list) and all(isinstance(r, dict) for r in rows):
        return rows
    return None


def mark_complete(co: dict, complete: bool) -> None:
    """Tell scan_boards this board was read to its end, so absence from it can close a listing.

    Only ever set True, and only at the very end of a fetch: an exception before this line, a
    page cap, a short or malformed page or a total that does not add up all leave it unset.
    """
    if complete:
        co["_scan_complete"] = True


# ------------------------------------------------------------------ page-boundary counts
# What a scan saw before it handed anything to the pipeline. The returned items are already
# filtered, so without these the ingest report cannot tell a board that listed nothing from one
# whose 300 results were all "Internal Audit Manager". Reasons are program-defined labels, never
# text from the response.
DISCARD_REASONS = frozenset({
    "not_student",      # is_internship said no to the title (and employment type)
    "outside_region",   # no US or Canadian place the adapter could keep
    "duplicate",        # the same job again: another keyword's search, another location row
    "unlisted",         # the API marked the row hidden or unlisted
    "expired",          # the row's own closing date has passed
    "unreadable",       # a row without the fields a listing needs (no link, not an object)
})
STOP_REASONS = frozenset({
    "page_cap",         # the adapter's page or offset ceiling stopped the read with results left
    "dry_pages",        # Workday: past CORE_OFFSET, pages in a row held no internship
    "row_limit",        # one request whose row limit was filled, so more may exist
    "quota",            # a paid search quota ran out before the plan was done
})


class ScanCounts:
    """Counts one scan keeps at its page boundaries: discovered, read, discarded, capped.

    discovered is the sum of the totals the API reported, one per search; it stays None when the
    API reports none, or when any one search of the scan lacked one, because a partial sum would
    look like a whole one. read is the rows the adapter actually received, and stays None until a
    page is counted, so an adapter that was never instrumented reports nothing rather than zero.
    Every row read is either returned or discarded with one reason, so read = returned + discarded
    is checkable. Not thread-safe; each scan owns one, and the coordinator reads it afterwards.
    """

    def __init__(self):
        self.discovered: int | None = None
        self._total_unknown = False
        self.read: int | None = None
        self.discarded: Counter = Counter()
        self.stops: Counter = Counter()

    def reported(self, total: int | None) -> None:
        """One search's API-reported total (common.reported_count), or None if it gave none."""
        if total is None or self._total_unknown:
            self._total_unknown, self.discovered = True, None
        else:
            self.discovered = (self.discovered or 0) + total

    def rows(self, n: int) -> None:
        self.read = (self.read or 0) + n

    def discard(self, reason: str, n: int = 1) -> None:
        if reason not in DISCARD_REASONS:
            raise ValueError(f"unknown discard reason: {reason}")
        if n:
            self.discarded[reason] += n

    def stop(self, reason: str) -> None:
        if reason not in STOP_REASONS:
            raise ValueError(f"unknown stop reason: {reason}")
        self.stops[reason] += 1

    def as_dict(self) -> dict:
        """Only what was measured: a key is absent when its count is unknown."""
        out: dict = {}
        if self.discovered is not None:
            out["discovered"] = self.discovered
        if self.read is not None:
            out["read"] = self.read
            out["discarded"] = dict(self.discarded)
        out["capped"] = bool(self.stops)
        if self.stops:
            out["stops"] = dict(self.stops)
        return out


def counts_of(co: dict) -> ScanCounts:
    """The counts run_ingest attached to this board scan, or a throwaway set when there are none.

    Parsers are also called directly (tests, scripts), so they count into whatever this returns
    without checking for None.
    """
    counts = co.get("_counts") if isinstance(co, dict) else None
    return counts if isinstance(counts, ScanCounts) else ScanCounts()


def failure_cause(e: BaseException) -> str:
    """A short, safe name for why a fetch failed: an HTTP status or an exception class, never str(e)."""
    if isinstance(e, httpx.HTTPStatusError):
        return str(e.response.status_code)
    return type(e).__name__


def report_source(report, source: str, *, items=None, error: BaseException | None = None,
                  skipped: str | None = None, counts: ScanCounts | None = None,
                  failed_units: int = 0, units: int | None = None) -> None:
    """Hand a whole non-board source's outcome to the run's collector (IngestMetrics.source_result).

    Exactly one status: skipped (with a code-defined cause), failed (an error stopped the fetch,
    whatever it returned before that), partial (some of a multi-search feed's searches failed),
    empty (it ran and returned nothing), or success. A failed feed never reads as an empty one.
    `report` may be None, in which case nothing is recorded.
    """
    if report is None:
        return
    n = len(items or [])
    if skipped:
        status, cause = "skipped", skipped
    elif error is not None and (not failed_units or failed_units == units):
        status, cause = "failed", failure_cause(error)
    elif failed_units:
        status, cause = "partial", failure_cause(error) if error is not None else None
    else:
        status, cause = ("success" if n else "empty"), None
    report(source, status, count=n, cause=cause,
           scan=counts.as_dict() if counts is not None else None)
