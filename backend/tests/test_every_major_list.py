"""growth/every_major_list.py: the public "Summer 2027 Internships — Every Major" README, written from
the data. Job-board text can't break a table, links go only where they should, and the same data
always writes the same bytes (so the publishing workflow commits nothing when nothing changed)."""
import importlib.util
import json
import os
import random
import re
import sys

import pytest

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
sys.path.insert(0, os.path.join(ROOT, "growth"))
_spec = importlib.util.spec_from_file_location("every_major_list", os.path.join(ROOT, "growth", "every_major_list.py"))
eml = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(eml)

# A "|" that isn't escaped: a cell boundary.
BAR = re.compile(r"(?<!\\)\|")


def _row(i, state="MA", tags=("mechanical",), **over):
    row = {
        "id": f"id{i:03d}", "company_name": f"Company {i}", "title": f"Mechanical Intern {i}",
        "field_tags": list(tags), "stage": ["internship"], "term": "Summer 2027", "salary": None,
        "posted_at": "2026-09-20T00:00:00", "first_seen": f"2026-09-2{i % 3}T00:00:00",
        "regions": [{"loc": f"Town {i}, {state}", "kind": "x", "state": state}],
        "apply_url": f"https://jobs.example.com/{i}", "status": "open", "is_remote": False,
        "insights": None,
    }
    row.update(over)
    return row


def _site(tmp_path, files, generated_at="2026-09-23T10:00:00+00:00"):
    data = tmp_path / "data" / "listings"
    data.mkdir(parents=True)
    index = {"generated_at": generated_at, "files": {}}
    for key, rows in files.items():
        (data / f"{key}.json").write_text(json.dumps(rows), encoding="utf-8")
        index["files"][key] = {"file": f"listings/{key}.json"}
    (data / "index.json").write_text(json.dumps(index), encoding="utf-8")
    (tmp_path / "data" / "majors.json").write_text(json.dumps({"majors": []}), encoding="utf-8")
    return str(tmp_path)


def _table_rows(text):
    return [line for line in text.splitlines() if line.startswith("| ") and "[Apply](" in line]


# ---------------------------------------------------------------- escaping

def test_job_board_text_cannot_break_a_cell_or_make_a_link():
    out = eml.md('Evil | Co [click](https://evil.example) <img src=x> *b* _i_ `c` ~s~ \\ &copy; AT&T\nnext')
    assert not BAR.search(out)
    assert "[" not in out.replace("\\[", "") and "]" not in out.replace("\\]", "")
    assert "<" not in out and ">" not in out
    assert "&amp;copy;" in out and "AT&T" in out          # an entity is escaped, a bare & is left
    assert "\n" not in out and out.endswith("next")
    assert eml.md("x" * 500, 20) == "x" * 19 + "…"


def test_links_are_web_addresses_that_stay_inside_their_cell():
    assert eml.md_url("javascript:alert(1)") is None
    assert eml.md_url("https://a.example/x y") is None              # whitespace: not a real address
    u = eml.md_url("https://a.example/job(1)|x?a=<b>")
    assert u == "https://a.example/job%281%29%7Cx?a=%3Cb%3E"


def test_a_hostile_listing_is_one_six_cell_row(tmp_path):
    rows = [_row(i) for i in range(6)]
    rows[0].update(company_name="Evil | Co [x](https://evil.example)", title="Intern | Ops\n<script>x</script>",
                   salary="$20 | hour", apply_url="https://jobs.example.com/a(b)|c")
    files = eml.build(_site(tmp_path, {"MA": rows}))
    for name, text in files.items():
        for line in _table_rows(text):
            assert len(BAR.findall(line)) == 7, (name, line)       # six cells, seven bars
        assert "<script>" not in text and "[x](https://evil.example)" not in text
    assert "[Apply](https://jobs.example.com/a%28b%29%7Cc)" in files["README.md"]


# ---------------------------------------------------------------- what is listed

def test_only_open_summer_2027_student_roles_are_listed(tmp_path):
    rows = [_row(i) for i in range(6)]
    rows += [_row(10, term="Fall 2026", title="Fall Role"), _row(11, term=None, title="No Term Role"),
             _row(12, stage=["part_time"], title="Part Time Role"), _row(13, status="closed", title="Closed Role"),
             _row(14, stage=["co_op"], title="Co-op Role")]
    text = eml.build(_site(tmp_path, {"MA": rows}))["README.md"]
    for gone in ("Fall Role", "No Term Role", "Part Time Role", "Closed Role"):
        assert gone not in text
    assert "Co-op Role" in text
    assert "**7 open Summer 2027 internships" in text


def test_a_role_posted_twice_by_one_employer_is_one_row(tmp_path):
    rows = [_row(i) for i in range(6)]
    rows.append(dict(rows[0], id="id900", apply_url="https://jobs.example.com/copy"))   # same title, same place
    text = eml.build(_site(tmp_path, {"MA": rows}))["fields/mechanical-engineering.md"]
    assert len(_table_rows(text)) == 6


def test_a_field_needs_min_field_roles_for_a_section(tmp_path):
    rows = [_row(i) for i in range(6)] + [_row(20 + i, tags=("nursing",), title=f"Nurse {i}") for i in range(2)]
    files = eml.build(_site(tmp_path, {"MA": rows}))
    assert "## Mechanical Engineering" in files["README.md"]
    assert "## Nursing" not in files["README.md"] and "fields/nursing.md" not in files


def test_no_field_with_enough_roles_writes_nothing(tmp_path):
    with pytest.raises(SystemExit):
        eml.build(_site(tmp_path, {"MA": [_row(i) for i in range(3)]}))


def test_listings_missing_optional_fields_still_render(tmp_path):
    rows = [_row(i) for i in range(5)]
    bare = {"id": "bare1", "title": "Bare Intern", "field_tags": ["mechanical"], "term": "Summer 2027",
            "apply_url": "https://jobs.example.com/bare", "status": "open"}     # no company, place, dates, stage
    rows.append(bare)
    rows.append(_row(7, field_tags=None, title="Untagged Intern"))             # no field: in no section
    files = eml.build(_site(tmp_path, {"MA": rows}))
    line = next(r for r in _table_rows(files["fields/mechanical-engineering.md"]) if "Bare Intern" in r)
    cells = [c.strip() for c in BAR.split(line)[1:-1]]
    assert cells[0] == "" and cells[2] == "United States" and cells[3] == "" and cells[4] == ""
    assert "Untagged Intern" not in files["fields/mechanical-engineering.md"]


# ---------------------------------------------------------------- caps and size

def test_rows_are_capped_per_field_newest_first(tmp_path, monkeypatch):
    rows = [_row(i, posted_at=f"2026-09-{1 + i % 20:02d}T00:00:00") for i in range(50)]
    monkeypatch.setattr(eml, "FILE_ROWS", 45)
    files = eml.build(_site(tmp_path, {"MA": rows}))
    readme = files["README.md"].split("## Mechanical Engineering")[1]
    assert len(_table_rows(readme)) == eml.README_ROWS[0] == 40
    assert "50 Summer 2027 roles, the 40 newest below" in readme
    assert "[One page with the newest 45](fields/mechanical-engineering.md)" in readme
    field = files["fields/mechanical-engineering.md"]
    assert len(_table_rows(field)) == 45 and "the 45 newest of 50" in field
    dates = [BAR.split(r)[5].strip() for r in _table_rows(field)]
    assert dates[0] == "Sep 20" and dates[-1] != "Sep 20"


def test_the_readme_shrinks_to_fit_the_budget(tmp_path, monkeypatch):
    rows = [_row(i) for i in range(50)]
    site = _site(tmp_path, {"MA": rows})
    full = eml.build(site)["README.md"]
    monkeypatch.setattr(eml, "README_BUDGET", len(full.encode()) - 1)
    small = eml.build(site)["README.md"]
    assert len(small.encode()) <= eml.README_BUDGET
    assert len(_table_rows(small.split("## Mechanical Engineering")[1])) == eml.README_ROWS[1]


def test_new_this_week_is_capped(tmp_path, monkeypatch):
    monkeypatch.setattr(eml, "NEW_ROWS", 3)
    text = eml.build(_site(tmp_path, {"MA": [_row(i) for i in range(8)]}))["README.md"]
    new = text.split("## New this week")[1].split("\n## ")[0]
    assert "8 Summer 2027 roles found in the last 7 days; the 3 newest are below." in new
    assert len(_table_rows(new)) == 3
    assert "(https://internscout.org/internships/new/)" in new


# ---------------------------------------------------------------- links

def test_links_go_to_the_field_page_the_employer_page_and_the_posting(tmp_path):
    rows = [_row(i, company_name="Acme") for i in range(5)] + [_row(10, company_name="Solo Shop")]
    rows.append(_row(11, term="Fall 2026", title="Fall Role"))       # counted on the field page, not listed
    text = eml.build(_site(tmp_path, {"MA": rows}))["README.md"]
    assert ("[See all 7 mechanical engineering internships on InternScout]"
            "(https://internscout.org/internships/mechanical-engineering/)") in text
    assert "| [Acme](https://internscout.org/internships/at/acme/) |" in text
    assert "| Solo Shop |" in text                                   # no employer page, no link
    assert "[Apply](https://jobs.example.com/10)" in text
    assert "[Mechanical Engineering](#mechanical-engineering)" in text


def test_a_field_with_no_page_links_the_dashboard(tmp_path):
    # A field whose slug is a state's gets no page (that path is the state's): "georgia" here.
    rows = [_row(i, state="GA", tags=("georgia",)) for i in range(6)]
    text = eml.build(_site(tmp_path, {"GA": rows}))["README.md"]
    assert "(https://internscout.org/?field=georgia)" in text
    assert "/internships/georgia/)" not in text.split("## Georgia")[1]


def test_github_anchors_match_headings_and_never_repeat():
    used = set()
    assert eml.anchor("Machine Learning and AI", used) == "machine-learning-and-ai"
    assert eml.anchor("Law and Legal", used) == "law-and-legal"
    assert eml.anchor("Law and Legal", used) == "law-and-legal-1"


# ---------------------------------------------------------------- the brand and the rules

def test_slogan_disclaimer_and_report_link(tmp_path):
    files = eml.build(_site(tmp_path, {"MA": [_row(i) for i in range(6)]}), repo="someone/list")
    for text in files.values():
        assert "**Built by one student, made for all students.**" in text
        assert "Not affiliated with UMass Amherst" in text
        assert "https://github.com/someone/list/issues/new" in text
        assert "Bruce" not in text and "McGinley" not in text


# ---------------------------------------------------------------- same data, same bytes

def test_same_data_writes_the_same_bytes_in_any_order(tmp_path):
    rows = [_row(i, posted_at="2026-09-20T00:00:00", first_seen="2026-09-21T00:00:00") for i in range(30)]
    a = eml.build(_site(tmp_path / "a", {"MA": rows}))
    shuffled = rows[:]
    random.Random(4).shuffle(shuffled)
    b = eml.build(_site(tmp_path / "b", {"MA": shuffled}))
    assert a == b
    assert "**Updated September 23, 2026.**" in a["README.md"]      # the export's day, not the clock


def test_a_later_export_on_the_same_day_changes_nothing(tmp_path):
    rows = [_row(i) for i in range(6)]
    a = eml.build(_site(tmp_path / "a", {"MA": rows}, "2026-09-23T04:00:00+00:00"))
    b = eml.build(_site(tmp_path / "b", {"MA": rows}, "2026-09-23T22:00:00+00:00"))
    assert a == b


def test_write_removes_stale_field_files_and_nothing_else(tmp_path):
    out = tmp_path / "out"
    (out / "fields").mkdir(parents=True)
    (out / "fields" / "gone-field.md").write_text("old", encoding="utf-8")
    (out / "LICENSE").write_text("keep", encoding="utf-8")
    files = eml.build(_site(tmp_path / "site", {"MA": [_row(i) for i in range(6)]}))
    eml.write(str(out), files)
    assert sorted(os.listdir(out / "fields")) == ["mechanical-engineering.md"]
    assert (out / "LICENSE").read_text(encoding="utf-8") == "keep"
    assert (out / "README.md").read_bytes().decode("utf-8") == files["README.md"]   # LF, as built
    assert b"\r\n" not in (out / "README.md").read_bytes()
