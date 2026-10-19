"""Shared test setup."""
import pytest


@pytest.fixture(autouse=True)
def _not_a_push_run(monkeypatch):
    """Run every test as if no CI event started it.

    The Tests workflow runs on a push, so GITHUB_EVENT_NAME is "push" there, and google_jobs skips
    its paid searches on a push-triggered run. The three budget tests in test_google_jobs.py passed
    on a laptop and failed in CI for that reason alone. A test that wants the push behaviour sets
    the variable itself.
    """
    monkeypatch.delenv("GITHUB_EVENT_NAME", raising=False)


@pytest.fixture(autouse=True)
def _no_real_state_files(monkeypatch, tmp_path):
    """Keep tests off the committed state files: the dropped-board list and the day Google Jobs last
    searched. Both are read and written by code the tests call, and a test that dropped a board
    would otherwise leave it kept out for every test after it."""
    from internscout import discover
    from internscout.sources import google_jobs
    monkeypatch.setattr(discover, "DROPPED_PATH", str(tmp_path / "dropped_boards.json"))
    monkeypatch.setattr(discover, "_DROPPED", {})
    monkeypatch.setattr(google_jobs, "DAY_PATH", str(tmp_path / "google_jobs_day.json"))



@pytest.fixture(autouse=True)
def _near_pages_only_where_tested(request, monkeypatch):
    """Build the 500 near-city pages only in their own tests (test_near_pages.py) and in production:
    they made every site build in the other tests about ten times slower (20 s suite to 3 min)."""
    if request.module.__name__.endswith("test_near_pages"):
        return
    from internscout import seo_pages
    monkeypatch.setattr(seo_pages, "NEAR_ON", False)


@pytest.fixture(autouse=True)
def _default_workday_keywords(monkeypatch):
    """Run every test with Workday's default search words, whatever the shell has set.

    WORKDAY_EXTRA_KEYWORDS turns on extra searches for every Workday board. A test that wants
    them sets the variable itself.
    """
    monkeypatch.delenv("WORKDAY_EXTRA_KEYWORDS", raising=False)
