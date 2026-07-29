"""Central configuration. The three search inputs are parameters, not hardcoded."""
from __future__ import annotations
import os
from dataclasses import dataclass, field


@dataclass
class Profile:
    """The configurable search: field, term, location."""
    name: str = "CS/Quant · Summer 2027 · Boston"
    # field tags we keep (see classify.py for the tag vocabulary)
    # Accept every discipline the classifier knows (filter in the dashboard instead of
    # dropping at ingest). Narrow this tuple to restrict what gets collected.
    fields: tuple[str, ...] = ()          # empty = accept all
    # exact-target fields score highest; adjacent still surface, scored lower
    core_fields: tuple[str, ...] = ("swe", "quant")
    # term(s) to keep, as (season, year)
    terms: tuple[tuple[str, int], ...] = (("Summer", 2027),)
    # geo
    center_city: str = "Boston, MA"
    center_lat: float = 42.3601
    center_lng: float = -71.0589
    radius_miles: float = 30.0
    include_remote: bool = True
    include_other_us: bool = True   # keep US roles outside the metros (filter in the UI)
    # Metro areas to accept (name, lat, lng, radius_miles). Boston is home; NYC/Chicago/Miami
    # are the quant hubs. Trim this list to narrow the search.
    metros: tuple = (
        ("Boston", 42.3601, -71.0589, 40.0),
        ("New York", 40.7128, -74.0060, 40.0),
        ("Chicago", 41.8781, -87.6298, 40.0),
        ("Miami", 25.7617, -80.1918, 40.0),
        ("San Francisco", 37.7749, -122.4194, 45.0),
        ("Seattle", 47.6062, -122.3321, 35.0),
        ("Austin", 30.2672, -97.7431, 35.0),
        ("Los Angeles", 34.0522, -118.2437, 45.0),
        ("Washington DC", 38.9072, -77.0369, 40.0),
        ("Philadelphia", 39.9526, -75.1652, 35.0),
        ("Atlanta", 33.7490, -84.3880, 35.0),
        ("Denver", 39.7392, -104.9903, 35.0),
        ("Pittsburgh", 40.4406, -79.9959, 30.0),
        ("Dallas", 32.7767, -96.7970, 40.0),
        ("Houston", 29.7604, -95.3698, 40.0),
        ("San Diego", 32.7157, -117.1611, 35.0),
        ("Raleigh", 35.7796, -78.6382, 35.0),
        ("Minneapolis", 44.9778, -93.2650, 35.0),
        ("Phoenix", 33.4484, -112.0740, 35.0),
        ("Detroit", 42.3314, -83.0458, 35.0),
    )


# Active profile (edit here or override via the API /profile endpoint later).
PROFILE = Profile()

DB_PATH = os.environ.get("INTERNSCOUT_DB", os.path.join(os.path.dirname(os.path.dirname(__file__)), "internscout.db"))
DB_URL = f"sqlite:///{DB_PATH}"

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
    "Chicago, Illinois",
    "United States",          # broad sweep catches everything else
]

# SerpApi free tier = 100 searches/month. Each run uses at most this many searches;
# queries rotate between runs (by day) so the whole list gets covered over time.
GOOGLE_JOBS_MAX_SEARCHES = int(os.environ.get("SERPAPI_MAX_SEARCHES", "12"))
