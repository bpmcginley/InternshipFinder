import json

import pytest

from internscout.ingest_metrics import IngestMetrics


def test_complete_funnel_reconciles_filters_duplicates_and_export_carryover():
    m = IngestMetrics()
    m.count("fetched", 8, source="greenhouse")
    m.count("parsed", 6, source="greenhouse")
    m.reject("missing_identity", source="greenhouse")
    m.reject("not_student_opportunity", source="greenhouse")
    m.count("accepted", 4)
    m.reject("term_filter", stage="filter")
    m.reject("outside_region", stage="filter")
    m.count("unique", 3)
    m.count("persisted", 3)
    m.export_result(24, open_count=22, held=21, unplaced=1)
    report = m.as_dict()
    assert report["discrepancies"] == []
    assert report["deduplicated"] == 1
    assert report["export"] == {"total": 24, "open": 22, "held": 21, "unplaced": 1}
    assert report["by_source"]["greenhouse"]["rejected_normalize_missing_identity"] == 1


def test_missing_measurements_remain_unknown_and_dropped_records_surface():
    m = IngestMetrics()
    assert m.as_dict()["funnel"] == {}
    assert m.as_dict()["deduplicated"] is None
    assert m.as_dict()["export"] is None
    m.count("fetched", 7)
    m.count("parsed", 4)
    m.reject("dead_url")
    assert m.as_dict()["discrepancies"] == [{"between": ["fetched", "parsed"], "unaccounted": 2}]


def test_board_retries_replace_failure_and_empty_success_is_explicit(tmp_path):
    m = IngestMetrics()
    m.board_result("workday", "employer", "failed", cause="429")
    m.board_result("workday", "employer", "success", count=3)
    m.board_result("workday", "empty", "success")
    m.board_result("workday", "other", "failed", cause="ReadTimeout")
    m.board_result("workday", "restricted", "blocked", cause="RobotsDisallowed")
    path = tmp_path / "nested" / "metrics.json"
    m.write(path)
    report = json.loads(path.read_text())
    assert report["boards"]["workday"] == {
        "success": 2, "returned": 3, "empty_success": 1, "failed": 1, "blocked": 1,
    }
    assert len(report["board_failures"]) == 2
    assert {r["cause"] for r in report["board_failures"]} == {"ReadTimeout", "RobotsDisallowed"}


def test_reports_do_not_echo_arbitrary_urls_messages_or_board_tokens():
    m = IngestMetrics()
    secret = "https://user:password@example.com/?token=private"
    m.board_result(secret, secret, "failed", cause=secret)
    m.reject(secret, source=secret)
    m.count("fetched", source=secret)
    serialized = json.dumps(m.as_dict())
    assert "password" not in serialized
    assert "example.com" not in serialized
    assert "private" not in serialized
    assert "unknown" in serialized


@pytest.mark.parametrize("value", [-1, True, 1.5, "2"])
def test_invalid_counts_are_rejected(value):
    with pytest.raises(ValueError):
        IngestMetrics().count("fetched", value)


def test_unknown_stages_and_statuses_are_rejected():
    m = IngestMetrics()
    with pytest.raises(ValueError):
        m.count("fetchd")
    with pytest.raises(ValueError):
        m.reject("reason", stage="other")
    with pytest.raises(ValueError):
        m.board_result("workday", "board", "timed_out")
