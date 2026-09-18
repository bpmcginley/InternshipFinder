"""Helpers shared by the ATS fetchers."""
from __future__ import annotations
import html
import re

from ..config import USER_AGENT
from ..geo import REMOTE_RE, _NON_US, state_of

DESC_CHARS = 4000


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
        "description": (description or "")[:DESC_CHARS],
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
