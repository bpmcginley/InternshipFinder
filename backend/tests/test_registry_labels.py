"""Employer names and sectors that once went wrong in the board registry (2026-10-14)."""

from pathlib import Path

import pytest

from internscout import companies_seed, discover

REGISTRY_FIXTURE = Path(__file__).parent / "fixtures" / "registry_labels.json"


@pytest.fixture
def greenhouse(monkeypatch, tmp_path):
    monkeypatch.setattr(discover, "REGISTRY_PATH", str(REGISTRY_FIXTURE))
    monkeypatch.setattr(discover, "DROPPED_PATH", str(tmp_path / "dropped_boards.json"))
    monkeypatch.setattr(discover, "_DROPPED", {})
    monkeypatch.setattr(discover, "_REFUSED", [0])
    registry = discover.load_registry()
    discover.seed_registry(registry)
    return registry["greenhouse"]


def test_aclu_internships_board_is_the_national_aclu(greenhouse):
    # The acluinternships board carries ACLU internships in many states, not only Kentucky.
    entry = greenhouse["acluinternships"]
    assert entry["name"] == "ACLU"
    assert entry.get("sector") == "nonprofit"


def test_robinhood_the_trading_app_is_not_a_nonprofit(greenhouse):
    # The Greenhouse token "robinhood" is Robinhood Markets, not the Robin Hood foundation.
    assert greenhouse["robinhood"].get("sector") != "nonprofit"
    seeded = [c for c in companies_seed.GREENHOUSE if c["ats_token"].lower() == "robinhood"]
    assert seeded and all(c.get("sector") != "nonprofit" for c in seeded)


def test_axon_talent_community_is_not_renderatl(greenhouse):
    # 2026-10-27: the board's live advert says "Axon's AfroTech recruiting experience" and
    # "Join Axon". The old RenderATL label put another company on a current Axon listing.
    # Revert: remove this guard only if Axon moves the token to a different employer.
    assert greenhouse["axontalentcommunity"]["name"] == "Axon"
