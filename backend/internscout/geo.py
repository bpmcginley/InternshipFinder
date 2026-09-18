"""Location parsing: remote/US detection, state parsing, a Northeast gazetteer, geocoding.

Offline by default: a gazetteer of New England + NYC-metro towns (plus a few nearby
out-of-region cities) answers most lookups. With INTERNSCOUT_GEOCODE=1, unknown towns in
NY/NJ/PA (the states where "within 50 mi of NYC" matters) are resolved once via Nominatim
and remembered in backend/data/geocache.json, which CI commits back.
"""
from __future__ import annotations
import json
import math
import os
import re
import threading
import time
from .config import DATA_DIR

REMOTE_RE = re.compile(r"\b(remote|anywhere|work from home|wfh|virtual)\b", re.I)
_US_STATES = {"al","ak","az","ar","ca","co","ct","de","fl","ga","hi","id","il","in","ia",
 "ks","ky","la","me","md","ma","mi","mn","ms","mo","mt","ne","nv","nh","nj","nm","ny","nc",
 "nd","oh","ok","or","pa","ri","sc","sd","tn","tx","ut","vt","va","wa","wv","wi","wy","dc"}
STATE_NAMES = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA",
    "colorado": "CO", "connecticut": "CT", "delaware": "DE", "florida": "FL", "georgia": "GA",
    "hawaii": "HI", "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA",
    "kansas": "KS", "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
    "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS",
    "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
    "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
    "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC",
    "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT", "vermont": "VT",
    "virginia": "VA", "washington": "WA", "west virginia": "WV", "wisconsin": "WI",
    "wyoming": "WY", "district of columbia": "DC",
}
_STATE_NAME_RE = re.compile(
    r"\b(" + "|".join(sorted(STATE_NAMES, key=len, reverse=True)) + r")\b", re.I)
_US_COUNTRY_RE = re.compile(r"\b(united states|u\.s\.a?\.?|usa|us)\b", re.I)
_FOREIGN = re.compile(r"\b(london|dublin|ireland|amsterdam|netherlands|canada|toronto|vancouver|"
 r"montreal|ontario|quebec|india|bangalore|bengaluru|hyderabad|singapore|australia|sydney|"
 r"germany|berlin|munich|france|paris|japan|tokyo|china|shanghai|beijing|hong kong|israel|"
 r"tel aviv|mexico|brazil|spain|madrid|poland|warsaw|uk|united kingdom|england|scotland|"
 r"wales|europe|emea|apac|latam|switzerland|zurich|sweden|denmark|norway|finland|korea|"
 r"seoul|taiwan|philippines|vietnam|argentina|colombia|chile|portugal|lisbon|italy|milan|"
 r"romania|ukraine|czech|prague|austria|vienna|belgium|brussels|luxembourg|uae|dubai)\b", re.I)

# Half the cities above have a namesake in the US, and several are where students are hired:
# Dublin, OH is Cardinal Health and Wendy's, Ontario, CA is an Inland Empire logistics hub, Warsaw,
# IN is Zimmer Biomet, New London, CT is Electric Boat, and "Vienna, VA; United States" is Tysons.
# The word alone threw every one of them out of the country, state code and all, and a posting with
# no other location was dropped outright. A location that names one of these towns and then a US
# state - "Dublin, OH", "New Berlin, WI 53151", "Paris, Texas, USA" - is that town. Only the
# namesakes are let through, so "Bangalore, IN" is still India and not Indiana.
_US_NAMESAKES = frozenset({"london", "dublin", "paris", "vienna", "berlin", "milan", "warsaw", "madrid",
                           "toronto", "mexico", "ontario", "vancouver", "lisbon", "amsterdam", "wales",
                           "brussels", "belgium", "prague"})
_TOWN_STATE = re.compile(r"^\s*([^,;|]+?)\s*,\s*([A-Za-z][A-Za-z ]*?)(?:\s+\d{5}(?:-\d{4})?)?"
                         r"\s*(?:,\s*(?:us|usa|u\.s\.a?\.?|united states(?: of america)?)\s*)?$", re.I)


class _NotUS:
    """_FOREIGN, except for a US namesake followed by its state. Callers use it as a regex."""

    def search(self, loc: str):
        m = _FOREIGN.search(loc)
        if not m:
            return None
        town = _TOWN_STATE.match(loc)
        if town:
            words = [w.lower() for w in _FOREIGN.findall(town.group(1))]
            st = town.group(2).strip()
            is_state = (len(st) == 2 and st.isupper() and st.lower() in _US_STATES) or st.lower() in STATE_NAMES
            if is_state and words and all(w in _US_NAMESAKES for w in words):
                return None
        return m


_NON_US = _NotUS()


def looks_us(loc: str) -> bool:
    """True if a location string appears to be in the US (state abbrev/name or country)."""
    if not loc or _NON_US.search(loc):
        return False
    return bool(state_of(loc) or _US_COUNTRY_RE.search(loc))


_TOKEN_SPLIT = re.compile(r"[,\-–/()|]")
_LOOSE_STATE = re.compile(r"(?<![A-Za-z])([A-Z]{2})(?![A-Za-z])")
_FACILITY = re.compile(r"^\s*US\s*-\s*.+\(([A-Z]{2})[A-Z]{3}\)\s*$")


def state_of(loc: str) -> str | None:
    """Two-letter state code from 'City, ST', 'US-MA-Boston', 'Boston, Massachusetts', ..."""
    if not loc:
        return None
    for tok in _TOKEN_SPLIT.split(loc):
        m = re.fullmatch(r"\s*([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*", tok)
        if m and m.group(1).lower() in _US_STATES:
            return m.group(1)
    m = _STATE_NAME_RE.search(loc)
    if m:
        return STATE_NAMES[m.group(1).lower()]
    # Last resort: a capitalised code standing on its own anywhere in the string. The two passes
    # above want the code to be a whole comma-or-dash piece, which loses every board that writes the
    # country beside it ("Cambridge, MA USA", "San Mateo, CA United States"), puts the code before
    # the town ("US WV Friendly", "(USA) OH HAMILTON 02441 WM SUPERCENTER") or separates with dots
    # ("US.GA.Atlanta.2018 Powers Ferry Rd"). That was 659 of the 20,287 US locations in one export,
    # and each of them landed in the "US" shard, where a student filtering by their own state never
    # saw it. Capitalisation is what keeps this honest: it reads the AR in "(USA) AR ROGERS" and not
    # the word "or" in a sentence, and it runs only when both passes above came back empty, so no
    # answer that already works can change.
    for m in _LOOSE_STATE.finditer(loc):
        if m.group(1).lower() in _US_STATES:
            return m.group(1)
    # UPS names every site "US - <building> (<state><3 letters>)": "US - UPS CORPORATE OFFICES
    # (GACOR)", "US - JEFFERSON HUB (ILJEF)", "US - OLYMPIC (CAOLY)". 30 open listings said nothing
    # else and sat in the country-only shard. The code has to close the string and follow "US -",
    # so nothing without that exact shape is read this way.
    m = _FACILITY.search(loc)
    if m and m.group(1).lower() in _US_STATES:
        return m.group(1)
    return None


_PREFIX = re.compile(r"^\s*(?:hybrid|on-?site|in[- ]office|remote)\b\s*(?:in\b|[-–:(])?\s*", re.I)


def city_of(loc: str) -> str:
    s = (loc or "").strip()
    m = re.match(r"^\s*USA?\s*[-–]\s*[A-Z]{2}\s*[-–]\s*(.+)$", s)
    if m:
        return m.group(1).strip().lower()
    s = _PREFIX.sub("", s)
    return re.sub(r"\s+", " ", s.split(",")[0].strip().strip("()")).lower()


# (lat, lng) keyed by "city|ST". NE towns only need entries when distance or the
# in-city flag matters; NY/NJ/PA entries decide the 50-mile NYC test.
GAZETTEER = {
    # Massachusetts
    "boston|MA": (42.3601, -71.0589), "cambridge|MA": (42.3736, -71.1097),
    "somerville|MA": (42.3876, -71.0995), "brookline|MA": (42.3318, -71.1212),
    "newton|MA": (42.3370, -71.2092), "waltham|MA": (42.3765, -71.2356),
    "medford|MA": (42.4184, -71.1062), "quincy|MA": (42.2529, -71.0023),
    "watertown|MA": (42.3709, -71.1828), "malden|MA": (42.4251, -71.0662),
    "arlington|MA": (42.4154, -71.1565), "lexington|MA": (42.4473, -71.2245),
    "burlington|MA": (42.5048, -71.1956), "woburn|MA": (42.4793, -71.1523),
    "needham|MA": (42.2809, -71.2358), "dedham|MA": (42.2418, -71.1662),
    "framingham|MA": (42.2793, -71.4162), "natick|MA": (42.2834, -71.3495),
    "wellesley|MA": (42.2968, -71.2924), "chelsea|MA": (42.3917, -71.0328),
    "revere|MA": (42.4084, -71.0120), "everett|MA": (42.4084, -71.0537),
    "lowell|MA": (42.6334, -71.3162), "andover|MA": (42.6584, -71.1370),
    "marlborough|MA": (42.3459, -71.5523), "billerica|MA": (42.5584, -71.2689),
    "braintree|MA": (42.2079, -71.0040), "peabody|MA": (42.5279, -70.9287),
    "worcester|MA": (42.2626, -71.8023), "springfield|MA": (42.1015, -72.5898),
    "amherst|MA": (42.3732, -72.5199), "bedford|MA": (42.4906, -71.2760),
    "maynard|MA": (42.4334, -71.4495), "chelmsford|MA": (42.5998, -71.3673),
    "westborough|MA": (42.2695, -71.6162), "canton|MA": (42.1584, -71.1448),
    "norwood|MA": (42.1945, -71.1990), "boxborough|MA": (42.4910, -71.5287),
    "salem|MA": (42.5195, -70.8967), "new bedford|MA": (41.6362, -70.9342),
    "foxborough|MA": (42.0654, -71.2478), "tewksbury|MA": (42.6106, -71.2342),
    "wilmington|MA": (42.5465, -71.1737), "danvers|MA": (42.5750, -70.9301),
    # Rhode Island
    "providence|RI": (41.8240, -71.4128), "warwick|RI": (41.7001, -71.4162),
    "newport|RI": (41.4901, -71.3128), "cranston|RI": (41.7798, -71.4373),
    "pawtucket|RI": (41.8787, -71.3826), "kingston|RI": (41.4804, -71.5231),
    # Connecticut
    "hartford|CT": (41.7658, -72.6734), "new haven|CT": (41.3083, -72.9279),
    "stamford|CT": (41.0534, -73.5387), "greenwich|CT": (41.0262, -73.6282),
    "norwalk|CT": (41.1177, -73.4082), "bridgeport|CT": (41.1792, -73.1894),
    "westport|CT": (41.1415, -73.3579), "danbury|CT": (41.3948, -73.4540),
    "groton|CT": (41.3501, -72.0787), "windsor|CT": (41.8526, -72.6437),
    "farmington|CT": (41.7198, -72.8320), "storrs|CT": (41.8084, -72.2495),
    "wallingford|CT": (41.4570, -72.8231), "new london|CT": (41.3557, -72.0995),
    "east hartford|CT": (41.7823, -72.6120), "middletown|CT": (41.5623, -72.6506),
    "wilton|CT": (41.1954, -73.4379), "darien|CT": (41.0787, -73.4693),
    # New Hampshire
    "manchester|NH": (42.9956, -71.4548), "nashua|NH": (42.7654, -71.4676),
    "portsmouth|NH": (43.0718, -70.7626), "concord|NH": (43.2081, -71.5376),
    "hanover|NH": (43.7022, -72.2896), "lebanon|NH": (43.6423, -72.2518),
    "salem|NH": (42.7884, -71.2009), "bedford|NH": (42.9465, -71.5159),
    "durham|NH": (43.1340, -70.9264),
    # Maine
    "portland|ME": (43.6591, -70.2568), "bangor|ME": (44.8016, -68.7712),
    "augusta|ME": (44.3106, -69.7795), "south portland|ME": (43.6415, -70.2409),
    "westbrook|ME": (43.6770, -70.3712), "brunswick|ME": (43.9145, -69.9653),
    "orono|ME": (44.8831, -68.6719), "bath|ME": (43.9109, -69.8206),
    # Vermont
    "burlington|VT": (44.4759, -73.2121), "montpelier|VT": (44.2601, -72.5754),
    "south burlington|VT": (44.4669, -73.1709), "williston|VT": (44.4376, -73.0682),
    "rutland|VT": (43.6106, -72.9726), "brattleboro|VT": (42.8509, -72.5579),
    # New York (NYC metro + upstate, so upstate is a known "no")
    "new york|NY": (40.7128, -74.0060), "new york city|NY": (40.7128, -74.0060),
    "nyc|NY": (40.7128, -74.0060), "manhattan|NY": (40.7831, -73.9712),
    "brooklyn|NY": (40.6782, -73.9442), "queens|NY": (40.7282, -73.7949),
    "bronx|NY": (40.8448, -73.8648), "the bronx|NY": (40.8448, -73.8648),
    "staten island|NY": (40.5795, -74.1502), "long island city|NY": (40.7447, -73.9485),
    "white plains|NY": (41.0340, -73.7629), "yonkers|NY": (40.9312, -73.8988),
    "new rochelle|NY": (40.9115, -73.7824), "tarrytown|NY": (41.0762, -73.8587),
    "purchase|NY": (41.0409, -73.7146), "armonk|NY": (41.1265, -73.7140),
    "rye|NY": (40.9807, -73.6837), "harrison|NY": (40.9690, -73.7126),
    "sleepy hollow|NY": (41.0857, -73.8585), "valhalla|NY": (41.0748, -73.7757),
    "mount kisco|NY": (41.2043, -73.7271), "garden city|NY": (40.7268, -73.6343),
    "mineola|NY": (40.7493, -73.6407), "hempstead|NY": (40.7062, -73.6187),
    "uniondale|NY": (40.7004, -73.5929), "melville|NY": (40.7934, -73.4151),
    "hauppauge|NY": (40.8257, -73.2026), "great neck|NY": (40.8007, -73.7285),
    "jericho|NY": (40.7920, -73.5399), "bethpage|NY": (40.7443, -73.4821),
    "stony brook|NY": (40.9257, -73.1409), "ossining|NY": (41.1629, -73.8615),
    "yorktown heights|NY": (41.2709, -73.7776), "pearl river|NY": (41.0590, -74.0218),
    "suffern|NY": (41.1148, -74.1496), "poughkeepsie|NY": (41.7004, -73.9210),
    "albany|NY": (42.6526, -73.7562), "rochester|NY": (43.1566, -77.6088),
    "buffalo|NY": (42.8864, -78.8784), "syracuse|NY": (43.0481, -76.1474),
    "ithaca|NY": (42.4440, -76.5019), "binghamton|NY": (42.0987, -75.9180),
    "troy|NY": (42.7284, -73.6918), "schenectady|NY": (42.8142, -73.9396),
    # New Jersey
    "jersey city|NJ": (40.7178, -74.0431), "hoboken|NJ": (40.7439, -74.0324),
    "newark|NJ": (40.7357, -74.1724), "weehawken|NJ": (40.7695, -74.0204),
    "secaucus|NJ": (40.7895, -74.0565), "fort lee|NJ": (40.8509, -73.9701),
    "hackensack|NJ": (40.8859, -74.0435), "paramus|NJ": (40.9445, -74.0754),
    "morristown|NJ": (40.7968, -74.4815), "parsippany|NJ": (40.8579, -74.4260),
    "edison|NJ": (40.5187, -74.4121), "new brunswick|NJ": (40.4862, -74.4518),
    "piscataway|NJ": (40.5549, -74.4643), "princeton|NJ": (40.3573, -74.6672),
    "basking ridge|NJ": (40.7062, -74.5493), "bridgewater|NJ": (40.6004, -74.6482),
    "berkeley heights|NJ": (40.6834, -74.4271), "summit|NJ": (40.7157, -74.3646),
    "florham park|NJ": (40.7879, -74.3882), "short hills|NJ": (40.7479, -74.3254),
    "holmdel|NJ": (40.3451, -74.1840), "red bank|NJ": (40.3471, -74.0643),
    "iselin|NJ": (40.5754, -74.3224), "woodbridge|NJ": (40.5576, -74.2846),
    "rahway|NJ": (40.6082, -74.2776), "elizabeth|NJ": (40.6640, -74.2107),
    "montvale|NJ": (41.0468, -74.0229), "mahwah|NJ": (41.0887, -74.1438),
    "whippany|NJ": (40.8243, -74.4174), "east hanover|NJ": (40.8201, -74.3646),
    "madison|NJ": (40.7598, -74.4171), "murray hill|NJ": (40.6948, -74.4007),
    "plainsboro|NJ": (40.3337, -74.6002), "cranbury|NJ": (40.3162, -74.5138),
    "lawrenceville|NJ": (40.2973, -74.7296), "trenton|NJ": (40.2206, -74.7597),
    "camden|NJ": (39.9259, -75.1196), "cherry hill|NJ": (39.9348, -75.0307),
    "mount laurel|NJ": (39.9340, -74.8910),
    # Pennsylvania
    "philadelphia|PA": (39.9526, -75.1652), "pittsburgh|PA": (40.4406, -79.9959),
    "king of prussia|PA": (40.0893, -75.3963), "allentown|PA": (40.6084, -75.4902),
    "malvern|PA": (40.0362, -75.5138), "conshohocken|PA": (40.0793, -75.3016),
}

# Bare city names ("Stamford", "NYC") are only trusted when the name is unambiguous.
_AMBIGUOUS = {"portland", "burlington", "manchester", "cambridge", "salem", "springfield",
              "bedford", "windsor", "durham", "madison", "arlington", "concord", "lebanon",
              "bath", "harrison", "rye", "summit", "kingston", "newport", "plymouth", "canton",
              "elizabeth", "troy", "rochester", "princeton", "jericho", "melville", "newark",
              "hanover", "wilmington", "farmington", "middletown", "newton", "quincy",
              "lexington", "brunswick", "augusta", "camden", "everett", "danvers", "norwalk",
              "hempstead", "edison", "warwick", "cranston", "westport", "greenwich"}
_CITY_ONLY: dict[str, tuple[float, float, str]] = {}
for _k, _v in GAZETTEER.items():
    _c, _s = _k.split("|")
    if _c not in _AMBIGUOUS:
        _CITY_ONLY.setdefault(_c, (_v[0], _v[1], _s))

LOOKUP_STATES = {"NY", "NJ", "PA"}
CACHE_PATH = os.path.join(DATA_DIR, "geocache.json")
_cache: dict | None = None
_dirty = False
_lock = threading.Lock()
_last_call = 0.0
_budget = int(os.environ.get("INTERNSCOUT_GEOCODE_MAX", "150"))


def haversine_miles(lat1, lng1, lat2, lng2) -> float:
    r = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _load_cache() -> dict:
    global _cache
    if _cache is None:
        try:
            with open(CACHE_PATH, encoding="utf-8") as f:
                _cache = json.load(f)
        except (OSError, ValueError):
            _cache = {}
    return _cache


def save_cache() -> None:
    if not _dirty or _cache is None:
        return
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump(dict(sorted(_cache.items())), f, indent=0, separators=(",", ":"))


def locate(loc: str):
    """Return (lat, lng, state) with lat/lng possibly None, or None if nothing is known."""
    if not loc or _NON_US.search(loc):
        return None
    city, st = city_of(loc), state_of(loc)
    if st:
        hit = GAZETTEER.get(f"{city}|{st}")
        if hit:
            return hit[0], hit[1], st
        cached = _load_cache().get(f"{city}|{st}", False)
        if cached is not False:
            return (cached[0], cached[1], st) if cached else (None, None, st)
        if st in LOOKUP_STATES and os.environ.get("INTERNSCOUT_GEOCODE") == "1":
            coords = _nominatim(city, st)
            return (coords[0], coords[1], st) if coords else (None, None, st)
        return None, None, st
    if "," not in loc:  # a bare city name
        hit = _CITY_ONLY.get(city)
        if hit:
            return hit
    return None


def geocode(loc: str):
    hit = locate(loc)
    return (hit[0], hit[1]) if hit and hit[0] is not None else None


def _nominatim(city: str, st: str):
    global _dirty, _last_call, _budget
    key = f"{city}|{st}"
    with _lock:  # Nominatim policy: at most 1 request/second
        cache = _load_cache()
        if key in cache:
            return cache[key]
        if _budget <= 0 or not city or len(city) > 60:
            return None
        _budget -= 1
        wait = 1.1 - (time.monotonic() - _last_call)
        if wait > 0:
            time.sleep(wait)
        coords = None
        try:
            import httpx
            from .config import USER_AGENT
            r = httpx.get(
                "https://nominatim.openstreetmap.org/search",
                params={"city": city, "state": st, "country": "us", "format": "json", "limit": 1},
                headers={"User-Agent": USER_AGENT}, timeout=20.0,
            )
            data = r.json()
            if data:
                coords = [round(float(data[0]["lat"]), 4), round(float(data[0]["lon"]), 4)]
        except Exception:
            _last_call = time.monotonic()
            return None  # network trouble: don't cache, try again next run
        _last_call = time.monotonic()
        cache[key] = coords
        _dirty = True
        return coords
