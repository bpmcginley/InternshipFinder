"""Location labels: every US and US-remote role is kept. Each location gets a kind:
new_england (ME, NH, VT, MA, RI, CT), nyc_metro (50 mi of Midtown), us (any other state, or just
"United States") or remote. A posting is kept if ANY of its locations is in the US."""
from __future__ import annotations
import re
from collections import Counter, defaultdict
from .config import REGION, wanted_states
from .geo import (REMOTE_RE, STATE_NAMES, _CITY_ONLY, _NON_US, _US_COUNTRY_RE,  # noqa: F401
                  city_of, haversine_miles, locate, state_of)

IN_CITY = {"boston|MA", "cambridge|MA", "new york|NY", "new york city|NY", "nyc|NY",
           "manhattan|NY", "brooklyn|NY", "queens|NY", "bronx|NY", "long island city|NY"}
BASELINE_KINDS = ("new_england", "nyc_metro")
ON_SITE_KINDS = ("new_england", "nyc_metro", "us")
_SPLIT = re.compile(r"\s*(?:;|\||\s/\s|\sor\s|\n)\s*")
# Big posting cities outside the gazetteer, so "New York, Chicago" is read as two cities, not one.
_MAJOR = {
    "chicago": "IL", "seattle": "WA", "redmond": "WA", "bellevue": "WA", "austin": "TX", "dallas": "TX",
    "houston": "TX", "san antonio": "TX", "san francisco": "CA", "los angeles": "CA", "san jose": "CA",
    "san diego": "CA", "palo alto": "CA", "mountain view": "CA", "menlo park": "CA", "sunnyvale": "CA",
    "santa clara": "CA", "irvine": "CA", "sacramento": "CA", "denver": "CO", "boulder": "CO",
    "atlanta": "GA", "miami": "FL", "orlando": "FL", "tampa": "FL", "phoenix": "AZ", "salt lake city": "UT",
    "detroit": "MI", "ann arbor": "MI", "minneapolis": "MN", "raleigh": "NC", "charlotte": "NC",
    "durham": "NC", "nashville": "TN", "baltimore": "MD", "columbus": "OH", "st. louis": "MO",
    "kansas city": "MO", "las vegas": "NV", "washington dc": "DC", "washington d.c.": "DC",
    "new york": "NY", "new york city": "NY", "sf": "CA", "la": "CA", "dc": "DC",
}


def _known_city(part: str) -> str | None:
    p = part.strip().lower()
    return _MAJOR.get(p) or (_CITY_ONLY[p][2] if p in _CITY_ONLY else None)


# "Cambridge, MA, Arlington, VA" -> split after each state code, but keep "Boston, MA, United States" whole.
_AFTER_STATE = re.compile(r"(?<=[\s,][A-Z]{2}),\s*(?=(?!United States|USA?\b)[A-Z][a-z])")


def _split_cities(loc: str) -> list[str]:
    """'New York, Chicago' -> ['New York', 'Chicago']; 'Brooklyn, New York' and 'Boston, MA' stay whole."""
    pieces = _AFTER_STATE.split(loc)
    if len(pieces) > 1:
        return [q for p in pieces for q in _split_cities(p.strip())]
    parts = [p.strip() for p in loc.split(",") if p.strip()]
    if len(parts) < 2:
        return [loc]
    states = [_known_city(p) for p in parts]
    if not all(states):
        return [loc]
    last = parts[-1].lower()
    if len(parts) == 2 and last in STATE_NAMES and STATE_NAMES[last] == states[0]:
        return [loc]  # "Brooklyn, New York" is a city and its state
    return parts
# Words that may accompany a US-remote location. Anything left over ("Remote - HU", "Virtual, BR") is
# a non-US qualifier, so the posting is not US-remote.
_REMOTE_NOISE = re.compile(
    r"\b(?:remote|anywhere|work from home|wfh|virtual|home ?based|hybrid|telecommute|distributed|in|the|of|"
    r"any|location|locations|only|flexible|nationwide|based|u\.?s\.?a?|united states(?: of america)?|america|"
    r"east coast|eastern|northeast|us time ?zones?|est|et)\b|[^a-z]+", re.I)


def remote_ok(loc: str) -> bool:
    return not _REMOTE_NOISE.sub("", loc.lower())


def split_locations(locations) -> list[str]:
    out = []
    for loc in locations or []:
        if not isinstance(loc, str):
            continue
        for p in _SPLIT.split(loc):
            if p and p.strip():
                out += _split_cities(p.strip())
    return out


# "Chicago" and "Chicago, United States" name the same city and no state, but only the first reached
# the map above: the comma made _state read the country as if it were a region of its own.
_JUST_COUNTRY = re.compile(r"^(?:the\s+)?(?:u\.?\s?s\.?\s?a?\.?|united states(?: of america)?|america)$", re.I)


def _city_only(loc: str) -> bool:
    """True for a bare city, and for a city whose only companion is the country."""
    parts = [p.strip() for p in loc.split(",") if p.strip()]
    return len(parts) == 1 or all(_JUST_COUNTRY.match(p) for p in parts[1:])


def _state(loc: str) -> str | None:
    return state_of(loc) or (_city_only(loc) and _MAJOR.get(city_of(loc))) or None


def maybe_in_region(loc: str) -> bool:
    """Cheap, network-free check fetchers use before a per-job detail call. True for US-remote,
    an unknown state, or a wanted state (the baseline plus states students picked)."""
    if not loc or _NON_US.search(loc):
        return False
    st = _state(loc)
    return st is None or st in wanted_states()


def classify_location(loc: str) -> dict | None:
    """{kind: new_england|nyc_metro|us|remote, state, lat, lng, distance, in_city} or None."""
    if not loc or _NON_US.search(loc):
        return None
    hit = locate(loc)
    lat = lng = st = None
    if hit:
        lat, lng, st = hit
    st = st or _state(loc)
    remote = bool(REMOTE_RE.search(loc))
    nyc = haversine_miles(*REGION.nyc_center, lat, lng) if lat is not None else None
    if st in REGION.states:
        kind = "new_england"
    elif nyc is not None and nyc <= REGION.nyc_radius_miles:
        kind = "nyc_metro"
    elif st:
        kind = "remote" if remote else "us"   # "Remote, TX" is remote but limited to Texas
    elif remote and REGION.include_remote and remote_ok(loc):
        kind = "remote"                        # "Remote", "Remote - US"
    elif not remote and _US_COUNTRY_RE.search(loc):
        kind = "us"                            # "United States": somewhere in the US
    else:
        return None
    dist = None
    if lat is not None:
        dist = min(haversine_miles(h[1], h[2], lat, lng) for h in REGION.hubs)
    return {"kind": kind, "state": st, "lat": lat, "lng": lng, "distance": dist,
            "in_city": f"{city_of(loc)}|{st}" in IN_CITY, "remote": remote}


# A bare town name we may place: letters and the punctuation town names carry, at most four words.
_PLACE_RE = re.compile(r"^[A-Za-z][A-Za-z.'\-’]*(?:[ \-][A-Za-z.'\-’]+){0,3}$")
# How many of a board's other postings must name a state before we trust it to speak for the rest.
_AGREE_MIN = 3


def _stated(loc: str) -> str | None:
    """The state a single location names, by the same reading classify_location uses."""
    hit = locate(loc)
    return (hit and hit[2]) or _state(loc)


def board_state(locations) -> str | None:
    """The one state a board's postings all name, or None if they disagree or barely say.

    Called by each board parser with every posting's location, internship or not: the postings we
    are about to throw away are most of the evidence, and after the parser returns they are gone.
    """
    states = Counter(st for loc in locations
                     for part in split_locations([loc] if isinstance(loc, str) else loc)
                     for st in [_stated(part)] if st)
    if len(states) != 1:
        return None
    (state, named), = states.items()
    return state if named >= _AGREE_MIN else None


def place_bare_cities(raw_items: list[dict], state: str | None = None) -> int:
    """Read a board's bare town names in the state the rest of that board agrees on.

    Eliot Community Human Services posts 189 jobs as "Danvers", "Lynn", "Lexington" - the town and
    nothing else. Forty-six of them do name a state, all of them Massachusetts, and the rest are
    towns within an hour of those. On its own "Lexington" is not to be trusted - geo._AMBIGUOUS
    lists it for good reason, Kentucky's being twenty times the size - so every posting on that
    board was dropped for having no readable location, the only psychology internship in the
    baseline states among them. The employer's own board is the evidence that settles it, and it
    only settles it when nothing on the board disagrees: one state, named at least _AGREE_MIN times.

    With a `state` this places one board's postings, which is how the parsers call it. Without one
    it groups by employer and reads each group's own locations, which is all a source that mixes
    employers together can offer. A posting placed this way can still be in the wrong town of the
    right state, which costs nothing we measure; a board that hires in two states never qualifies,
    which is the case worth being careful about. Returns how many locations were placed.
    """
    groups = [(state, raw_items)]
    if state is None:
        by_board = defaultdict(list)
        for raw in raw_items:
            key = (raw.get("company_name") or "").strip().lower()
            if key:
                by_board[key].append(raw)
        groups = [(board_state([it.get("locations") or [] for it in items]), items)
                  for items in by_board.values()]

    placed = 0
    for st, items in groups:
        if not st:
            continue
        for it in items:
            out = []
            for loc in (it.get("locations") or []):
                fixed = _with_state(loc, st)
                placed += fixed != loc
                out.append(fixed)
            it["locations"] = out
    return placed


def _with_state(loc, state: str):
    """"Lexington" -> "Lexington, MA", leaving anything that already reads as somewhere alone."""
    if not isinstance(loc, str):
        return loc
    bare = loc.strip()
    if "," in bare or _stated(bare) or REMOTE_RE.search(bare) or _NON_US.search(bare):
        return loc
    if not _PLACE_RE.match(bare) or _US_COUNTRY_RE.search(bare):
        return loc
    return f"{bare}, {state}"


def evaluate_locations(locations) -> dict:
    locs = split_locations(locations)
    region = [(l, h) for l in locs for h in [classify_location(l)] if h]
    local = [h for _, h in region if h["kind"] in BASELINE_KINDS]
    on_site = [h for _, h in region if h["kind"] in ON_SITE_KINDS]
    pool = local or on_site
    placed = [h for h in pool if h["distance"] is not None]
    best = min(placed, key=lambda h: h["distance"]) if placed else (pool[0] if pool else None)
    stated = next((h["state"] for _, h in region if h["state"]), None)
    return {
        "in_region": bool(region),                 # any US or US-remote location
        "is_remote": any(REMOTE_RE.search(l) for l in locs),
        "on_site": bool(on_site),                  # has a non-remote US location
        "within_radius": bool(local),              # has a New England / NYC-metro location
        "in_city": any(h["in_city"] for h in local),
        # "Remote" only where a location actually says so. A US location we could not pin to a state
        # ("United States", "US - UPS CORPORATE OFFICES (GACOR)") is somewhere in the US, not remote,
        # and the old fallback put on-site listings under a label that was simply untrue - visible
        # in the card's location line and in what the dashboard searches.
        "state": (best and best["state"]) or stated
        or ("Remote" if any(h["kind"] == "remote" for _, h in region) else None),
        "region_locations": [l for l, _ in region],
        # one entry per US location, so the dashboard can filter and show the right one
        "regions": [{"loc": l, "kind": h["kind"], "state": h["state"] or ("Remote" if h["kind"] == "remote" else None)}
                    for l, h in region],
        "best_distance": best["distance"] if best else None,
        "lat": best["lat"] if best else None,
        "lng": best["lng"] if best else None,
        "location_raw": "; ".join(l for l in (locations or []) if isinstance(l, str)),
    }


def in_region(locations) -> bool:
    if isinstance(locations, str):
        locations = [locations]
    return evaluate_locations(locations)["in_region"]
