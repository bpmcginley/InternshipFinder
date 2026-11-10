"""Population-ranked metro anchors and a persistent, budget-bounded search rotation.

The source is Census Vintage 2025 MSA population, not city-proper population.
Searching an anchor city does not establish complete coverage of an MSA boundary.
"""
from __future__ import annotations

import json
from pathlib import Path

CATALOG = json.loads(Path(__file__).with_name("us_top50_metros.json").read_text(encoding="utf-8"))
TOP_US_METROS = tuple(CATALOG["metros"])
METRO_QUERIES = ("internship", "co-op student", "summer student internship",
                 "undergraduate research internship")


def metro_searches(cursor: int, slots: int) -> list[tuple[str, str, str]]:
    """(query, location, CBSA) in order, moving query after every complete pass.

    Caller advances the cursor only after valid successful responses. Independent
    of calendar/run number, so skipped runs and quota failures cannot skip cities.
    """
    cursor = max(0, cursor)
    out = []
    for step in range(max(0, slots)):
        position = cursor + step
        metro = TOP_US_METROS[position % len(TOP_US_METROS)]
        query = METRO_QUERIES[(position // len(TOP_US_METROS)) % len(METRO_QUERIES)]
        out.append((query, metro["location"], metro["cbsa"]))
    return out
