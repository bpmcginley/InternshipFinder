"""growth/digest.py: the weekly email lists only this week's roles, stays short, is safe against
whatever a job board puts in a title, and cannot go out without an unsubscribe link and a postal
address."""
import importlib.util
import json
import os
import re
import sys
from datetime import datetime, timezone

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
sys.path.insert(0, os.path.join(ROOT, "growth"))
_spec = importlib.util.spec_from_file_location("digest", os.path.join(ROOT, "growth", "digest.py"))
digest = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(digest)

NOW = datetime(2026, 9, 23, 10, tzinfo=timezone.utc)      # the fixture data's generated_at


def _row(i, state="MA", tags=("mechanical",), **over):
    row = {
        "id": f"id{i}", "company_name": f"Company {i}", "title": f"Mechanical Intern {i}",
        "field_tags": list(tags), "stage": ["internship"], "term": "Summer 2027", "salary": None,
        "posted_at": "2026-09-20T00:00:00", "first_seen": f"2026-09-2{i % 3}T00:00:00",
        "regions": [{"loc": f"Town {i}, {state}", "kind": "x", "state": state}],
        "apply_url": f"https://jobs.example.com/{i}", "status": "open", "is_remote": False,
        "insights": None,
    }
    row.update(over)
    return row


def _site(tmp_path, files):
    data = tmp_path / "data" / "listings"
    data.mkdir(parents=True)
    index = {"generated_at": "2026-09-23T10:00:00+00:00", "files": {}}
    for key, rows in files.items():
        (data / f"{key}.json").write_text(json.dumps(rows), encoding="utf-8")
        index["files"][key] = {"file": f"listings/{key}.json"}
    (data / "index.json").write_text(json.dumps(index), encoding="utf-8")
    (tmp_path / "data" / "majors.json").write_text(json.dumps({"majors": []}), encoding="utf-8")
    return str(tmp_path)


def _ids(d):
    return {r["id"] for s in d["sections"] + d["more_sections"] for r in s["roles"]}


def _hrefs(page):
    return re.findall(r'href="([^"]*)"', page)


def test_only_roles_new_this_week(tmp_path):
    rows = [_row(i) for i in range(4)]                                              # found Sep 20-22
    rows.append(_row(10, company_name="Old Post", posted_at="2024-01-01T00:00:00"))  # an old posting just reached
    rows.append(_row(11, company_name="Long Ago", first_seen="2026-08-01T00:00:00"))
    rows.append(_row(12, company_name="Day One", first_seen="2026-09-18T00:00:00"))  # the day first_seen began
    rows.append(_row(13, company_name="Shut", status="closed"))
    site = _site(tmp_path, {"MA": rows})
    d = digest.build(site)
    assert d == digest.build(site, now=NOW)              # "this week" ends when the data was exported
    assert _ids(d) == {f"id{i}" for i in range(4)}
    assert d["totals"]["new"] == 4 and d["totals"]["open"] == 7
    assert d["subject"] == "4 new internships this week"
    for name in ("Old Post", "Long Ago", "Day One", "Shut"):
        assert name not in digest.render_html(d) and name not in digest.render_text(d)
    later = digest.build(site, now=datetime(2026, 10, 5, tzinfo=timezone.utc))
    assert later["totals"]["new"] == 0 and later["sections"] == []


def test_a_role_posted_twice_counts_once_but_two_employers_are_two_roles(tmp_path):
    same = dict(title="Design Intern", regions=[{"loc": "Boston, MA", "kind": "x", "state": "MA"}])
    rows = [_row(1, company_name="Acme", **same), _row(2, company_name="Acme Inc", **same),    # two boards
            _row(3, company_name="Other Co", **same), _row(4)]
    d = digest.build(_site(tmp_path, {"MA": rows}))
    assert d["totals"]["new"] == 3 and d["sections"][0]["new"] == 3
    assert sorted(r["company"] for r in d["sections"][0]["roles"]) == ["Acme Inc", "Company 4", "Other Co"]


def test_a_field_needs_three_new_roles_and_at_most_eight_fields_are_shown(tmp_path):
    rows, n = [], 0
    for f in range(10):                          # field f0 has 3 new roles, f1 has 4, ... f9 has 12
        for _ in range(3 + f):
            rows.append(_row(n, tags=(f"f{f}",)))
            n += 1
    rows += [_row(900 + i, tags=("two",)) for i in range(2)]                        # below the bar
    d = digest.build(_site(tmp_path, {"MA": rows}))
    assert [s["tag"] for s in d["sections"]] == [f"f{f}" for f in range(9, 1, -1)]  # most new first
    assert [s["new"] for s in d["sections"]] == list(range(12, 4, -1))
    assert [s["tag"] for s in d["more_sections"]] == ["f1", "f0"]
    assert "two" not in {s["tag"] for s in d["sections"] + d["more_sections"]}
    assert d["totals"]["fields"] == 10
    assert all(len(s["roles"]) == min(s["new"], digest.PER_SECTION) for s in d["sections"])
    page = digest.render_html(d)
    assert page.count("<h2") == digest.MAX_SECTIONS
    assert "F1</h2>" not in page and "Two</h2>" not in page
    assert (d["sections"][0]["url"]
            == "https://internscout.org/internships/f9/?utm_source=digest&utm_medium=email")
    assert d["new_url"] == "https://internscout.org/internships/new/?utm_source=digest&utm_medium=email"


def test_a_field_without_a_landing_page_links_to_the_dashboard(tmp_path):
    # Three new roles is a section, but a field page needs MIN_OPEN open roles.
    d = digest.build(_site(tmp_path, {"MA": [_row(i, tags=("museums",)) for i in range(3)]}))
    assert d["sections"][0]["url"] == "https://internscout.org/?field=museums&utm_source=digest&utm_medium=email"
    assert d["new_url"] == "https://internscout.org/?new=1&utm_source=digest&utm_medium=email"


def test_northeast_and_remote_roles_come_first_then_newest(tmp_path):
    far = [_row(i, state="TX", posted_at=f"2026-09-2{i}T00:00:00") for i in range(3)]          # newest
    near = [_row(10, state="MA", posted_at="2026-09-17T00:00:00", first_seen="2026-09-20T00:00:00"),
            _row(11, state="NY", posted_at="2026-09-18T00:00:00", first_seen="2026-09-20T00:00:00")]
    remote = [_row(12, posted_at="2026-09-19T00:00:00", first_seen="2026-09-20T00:00:00", is_remote=True,
                   regions=[{"loc": "Remote", "kind": "remote", "state": "Remote"}])]
    more_far = [_row(20 + i, state="CA", posted_at="2026-09-16T00:00:00") for i in range(3)]
    d = digest.build(_site(tmp_path, {"TX": far, "MA": near, "NY": [near[1]], "remote": remote, "CA": more_far}))
    roles = d["sections"][0]["roles"]
    assert [r["id"] for r in roles] == ["id12", "id11", "id10", "id2", "id1"]
    assert [r["nearby"] for r in roles] == [True, True, True, False, False]
    assert d["totals"]["nearby"] == 3
    assert roles[0]["place"] == "Remote"


def test_job_board_text_is_escaped(tmp_path):
    rows = [_row(i) for i in range(3)]
    rows[0]["title"] = '<script>alert("x")</script>Intern'
    rows[1]["company_name"] = 'Evil & Co "</title><img src=x onerror=alert(1)>'
    rows[2]["salary"] = "<b>$30</b>/hr"
    d = digest.build(_site(tmp_path, {"MA": rows}))
    page = digest.render_html(d)
    assert "<script" not in page and "<img" not in page and "<b>" not in page
    assert "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;Intern" in page
    assert "Evil &amp; Co &quot;&lt;/title&gt;&lt;img src=x onerror=alert(1)&gt;" in page
    assert "&lt;b&gt;$30&lt;/b&gt;/hr" in page
    # The text part is plain text, so it keeps the words as they are.
    assert '<script>alert("x")</script>Intern' in digest.render_text(d)


def test_only_web_links_are_emitted(tmp_path):
    rows = [_row(i) for i in range(4)]
    rows[3]["apply_url"] = "javascript:alert(1)"
    d = digest.build(_site(tmp_path, {"MA": rows}))
    assert "id3" not in _ids(d)                          # a listing with no web link is not listed at all
    # A digest edited by hand, or read back from JSON, still cannot put a non-web link in the email.
    d["sections"][0]["roles"][0]["url"] = "javascript:alert(1)"
    d["sections"][0]["roles"][1]["url"] = "data:text/html,<script>alert(1)</script>"
    d["sections"][0]["url"] = "vbscript:msgbox"
    page, text = digest.render_html(d), digest.render_text(d)
    for href in _hrefs(page):
        assert href.startswith(("https://", "http://")) or href == digest.UNSUBSCRIBE
    assert "javascript:" not in page and "data:" not in page and "vbscript:" not in page
    assert "javascript:" not in text and "data:" not in text and "vbscript:" not in text
    assert "Mechanical Intern" in page                   # the role is still listed, just not linked
    assert "<style" not in page and "<link" not in page and "<script" not in page


def test_subscribers_get_their_fields_or_every_field_when_theirs_had_a_quiet_week(tmp_path):
    rows = ([_row(i, tags=("swe",), title=f"Software Intern {i}") for i in range(5)]
            + [_row(10 + i, tags=("finance",), title=f"Finance Intern {i}") for i in range(4)]
            + [_row(20 + i, tags=("museums",), title=f"Museum Intern {i}") for i in range(3)])
    d = digest.build(_site(tmp_path, {"MA": rows}))
    assert [s["tag"] for s in d["sections"]] == ["swe", "finance", "museums"]

    mine = digest.render_html(d, fields=["finance", "museums"])
    assert "Finance Intern" in mine and "Museum Intern" in mine and "Software Intern" not in mine
    assert "Showing only the fields you picked." in mine
    assert "New this week in Finance, Museums." in mine                    # the preheader follows the fields
    assert "Showing only the fields you picked." in digest.render_text(d, fields="finance,museums")

    quiet = digest.render_html(d, fields=["nursing"])
    assert "Finance Intern" in quiet and "Museum Intern" in quiet and "Software Intern" in quiet
    assert "None of the fields you picked gained 3 or more new roles this week" in quiet
    assert "None of the fields you picked" in digest.render_text(d, fields=["nursing"])

    everyone = digest.render_html(d)
    assert "fields you picked" not in everyone and "Software Intern" in everyone


def test_a_field_past_the_cap_still_reaches_the_people_who_picked_it(tmp_path):
    rows, n = [], 0
    for f in range(9):
        for _ in range(3 + f):
            rows.append(_row(n, tags=(f"f{f}",), title=f"Role f{f} {n}"))
            n += 1
    d = digest.build(_site(tmp_path, {"MA": rows}))
    assert "f0" not in {s["tag"] for s in d["sections"]}
    assert "Role f0 " in digest.render_html(d, fields=["f0"])
    assert "Role f0 " not in digest.render_html(d)


def test_postal_address_marker_until_there_is_a_real_address(tmp_path):
    d = digest.build(_site(tmp_path, {"MA": [_row(i) for i in range(3)]}))
    assert digest.NO_ADDRESS == "[POSTAL ADDRESS REQUIRED BEFORE SENDING]"
    for render in (digest.render_html, digest.render_text):
        assert digest.NO_ADDRESS in render(d)
        assert digest.NO_ADDRESS in render(d, postal_address="  ")          # blank is no address
        with_address = render(d, postal_address="InternScout\nPO Box 12 <Amherst>\nAmherst, MA 01004")
        assert digest.NO_ADDRESS not in with_address
        assert "Amherst, MA 01004" in with_address
    page = digest.render_html(d, postal_address="InternScout\nPO Box 12 <Amherst>\nAmherst, MA 01004")
    assert "InternScout<br>PO Box 12 &lt;Amherst&gt;<br>Amherst, MA 01004" in page


def test_every_email_carries_the_unsubscribe_token_the_slogan_and_why_it_came(tmp_path):
    d = digest.build(_site(tmp_path, {"MA": [_row(i) for i in range(3)]}))
    page, text = digest.render_html(d), digest.render_text(d)
    assert '<a href="{{ unsubscribe_url }}"' in page
    assert "Unsubscribe: {{ unsubscribe_url }}" in text
    assert "You&#x27;re getting this because you signed up for new-internship emails at internscout.org." in page
    assert "You're getting this because you signed up for new-internship emails at internscout.org." in text
    for part in (page, text):
        assert "Built by one student, made for all students." in part
        assert "not affiliated with UMass Amherst or with any employer listed here" in part


def test_text_version(tmp_path):
    rows = [_row(i, salary="$25/hr" if i == 0 else None) for i in range(3)]
    rows[1]["insights"] = {"pay": "paid"}
    rows[2]["title"] = "Line\nbreak\tIntern"
    d = digest.build(_site(tmp_path, {"MA": rows}))
    text = digest.render_text(d)
    assert text.startswith("3 new internships this week\nWeek ending September 23, 2026\n")
    assert "<" not in text.replace("{{ unsubscribe_url }}", "")          # no markup
    assert "Mechanical Engineering: 3 new this week\n" in text
    assert "* Mechanical Intern 0 at Company 0\n  Town 0, MA · $25/hr\n  https://jobs.example.com/0\n" in text
    assert "  Town 1, MA · Paid\n" in text
    assert "* Line break Intern at Company 2\n" in text                   # one role, one line
    assert "See every new role: https://internscout.org/?new=1&utm_source=digest&utm_medium=email" in text
    assert ("See all 3 open mechanical engineering roles: "
            "https://internscout.org/?field=mechanical&utm_source=digest&utm_medium=email") in text


def test_the_command_writes_a_preview_and_sends_nothing(tmp_path, capsys):
    (tmp_path / "site").mkdir()
    site = _site(tmp_path / "site", {"MA": [_row(i) for i in range(6)]})
    out = tmp_path / "preview"
    assert digest.main(["digest.py", site, "--out", str(out)]) == 0
    assert sorted(os.listdir(out)) == ["digest.html", "digest.json", "digest.txt"]
    saved = json.loads((out / "digest.json").read_text(encoding="utf-8"))
    assert saved["subject"] == "6 new internships this week" and saved["totals"]["new"] == 6
    assert (out / "digest.html").read_text(encoding="utf-8").startswith("<!DOCTYPE html>")
    assert "6 new internships this week" in capsys.readouterr().out
    # Building the email must never be able to send it.
    source = open(os.path.join(ROOT, "growth", "digest.py"), encoding="utf-8").read()
    for module in ("smtplib", "urllib.request", "http.client", "socket", "requests"):
        assert f"import {module}" not in source and f"from {module}" not in source


def test_one_employer_fills_at_most_two_places_in_a_field():
    rows = [{"company_name": "Big Co", "id": f"b{i}"} for i in range(6)] + [{"company_name": "Small Co", "id": "s1"}]
    picked = digest.varied(rows)
    assert [x["id"] for x in picked] == ["b0", "b1", "s1", "b2", "b3"]   # 2 + the other employer, then topped up
