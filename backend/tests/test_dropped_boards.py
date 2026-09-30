"""A board pruned from the registry stays out for a while instead of being rediscovered the next day."""
import json
from datetime import date

from internscout import discover
from internscout.discover import (MAX_FAILS, add_board, discover as discover_items, kept_out, prune,
                                  record_closed, record_result, save_registry)


def _fail_out(reg, ats, token):
    for d in range(1, MAX_FAILS + 1):
        record_result(reg, ats, token, False, today=date(2026, 9, d))


def test_a_pruned_board_is_not_rediscovered_from_an_old_apply_link():
    reg = {"greenhouse": {"gone": {"name": "Gone"}}}
    _fail_out(reg, "greenhouse", "gone")
    assert prune(reg) == 1 and reg["greenhouse"] == {}
    # The GitHub lists still carry the old link the next morning.
    item = {"company_name": "Gone", "apply_url": "https://job-boards.greenhouse.io/gone/jobs/1"}
    assert discover_items(reg, [item]) == 0
    assert reg["greenhouse"] == {}
    assert discover.refused_count() == 1


def test_a_dropped_board_may_come_back_after_the_keep_out_period():
    reg = {"lever": {"acme": {"name": "Acme"}}}
    _fail_out(reg, "lever", "acme")
    prune(reg, today=date(2026, 9, 5))
    later = date(2026, 9, 5).toordinal() + discover.KEEP_OUT["dead"]
    assert kept_out("lever", "ACME", today=date(2026, 9, 6))           # case does not matter
    assert not kept_out("lever", "acme", today=date.fromordinal(later))


def test_a_robots_closure_drops_the_board_at_once_and_for_longer():
    reg = {"smartrecruiters": {"Acme1": {"name": "Acme"}}}
    record_closed(reg, "smartrecruiters", "Acme1")
    assert prune(reg, today=date(2026, 9, 30)) == 1
    hit = discover._DROPPED["smartrecruiters"]["acme1"]
    assert hit == {"on": "2026-09-30", "why": "robots"}
    assert discover.KEEP_OUT["robots"] > discover.KEEP_OUT["dead"]


def test_a_board_already_registered_is_untouched_and_other_boards_still_come_in():
    reg = {"ashby": {}}
    discover._DROPPED["ashby"] = {"old": {"on": date.today().isoformat(), "why": "dead"}}
    assert add_board(reg, "ashby", "new", "New Co")
    assert not add_board(reg, "ashby", "old", "Old Co")
    assert list(reg["ashby"]) == ["new"]


def test_the_list_is_saved_with_the_registry_and_expired_entries_are_let_go(monkeypatch, tmp_path):
    monkeypatch.setattr(discover, "REGISTRY_PATH", str(tmp_path / "ats_registry.json"))
    discover._DROPPED.update({"greenhouse": {"recent": {"on": date.today().isoformat(), "why": "dead"},
                                             "ancient": {"on": "2020-01-01", "why": "dead"}}})
    save_registry({"greenhouse": {"live": {"name": "Live", "fails": 0}}})
    with open(discover.DROPPED_PATH, encoding="utf-8") as f:
        saved = json.load(f)
    assert list(saved["greenhouse"]) == ["recent"]
    discover._DROPPED.clear()
    assert discover.load_registry() == {"greenhouse": {"live": {"name": "Live", "fails": 0}}}
    assert kept_out("greenhouse", "recent")


def test_a_damaged_list_is_treated_as_empty(tmp_path):
    with open(discover.DROPPED_PATH, "w", encoding="utf-8") as f:
        f.write("{not json")
    assert discover.load_dropped() == {}
