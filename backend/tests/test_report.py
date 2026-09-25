"""growth/report.py: what the analytics say goes into a PUBLIC GitHub issue, so a visitor-supplied
page path or referrer must never become a link, an @mention or a broken table. Cloudflare is replaced
in every test, so nothing here touches the network."""
import importlib.util
import os
import re
import sys
from datetime import datetime, timezone

import pytest

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
sys.path.insert(0, os.path.join(ROOT, "growth"))
_spec = importlib.util.spec_from_file_location("report", os.path.join(ROOT, "growth", "report.py"))
report = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(report)

NOW = datetime(2026, 9, 28, 13, tzinfo=timezone.utc)

HOSTILE = [
    "evil.example/[click me](https://evil.example)",
    "@octocat please look",
    "x` [link](https://evil.example) `y",
    "a | b | c",
    "line one\nline two\r\n| injected | 999 |",
    "<img src=x onerror=alert(1)>",
    "https://evil.example/phish",
    "#1 and GH-2",
    "‮evil‬.example",           # a right-to-left override
    "```\nfenced\n```",
    "\\`escaped\\`",
    "",
    None,
]


def _cells(line):
    """A table row's cells, split as GitHub splits them: on every pipe outside a code span. inert()
    leaves no pipe in a value, so a plain split is the same thing here."""
    assert line.startswith("| ") and line.endswith(" |")
    return line[2:-2].split(" | ")


@pytest.mark.parametrize("value", HOSTILE)
def test_inert_is_one_plain_code_span(value):
    out = report.inert(value)
    if out == "(none)":
        return
    assert out.startswith("`") and out.endswith("`") and out.count("`") == 2
    inner = out[1:-1]
    assert "|" not in inner and "\n" not in inner and "\r" not in inner and "\\" not in inner
    assert "‮" not in inner and "‬" not in inner
    assert len(inner) <= report.MAX_SHOWN


def _analytics(pages, refs):
    week = [{"count": 1, "sum": {"visits": 100}}]
    return {"data": {"viewer": {"accounts": [{
        "week": week, "prev": week,
        "pages": [{"sum": {"visits": v}, "dimensions": {"requestPath": p}} for p, v in pages],
        "refs": [{"sum": {"visits": v}, "dimensions": {"refererHost": h}} for h, v in refs],
        "countries": [{"sum": {"visits": 100}, "dimensions": {"countryName": "United States"}}],
        "landing": [{"sum": {"visits": 40}}],
    }]}}}


@pytest.fixture
def cloudflare(monkeypatch):
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "cf-test-token")
    answers = []
    monkeypatch.setattr(report, "_post", lambda url, body, token: answers.pop(0))
    return answers


def test_hostile_paths_and_referrers_render_inert(cloudflare):
    hostile = [h for h in HOSTILE if h]
    data = _analytics([("/internships/", 50)] + [(f"/{h}", 5) for h in hostile],
                      [("", 30), ("www.google.com", 20)] + [(h, 10) for h in hostile])
    cloudflare += [data, data]
    md = "\n".join(report.visits_section(NOW))

    # Every table row still has exactly two cells, and no value ran onto a line of its own.
    rows = [line for line in md.splitlines() if line.startswith("| ") and not line.startswith("| Page")
            and not line.startswith("| Came from")]
    assert len(rows) == 1 + len(hostile) + 2 + len(hostile)
    for line in rows:
        name, visits = _cells(line)
        assert re.fullmatch(r"[\d,]+", visits)
        assert name == "(direct or unknown)" or (name.startswith("`") and name.endswith("`")
                                                 and name.count("`") == 2)

    # Outside the code spans nothing can be a link, a mention, an issue reference or HTML.
    bare = re.sub(r"`[^`\n]*`", "", md)
    for token in ("](", "@octocat", "https://evil", "<img", "#1 ", "GH-2", "```", "‮"):
        assert token not in bare
    assert "`www.google.com`" in md and "(direct or unknown)" in md


def test_referrers_with_fewer_than_three_visits_are_left_out(cloudflare):
    data = _analytics([("/", 10)], [("", 1), ("news.ycombinator.com", 3), ("spoof.example", 2),
                                    ("@someone", 1)])
    cloudflare += [data, data]
    md = "\n".join(report.visits_section(NOW))
    assert "`news.ycombinator.com` | 3 |" in md
    assert "spoof.example" not in md and "someone" not in md
    assert "(direct or unknown) | 1 |" in md                # no referrer: our own label, always shown
    assert f"fewer than {report.MIN_REF_VISITS} visits are left out" in md


def test_nothing_left_out_says_nothing(cloudflare):
    data = _analytics([("/", 10)], [("www.google.com", 9)])
    cloudflare += [data, data]
    assert "left out" not in "\n".join(report.visits_section(NOW))
