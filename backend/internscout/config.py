"""Central configuration. The three search inputs are parameters, not hardcoded."""
from __future__ import annotations
import os
from dataclasses import dataclass, field


@dataclass
class Profile:
    """The configurable search: field, term, location."""
    name: str = "All fields · Summer 2027 · New England + NYC"
    # field tags we keep (see classify.py for the tag vocabulary)
    # Accept every discipline the classifier knows (filter in the dashboard instead of
    # dropping at ingest). Narrow this tuple to restrict what gets collected.
    fields: tuple[str, ...] = ()          # empty = accept all
    # exact-target fields score highest; adjacent still surface, scored lower
    core_fields: tuple[str, ...] = ("swe", "quant")
    # term(s) to keep, as (season, year)
    terms: tuple[tuple[str, int], ...] = (("Summer", 2027),)
    # shown by the API/dashboard; the actual geo rule lives in REGION below
    center_city: str = "New England + NYC metro"
    radius_miles: float = 50.0
    include_remote: bool = True


@dataclass(frozen=True)
class Region:
    """Where roles must be: New England states, within N miles of Midtown, or US-remote."""
    name: str = "New England + NYC metro"
    states: frozenset = frozenset({"ME", "NH", "VT", "MA", "RI", "CT"})
    nyc_center: tuple = (40.7580, -73.9855)
    nyc_radius_miles: float = 50.0
    include_remote: bool = True
    hubs: tuple = (("Boston", 42.3601, -71.0589), ("New York", 40.7580, -73.9855))


REGION = Region()

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
USER_AGENT = "InternScout/0.1 (personal internship finder; contact: brucepmcginley@gmail.com)"

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
    # computing / quant
    "software engineer intern summer 2027",
    "software engineering internship 2027",
    "quantitative researcher intern summer 2027",
    "quantitative developer intern summer 2027",
    "quantitative trading intern summer 2027",
    "machine learning intern summer 2027",
    "data science intern summer 2027",
    "data engineering intern summer 2027",
    "cybersecurity intern summer 2027",
    "cloud infrastructure intern summer 2027",
    "product management intern summer 2027",
    "computer science internship summer 2027",
    # engineering
    "electrical engineering intern summer 2027",
    "mechanical engineering intern summer 2027",
    "civil engineering intern summer 2027",
    "aerospace engineering intern summer 2027",
    "chemical engineering intern summer 2027",
    "biomedical engineering intern summer 2027",
    "industrial engineering intern summer 2027",
    "hardware engineering intern summer 2027",
    # science / math / health
    "biology research intern summer 2027",
    "chemistry intern summer 2027",
    "physics research intern summer 2027",
    "mathematics statistics intern summer 2027",
    "public health intern summer 2027",
    "clinical research intern summer 2027",
    # business / finance / other
    "finance intern summer 2027",
    "investment banking summer analyst 2027",
    "accounting intern summer 2027",
    "consulting intern summer 2027",
    "marketing intern summer 2027",
    "human resources intern summer 2027",
    "supply chain intern summer 2027",
    "economics research intern summer 2027",
    "ux design intern summer 2027",
    "legal intern summer 2027",
    "journalism media intern summer 2027",
    "architecture intern summer 2027",
]
# Google Jobs is location-driven; one search per location per query (watch your SerpApi quota).
GOOGLE_JOBS_LOCATIONS = [
    "Boston, Massachusetts",
    "New York, New York",
    "Hartford, Connecticut",
    "Providence, Rhode Island",
    "Manchester, New Hampshire",
    "Portland, Maine",
]

# SerpApi free tier = 100 searches/month. Each run uses at most this many searches;
# queries rotate between runs (by day) so the whole list gets covered over time.
GOOGLE_JOBS_MAX_SEARCHES = int(os.environ.get("SERPAPI_MAX_SEARCHES", "12"))
