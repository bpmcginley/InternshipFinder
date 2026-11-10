"""The role index (worker/ORDERS.md, "The role index"): the open roles an employer can buy a paid
listing for, which the buy page searches and the Worker checks every order against. Only roles the site
lists today, from a real employer, with an https apply link and a well-formed id; one row per role;
the same bytes from the same data."""
import json
import os
import random
from datetime import datetime, timezone

from internscout import role_index, seo_pages

NOW = datetime(2026, 10, 19, 15, 37, 28, tzinfo=timezone.utc)
DAY = "2026-10-19"


def _id(i):
    return f"{i:016x}"


def _row(i, company="Acme Robotics", title=None, **over):
    x = {"id": _id(i), "company_name": company, "title": title or f"Robotics Intern {i}",
         "field_tags": ["mechanical"], "stage": ["internship"], "term": "Summer 2027", "salary": None,
         "posted_at": "2026-10-10T00:00:00", "first_seen": "2026-10-11T00:00:00",
         "regions": [{"loc": f"Town {i}, MA", "kind": "x", "state": "MA"}],
         "apply_url": f"https://jobs.example.com/{i}", "status": "open", "is_remote": False,
         "insights": None, "restrictions": []}
    x.update(over)
    return x


def _write(tmp_path, rows, name="site"):
    site = tmp_path / name
    role_index.write(str(site), rows, NOW, DAY)
    folder = site / "data" / "roles"
    return {f: json.loads((folder / f).read_text(encoding="utf-8")) for f in sorted(os.listdir(folder))
            if f.endswith(".json")}


def _bytes(site):
    folder = os.path.join(site, "data", "roles")
    return {f: open(os.path.join(folder, f), "rb").read() for f in sorted(os.listdir(folder))}


def _ids(files):
    return [r["id"] for f, d in files.items() if f != "index.json" for r in d["roles"]]


def test_only_qualifying_roles_are_listed():
    rows = [_row(1),
            _row(2, status="closed"),
            _row(3, company="Confidential"),                                   # not a real employer
            _row(4, apply_url="http://jobs.example.com/4"),                    # not https
            _row(5, apply_url="mailto:jobs@example.com"),
            _row(6, insights={"deadline": "2026-10-18"}),                      # passed yesterday
            _row(7, insights={"deadline": "2026-10-19"}),                      # closes today: still open
            _row(8, insights={"deadline": "2026-11-30T23:59:00"}),
            _row(9, id="id9"),                                                 # a fixture's id
            _row(10, id=_id(10).upper()),
            _row(11, id=_id(11)[:15]),
            _row(12, id=12)]
    assert [r["id"] for r in role_index.roles(rows, DAY)] == [_id(1), _id(7), _id(8)]


def test_a_row_carries_what_the_site_shows():
    x = _row(1, company="The Acme Company Inc.", title="Data Intern", field_tags=["data", "swe"],
             regions=[{"loc": "Boston, MA", "kind": "x", "state": "MA"},
                      {"loc": "Austin, TX", "kind": "x", "state": "TX"}])
    [r] = role_index.roles([x], DAY)
    assert r == {"id": _id(1), "k": "acme", "co": "The Acme Company Inc.", "t": "Data Intern",
                 "loc": "Boston, MA +1", "u": "https://jobs.example.com/1", "f": ["data", "swe"],
                 "unpaid": False}
    assert r["loc"] == seo_pages.place(x)
    [r] = role_index.roles([_row(2, field_tags=[], regions=[], is_remote=True)], DAY)
    assert r["f"] == [] and r["loc"] == "Remote"


def test_unpaid_is_read_as_placements_reads_it():
    rows = [_row(1, restrictions=["unpaid"]),
            _row(2, insights={"pay": "unpaid"}),
            _row(3, restrictions=["paid"], insights={"pay": "unpaid"}),        # restrictions come first
            _row(4, insights={"pay": "paid"}),
            _row(5, restrictions=["stipend"])]
    assert {r["id"]: r["unpaid"] for r in role_index.roles(rows, DAY)} == {
        _id(1): True, _id(2): True, _id(3): False, _id(4): False, _id(5): False}


def test_shard_is_the_first_character_of_the_key():
    assert [role_index.shard(k) for k in ("acme", "3m", "zeta", "&yet", "élan", "", " x")] == \
        ["a", "3", "z", "_", "_", "_", "_"]
    rows = [_row(1, company="Acme"), _row(2, company="3M"), _row(3, company="&Yet"), _row(4, company="Zeta")]
    ix = role_index.employers(role_index.roles(rows, DAY))
    assert {e["n"]: e["s"] for e in ix} == {"Acme": "a", "3M": "3", "&Yet": "_", "Zeta": "z"}


def test_files_index_and_shards(tmp_path):
    rows = [_row(1, company="Acme"), _row(2, company="ACME Inc."), _row(3, company="acme", title="Ops Intern"),
            _row(4, company="3M"), _row(5, company="&Yet"), _row(6, company="Zeta", status="closed")]
    files = _write(tmp_path, rows)
    assert list(files) == ["3.json", "_.json", "a.json", "index.json"]      # no shard without roles
    assert all(d["generated"] == "2026-10-19T15:37:28+00:00" for d in files.values())
    ix = files["index.json"]["employers"]
    # Spellings of one employer are one entry, named by the spelling most of its roles use (a tie goes
    # to the shorter name, then the name itself), and counted once per role.
    assert ix == [{"k": "&yet", "n": "&Yet", "c": 1, "s": "_"},
                  {"k": "3m", "n": "3M", "c": 1, "s": "3"},
                  {"k": "acme", "n": "Acme", "c": 3, "s": "a"}]
    # Every count matches its shard, and every role's employer is in the index under that shard.
    for e in ix:
        assert sum(r["k"] == e["k"] for r in files[f"{e['s']}.json"]["roles"]) == e["c"]
    keys = {e["k"]: e["s"] for e in ix}
    for f, d in files.items():
        if f != "index.json":
            assert all(keys[r["k"]] + ".json" == f for r in d["roles"])


def test_sort_orders(tmp_path):
    rows = [_row(5, company="beta", title="Zoo Intern"), _row(4, company="Alpha", title="b Intern"),
            _row(3, company="alpha", title="B Intern"), _row(2, company="Alpha", title="A Intern"),
            _row(1, company="Beta", title="Zoo Intern", regions=[{"loc": "Elsewhere, NY", "kind": "x", "state": "NY"}]),
            _row(6, company="bravo"), _row(7, company="Apex")]
    files = _write(tmp_path, rows)
    # Employers by name, ignoring case.
    assert [e["n"] for e in files["index.json"]["employers"]] == ["Alpha", "Apex", "Beta", "bravo"]
    # Roles by company, then title, both ignoring case, then id.
    assert [(r["co"], r["t"]) for r in files["a.json"]["roles"]] == [
        ("Alpha", "A Intern"), ("alpha", "B Intern"), ("Alpha", "b Intern"), ("Apex", "Robotics Intern 7")]
    assert [r["id"] for r in files["b.json"]["roles"]] == [_id(1), _id(5), _id(6)]


def test_a_role_posted_on_two_boards_is_offered_once():
    # Boeing's JR2026520392 and JR2026520392-1: same title and place, two ids. The newer posting stays,
    # as on the employer's page (seo_pages.dedupe_roles).
    a = _row(1, company="Boeing", title="Engineering Intern", posted_at="2026-10-01T00:00:00")
    b = _row(2, company="Boeing", title="Engineering  intern", posted_at="2026-10-05T00:00:00",
             regions=a["regions"])
    other = _row(3, company="Raytheon", title="Engineering Intern", regions=a["regions"])
    elsewhere = _row(4, company="Boeing", title="Engineering Intern")
    assert sorted(r["id"] for r in role_index.roles([a, b, other, elsewhere], DAY)) == [_id(2), _id(3), _id(4)]
    # Only qualifying copies count: when the newer one's deadline has passed, the older one is offered.
    b["insights"] = {"deadline": "2026-10-01"}
    assert sorted(r["id"] for r in role_index.roles([a, b], DAY)) == [_id(1)]


def test_the_same_data_gives_the_same_bytes(tmp_path):
    rows = [_row(i, company=c, title=t) for i, (c, t) in
            enumerate([("Acme", "X"), ("acme", "X"), ("Zeta", "Y"), ("Élan", "Zürich Intern"), ("3M", "W")] * 3)]
    role_index.write(str(tmp_path / "one"), rows, NOW, DAY)
    shuffled = rows[:]
    random.Random(7).shuffle(shuffled)
    role_index.write(str(tmp_path / "two"), shuffled, NOW, DAY)
    one = _bytes(str(tmp_path / "one"))
    assert one == _bytes(str(tmp_path / "two"))
    text = one["l.json"].decode("utf-8")                # employer_key("Élan") is "lan"
    assert "Élan" in text and "Zürich" in text and text.startswith('{"generated":"') and text.endswith("]}\n")


def test_a_shard_with_no_roles_left_is_removed(tmp_path):
    files = _write(tmp_path, [_row(1, company="Acme"), _row(2, company="Zeta")])
    assert "z.json" in files
    keep = tmp_path / "site" / "data" / "roles" / "notes.txt"
    keep.write_text("x", encoding="utf-8")
    files = _write(tmp_path, [_row(1, company="Acme")])
    assert "z.json" not in files and keep.exists()


def test_today_defaults_to_the_data_day(tmp_path):
    rows = [_row(1, insights={"deadline": "2026-10-18"}), _row(2, insights={"deadline": "2026-10-19"})]
    role_index.write(str(tmp_path), rows, NOW)
    roles = json.loads((tmp_path / "data" / "roles" / "a.json").read_text(encoding="utf-8"))["roles"]
    assert [r["id"] for r in roles] == [_id(2)]


def _site(tmp_path, rows):
    data = tmp_path / "data" / "listings"
    data.mkdir(parents=True)
    (data / "MA.json").write_text(json.dumps(rows), encoding="utf-8")
    (data / "index.json").write_text(json.dumps({"generated_at": "2026-10-19T15:37:28.473703+00:00",
                                                 "files": {"MA": {"file": "listings/MA.json"}}}), encoding="utf-8")
    (tmp_path / "data" / "majors.json").write_text(json.dumps({"majors": []}), encoding="utf-8")
    return str(tmp_path)


def test_the_site_build_writes_it_and_build_alone_does_not(tmp_path, monkeypatch):
    monkeypatch.setattr(seo_pages, "today_utc", lambda: DAY)
    rows = [_row(1), _row(2, company="Zeta", insights={"deadline": "2026-10-18"})]
    site = _site(tmp_path / "a", rows)
    seo_pages.build(site)
    assert not os.path.exists(os.path.join(site, "data", "roles"))      # growth/report.py builds on docs/
    seo_pages.main(["seo_pages", site])
    got = _bytes(site)
    assert list(got) == ["a.json", "index.json"]
    ix = json.loads(got["index.json"])
    assert ix == {"generated": "2026-10-19T15:37:28+00:00",
                  "employers": [{"k": "acme robotics", "n": "Acme Robotics", "c": 1, "s": "a"}]}
    # The same data built again: the same files.
    again = _site(tmp_path / "b", rows)
    seo_pages.main(["seo_pages", again])
    assert _bytes(again) == got
