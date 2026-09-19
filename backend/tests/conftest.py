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
