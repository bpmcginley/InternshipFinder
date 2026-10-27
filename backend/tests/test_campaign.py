"""growth/campaign.py: the weekly campaign pack (2026-10-25)."""
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

import pytest

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
sys.path.insert(0, os.path.join(ROOT, "growth"))
sys.path.insert(0, os.path.join(ROOT, "backend"))
import campaign  # noqa: E402
from internscout import seo_pages as sp  # noqa: E402
from test_seo_pages import _row, _site  # noqa: E402

NOW = datetime(2026, 10, 26, 12, tzinfo=timezone.utc)      # a Monday, ISO week 44


def _fonts():
    pytest.importorskip("PIL")
    import cards
    try:
        cards.font("sans", 20)
    except RuntimeError:
        pytest.skip("no usable font on this machine")


def _ny(i, tags=("finance",), **over):
    return _row(i, state="NY", tags=tags, company_name=f"Bank {i % 6}", **over)


def test_lint_refuses_hype_words_and_emoji_and_passes_plain_text():
    assert campaign.lint("Unlock your dream internship") == ["unlock", "dream internship"]
    assert campaign.lint("Find roles fast 🚀") == ["🚀", "emoji"]
    assert campaign.lint("Level up your search") == ["level up"]
    assert campaign.lint("151 open roles, 17 of them found in the last 7 days.") == []
    # Whole words only: "hacked" or "journeyman" would be a different word.
    assert campaign.lint("unlocked doors") == [] and campaign.lint("a hack") == ["hack"]


def test_every_hand_written_tip_is_clean_and_ends_on_what_internscout_does():
    assert len(campaign.TIPS) >= 8 and len({t["slug"] for t in campaign.TIPS}) == len(campaign.TIPS)
    for tip in campaign.TIPS:
        kickers = [k for k, _ in tip["slides"]]
        assert kickers[1:4] == ["1", "2", "3"] and kickers[-1] == "On InternScout", tip["slug"]
        assert tip["path"].startswith("/")
        for kicker, text in tip["slides"]:
            assert campaign.lint(f"{kicker} {text}") == [], (tip["slug"], text)
            assert "—" not in text                                 # no em dashes in copy


def test_the_tip_rotates_by_week():
    weeks = {campaign.tip_pick(NOW + timedelta(weeks=w))["slug"] for w in range(len(campaign.TIPS))}
    assert len(weeks) == len(campaign.TIPS)


def test_search_pick_needs_enough_roles_and_changes_field_each_week():
    rows = [_ny(i) for i in range(campaign.MIN_SEARCH)] + [_ny(100 + i, tags=("law",)) for i in range(20)]
    rows += [_ny(200 + i, tags=("arts",)) for i in range(campaign.MIN_SEARCH - 1)]       # one short
    listings = [dict(x, keys={"NY", "New York City"}) for x in rows]
    picks = {campaign.search_pick(listings, NOW.replace(day=d))["field"] for d in (19, 26)}
    assert picks == {"finance", "law"}                                  # two weeks, two fields; never arts
    pick = campaign.search_pick(listings, NOW)
    assert pick["place"] in campaign.SEARCH_PLACES and len(pick["items"]) >= campaign.MIN_SEARCH
    assert campaign.search_pick([dict(x, keys={"TX"}) for x in rows], NOW) is None


def test_search_slides_say_only_what_the_listings_show():
    items = [dict(_ny(i, salary="$25/hr" if i < 3 else None), keys={"NY"}) for i in range(16)]
    items[0]["years"] = ["sophomore"]
    pick = {"field": "finance", "place": "NY", "items": items}
    slides = campaign.search_slides(pick, NOW, None)
    words = [campaign.said(s) for s in slides]
    assert words[0] == "Finance internships in New York"
    assert words[1].startswith("16 open roles")
    assert any(w.startswith("$25 an hour, on the 3 of 16 postings") for w in words)
    assert any(w.startswith("1 of them say they take first-years") for w in words)
    assert slides[-1][0] == "Search it yourself"
    # No pay slide when no posting states an hourly rate, and no class-year slide when none says.
    bare = [dict(_ny(i), keys={"NY"}) for i in range(16)]
    kickers = [s[0] for s in campaign.search_slides({"field": "finance", "place": "NY", "items": bare}, NOW, None)]
    assert "Listed pay" not in kickers and "First-years and sophomores" not in kickers


def test_captions_tag_each_channel_and_fit_x():
    slides = [("A", "Finance internships in New York"), ("B", "151 open roles. " * 30, "151"), ("C", "Search it.")]
    caps = campaign.captions(slides, "/?field=finance&state=NY", "weekly-2026w44", "search")
    assert "utm_source=facebook&utm_medium=social&utm_campaign=weekly-2026w44" in caps["facebook"]
    assert "utm_content=search" in caps["facebook"]
    assert "?field=finance&state=NY&utm_source=youtube" in caps["youtube"]
    assert "http" not in caps["instagram"] and "Link in bio" in caps["instagram"]
    # X counts any link as 23 characters.
    text = re.sub(r"https?://\S+", "x" * 23, caps["x"])
    assert len(text) <= 280 and caps["x"].split(" https://")[0].endswith(".")
    assert len(caps["youtube_title"]) <= 95


def test_the_pack_is_written_in_both_sizes_with_captions_and_a_readme(tmp_path):
    _fonts()
    rows = [_ny(i, salary="$30/hr") for i in range(20)]
    site = _site(tmp_path, {"NY": rows})
    out = tmp_path / "pack"
    pack = campaign.build(site, str(out), NOW)
    assert pack and pack["week"] == "2026w44" and pack["campaign"] == "weekly-2026w44"
    for kind in ("search", "tip"):
        n = pack[kind]["slides"]
        assert len(pack[kind]["feed"]) == len(pack[kind]["tall"]) == n
        from PIL import Image
        assert Image.open(out / pack[kind]["feed"][0]).size == (1080, 1350)
        assert Image.open(out / pack[kind]["tall"][-1]).size == (1080, 1920)
    caps = json.loads((out / "captions.json").read_text(encoding="utf-8"))
    assert set(caps) == {"search", "tip"} and "utm_campaign=weekly-2026w44" in caps["search"]["facebook"]
    assert "utm_content=search" in caps["search"]["facebook"]
    assert "utm_content=tip" in caps["tip"]["facebook"]
    readme = (out / "README.md").read_text(encoding="utf-8")
    assert "Nothing here has been posted." in readme and "Before posting" in readme


def test_nothing_is_written_when_a_slide_breaks_the_rules(tmp_path, monkeypatch, capsys):
    rows = [_ny(i) for i in range(20)]
    site = _site(tmp_path, {"NY": rows})
    bad = [{"slug": "bad", "path": "/", "slides": [("Hook", "Unlock your future 🚀"), ("1", "a"), ("2", "b"),
                                                   ("3", "c"), ("On InternScout", "d")]}]
    monkeypatch.setattr(campaign, "TIPS", bad)
    out = tmp_path / "pack"
    assert campaign.build(site, str(out), NOW) is None
    assert not out.exists()
    assert "tip slide 1: unlock" in capsys.readouterr().out


def test_clip_cuts_at_a_sentence_when_it_can():
    assert campaign.clip("Short.", 10) == "Short."
    assert campaign.clip("First sentence here. Second one is long", 30) == "First sentence here."
    assert campaign.clip("one two three four five six", 12).endswith("…")


def test_the_workflow_builds_the_pack_weekly_and_posts_nothing():
    wf = open(os.path.join(ROOT, ".github", "workflows", "campaign.yml"), encoding="utf-8").read()
    assert "python growth/campaign.py docs --out=campaign" in wf and "upload-artifact" in wf
    assert "cron:" in wf and "--send" not in wf and "secrets." not in wf
    assert "contents: read" in wf
