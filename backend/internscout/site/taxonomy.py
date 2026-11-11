"""The existing field and place vocabulary used to select and label pages."""

from __future__ import annotations

import hashlib
import re


US_STATES = {
    "AL": "Alabama",
    "AK": "Alaska",
    "AZ": "Arizona",
    "AR": "Arkansas",
    "CA": "California",
    "CO": "Colorado",
    "CT": "Connecticut",
    "DE": "Delaware",
    "DC": "Washington, DC",
    "FL": "Florida",
    "GA": "Georgia",
    "HI": "Hawaii",
    "ID": "Idaho",
    "IL": "Illinois",
    "IN": "Indiana",
    "IA": "Iowa",
    "KS": "Kansas",
    "KY": "Kentucky",
    "LA": "Louisiana",
    "ME": "Maine",
    "MD": "Maryland",
    "MA": "Massachusetts",
    "MI": "Michigan",
    "MN": "Minnesota",
    "MS": "Mississippi",
    "MO": "Missouri",
    "MT": "Montana",
    "NE": "Nebraska",
    "NV": "Nevada",
    "NH": "New Hampshire",
    "NJ": "New Jersey",
    "NM": "New Mexico",
    "NY": "New York",
    "NC": "North Carolina",
    "ND": "North Dakota",
    "OH": "Ohio",
    "OK": "Oklahoma",
    "OR": "Oregon",
    "PA": "Pennsylvania",
    "RI": "Rhode Island",
    "SC": "South Carolina",
    "SD": "South Dakota",
    "TN": "Tennessee",
    "TX": "Texas",
    "UT": "Utah",
    "VT": "Vermont",
    "VA": "Virginia",
    "WA": "Washington",
    "WV": "West Virginia",
    "WI": "Wisconsin",
    "WY": "Wyoming",
    "PR": "Puerto Rico",
    "remote": "Remote (US)",
}
# Canada since 2026-09-30. A province is filed like a state (none of the codes is a US state's), and
# three more kinds of page are made from the same listings: all of Canada, and each big metro, since
# "internships in Toronto" is searched far more than "internships in Ontario". The metros are the
# ones geo.CA_METROS groups towns under; smaller ones still count toward their province.
CA_PROVINCES = {
    "ON": "Ontario",
    "QC": "Quebec",
    "BC": "British Columbia",
    "AB": "Alberta",
    "MB": "Manitoba",
    "SK": "Saskatchewan",
    "NS": "Nova Scotia",
    "NB": "New Brunswick",
    "NL": "Newfoundland and Labrador",
    "PE": "Prince Edward Island",
    "NT": "Northwest Territories",
    "NU": "Nunavut",
    "YT": "Yukon",
}
CA_METRO_PAGES = {
    "Toronto": "ON",
    "Montreal": "QC",
    "Vancouver": "BC",
    "Calgary": "AB",
    "Ottawa": "ON",
    "Edmonton": "AB",
    "Waterloo Region": "ON",
}
# US cities since 2026-10-07. Search Console's field queries read "<field> internships in <place>", and
# students name the city ("software engineering internships nyc") at least as often as the state. The
# export carries a metro only for Canada (geo.CA_METROS), so a US region is in one of these when it is
# filed in the metro's state and its location names one of the metro's towns; New York City also needs
# the region's own nyc_metro kind (region.py: within 50 miles of Midtown), so "Rochester, New York" is
# not in it. The towns are the ones the listings name (2026-10-07 export) within a short commute of the
# city. Boston is the inner ring, not eastern Massachusetts: drawn that wide it held 89% of the
# Massachusetts page's roles, the same list under a second URL (see near_same).
US_METRO_PAGES = {
    "New York City": (
        "NY",
        "new york|nyc|manhattan|brooklyn|queens|bronx|staten island|long island city",
    ),
    "Boston": (
        "MA",
        "boston|cambridge|somerville|brookline|newton|watertown|waltham|medford|malden|everett|"
        "chelsea|revere|quincy|arlington|belmont|needham|dedham|wellesley|lexington|burlington|"
        "woburn|winchester|milton|braintree|canton|norwood|westwood|bedford|hanscom",
    ),
    "San Francisco Bay Area": (
        "CA",
        "san francisco|sf|oakland|berkeley|emeryville|alameda|san jose|palo alto|"
        "mountain view|sunnyvale|santa clara|cupertino|menlo park|redwood city|"
        "redwood shores|san mateo|foster city|south san francisco|san bruno|burlingame|"
        "san carlos|belmont|brisbane|millbrae|fremont|newark|milpitas|los gatos|campbell|"
        "pleasanton|livermore|dublin|san ramon|walnut creek|hayward|union city",
    ),
    "Los Angeles": (
        "CA",
        "los angeles|santa monica|el segundo|culver city|playa vista|venice|marina del rey|"
        "long beach|torrance|hawthorne|manhattan beach|redondo beach|carson|inglewood|burbank|"
        "glendale|pasadena|west hollywood|beverly hills|van nuys|northridge|seal beach|irvine|"
        "costa mesa|huntington beach|santa ana|anaheim|newport beach",
    ),
    "Seattle": (
        "WA",
        "seattle|bellevue|redmond|kirkland|bothell|renton|tukwila|kent|everett|mukilteo|issaquah|"
        "auburn|seatac|tacoma|puyallup|lynnwood",
    ),
    "Chicago": (
        "IL",
        "chicago|evanston|skokie|niles|glenview|northbrook|northfield|deerfield|lake forest|rosemont|"
        "des plaines|schaumburg|rolling meadows|hoffman estates|elk grove village|itasca|naperville|"
        "lisle|downers grove|oak brook|oakbrook terrace|westchester|lombard|warrenville|abbott park|"
        "north chicago|waukegan|wood dale|bolingbrook|aurora|batavia",
    ),
    "Austin": ("TX", "austin|round rock|cedar park|georgetown|pflugerville|taylor|leander"),
    "Dallas–Fort Worth": (
        "TX",
        "dallas|fort worth|ft\\.? worth|plano|irving|richardson|frisco|arlington|addison|"
        "carrollton|coppell|westlake|grapevine|lewisville|mckinney|allen|garland|grand prairie|"
        "north richland hills|las colinas|denton|southlake",
    ),
    "Houston": (
        "TX",
        "houston|the woodlands|spring|sugar land|katy|pasadena|pearland|baytown|deer park|la porte|"
        "texas city|kingwood|humble|cypress|conroe|galveston",
    ),
    "Atlanta": (
        "GA",
        "atlanta|atl|alpharetta|duluth|dunwoody|suwanee|johns creek|kennesaw|norcross|marietta|"
        "sandy springs|buford|peachtree corners|lawrenceville|roswell|smyrna|decatur",
    ),
    "Denver": (
        "CO",
        "denver|boulder|golden|westminster|lakewood|centennial|broomfield|lone tree|greenwood village|"
        "littleton|englewood|louisville|lafayette|aurora|arvada|thornton|highlands ranch|longmont|superior",
    ),
    "Philadelphia": (
        "PA",
        "philadelphia|king of prussia|conshohocken|malvern|wayne|radnor|bala cynwyd|ardmore|exton|"
        "fort washington|horsham|blue bell|collegeville|spring house|west point|plymouth meeting|"
        "ridley park|west chester|newtown square|berwyn",
    ),
    "Pittsburgh": (
        "PA",
        "pittsburgh|canonsburg|cranberry|coraopolis|moon township|warrendale|murrysville|"
        "bridgeville|wexford",
    ),
}
_US_METRO_TOWNS = {
    m: re.compile(rf"\b(?:{towns})\b", re.I) for m, (_, towns) in US_METRO_PAGES.items()
}
# Every metro page's state or province: the dashboard opens on it, and a page names a town without it.
METRO_STATE = {**CA_METRO_PAGES, **{m: st for m, (st, _) in US_METRO_PAGES.items()}}


def us_metro(g: dict, *, metro_towns=_US_METRO_TOWNS) -> str | None:
    """The US metro (US_METRO_PAGES) a region is in, or None."""
    for m, (st, _) in US_METRO_PAGES.items():
        if (
            g.get("state") == st
            and (m != "New York City" or g.get("kind") == "nyc_metro")
            and metro_towns[m].search(str(g.get("loc") or ""))
        ):
            return m
    return None


US_STATES.update(CA_PROVINCES)
US_STATES.update(
    {"Canada": "Canada", **{m: m for m in CA_METRO_PAGES}, **{m: m for m in US_METRO_PAGES}}
)
CANADA_KEYS = set(CA_PROVINCES) | {"Canada"}
# was: set(US_STATES) - {"remote"}. "Canada" and the metros are views over the provinces, not places
# a posting is filed in, so they do not count toward how widely a posting is spread.
# was: ... - set(CA_METRO_PAGES); the US metros (2026-10-07) are views over their states the same way.
PLACES = (
    set(US_STATES) - {"remote", "Canada"} - set(METRO_STATE)
)  # the states a posting can be filed in

# How a field tag reads in a heading and in a URL. Tags not listed read as their own words.
FIELD_TITLES = {
    "swe": ("Software Engineering", "software-engineering"),
    "ml": ("Machine Learning and AI", "machine-learning-ai"),
    "data": ("Data Science and Analytics", "data-science"),
    "pm": ("Product Management", "product-management"),
    "hr": ("Human Resources", "human-resources"),
    "quant": ("Quantitative Finance", "quantitative-finance"),
    "security": ("Cybersecurity", "cybersecurity"),
    "hardware": ("Hardware Engineering", "hardware-engineering"),
    "electrical": ("Electrical Engineering", "electrical-engineering"),
    "mechanical": ("Mechanical Engineering", "mechanical-engineering"),
    "civil": ("Civil Engineering", "civil-engineering"),
    "aerospace": ("Aerospace Engineering", "aerospace-engineering"),
    "chemical": ("Chemical Engineering", "chemical-engineering"),
    "industrial": ("Industrial Engineering", "industrial-engineering"),
    "environmental": ("Environmental Science and Engineering", "environmental"),
    "biomedical": ("Biomedical Engineering", "biomedical-engineering"),
    "materials": ("Materials Science", "materials-science"),
    "supply_chain": ("Supply Chain", "supply-chain"),
    "public_health": ("Public Health", "public-health"),
    "clinical_research": ("Clinical Research", "clinical-research"),
    "lab_research": ("Lab Research", "lab-research"),
    "real_estate": ("Real Estate", "real-estate"),
    "social_work": ("Social Work", "social-work"),
    "social_science": ("Social Science", "social-science"),
    "urban_planning": ("Urban Planning", "urban-planning"),
    "business": ("Business", "business"),
    "law": ("Law and Legal", "law"),
    "government": ("Government and Public Policy", "government"),
    "sports": ("Sports", "sports"),
    "arts": ("Arts", "arts"),
    "museums": ("Museums", "museums"),
    "library": ("Library Science", "library-science"),
}
SKIP_FIELDS = {"other"}
# The long field titles as a title tag can carry them when the full one won't fit beside a state
# ("Environmental Science and Engineering Internships in Pennsylvania" is 65 characters on its own).
# Each is what students search for; fit_title falls back to it only when the full title is too long.
FIELD_SHORT = {
    "ml": "Machine Learning",
    "data": "Data Science",
    "environmental": "Environmental",
    "government": "Government",
    "law": "Law",
}


def field_title(tag: str, *, field_titles=FIELD_TITLES) -> str:
    return field_titles.get(tag, (tag.replace("_", " ").title(), None))[0]


def field_short(tag: str, *, field_titles=FIELD_TITLES, short_fields=FIELD_SHORT) -> str:
    return short_fields.get(tag, field_title(tag))


SLUG_MAX = 80  # longest slug a URL folder gets (see slugify)


def slugify(text: str, *, limit=SLUG_MAX) -> str:
    """URL-safe words. A job board's company name can run to hundreds of characters, and a folder
    name past the filesystem's 255 bytes is an OSError that stopped the whole deploy. A long slug is
    cut to limit and ends in a hash of the whole one, so two long names that share their first 70
    characters still get two folders, and the same name gets the same folder on every build."""
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    # was: return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    if len(slug) <= limit:
        return slug
    return slug[: limit - 9].rstrip("-") + "-" + hashlib.sha1(slug.encode()).hexdigest()[:8]


def field_slug(tag: str, *, field_titles=FIELD_TITLES, slug=slugify) -> str:
    return field_titles.get(tag, (None, None))[1] or slug(tag)


def state_slug(key: str, *, places=US_STATES, slug=slugify) -> str:
    return slug(places.get(key, key))


PLACE_THE = frozenset({"San Francisco Bay Area", "NT"})


def in_place(k: str, *, article_places=PLACE_THE, places=US_STATES) -> str:
    """ "in Boston", "in the San Francisco Bay Area": a place after "in", as a sentence or title says it."""
    return f"in {'the ' if k in article_places else ''}{places[k]}"


def _dash_state(state: str, *, provinces=CA_PROVINCES, metro_state=METRO_STATE) -> str:
    """The dashboard has state and province files, not metro or all-Canada ones: a metro opens its state
    or province, and Canada every province and the no-province file."""
    if state == "Canada":
        return ",".join(list(provinces) + ["Canada"])
    return ",".join(
        metro_state.get(s, s) for s in state.split(",")
    )  # was: CA_METRO_PAGES.get(s, s)
