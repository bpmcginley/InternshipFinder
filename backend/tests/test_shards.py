"""Nationwide labels, demand-gated detail calls, sharded export and the coverage report."""
import json
import os
from internscout.classify import ALL_FIELDS
from internscout.coverage import CLUSTERS, counts
from internscout.export_static import shard_keys, write_shards
from internscout.region import evaluate_locations, maybe_in_region


def _listing(i, locs, status="open", tags=("health",)):
    ev = evaluate_locations(locs)
    return {"id": i, "regions": ev["regions"], "state": ev["state"], "status": status,
            "field_tags": list(tags), "stage": ["internship"]}


def test_kinds():
    kinds = lambda locs: [(g["kind"], g["state"]) for g in evaluate_locations(locs)["regions"]]
    assert kinds(["Philadelphia, PA"]) == [("us", "PA")]
    assert kinds(["Remote, TX"]) == [("remote", "TX")]
    assert kinds(["United States"]) == [("us", None)]
    assert kinds(["Chicago"]) == [("us", "IL")]
    g = evaluate_locations(["Austin, TX"])
    assert g["in_region"] and g["on_site"] and not g["within_radius"] and g["state"] == "TX"


def test_detail_calls_follow_demand(monkeypatch):
    monkeypatch.delenv("INTERNSCOUT_WANTED_STATES", raising=False)
    assert maybe_in_region("Boston, MA") and maybe_in_region("Jersey City, NJ")
    assert maybe_in_region("Remote - US") and maybe_in_region("3 Locations")
    assert not maybe_in_region("Austin, TX") and not maybe_in_region("Remote, TX")
    assert not maybe_in_region("London, UK")
    monkeypatch.setenv("INTERNSCOUT_WANTED_STATES", "tx, FL")
    assert maybe_in_region("Austin, TX") and maybe_in_region("Miami, FL")


def test_google_locations_follow_demand(monkeypatch):
    from internscout.config import google_jobs_locations, GOOGLE_JOBS_LOCATIONS
    monkeypatch.delenv("INTERNSCOUT_WANTED_STATES", raising=False)
    assert google_jobs_locations() == GOOGLE_JOBS_LOCATIONS
    monkeypatch.setenv("INTERNSCOUT_WANTED_STATES", "CA,MA")
    assert google_jobs_locations() == GOOGLE_JOBS_LOCATIONS + ["San Francisco, California"]


def test_each_listing_in_exactly_its_files(tmp_path):
    listings = [
        _listing(1, ["Boston, MA", "Austin, TX"]),
        _listing(2, ["Remote - US"]),
        _listing(3, ["Remote, TX"]),
        _listing(4, ["United States"], status="closed"),
        _listing(5, ["New York, NY; Remote"]),
    ]
    assert shard_keys(listings[0]) == {"MA", "TX"}
    assert shard_keys(listings[4]) == {"NY", "remote"}
    stale = tmp_path / "listings"
    stale.mkdir()
    (stale / "WY.json").write_text("[]")
    index = write_shards(listings, str(tmp_path), "now")
    assert set(index["files"]) == {"MA", "TX", "remote", "US", "NY"}
    assert not (stale / "WY.json").exists()
    for x in listings:
        homes = {k for k in index["files"]
                 if x["id"] in [y["id"] for y in json.loads((stale / f"{k}.json").read_text(encoding="utf-8"))]}
        assert homes == shard_keys(x), x["id"]
    assert index["files"]["TX"]["count"] == 2 and index["files"]["US"]["open"] == 0
    assert index["files"]["MA"]["by_field"] == {"health": 1}


def test_coverage():
    known = set(ALL_FIELDS)
    for name, tags in CLUSTERS.items():
        assert set(tags) <= known, (name, set(tags) - known)
    c = counts([_listing(1, ["Boston, MA"]), _listing(2, ["Austin, TX"]), _listing(3, ["Remote"])])
    assert c["Health"] == 2
