"""Employer names and sectors that once went wrong in the board registry (2026-10-14)."""
import json
import os

from internscout import companies_seed

REGISTRY = os.path.join(os.path.dirname(__file__), "..", "data", "ats_registry.json")


def _greenhouse():
    with open(REGISTRY, encoding="utf-8") as f:
        return json.load(f)["greenhouse"]


def test_aclu_internships_board_is_the_national_aclu():
    # The acluinternships board carries ACLU internships in many states, not only Kentucky.
    entry = _greenhouse()["acluinternships"]
    assert entry["name"] == "ACLU"
    assert entry.get("sector") == "nonprofit"


def test_robinhood_the_trading_app_is_not_a_nonprofit():
    # The Greenhouse token "robinhood" is Robinhood Markets, not the Robin Hood foundation.
    assert _greenhouse()["robinhood"].get("sector") != "nonprofit"
    seeded = [c for c in companies_seed.GREENHOUSE if c["ats_token"].lower() == "robinhood"]
    assert seeded and all(c.get("sector") != "nonprofit" for c in seeded)
