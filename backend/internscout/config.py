"""Central configuration. The three search inputs are parameters, not hardcoded."""
from __future__ import annotations
import os
from dataclasses import dataclass, field
from datetime import date

# last month of each term; co-ops and part-time roles run outside summer
_TERM_END = {"Winter": 2, "Spring": 5, "Summer": 8, "Fall": 12, "Year-round": 12}


def open_terms(today: date | None = None) -> tuple[tuple[str, int], ...]:
    """Every (season, year) this year or next that hasn't ended yet."""
    today = today or date.today()
    return tuple((s, y) for y in (today.year, today.year + 1) for s, end in _TERM_END.items()
                 if (y, end) >= (today.year, today.month))


@dataclass
class Profile:
    """The configurable search: field, term, location."""
    name: str = "All fields · upcoming terms · United States"
    # field tags we keep (see classify.py for the tag vocabulary)
    # Accept every discipline the classifier knows (filter in the dashboard instead of
    # dropping at ingest). Narrow this tuple to restrict what gets collected.
    fields: tuple[str, ...] = ()          # empty = accept all
    # term(s) to keep, as (season, year)
    terms: tuple[tuple[str, int], ...] = field(default_factory=open_terms)
    # shown by the API/dashboard; the actual geo rule lives in REGION below
    center_city: str = "United States"
    radius_miles: float = 50.0
    include_remote: bool = True


@dataclass(frozen=True)
class Region:
    """Every US and US-remote role is kept. New England and the NYC metro (N miles of Midtown)
    are the baseline area, labeled separately and always given full detail fetches."""
    name: str = "United States"
    states: frozenset = frozenset({"ME", "NH", "VT", "MA", "RI", "CT"})
    nyc_center: tuple = (40.7580, -73.9855)
    nyc_radius_miles: float = 50.0
    include_remote: bool = True
    hubs: tuple = (("Boston", 42.3601, -71.0589), ("New York", 40.7580, -73.9855))


REGION = Region()

# Slow or paid work (per-job detail calls, Google Jobs searches) runs only for these states.
# CI adds the states students picked (the Worker's /demand counts) via INTERNSCOUT_WANTED_STATES.
BASELINE_STATES = frozenset({"MA", "CT", "RI", "NH", "VT", "ME", "NY", "NJ"})


def wanted_states() -> frozenset:
    extra = os.environ.get("INTERNSCOUT_WANTED_STATES", "")
    return BASELINE_STATES | {s.strip().upper() for s in extra.split(",") if len(s.strip()) == 2}

# Active profile (edit here or override via the API /profile endpoint later).
PROFILE = Profile()

DB_PATH = os.environ.get("INTERNSCOUT_DB", os.path.join(os.path.dirname(os.path.dirname(__file__)), "internscout.db"))
DB_URL = f"sqlite:///{DB_PATH}"
# Committed, auto-growing data: ATS board registry + geocode cache
DATA_DIR = os.environ.get("INTERNSCOUT_DATA", os.path.join(os.path.dirname(os.path.dirname(__file__)), "data"))
# Parallel board fetches per ingest run
FETCH_WORKERS = int(os.environ.get("INTERNSCOUT_WORKERS", "16"))

# Network etiquette
HTTP_TIMEOUT = 25.0
USER_AGENT = "InternScout/0.2 (student internship finder; +https://github.com/bpmcginley/InternshipFinder)"

# GitHub community lists (Tier 1). Each maps season->cycle year for that repo.
GITHUB_LISTS = [
    {
        "source": "vanshb03",
        "url": "https://raw.githubusercontent.com/vanshb03/Summer2027-Internships/dev/.github/scripts/listings.json",
        "cycle_years": {"Summer": 2027, "Fall": 2026, "Winter": 2027, "Spring": 2027},
    },
    {
        # SimplifyJobs' master list (the Summer2026 repo's file carries every current term)
        "source": "simplify",
        "url": "https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/.github/scripts/listings.json",
        "cycle_years": {"Summer": 2027, "Fall": 2026, "Winter": 2027, "Spring": 2027},
    },
]


# Google Jobs (SerpApi) search layer. Finds roles from companies NOT in the ATS registry.
# Set SERPAPI_KEY in the environment (GitHub Actions secret or local) to enable.
GOOGLE_JOBS_QUERIES = [
    # Google finds employers that aren't on a job board we scan, so these lean toward fields the
    # boards cover thinly (health, public service, arts, media, hospitality). One cluster per line;
    # the run number picks which ones run, so every cluster gets its turn.
    "nursing student internship",
    "hospital summer internship undergraduate",
    "public health internship 2027",
    "clinical research internship undergraduate",
    "government internship college student",
    "public policy fellowship undergraduate",
    "legal internship undergraduate",
    "nonprofit internship summer 2027",
    "social work practicum student",
    "education internship college student",
    "museum internship",
    "arts internship college student",
    "journalism internship 2027",
    "communications public relations internship",
    "hospitality internship summer 2027",
    "sports management internship",
    "environmental sustainability internship",
    "undergraduate research assistant summer",
    "psychology research internship undergraduate",
    "economics research internship",
    # Social sciences stayed the thinnest field on the coverage report (12 open listings in the
    # baseline states against a target of 15), and the employers that hire for it most - RTI,
    # NORC, Mathematica, Westat - are either closed to us by robots.txt or post nowhere we scan.
    "sociology anthropology internship",
    "survey research polling internship",
    "agriculture food science internship",
    "architecture design internship",
    "marketing internship summer 2027",
    "finance accounting internship summer 2027",
    "engineering co-op 2027",
    "data analyst internship 2027",
]
# Google Jobs is location-driven; one search per location per query (watch your SerpApi quota).
GOOGLE_JOBS_LOCATIONS = [
    "Boston, Massachusetts",
    "New York, New York",
    "Hartford, Connecticut",
    "Providence, Rhode Island",
    "Manchester, New Hampshire",
    "Portland, Maine",
    # NJ and VT are baseline states too, and had no metro here, so Google never searched them.
    # On the free 250-a-month plan the daily budget is 8 searches and each location gets one query,
    # so six locations left two unspent; these use them. (On a plan under 8 a day the locations
    # rotate by day, and each would come up every eighth day rather than every sixth.)
    "Newark, New Jersey",
    "Burlington, Vermont",
]
# The metro searched for each state students pick (baseline states are covered above).
STATE_METROS = {
    "AL": "Birmingham, Alabama", "AK": "Anchorage, Alaska", "AZ": "Phoenix, Arizona",
    "AR": "Little Rock, Arkansas", "CA": "San Francisco, California", "CO": "Denver, Colorado",
    "DE": "Wilmington, Delaware", "DC": "Washington, District of Columbia", "FL": "Miami, Florida",
    "GA": "Atlanta, Georgia", "HI": "Honolulu, Hawaii", "ID": "Boise, Idaho", "IL": "Chicago, Illinois",
    "IN": "Indianapolis, Indiana", "IA": "Des Moines, Iowa", "KS": "Wichita, Kansas",
    "KY": "Louisville, Kentucky", "LA": "New Orleans, Louisiana", "MD": "Baltimore, Maryland",
    "MI": "Detroit, Michigan", "MN": "Minneapolis, Minnesota", "MS": "Jackson, Mississippi",
    "MO": "St. Louis, Missouri", "MT": "Billings, Montana", "NE": "Omaha, Nebraska",
    "NV": "Las Vegas, Nevada", "NM": "Albuquerque, New Mexico", "NC": "Charlotte, North Carolina",
    "ND": "Fargo, North Dakota", "OH": "Columbus, Ohio", "OK": "Oklahoma City, Oklahoma",
    "OR": "Portland, Oregon", "PA": "Philadelphia, Pennsylvania", "SC": "Charleston, South Carolina",
    "SD": "Sioux Falls, South Dakota", "TN": "Nashville, Tennessee", "TX": "Dallas, Texas",
    "UT": "Salt Lake City, Utah", "VA": "Arlington, Virginia", "WA": "Seattle, Washington",
    "WV": "Charleston, West Virginia", "WI": "Milwaukee, Wisconsin", "WY": "Cheyenne, Wyoming",
    "PR": "San Juan, Puerto Rico",
}


def google_jobs_locations() -> list[str]:
    """Baseline metros first, then one metro per extra wanted state."""
    extra = sorted(s for s in wanted_states() - BASELINE_STATES if s in STATE_METROS)
    return GOOGLE_JOBS_LOCATIONS + [STATE_METROS[s] for s in extra]

# SerpApi free tier = 250 searches/month. Google Jobs runs once a day and spends the plan evenly
# (searches_per_month / 31, read from SerpApi's free Account API), never more than this cap;
# queries rotate between runs so the whole list gets covered over time.
GOOGLE_JOBS_MAX_SEARCHES = int(os.environ.get("SERPAPI_MAX_SEARCHES", "12"))
