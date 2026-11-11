"""Pure thresholds and overlap rules for listing pages."""

from __future__ import annotations

MIN_OPEN = 5  # no page for fewer open listings than this
# A field in one state needs more: at 5, 900 near-identical pages would be most of the site, the shape
# search engines treat as doorway pages. At 15 about 400 remain, each a list worth reading.
MIN_COMBO = 15
# ...counting only postings filed in fewer states than this. One employer posting the same role in
# 30 states would otherwise make 30 pages that differ only in the state's name.
SPREAD = 10
# Widened 2026-10-07: the field pages draw three times the click rate of the employer pages (Search
# Console, 28 days to 2026-10-07: 6.1% against 2.0%), so there are more field-in-a-place pages where
# students look. A field in a US metro (US_METRO_PAGES) gets a page at MIN_COMBO like a state; one of
# the fields the growth plan markets first (growth/README.md, "Primary: market now": these are those
# majors' tags in majors.json) in the Northeast, remote or a metro gets one at MIN_COMBO_PRIORITY. Every
# page these rules add must also be its own list: MIN_EMPLOYERS_NEW employers at least (not one
# employer's page under a place's name), and not near_same as a page already made (the field's own
# page, the field in the metro's state, or another field in the same place).
PRIORITY_FIELDS = frozenset(
    {
        "swe",
        "hardware",
        "data",
        "math",
        "finance",
        "operations",
        "supply_chain",
        "consulting",
        "hr",
        "industrial",
    }
)
PRIORITY_PLACES = frozenset(
    {"MA", "CT", "RI", "NH", "VT", "ME", "NY", "NJ", "PA", "remote"}
)  # and the metros
MIN_COMBO_PRIORITY = 10
MIN_EMPLOYERS_NEW = 3
# Two pages whose full role lists overlap this much (shared roles over all roles of either, so a page
# that holds 80% of a bigger one's roles is not "the same" until the bigger one is mostly it too) are
# one list to a reader. A page already live is folded only at SAME_SHARE, so one hovering at the line
# does not come and go between deploys (keep_at's reason).
NEAR_SAME = 0.8


def near_same(a: frozenset, b: frozenset, limit: float = NEAR_SAME) -> bool:
    return bool(a | b) and len(a & b) >= limit * len(a | b)


def keep_at(need: int) -> int:
    """A page that is already live stays until it falls to two thirds of what a new page needs, so a
    topic hovering at the line does not vanish and come back between deploys (a search engine that
    finds a URL gone drops it, and takes weeks to trust it again)."""
    return need * 2 // 3
