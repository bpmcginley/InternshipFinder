"""Region filter: New England (ME, NH, VT, MA, RI, CT), the NYC metro (50 mi of Midtown),
and US-remote roles. A posting passes if ANY of its locations is in region."""
from __future__ import annotations
import re
from .config import REGION
from .geo import REMOTE_RE, STATE_NAMES, _CITY_ONLY, _NON_US, city_of, haversine_miles, locate, state_of  # noqa: F401

IN_CITY = {"boston|MA", "cambridge|MA", "new york|NY", "new york city|NY", "nyc|NY",
           "manhattan|NY", "brooklyn|NY", "queens|NY", "bronx|NY", "long island city|NY"}
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


def maybe_in_region(loc: str) -> bool:
    """Cheap, network-free pre-check used by fetchers before fetching job details."""
    if not loc or _NON_US.search(loc):
        return False
    st = state_of(loc)
    return st is None or st in REGION.states or st in {"NY", "NJ", "PA"} or bool(REMOTE_RE.search(loc))


def classify_location(loc: str) -> dict | None:
    """{kind: new_england|nyc_metro|remote, state, lat, lng, distance, in_city} or None."""
    if not loc or _NON_US.search(loc):
        return None
    hit = locate(loc)
    lat = lng = st = None
    if hit:
        lat, lng, st = hit
    remote = bool(REMOTE_RE.search(loc))
    nyc = haversine_miles(*REGION.nyc_center, lat, lng) if lat is not None else None
    if st in REGION.states:
        kind = "new_england"
    elif nyc is not None and nyc <= REGION.nyc_radius_miles:
        kind = "nyc_metro"
    elif remote and REGION.include_remote and st is None and remote_ok(loc):
        kind = "remote"          # "Remote", "Remote - US"; a non-region state ("Remote, TX") is not
    else:
        return None
    dist = None
    if lat is not None:
        dist = min(haversine_miles(h[1], h[2], lat, lng) for h in REGION.hubs)
    return {"kind": kind, "state": st, "lat": lat, "lng": lng, "distance": dist,
            "in_city": f"{city_of(loc)}|{st}" in IN_CITY, "remote": remote}


def evaluate_locations(locations) -> dict:
    locs = split_locations(locations)
    region = [(l, h) for l in locs for h in [classify_location(l)] if h]
    local = [h for _, h in region if h["kind"] != "remote"]
    placed = [h for h in local if h["distance"] is not None]
    best = min(placed, key=lambda h: h["distance"]) if placed else (local[0] if local else None)
    return {
        "in_region": bool(region),
        "is_remote": any(REMOTE_RE.search(l) for l in locs),
        "within_radius": bool(local),              # has a non-remote in-region location
        "in_city": any(h["in_city"] for h in local),
        "state": best["state"] if best else ("Remote" if region else None),
        "region_locations": [l for l, _ in region],
        # one entry per region location, so the dashboard can filter and show the right one
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
