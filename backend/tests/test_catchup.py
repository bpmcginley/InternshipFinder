"""growth/catchup.py: start the jobs GitHub's scheduler is late with, and let only one of each run."""
import importlib.util
import os
import sys
from datetime import datetime, timedelta, timezone

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
_spec = importlib.util.spec_from_file_location("catchup", os.path.join(ROOT, "growth", "catchup.py"))
cu = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cu)

TUE = datetime(2026, 9, 29, 16, 4, tzinfo=timezone.utc)      # a Tuesday, just after the post hour


def _run(i, created, status="completed", conclusion="success"):
    return {"id": i, "created_at": created.strftime("%Y-%m-%dT%H:%M:%SZ"), "status": status,
            "conclusion": conclusion}


def _jobs(ran: set):
    """jobs_of for tests: the working job ran in the runs whose ids are in `ran`, else was skipped."""
    return lambda r: [{"name": "guard", "conclusion": "success"},
                      {"name": "ingest", "conclusion": "success" if r["id"] in ran else "skipped"},
                      {"name": "post", "conclusion": "failure" if r["id"] in ran else "skipped"}]


def test_an_ingest_is_overdue_once_the_last_one_that_ran_is_over_six_hours_old():
    now = TUE
    rs = [_run(2, now - timedelta(hours=1)), _run(1, now - timedelta(hours=7))]
    # Run 2 was a late scheduled run that the guard skipped: it does not count as an ingest.
    assert cu.overdue(rs, "ingest", cu.EVERY["ingest.yml"][1], now, _jobs({1}))
    assert not cu.overdue(rs, "ingest", cu.EVERY["ingest.yml"][1], now, _jobs({1, 2}))


def test_nothing_is_started_while_a_run_is_queued_or_running():
    rs = [_run(3, TUE - timedelta(minutes=2), status="queued", conclusion=None),
          _run(1, TUE - timedelta(days=1))]
    assert not cu.overdue(rs, "ingest", timedelta(hours=6), TUE, _jobs({1}))


def test_a_job_that_never_ran_is_overdue():
    assert cu.overdue([], "metrics", timedelta(minutes=70), TUE, _jobs(set()))


def test_the_post_is_started_once_on_a_post_day_after_the_hour():
    assert cu.post_due([], TUE)
    assert not cu.post_due([], TUE.replace(hour=14))                       # before the hour
    assert not cu.post_due([], TUE + timedelta(days=1))                    # Wednesday
    assert cu.post_due([], TUE + timedelta(days=2))                        # Thursday
    # Any run since the hour - the schedule on time, or an earlier catch-up - means no second start.
    assert not cu.post_due([_run(9, TUE.replace(hour=15, minute=1), conclusion="failure")], TUE)
    assert cu.post_due([_run(8, TUE - timedelta(days=5))], TUE)


def test_a_late_scheduled_post_skips_when_another_run_posted_today():
    late = TUE.replace(hour=19, minute=45)
    rs = [_run(20, late, status="in_progress", conclusion=None), _run(19, TUE.replace(hour=15, minute=5), conclusion="failure")]
    # Run 19 reached the post job and failed on Instagram after Bluesky posted: once is enough.
    assert cu.post_done_today(rs, late, this_id=20, jobs_of=_jobs({19}))
    # A run whose post job was skipped (kill switch, or a guard) posted nothing.
    assert not cu.post_done_today(rs, late, this_id=20, jobs_of=_jobs(set()))
    # Yesterday's post does not stop today's.
    assert not cu.post_done_today([_run(5, TUE - timedelta(days=1))], TUE, this_id=20, jobs_of=_jobs({5}))


def test_a_late_scheduled_ingest_skips_inside_four_hours_of_one_that_ran():
    now = TUE
    rs = [_run(31, now, status="in_progress", conclusion=None), _run(30, now - timedelta(hours=2))]
    assert cu.recent_ingest(rs, now, this_id=31, jobs_of=_jobs({30}))
    assert not cu.recent_ingest(rs, now, this_id=31, jobs_of=_jobs(set()))          # 30 was skipped
    old = [_run(31, now, status="in_progress", conclusion=None), _run(30, now - timedelta(hours=5))]
    assert not cu.recent_ingest(old, now, this_id=31, jobs_of=_jobs({30}))
    failed = [_run(31, now, status="in_progress", conclusion=None), _run(30, now - timedelta(hours=1), conclusion="failure")]
    assert not cu.recent_ingest(failed, now, this_id=31, jobs_of=_jobs({30}))       # a failed one is redone


def test_a_person_clicking_run_workflow_is_never_skipped(monkeypatch):
    monkeypatch.setenv("GITHUB_EVENT_NAME", "workflow_dispatch")
    monkeypatch.setenv("CATCHUP_FORCE", "true")
    monkeypatch.setattr(cu, "runs", lambda f: (_ for _ in ()).throw(AssertionError("no API call needed")))
    assert cu.guard("social.yml", TUE) is False and cu.guard("ingest.yml", TUE) is False


def test_a_push_started_ingest_is_never_skipped(monkeypatch):
    monkeypatch.setenv("GITHUB_EVENT_NAME", "push")
    monkeypatch.setattr(cu, "runs", lambda f: [_run(1, TUE - timedelta(minutes=30))])
    monkeypatch.setattr(cu, "job_ran", lambda r, job, jobs_of=None: True)
    assert cu.guard("ingest.yml", TUE) is False


def test_the_guard_writes_its_answer_for_the_next_job(monkeypatch, tmp_path):
    out = tmp_path / "out"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    monkeypatch.setenv("GITHUB_EVENT_NAME", "schedule")
    monkeypatch.setattr(cu, "guard", lambda f, now: True)
    assert cu.main(["catchup.py", "--guard", "social.yml"]) == 0
    assert out.read_text() == "skip=true\n"


def test_one_failed_check_does_not_stop_the_others(monkeypatch, capsys):
    started = []
    monkeypatch.setattr(cu, "runs", lambda f: (_ for _ in ()).throw(OSError("boom")) if f == "ingest.yml" else [])
    monkeypatch.setattr(cu, "dispatch", started.append)
    monkeypatch.setattr(cu, "post_due", lambda rs, now: False)
    assert cu.main(["catchup.py"]) == 1
    assert started == ["metrics.yml"]
    assert "ingest.yml: check failed (OSError)" in capsys.readouterr().out


def test_a_catch_up_asks_for_the_guard_explicitly(monkeypatch):
    # GitHub fills a missing input with its default, and the ingest's force defaults to true.
    sent = []
    monkeypatch.setattr(cu, "_call", lambda method, path, body=None: sent.append((path, body)) or {})
    cu.dispatch("ingest.yml")
    cu.dispatch("metrics.yml")
    assert sent == [("workflows/ingest.yml/dispatches", {"ref": "main", "inputs": {"force": "false"}}),
                    ("workflows/metrics.yml/dispatches", {"ref": "main"})]
