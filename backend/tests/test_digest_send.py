"""growth/digest_send.py: the weekly email goes out only when every requirement is there, only as
Buttondown's API documents it, and never with a job board's text read as a template tag. The HTTP
layer is replaced in every test, so nothing here touches the network."""
import importlib.util
import io
import json
import os
import sys
import urllib.error
from datetime import datetime, timedelta, timezone

import pytest

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
sys.path.insert(0, os.path.join(ROOT, "growth"))
_spec = importlib.util.spec_from_file_location("digest_send", os.path.join(ROOT, "growth", "digest_send.py"))
digest_send = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(digest_send)
digest = digest_send.digest

KEY = "bd-test-key-0123456789"
ADDRESS = "InternScout\nPO Box 12\nAmherst, MA 01004"
EVERYONE = {"filters": [], "groups": [], "predicate": "and"}
# Buttondown's answer to the same-week check when nothing has gone out: every send to everyone asks first.
NONE_SENT = {"results": [], "next": None, "count": 0}
LIST_URL = ("https://api.buttondown.com/v1/emails?status=about_to_send&status=scheduled&status=in_flight"
            "&status=sent")


def _row(i, tags=("mechanical",), **over):
    row = {
        "id": f"id{i}", "company_name": f"Company {i}", "title": f"Mechanical Intern {i}",
        "field_tags": list(tags), "stage": ["internship"], "term": "Summer 2027", "salary": None,
        "posted_at": "2026-09-20T00:00:00", "first_seen": f"2026-09-2{i % 3}T00:00:00",
        "regions": [{"loc": f"Town {i}, MA", "kind": "x", "state": "MA"}],
        "apply_url": f"https://jobs.example.com/{i}", "status": "open", "is_remote": False,
        "insights": None,
    }
    row.update(over)
    return row


def _site(tmp_path, rows):
    data = tmp_path / "data" / "listings"
    data.mkdir(parents=True)
    (data / "MA.json").write_text(json.dumps(rows), encoding="utf-8")
    index = {"generated_at": "2026-09-23T10:00:00+00:00", "files": {"MA": {"file": "listings/MA.json"}}}
    (data / "index.json").write_text(json.dumps(index), encoding="utf-8")
    (tmp_path / "data" / "majors.json").write_text(json.dumps({"majors": []}), encoding="utf-8")
    return str(tmp_path)


class _Answer:
    def __init__(self, body):
        self._raw = json.dumps(body).encode()

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeButtondown:
    """Stands in for urllib.request.urlopen: records each request and gives the next canned answer.
    A request with no answer left fails the test, so nothing can slip out unnoticed."""

    def __init__(self):
        self.requests = []
        self.answers = []

    def __call__(self, req, timeout=None):
        self.requests.append(req)
        if not self.answers:
            raise AssertionError(f"unexpected request: {req.get_method()} {req.full_url}")
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return _Answer(answer)


def _headers(req):
    return {k.lower(): v for k, v in req.header_items()}


def _body(req):
    return json.loads(req.data.decode("utf-8"))


def _refused(url, status, body):
    return urllib.error.HTTPError(url, status, "refused", {}, io.BytesIO(json.dumps(body).encode()))


@pytest.fixture(autouse=True)
def api(monkeypatch):
    monkeypatch.delenv(digest_send.KEY_ENV, raising=False)
    monkeypatch.delenv(digest_send.ADDRESS_ENV, raising=False)
    fake = FakeButtondown()
    monkeypatch.setattr(digest_send.urllib.request, "urlopen", fake)
    return fake


@pytest.fixture
def ready(monkeypatch):
    """Everything a real send needs, apart from --send."""
    monkeypatch.setenv(digest_send.KEY_ENV, KEY)
    monkeypatch.setenv(digest_send.ADDRESS_ENV, ADDRESS)


@pytest.fixture
def site(tmp_path):
    return _site(tmp_path, [_row(i) for i in range(3)])


def test_a_dry_run_sends_nothing_and_shows_what_would_go(site, ready, api, capsys):
    assert digest_send.main(["digest_send.py", site]) == 0
    assert api.requests == []
    out = capsys.readouterr().out
    assert "Dry run: nothing was sent." in out
    assert "Subject: 3 new internships this week (September 23, 2026)" in out
    assert "PATCH https://api.buttondown.com/v1/emails/<new id>" in out
    assert "* Mechanical Intern 0 at Company 0" in out              # the plain-text version
    assert "PO Box 12" in out and digest.NO_ADDRESS not in out
    assert "A real send needs: --send\n" in out
    assert KEY not in out


def test_a_dry_run_names_everything_a_real_send_still_needs(site, api, capsys):
    assert digest_send.main(["digest_send.py", site]) == 0
    assert api.requests == []
    out = capsys.readouterr().out
    assert "A real send needs: --send, BUTTONDOWN_API_KEY, DIGEST_POSTAL_ADDRESS" in out
    assert digest.NO_ADDRESS in out


@pytest.mark.parametrize("env, missing", [
    ({}, ["BUTTONDOWN_API_KEY", "DIGEST_POSTAL_ADDRESS"]),
    ({"DIGEST_POSTAL_ADDRESS": ADDRESS}, ["BUTTONDOWN_API_KEY"]),
    ({"BUTTONDOWN_API_KEY": "   ", "DIGEST_POSTAL_ADDRESS": ADDRESS}, ["BUTTONDOWN_API_KEY"]),
    ({"BUTTONDOWN_API_KEY": KEY}, ["DIGEST_POSTAL_ADDRESS"]),
    ({"BUTTONDOWN_API_KEY": KEY, "DIGEST_POSTAL_ADDRESS": " \n\t "}, ["DIGEST_POSTAL_ADDRESS"]),
])
def test_send_refuses_and_names_each_missing_requirement(site, api, capsys, monkeypatch, env, missing):
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    for argv in (["digest_send.py", site, "--send"], ["digest_send.py", site, "--send", "--test-to", "me@example.org"]):
        assert digest_send.main(argv) == digest_send.EXIT_REFUSED
        out = capsys.readouterr().out
        line = next(x for x in out.splitlines() if x.startswith("[digest] Not sent. Missing:"))
        for name in ("BUTTONDOWN_API_KEY", "DIGEST_POSTAL_ADDRESS"):
            assert (name in line) == (name in missing)
        assert KEY not in out
    assert api.requests == []


def test_a_send_makes_a_draft_for_everyone_then_sends_it(site, ready, api, capsys):
    api.answers = [NONE_SENT, {"id": "em_0123abc", "status": "draft"},
                   {"id": "em_0123abc", "status": "about_to_send"}]
    assert digest_send.main(["digest_send.py", site, "--send"]) == 0
    assert len(api.requests) == 3
    check, create, send = api.requests

    assert check.get_method() == "GET" and check.full_url == LIST_URL          # this week's, first
    assert check.data is None
    assert _headers(check)["authorization"] == f"Token {KEY}"

    assert create.get_method() == "POST"
    assert create.full_url == "https://api.buttondown.com/v1/emails"
    h = _headers(create)
    assert h["authorization"] == f"Token {KEY}"
    assert h["x-api-version"] == "2026-04-01"
    assert h["content-type"] == "application/json"
    assert h["user-agent"].startswith("InternScout-digest/")              # never Python-urllib's default
    assert 0 < len(h["x-idempotency-key"]) <= 200
    draft = _body(create)
    assert set(draft) == {"subject", "body", "status", "filters", "archival_mode"}
    assert draft["status"] == "draft"
    assert draft["filters"] == EVERYONE
    assert draft["archival_mode"] == "disabled"
    assert draft["subject"] == "3 new internships this week (September 23, 2026)"
    body = draft["body"]
    assert body.startswith("<!-- buttondown-editor-mode: fancy -->")
    assert '<a href="{{ unsubscribe_url }}"' in body
    assert "InternScout<br>PO Box 12<br>Amherst, MA 01004" in body
    assert digest.NO_ADDRESS not in body
    assert "Built by one student, made for all students." in body
    assert "Mechanical Intern 0" in body
    for tag in ("<!DOCTYPE", "<html", "<head", "<body", "</body>"):          # Buttondown's template wraps it
        assert tag not in body

    assert send.get_method() == "PATCH"
    assert send.full_url == "https://api.buttondown.com/v1/emails/em_0123abc"
    assert _body(send) == {"status": "about_to_send"}
    h = _headers(send)
    assert h["authorization"] == f"Token {KEY}" and h["x-api-version"] == "2026-04-01"
    assert h["user-agent"].startswith("InternScout-digest/")

    out = capsys.readouterr().out
    assert "em_0123abc" in out and "every subscriber" in out
    assert KEY not in out


def test_a_public_archive_is_opt_in(site, ready, api):
    api.answers = [NONE_SENT, {"id": "em_1", "status": "draft"}, {}]
    assert digest_send.main(["digest_send.py", site, "--send", "--public-archive"]) == 0
    assert "archival_mode" not in _body(api.requests[1])


def test_a_test_copy_goes_to_one_address_and_the_draft_stays_unsent(site, ready, api, capsys):
    api.answers = [{"id": "em_1", "status": "draft"}, {}]
    assert digest_send.main(["digest_send.py", site, "--send", "--test-to", " hello@example.org "]) == 0
    assert [(r.get_method(), r.full_url) for r in api.requests] == [
        ("POST", "https://api.buttondown.com/v1/emails"),
        ("POST", "https://api.buttondown.com/v1/emails/em_1/send-draft")]
    assert _body(api.requests[1]) == {"recipients": ["hello@example.org"]}
    assert _headers(api.requests[1])["authorization"] == f"Token {KEY}"
    assert _body(api.requests[0])["filters"] == EVERYONE          # the same draft everyone would get
    assert "test copy of em_1 to hello@example.org" in capsys.readouterr().out


@pytest.mark.parametrize("to", ["", "  ", "not-an-address", "a@example.org,b@example.org", "a@example.org b@x.org"])
def test_a_test_copy_needs_one_real_address(site, ready, api, capsys, to):
    assert digest_send.main(["digest_send.py", site, "--send", "--test-to", to]) == digest_send.EXIT_REFUSED
    assert api.requests == []
    assert "--test-to needs one email address" in capsys.readouterr().out


def test_the_unsubscribe_placeholder_maps_to_buttondowns_merge_tag(site, monkeypatch):
    d = digest.build(site)
    # digest.py's placeholder and Buttondown's tag are the same text today, so give digest.py a
    # different one to show the mapping is really done.
    monkeypatch.setattr(digest, "UNSUBSCRIBE", "%%UNSUBSCRIBE%%")
    body = digest_send.body_html(digest.render_html(d, postal_address=ADDRESS))
    assert "%%UNSUBSCRIBE%%" not in body
    assert '<a href="{{ unsubscribe_url }}"' in body
    with pytest.raises(ValueError, match="unsubscribe"):
        digest_send.body_html("<html><body><p>no link</p></body></html>")


def test_job_board_braces_cannot_become_template_tags(tmp_path, ready, api):
    rows = [_row(i) for i in range(3)]
    rows[0]["title"] = "{% if subscriber %}{{ subscriber.email }}{% endif %} Intern"
    rows[1]["company_name"] = "{# note #} Co"
    api.answers = [NONE_SENT, {"id": "em_1", "status": "draft"}, {}]
    assert digest_send.main(["digest_send.py", _site(tmp_path, rows), "--send"]) == 0
    body = _body(api.requests[1])["body"]
    assert body.count("{") == body.count("}") == 2                      # only the unsubscribe tag
    assert body.count("{{ unsubscribe_url }}") == 1
    assert "{%" not in body and "{#" not in body
    assert "&#123;&#123; subscriber.email &#125;&#125;" in body          # shown to the reader, as text


def test_a_week_with_nothing_to_list_is_not_sent(tmp_path, ready, api, capsys):
    site = _site(tmp_path, [_row(i) for i in range(2)])                 # 2 new roles: below MIN_NEW
    assert digest_send.main(["digest_send.py", site, "--send"]) == digest_send.EXIT_REFUSED
    assert api.requests == []
    assert "Not sent: no field gained 3 or more new roles this week" in capsys.readouterr().out
    assert digest_send.main(["digest_send.py", site]) == 0              # the dry run says so, and sends nothing
    assert "A real send would refuse this week" in capsys.readouterr().out
    assert api.requests == []


def test_a_bad_key_stops_at_the_first_request(site, ready, api, capsys):
    api.answers = [_refused("https://api.buttondown.com/v1/emails", 401, {"detail": "Invalid token."})]
    assert digest_send.main(["digest_send.py", site, "--send"]) == digest_send.EXIT_PROVIDER
    assert len(api.requests) == 1
    out = capsys.readouterr().out
    assert "401" in out and "email_access and sending_access" in out
    assert KEY not in out


def test_a_duplicate_email_says_what_to_check(site, ready, api, capsys):
    api.answers = [NONE_SENT, _refused("https://api.buttondown.com/v1/emails", 400, {"code": "email_duplicate"})]
    assert digest_send.main(["digest_send.py", site, "--send"]) == digest_send.EXIT_PROVIDER
    assert "same subject" in capsys.readouterr().out


def test_a_refused_send_names_the_draft_it_left(site, ready, api, capsys):
    # was: a 500 here, answered with "made but not sent". A 5xx can come after Buttondown took the
    # send, so only a 4xx (Buttondown answered, and said no) is a definite "not sent".
    api.answers = [NONE_SENT, {"id": "em_9", "status": "draft"},
                   _refused("https://api.buttondown.com/v1/emails/em_9", 400, {"detail": "bad status"})]
    assert digest_send.main(["digest_send.py", site, "--send"]) == digest_send.EXIT_PROVIDER
    assert "Draft em_9 was made but not sent" in capsys.readouterr().out


@pytest.mark.parametrize("status", [500, 502, 503, 504])
@pytest.mark.parametrize("test_to", [None, "hello@example.org"])
def test_a_5xx_on_the_send_is_unknown_and_never_advises_sending_again(site, ready, api, capsys, status, test_to):
    """A gateway's 502 or 504 can arrive after Buttondown queued the email. Telling the operator to
    send the draft then would send everyone a second copy."""
    argv = ["digest_send.py", site, "--send"] + (["--test-to", test_to] if test_to else [])
    last = f"https://api.buttondown.com/v1/emails/em_5{'/send-draft' if test_to else ''}"
    api.answers = ([] if test_to else [NONE_SENT]) + [
        {"id": "em_5", "status": "draft"}, _refused(last, status, {"detail": "Bad Gateway"})]
    assert digest_send.main(argv) == digest_send.EXIT_PROVIDER
    assert len(api.requests) == (2 if test_to else 3)                  # the send is not repeated
    out = capsys.readouterr().out
    assert "UNKNOWN" in out and "may or may not be sending" in out
    assert "sent and scheduled" in out and "em_5" in out
    assert "was made but not sent" not in out
    assert "Send or delete" not in out and "send it" not in out.lower()
    assert KEY not in out


def test_a_lost_connection_retries_the_draft_once_with_the_same_idempotency_key(site, ready, api):
    api.answers = [NONE_SENT, urllib.error.URLError("timed out"), {"id": "em_2", "status": "draft"}, {}]
    assert digest_send.main(["digest_send.py", site, "--send"]) == 0
    _, first, retry, send = api.requests
    assert first.full_url == retry.full_url == "https://api.buttondown.com/v1/emails"
    assert _headers(first)["x-idempotency-key"] == _headers(retry)["x-idempotency-key"]
    assert first.data == retry.data
    assert send.get_method() == "PATCH"


def test_the_send_itself_is_never_repeated(site, ready, api, capsys):
    api.answers = [NONE_SENT, {"id": "em_3", "status": "draft"}, urllib.error.URLError("timed out")]
    assert digest_send.main(["digest_send.py", site, "--send"]) == digest_send.EXIT_PROVIDER
    assert len(api.requests) == 3
    assert "may or may not be sending" in capsys.readouterr().out


@pytest.mark.parametrize("answer", [{}, {"id": ""}, {"id": "em_1/../../newsletters"},
                                    {"id": "em_1", "status": "about_to_send"}])
def test_an_unexpected_answer_to_the_draft_stops_before_sending(site, ready, api, answer):
    api.answers = [NONE_SENT, answer]
    assert digest_send.main(["digest_send.py", site, "--send"]) == digest_send.EXIT_PROVIDER
    assert len(api.requests) == 2


def test_standard_library_only():
    source = open(os.path.join(ROOT, "growth", "digest_send.py"), encoding="utf-8").read()
    for module in ("requests", "httpx", "urllib3", "aiohttp"):
        assert f"import {module}" not in source and f"from {module}" not in source


def test_a_job_title_with_the_unsubscribe_token_stays_text():
    page = ('<html><body><p>Intern {{ unsubscribe_url }} role</p>'
            '<a href="{{ unsubscribe_url }}">Unsubscribe</a></body></html>')
    body = digest_send.body_html(page)
    assert body.count(digest_send.UNSUBSCRIBE) == 1                  # only the footer's link is live
    assert "Intern &#123;&#123; unsubscribe_url &#125;&#125; role" in body
    with pytest.raises(ValueError):                                  # a title can't stand in for the link
        digest_send.body_html("<html><body><p>{{ unsubscribe_url }}</p></body></html>")


def test_no_answer_to_the_send_says_the_result_is_unknown(site, ready, api, capsys):
    api.answers = [NONE_SENT, {"id": "em_4", "status": "draft"}, urllib.error.URLError("reset")]
    assert digest_send.main(["digest_send.py", site, "--send"]) == digest_send.EXIT_PROVIDER
    out = capsys.readouterr().out
    assert "may or may not be sending" in out and "was made but not sent" not in out
    assert "UNKNOWN" in out and "sent and scheduled" in out


# ---------------------------------------------------------------- one digest a week

def _stamp(delta):
    return (datetime.now(timezone.utc) - delta).strftime("%Y-%m-%dT%H:%M:%SZ")


@pytest.mark.parametrize("earlier", [
    {"id": "em_old", "status": "sent", "subject": "9 new internships this week (September 21, 2026)",
     "publish_date": "2 days ago"},
    {"id": "em_old", "status": "scheduled", "subject": "Something else", "publish_date": "in a day"},
    {"id": "em_old", "status": "about_to_send", "subject": "x", "publish_date": None, "creation_date": "now"},
    {"id": "em_old", "status": "in_flight", "subject": "x", "creation_date": "2 days ago"},
])
def test_a_second_send_in_the_same_week_is_refused(site, ready, api, capsys, earlier):
    when = {"2 days ago": _stamp(timedelta(days=2)), "in a day": _stamp(-timedelta(days=1)),
            "now": _stamp(timedelta(0))}
    earlier = {k: when.get(v, v) if isinstance(v, str) else v for k, v in earlier.items()}
    api.answers = [{"results": [earlier], "next": None}]
    assert digest_send.main(["digest_send.py", site, "--send"]) == digest_send.EXIT_REFUSED
    assert len(api.requests) == 1 and api.requests[0].get_method() == "GET"      # no draft, no send
    out = capsys.readouterr().out
    assert "Not sent: Buttondown already has em_old" in out and "--allow-same-week" in out
    assert KEY not in out


def test_the_same_subject_is_refused_whenever_it_was_sent(site, ready, api, capsys):
    same = {"id": "em_s", "status": "sent", "subject": "3 new internships this week (September 23, 2026)",
            "publish_date": "2020-01-01T00:00:00Z"}
    api.answers = [{"results": [same], "next": None}]
    assert digest_send.main(["digest_send.py", site, "--send"]) == digest_send.EXIT_REFUSED
    assert len(api.requests) == 1


def test_last_weeks_digest_and_unsent_drafts_do_not_block_this_week(site, ready, api):
    older = [{"id": "em_w", "status": "sent", "subject": "10 new internships this week (September 16, 2026)",
              "publish_date": _stamp(timedelta(days=7))},
             # a test copy's draft, whatever its subject or date: it never went to subscribers
             {"id": "em_d", "status": "draft", "subject": "3 new internships this week (September 23, 2026)",
              "creation_date": _stamp(timedelta(hours=1))}]
    api.answers = [{"results": older, "next": None}, {"id": "em_n", "status": "draft"}, {}]
    assert digest_send.main(["digest_send.py", site, "--send"]) == 0
    assert [r.get_method() for r in api.requests] == ["GET", "POST", "PATCH"]


def test_the_check_reads_every_page_but_only_buttondowns_own(site, ready, api, capsys):
    page2 = LIST_URL + "&page=2"
    recent = {"id": "em_p2", "status": "sent", "subject": "x", "publish_date": _stamp(timedelta(days=1))}
    api.answers = [{"results": [], "next": page2}, {"results": [recent], "next": None}]
    assert digest_send.main(["digest_send.py", site, "--send"]) == digest_send.EXIT_REFUSED
    assert [r.full_url for r in api.requests] == [LIST_URL, page2]
    assert "em_p2" in capsys.readouterr().out

    api.requests.clear()
    api.answers = [{"results": [], "next": "https://evil.example/steal?page=2"}]
    assert digest_send.main(["digest_send.py", site, "--send"]) == digest_send.EXIT_PROVIDER
    assert len(api.requests) == 1                                     # the key never went to evil.example
    assert "could not check" in capsys.readouterr().out


@pytest.mark.parametrize("failure", [urllib.error.URLError("down"),
                                     _refused(LIST_URL, 503, {"detail": "unavailable"}),
                                     _refused(LIST_URL, 401, {"detail": "Invalid token."})])
def test_when_the_check_cannot_be_made_nothing_is_sent(site, ready, api, capsys, failure):
    # A network failure is tried once more (a read is safe to repeat); a refusal is not.
    api.answers = [failure, failure] if isinstance(failure, urllib.error.URLError) else [failure]
    assert digest_send.main(["digest_send.py", site, "--send"]) == digest_send.EXIT_PROVIDER
    assert all(r.get_method() == "GET" for r in api.requests)
    assert "Not sent: could not check Buttondown" in capsys.readouterr().out


def test_allow_same_week_skips_the_check(site, ready, api):
    api.answers = [{"id": "em_o", "status": "draft"}, {}]
    assert digest_send.main(["digest_send.py", site, "--send", "--allow-same-week"]) == 0
    assert [r.get_method() for r in api.requests] == ["POST", "PATCH"]


def test_a_test_copy_is_not_checked_against_this_weeks_sends(site, ready, api):
    # One copy to the owner's own inbox; a week's real send must not stop the owner testing.
    api.answers = [{"id": "em_t", "status": "draft"}, {}]
    assert digest_send.main(["digest_send.py", site, "--send", "--test-to", "hello@example.org"]) == 0
    assert [r.get_method() for r in api.requests] == ["POST", "POST"]
