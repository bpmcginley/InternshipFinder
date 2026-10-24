"""Paid listings (placements): resolve() keeps only placements that point at a listing the normal pipeline
already produced, and nothing in the pipeline, the scorer or the export can see them (B2 plan 4.4).
The rule: payment never changes a score, an order, a filter, a count or what Auto-Apply does."""
import json
import os
import subprocess
import sys

import pytest

from internscout import placements
from internscout.placements import resolve

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.join(HERE, "..", "internscout")
DAY = "2026-11-03"
URL = "https://jobs.example.com/acme/1"


def _listing(**over):
    x = {"id": "3f9c0a1b2c3d4e5f", "company_name": "Acme Robotics", "title": "Robotics Intern",
         "apply_url": URL, "status": "open", "insights": None, "restrictions": []}
    x.update(over)
    return x


def _pl(**over):
    p = {"id": "p-2026-11-acme-1", "listing_id": "3f9c0a1b2c3d4e5f", "apply_url": URL,
         "employer": "Acme Robotics", "start": "2026-11-01", "end": "2026-12-01", "page_cap": 1}
    p.update(over)
    return p


def _by_id(*rows):
    return {x["id"]: x for x in rows}


def test_a_good_placement_is_kept_with_public_fields_only():
    kept, dropped = resolve([_pl(paid_ref="INV-1", note="private", lead_id=12)], _by_id(_listing()), DAY)
    assert dropped == []
    assert kept == [{"id": "p-2026-11-acme-1", "listing_id": "3f9c0a1b2c3d4e5f", "apply_url": URL,
                     "employer": "Acme Robotics", "start": "2026-11-01", "end": "2026-12-01"}]
    assert placements.public(kept) == kept


@pytest.mark.parametrize("name,pl,over,reason", [
    ("listing gone", _pl(listing_id="0000000000000000"), {"apply_url": "https://jobs.example.com/acme/9"},
     "listing_gone"),
    ("closed", _pl(), {"status": "closed"}, "closed"),
    ("url changed", _pl(apply_url="https://jobs.example.com/acme/2"), {}, "url_changed"),
    ("deadline passed", _pl(), {"insights": {"deadline": "2026-11-02"}}, "deadline"),
    ("unpaid in insights", _pl(), {"insights": {"pay": "unpaid"}}, "unpaid"),
    ("unpaid restriction", _pl(), {"restrictions": ["unpaid"]}, "unpaid"),
    ("not started", _pl(start="2026-11-04"), {}, "dates"),
    ("ended today", _pl(end=DAY), {}, "dates"),
    ("no dates", _pl(start=None), {}, "malformed"),
    ("bad day", _pl(end="next week"), {}, "malformed"),
    ("no id", _pl(id=""), {}, "malformed"),
    ("id that could write a log command", _pl(id="x\n::error::boom"), {}, "malformed"),
    ("http link", _pl(apply_url="http://jobs.example.com/acme/1"), {}, "malformed"),
    ("not a dict", "p-1", {}, "malformed"),
])
def test_each_failing_case_is_dropped_with_its_reason(name, pl, over, reason):
    kept, dropped = resolve([pl], _by_id(_listing(**over)), DAY)
    assert kept == [], name
    assert [d["reason"] for d in dropped] == [reason], name


@pytest.mark.parametrize("name,pl,over", [
    ("trailing slash", _pl(apply_url=URL + "/"), {}),
    ("deadline today", _pl(), {"insights": {"deadline": DAY}}),
    ("deadline with a time", _pl(), {"insights": {"deadline": DAY + "T23:59:00"}}),
    ("starts today", _pl(start=DAY), {}),
    ("ends tomorrow", _pl(end="2026-11-04"), {}),
    ("paid restriction first", _pl(), {"restrictions": ["paid"], "insights": {"pay": "unpaid"}}),
    ("unpaid with Bruce's waiver", _pl(unpaid_ok=1), {"insights": {"pay": "unpaid"}}),
])
def test_cases_that_still_hold_are_kept(name, pl, over):
    kept, dropped = resolve([pl], _by_id(_listing(**over)), DAY)
    assert [p["id"] for p in kept] == [pl["id"]] and dropped == [], name


def test_the_unpaid_waiver_travels_with_the_placement_so_the_email_agrees():
    kept, _ = resolve([_pl(unpaid_ok=1)], _by_id(_listing(insights={"pay": "unpaid"})), DAY)
    assert placements.public(kept)[0]["unpaid_ok"] == 1
    again, _ = resolve(placements.public(kept), _by_id(_listing(insights={"pay": "unpaid"})), DAY, by_url=False)
    assert len(again) == 1


def test_the_worker_answer_carries_unpaid_ok_as_0_or_1():
    # GET /placements sends unpaid_ok on every placement since 2026-10-14 (worker/src/placements.js):
    # 0 keeps an unpaid listing out, 1 keeps it, and a paid role is kept either way, with no waiver in the file.
    unpaid = _by_id(_listing(insights={"pay": "unpaid"}))
    assert resolve([_pl(unpaid_ok=0, page_cap=1)], unpaid, DAY)[1][0]["reason"] == "unpaid"
    assert len(resolve([_pl(unpaid_ok=1, page_cap=1)], unpaid, DAY)[0]) == 1
    kept, _ = resolve([_pl(unpaid_ok=0, page_cap=1)], _by_id(_listing()), DAY)
    assert "unpaid_ok" not in placements.public(kept)[0]


def test_a_url_only_match_is_kept_with_a_warning_and_never_repointed_silently():
    moved = _listing(id="aaaaaaaaaaaaaaaa")             # the same role, a new id after a re-ingest
    kept, dropped = resolve([_pl()], _by_id(moved), DAY)
    assert dropped == [] and kept[0]["listing_id"] == "aaaaaaaaaaaaaaaa"
    lines = placements.warnings(kept, dropped)
    assert lines == ["::warning::placement p-2026-11-acme-1 matched by URL only; update its listing_id to aaaaaaaaaaaaaaaa"]
    assert "note" not in placements.public(kept)[0]
    # The email reads the already-resolved file, so it never matches by URL.
    assert resolve([_pl()], _by_id(moved), DAY, by_url=False)[0] == []


def test_a_url_only_match_needs_one_listing_and_the_same_company():
    a, b = _listing(id="aaaaaaaaaaaaaaaa"), _listing(id="bbbbbbbbbbbbbbbb")       # two listings share the URL
    assert resolve([_pl()], _by_id(a, b), DAY)[0] == []
    other = _listing(id="cccccccccccccccc", company_name="Other Co")             # never across companies
    kept, dropped = resolve([_pl()], _by_id(other), DAY)
    assert kept == [] and dropped[0]["reason"] == "listing_gone"
    assert resolve([_pl(employer="")], _by_id(_listing(id="aaaaaaaaaaaaaaaa")), DAY)[0] == []
    # Case and spacing in the company name do not matter.
    assert len(resolve([_pl(employer="acme  robotics")], _by_id(_listing(id="aaaaaaaaaaaaaaaa")), DAY)[0]) == 1


def test_a_placement_listed_twice_shows_once():
    kept, dropped = resolve([_pl(), _pl()], _by_id(_listing()), DAY)
    assert len(kept) == 1 and [d["reason"] for d in dropped] == ["duplicate"]


def test_warnings_name_only_ids_and_reasons():
    _, dropped = resolve([_pl(listing_id="0000000000000000"), {"id": "bad\nid"}],
                         _by_id(_listing(apply_url="https://jobs.example.com/acme/9")), DAY)
    assert placements.warnings([], dropped) == [
        "::warning::placement p-2026-11-acme-1 dropped: listing_gone (listing 0000000000000000)",
        "::warning::placement (unreadable) dropped: malformed"]


def test_resolve_writes_nothing_to_the_listings():
    x = _listing()
    before = json.dumps(x, sort_keys=True)
    resolve([_pl(), _pl(id="p-2", listing_id="nope000000000000")], _by_id(x), DAY)
    assert json.dumps(x, sort_keys=True) == before


def test_read_gives_an_empty_list_for_a_missing_or_malformed_file(tmp_path):
    assert placements.read(None) == [] and placements.read(str(tmp_path / "none.json")) == []
    f = tmp_path / "p.json"
    for bad in ("not json", "[]", '{"placements": "x"}', "null"):
        f.write_text(bad, encoding="utf-8")
        assert placements.read(str(f)) == []
    f.write_text('{"day": "2026-11-03", "placements": [1, null, {"id": "p-1"}]}', encoding="utf-8")
    assert placements.read(str(f)) == [{"id": "p-1"}]


# ---------------------------------------------------------------- no bypass

GUARDED = ("pipeline.py", "score.py", "export_static.py", "normalize.py", "dedupe.py", "run_ingest.py",
           "discover.py")


@pytest.mark.parametrize("name", GUARDED)
def test_the_pipeline_scorer_and_export_never_name_placements(name):
    with open(os.path.join(PKG, name), encoding="utf-8") as f:
        text = f.read()
    assert "placement" not in text.lower(), f"{name} mentions placements"


def test_importing_the_pipeline_never_loads_the_placements_module():
    # export_static imports seo_pages, which uses placements only inside its post-pass functions.
    code = ("import sys; import internscout.pipeline, internscout.score, internscout.export_static, "
            "internscout.normalize, internscout.dedupe, internscout.run_ingest, internscout.discover; "
            "print('internscout.placements' in sys.modules)")
    out = subprocess.run([sys.executable, "-c", code], cwd=os.path.join(HERE, ".."), capture_output=True,
                         text=True, check=True)
    assert out.stdout.strip() == "False"


# The keys a listing record carries. A new key fails here until someone adds it on purpose, so a field
# such as "sponsored" can never slip into the records the scorer and the filters read.
LISTING_KEYS = {"id", "company_name", "title", "field_tags", "sector", "stage", "years", "term", "salary",
                "duration", "posted_at", "location_raw", "is_remote", "state", "region_locations", "regions",
                "ats", "apply_url", "description", "status", "score_parts", "insights", "is_new", "first_seen",
                "scan_sources", "insights_text_version"}  # 2026-10-23: eligibility evidence revision, never paid rank
LISTING_OPTIONAL = {"via_search"}


def test_a_listing_record_has_exactly_the_allowed_keys():
    from internscout.export_static import _listing_dict
    from internscout.models import Listing
    row = Listing(company_name="Acme Robotics", title="Software Engineering Intern", dedupe_key="acme|swe|2027",
                  apply_url=URL, status="open", description="Pay is $25 an hour.", field_tags=["swe"],
                  stage=["internship"])
    keys = set(_listing_dict(row))
    assert LISTING_KEYS <= keys <= LISTING_KEYS | LISTING_OPTIONAL
    assert not any("placement" in k or "sponsor" in k or "promot" in k for k in keys)


def test_an_export_is_byte_identical_with_or_without_a_placements_file(tmp_path, monkeypatch):
    from datetime import datetime, timezone
    from types import SimpleNamespace
    from internscout import export_static

    class NoRows:                  # nothing fetched this run: the export carries the last one's rows
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def scalars(self, query):
            return SimpleNamespace(all=lambda: [])

    fixed = datetime(2026, 11, 3, 12, 0, tzinfo=timezone.utc)

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return fixed

    monkeypatch.setattr(export_static, "SessionLocal", NoRows)
    monkeypatch.setattr(export_static, "init_db", lambda: None)
    monkeypatch.setattr(export_static, "datetime", Clock)
    prev = [{"id": str(i), "apply_url": f"https://x/{i}", "ats": "workday", "company_name": "Stryker",
             "status": "open", "first_seen": "2026-10-20T00:00:00+00:00", "last_seen": "2026-11-03T00:00:00+00:00",
             "regions": [], "state": "MA", "title": "Summer Intern", "stage": ["internship"],
             "field_tags": ["mechanical"], "is_new": False, "posted_at": None} for i in range(4)]

    def run(folder, with_placements):
        out = tmp_path / folder
        (out / "listings").mkdir(parents=True)
        (out / "listings" / "MA.json").write_text(json.dumps(prev), encoding="utf-8")
        (out / "listings" / "index.json").write_text('{"files": {}}', encoding="utf-8")
        if with_placements:
            (out / "placements.json").write_text(json.dumps({"placements": [_pl(listing_id="0")]}), encoding="utf-8")
        export_static.export(str(out))
        files = {}
        for root, _, names in os.walk(out):
            for n in names:
                rel = os.path.relpath(os.path.join(root, n), out)
                if rel != "placements.json":
                    with open(os.path.join(root, n), "rb") as f:
                        files[rel] = f.read()
        return files

    without, with_ = run("a", False), run("b", True)
    assert without.keys() == with_.keys() and len(without) > 2
    assert [k for k in without if without[k] != with_[k]] == []
