"""Central configuration. The three search inputs are parameters, not hardcoded."""
from __future__ import annotations
import os
from dataclasses import dataclass, field


@dataclass
class Profile:
    """The configurable search: field, term, location."""
    name: str = "CS/Quant · Summer 2027 · Boston"
    # field tags we keep (see classify.py for the tag vocabulary)
    fields: tuple[str, ...] = ("swe", "quant", "data", "ml")
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
    {
        "source": "speedyapply",
        "url": "https://raw.githubusercontent.com/speedyapply/2027-SWE-College-Jobs/main/.github/scripts/listings.json",
        "cycle_years": {"Summer": 2027, "Fall": 2026, "Winter": 2027, "Spring": 2027},
    },
]
