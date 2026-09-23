"""The daily focus searches follow whichever fields UMass majors are worst served in."""
import re

from internscout import focus
from internscout.classify import classify, stage_of


def _x(tags, key="MA"):
    return {"field_tags": list(tags), "keys": {key}}


MAJORS = [
    {"name": "French", "tags": ["languages"], "level": "undergrad"},
    {"name": "Spanish", "tags": ["languages"], "level": "undergrad"},
    {"name": "Italian", "tags": ["languages"], "level": "undergrad"},
    {"name": "Psychology", "tags": ["psychology"], "level": "undergrad"},
    {"name": "Finance", "tags": ["finance"], "level": "undergrad"},
    {"name": "Clinical Psych PhD", "tags": ["psychology"], "level": "grad"},
]


def test_more_majors_on_an_empty_field_rank_first():
    listings = [_x(["psychology"])] * 2 + [_x(["finance"])] * 500
    picks = focus.thinnest(listings, MAJORS)
    # Three language majors share one empty field; one psychology major has two roles nearby.
    assert [p[0] for p in picks] == ["languages", "psychology"]


def test_full_fields_and_far_away_roles():
    near = [_x(["psychology"])] * focus.ENOUGH
    far = [_x(["languages"], key="TX")] * 500      # plenty in Texas is still nothing nearby
    assert [p[0] for p in focus.thinnest(near + far, MAJORS)] == ["languages"]


def test_fields_with_no_search_bank_are_skipped():
    majors = [{"name": "Undeclared", "tags": [], "level": "undergrad"},
              {"name": "Finance", "tags": ["finance"], "level": "undergrad"}]
    assert focus.thinnest([], majors) == []          # finance has no bank; it is searched elsewhere


def test_interleave_reaches_every_field_early():
    q = focus.interleave(["languages", "arts"])
    assert q[:2] == [focus.SEARCHES["languages"][0], focus.SEARCHES["arts"][0]]
    assert len(q) == len(focus.SEARCHES["languages"]) + len(focus.SEARCHES["arts"])


def test_no_export_falls_back(tmp_path):
    assert focus.choose(None, ["x"]) == ["x"]
    assert focus.choose(str(tmp_path / "data"), ["x"]) == ["x"]


def test_bad_export_falls_back(tmp_path):
    (tmp_path / "data" / "listings").mkdir(parents=True)
    (tmp_path / "data" / "listings" / "index.json").write_text("not json", encoding="utf-8")
    assert focus.choose(str(tmp_path / "data"), ["x"]) == ["x"]


def _typical_title(query: str) -> str:
    """The title a query usually brings back: "fine arts internship" -> "Fine Arts Intern"."""
    if re.search(r"\bintern(ship)?s?\b", query, re.I):
        core = re.sub(r"\b(internships?|interns?|undergraduate|college student|summer \d{4}|\d{4})\b", "", query, flags=re.I)
        return re.sub(r"\s+", " ", core).strip().title() + " Intern"
    return query.title()


def test_every_search_can_add_to_its_own_field():
    for tag, queries in focus.SEARCHES.items():
        for q in queries:
            title = _typical_title(q)
            assert tag in classify(title), (tag, q, title, classify(title))
            assert stage_of(title), (q, title)
