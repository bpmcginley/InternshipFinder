"""Location handling: remote detection, Boston-metro radius filter, optional geocoding.

Default path is fully offline (a Boston-metro gazetteer + a small US-city coord
table) so ingestion and tests need no network or API key. Set INTERNSCOUT_GEOCODE=1
to additionally resolve unknown "City, ST" strings via Nominatim at runtime.
"""
from __future__ import annotations
import math
import os
import re
from functools import lru_cache
from .config import PROFILE

REMOTE_RE = re.compile(r"\b(remote|anywhere|work from home|wfh)\b", re.I)

# Towns within ~30 mi of downtown Boston (approx coords). Used for the radius test
# without needing a live geocoder.
BOSTON_METRO = {
    "boston": (42.3601, -71.0589), "cambridge": (42.3736, -71.1097),
    "somerville": (42.3876, -71.0995), "brookline": (42.3318, -71.1212),
    "newton": (42.3370, -71.2092), "waltham": (42.3765, -71.2356),
    "medford": (42.4184, -71.1062), "quincy": (42.2529, -71.0023),
    "watertown": (42.3709, -71.1828), "malden": (42.4251, -71.0662),
    "arlington": (42.4154, -71.1565), "lexington": (42.4473, -71.2245),
    "burlington": (42.5048, -71.1956), "woburn": (42.4793, -71.1523),
    "needham": (42.2809, -71.2358), "dedham": (42.2418, -71.1662),
    "framingham": (42.2793, -71.4162), "natick": (42.2834, -71.3495),
    "wellesley": (42.2968, -71.2924), "chelsea": (42.3917, -71.0328),
    "revere": (42.4084, -71.0120), "everett": (42.4084, -71.0537),
    "lowell": (42.6334, -71.3162), "andover": (42.6584, -71.1370),
    "marlborough": (42.3459, -71.5523), "billerica": (42.5584, -71.2689),
    "braintree": (42.2079, -71.0040), "peabody": (42.5279, -70.9287),
    "waltham,": (42.3765, -71.2356),
}

# A few common US cities so we can compute distance for non-metro locations too.
US_CITIES = {
    "new york": (40.7128, -74.0060), "san francisco": (37.7749, -122.4194),
    "seattle": (47.6062, -122.3321), "chicago": (41.8781, -87.6298),
    "austin": (30.2672, -97.7431), "los angeles": (34.0522, -118.2437),
    "washington": (38.9072, -77.0369), "atlanta": (33.7490, -84.3880),
    "dallas": (32.7767, -96.7970), "denver": (39.7392, -104.9903),
    "providence": (41.8240, -71.4128), "portland": (45.5152, -122.6784),
    "philadelphia": (39.9526, -75.1652), "houston": (29.7604, -95.3698),
    "san jose": (37.3382, -121.8863), "manchester": (42.9956, -71.4548),
    "nashua": (42.7654, -71.4676), "worcester": (42.2626, -71.8023),
}


def haversine_miles(lat1, lng1, lat2, lng2) -> float:
    r = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _city_key(loc: str) -> str:
    return loc.split(",")[0].strip().lower()


@lru_cache(maxsize=4096)
def geocode(loc: str):
    """Return (lat, lng) or None. Offline tables first, Nominatim if enabled."""
    key = _city_key(loc)
    if key in BOSTON_METRO:
        return BOSTON_METRO[key]
    if key in US_CITIES:
        return US_CITIES[key]
    if os.environ.get("INTERNSCOUT_GEOCODE") == "1":
        return _nominatim(loc)
    return None


def _nominatim(loc: str):
    try:
        import httpx
        from .config import USER_AGENT
        r = httpx.get(
            "https://nominatim.openstreetmap.org/search",
            params={"q": loc, "format": "json", "limit": 1, "countrycodes": "us"},
            headers={"User-Agent": USER_AGENT}, timeout=20.0,
        )
        data = r.json()
        if data:
            return float(data[0]["lat"]), float(data[0]["lon"])
    except Exception:
        return None
    return None


def evaluate_locations(locations: list[str]):
    """Given raw location strings, return dict describing geo relevance vs. profile.

    Keys: is_remote, within_radius, best_distance, lat, lng, in_city, location_raw
    """
    locations = locations or []
    joined = "; ".join(locations)
    is_remote = any(REMOTE_RE.search(l) for l in locations) or bool(REMOTE_RE.search(joined))

    best = None  # (distance, lat, lng, in_city)
    for loc in locations:
        coords = geocode(loc)
        if not coords:
            continue
        d = haversine_miles(PROFILE.center_lat, PROFILE.center_lng, coords[0], coords[1])
        in_city = _city_key(loc) in {"boston", "cambridge"}
        if best is None or d < best[0]:
            best = (d, coords[0], coords[1], in_city)

    within = False
    dist = lat = lng = None
    in_city = False
    if best:
        dist, lat, lng, in_city = best
        within = dist <= PROFILE.radius_miles
    return {
        "is_remote": is_remote,
        "within_radius": within,
        "best_distance": dist,
        "lat": lat,
        "lng": lng,
        "in_city": in_city,
        "location_raw": joined,
    }


def passes_location_filter(geo: dict) -> bool:
    if geo["within_radius"]:
        return True
    if geo["is_remote"] and PROFILE.include_remote:
        return True
    return False
