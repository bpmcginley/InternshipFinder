"""The weekly email stays at 8 a.m. Eastern through daylight-saving changes."""
import importlib.util
import os
from datetime import date

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
_spec = importlib.util.spec_from_file_location(
    "digest_schedule", os.path.join(ROOT, "growth", "digest_schedule.py"))
digest_schedule = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(digest_schedule)


def test_the_noon_utc_slot_is_active_in_daylight_time_only():
    assert digest_schedule.active("0 12 * * 1", date(2026, 10, 26))
    assert not digest_schedule.active("0 13 * * 1", date(2026, 10, 26))


def test_the_one_pm_utc_slot_is_active_in_standard_time_only():
    assert not digest_schedule.active("0 12 * * 1", date(2026, 11, 2))
    assert digest_schedule.active("0 13 * * 1", date(2026, 11, 2))


def test_a_manual_run_is_never_suppressed_by_the_time_guard():
    assert digest_schedule.active("", date(2026, 11, 2))


def test_the_workflow_has_both_utc_slots_and_gates_every_effectful_step():
    workflow = open(os.path.join(ROOT, ".github", "workflows", "digest.yml"), encoding="utf-8").read()
    assert workflow.count('cron: "0 12 * * 1"') == 1
    assert workflow.count('cron: "0 13 * * 1"') == 1
    assert 'id: eastern-slot' in workflow
    assert workflow.count("steps.eastern-slot.outputs.run == 'true'") == 4
