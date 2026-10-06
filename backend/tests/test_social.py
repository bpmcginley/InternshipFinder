"""growth/social.py: brand posts written from the data, short enough for every account."""
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
_spec = importlib.util.spec_from_file_location("social", os.path.join(ROOT, "growth", "social.py"))
social = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(social)

NOW = datetime(2026, 9, 23, 12, tzinfo=timezone.utc)


def _x(i, company, first_seen="2026-09-21T00:00:00", posted_at=None):
    return {"id": str(i), "company_name": company, "first_seen": first_seen, "posted_at": posted_at}


def test_post_fits_bluesky_and_ends_with_the_landing_page():
    items = [_x(i, "A Very Long Employer Name Incorporated %d" % i) for i in range(40)]
    text, url = social.compose("ml", items, 40)
    assert len(text) <= social.LIMIT
    assert text.endswith(url) and url == "https://internscout.org/internships/machine-learning-ai/"
    assert text.startswith("40 new machine learning and AI internships")


def test_old_postings_a_scan_just_reached_are_not_new():
    assert social.fresh(_x(1, "A"), NOW)
    assert not social.fresh(_x(2, "A", posted_at="2024-09-01T00:00:00"), NOW)
    assert not social.fresh(_x(3, "A", first_seen="2026-09-01T00:00:00"), NOW)


# ---------------------------------------------------------------- links only to pages that exist

def test_a_field_without_a_page_links_the_dashboard_instead(monkeypatch):
    items = [_x(i, f"Co {i}") for i in range(6)]
    # Below seo_pages.MIN_OPEN open roles the field has no landing page.
    text, url = social.compose("ml", items, social.sp.MIN_OPEN - 1)
    assert url == "https://internscout.org/?field=ml" and text.endswith(url)
    # A field whose slug is a state's gets no page either: the state's page has that path.
    monkeypatch.setattr(social.digest, "STATE_SLUGS", {"machine-learning-ai"})
    assert social.compose("ml", items, 500)[1] == "https://internscout.org/?field=ml"
    monkeypatch.undo()
    assert social.compose("ml", items, 500)[1] == "https://internscout.org/internships/machine-learning-ai/"


def test_the_link_rule_is_the_digests():
    for tag, n in (("ml", 0), ("ml", 5), ("ml", 4), ("data", 99)):
        assert (social.link(tag, n).startswith("https://internscout.org/internships/")
                == social.digest.has_page(tag, n))


# ---------------------------------------------------------------- the run

def _site(tmp_path, made, rows=None):
    """A site whose export was made at made, with six new roles in one field nearby."""
    seen = ((made or _now()) - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%S")
    rows = rows if rows is not None else [
        {"id": f"n{i}", "company_name": f"Company {i}", "title": f"Data Intern {i}", "field_tags": ["data"],
         "first_seen": seen, "posted_at": None, "status": "open", "is_remote": False,
         "regions": [{"loc": "Boston, MA", "kind": "x", "state": "MA"}], "apply_url": f"https://jobs.example.com/{i}"}
        for i in range(6)]
    data = tmp_path / "data" / "listings"
    data.mkdir(parents=True)
    (data / "MA.json").write_text(json.dumps(rows), encoding="utf-8")
    index = {"files": {"MA": {"file": "listings/MA.json"}}}
    if made is not None:
        index["generated_at"] = made.isoformat()
    (data / "index.json").write_text(json.dumps(index), encoding="utf-8")
    (tmp_path / "data" / "majors.json").write_text(json.dumps({"majors": []}), encoding="utf-8")
    return str(tmp_path)


@pytest.fixture
def no_accounts(monkeypatch):
    for k in ("BLUESKY_HANDLE", "BLUESKY_APP_PASSWORD", "MASTODON_URL", "MASTODON_TOKEN", "DISCORD_WEBHOOK_URL"):
        monkeypatch.delenv(k, raising=False)


def _now():
    return datetime.now(timezone.utc)


def test_a_fresh_export_is_posted(tmp_path, no_accounts, capsys):
    assert social.main(["social.py", _site(tmp_path, _now() - timedelta(hours=3)), "--send"]) == 0
    out = capsys.readouterr().out
    assert out.startswith("6 new ") and "in the Northeast and remote this week" in out
    assert "not posting" not in out


@pytest.mark.parametrize("age", [timedelta(days=2, hours=1), timedelta(days=9)])
def test_a_stale_export_posts_nothing_and_says_why(tmp_path, monkeypatch, capsys, age):
    """A stalled ingest leaves the same export behind, and every scheduled run would post its week again."""
    monkeypatch.setenv("DISCORD_WEBHOOK_URL", "https://discord.com/api/webhooks/1/secret")
    monkeypatch.setattr(social, "to_discord", lambda t: pytest.fail("posted from a stale export"))
    assert social.main(["social.py", _site(tmp_path, _now() - age), "--send"]) == 0
    out = capsys.readouterr().out
    assert "not posting: the data export is from" in out and "stalled" in out
    assert "internships" not in out                                    # no post text either


def test_an_export_with_no_time_counts_as_stale(tmp_path, no_accounts, capsys):
    assert social.main(["social.py", _site(tmp_path, None), "--send"]) == 0
    assert "no generated_at" in capsys.readouterr().out


def _hook_refused(*_a, **_k):
    raise urllib.error.HTTPError("https://discord.com/api/webhooks/1/secret-token", 401, "Unauthorized", {},
                                 io.BytesIO(b'{"message": "Invalid Webhook Token"}'))


def test_a_failed_account_fails_the_run_after_trying_the_others(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("MASTODON_URL", "https://mastodon.example")
    monkeypatch.setenv("MASTODON_TOKEN", "mastodon-secret-token")
    monkeypatch.setenv("DISCORD_WEBHOOK_URL", "https://discord.com/api/webhooks/1/secret-token")
    monkeypatch.delenv("BLUESKY_HANDLE", raising=False)
    tried = []
    monkeypatch.setattr(social, "to_mastodon", lambda t: _hook_refused())
    monkeypatch.setattr(social, "to_discord", lambda t: tried.append("Discord") or "sent")
    assert social.main(["social.py", _site(tmp_path, _now() - timedelta(hours=1)), "--send"]) == 1
    out = capsys.readouterr().out
    assert tried == ["Discord"]                                        # the next account was still tried
    assert "[social] Mastodon failed: HTTPError" in out and "[social] Discord: sent" in out
    for secret in ("secret-token", "mastodon-secret-token", "discord.com/api", "Invalid Webhook Token"):
        assert secret not in out


def test_every_account_posting_is_a_green_run(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("DISCORD_WEBHOOK_URL", "https://discord.com/api/webhooks/1/x")
    for k in ("BLUESKY_HANDLE", "MASTODON_URL"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(social, "to_discord", lambda t: "sent")
    assert social.main(["social.py", _site(tmp_path, _now() - timedelta(hours=1)), "--send"]) == 0


def test_a_post_links_the_dashboard_when_the_field_has_too_few_open_roles(tmp_path, no_accounts, capsys,
                                                                         monkeypatch):
    monkeypatch.setattr(social.sp, "MIN_OPEN", 50)                     # six open roles: no page
    assert social.main(["social.py", _site(tmp_path, _now() - timedelta(hours=1))]) == 0
    assert capsys.readouterr().out.rstrip().endswith("https://internscout.org/?field=data")


def test_new_roles_are_counted_once_per_employer(tmp_path, no_accounts):
    """The same role on two of one employer's boards is one role, as in the digest."""
    made = _now() - timedelta(hours=1)
    seen = (made - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%S")
    row = lambda i, co: {"id": f"r{i}", "company_name": co, "title": "Data Intern", "field_tags": ["data"],  # noqa: E731
                         "first_seen": seen, "posted_at": None, "status": "open", "is_remote": False,
                         "regions": [{"loc": "Boston, MA", "kind": "x", "state": "MA"}],
                         "apply_url": f"https://jobs.example.com/{i}"}
    rows = [row(i, f"Co {i}") for i in range(5)] + [row(9, "Co 0 Inc.")]
    ranked, _, _ = social.candidates(_site(tmp_path, made, rows))
    assert [(t, len(v)) for t, v in ranked] == [("data", 5)]


def test_the_linkedin_draft_carries_its_card_for_the_download_button(tmp_path, monkeypatch):
    # The analytics page can only reach D1, so the card's bytes go into the draft row.
    import base64
    import metrics
    calls = []

    def fake_d1(token, sql, params=None):
        calls.append((sql, params))
        if sql.startswith("ALTER TABLE"):
            raise RuntimeError('D1: [{"message": "duplicate column name: image_b64"}]')
    monkeypatch.setattr(metrics, "d1", fake_d1)
    card = tmp_path / "card.jpg"
    card.write_bytes(b"\xff\xd8jpeg")
    data = {"linkedin_text": "text", "card_url": "https://example.test/c.jpg", "url": "https://internscout.org/"}
    social.save_drafts(data, "token", str(card))
    insert = next(p for s, p in calls if s.startswith("INSERT"))
    assert base64.b64decode(insert[-1]) == b"\xff\xd8jpeg"
    social.save_drafts(data, "token", str(tmp_path / "missing.jpg"))     # no card: the text still saves
    assert [p for s, p in calls if s.startswith("INSERT")][-1][-1] is None


# ---------------------------------------------------------------- the weekly email's line (2026-10-06)

FORM = "https://buttondown.com/api/emails/embed-subscribe/internscout-test"


def _live(site, action=FORM):
    """The dashboard's config line, as docs/index.html writes it: the one place the form address lives."""
    with open(os.path.join(site, "index.html"), "w", encoding="utf-8") as f:
        f.write(f'<script>window.CONFIG = {{\n    digest: {{ provider: "Buttondown", formAction: "{action}" }},\n}};</script>')
    return site


def test_the_signup_line_is_tagged_per_channel_and_fits_bluesky():
    items = [_x(i, "A Very Long Employer Name Incorporated %d" % i) for i in range(40)]
    for channel in ("bluesky", "mastodon", "discord"):
        line = social.signup_line(channel)
        assert line == f"Every Monday by email: https://internscout.org/digest/?utm_source={channel}&utm_medium=social"
        text, url = social.compose("ml", items, 40, signup=line)
        assert len(text) <= social.LIMIT and text.endswith("\n\n" + line) and url in text
    # Employers' names give way to the line, not the other way round.
    short = [_x(i, f"Co {i}") for i in range(6)]
    text, _ = social.compose("ml", short, 40, signup=social.signup_line("bluesky"))
    assert text.endswith(social.signup_line("bluesky")) and "from Co" in text


def test_a_post_too_long_for_the_line_goes_out_without_it(monkeypatch):
    monkeypatch.setattr(social, "LIMIT", 140)
    text, url = social.compose("ml", [_x(i, "Co") for i in range(6)], 40, signup=social.signup_line("bluesky"))
    assert "digest" not in text and text.endswith(url) and len(text) <= 140


def test_the_line_goes_out_only_once_the_form_has_an_address(tmp_path, monkeypatch, capsys):
    sent = {}
    for k in ("BLUESKY_HANDLE", "BLUESKY_APP_PASSWORD", "MASTODON_URL", "MASTODON_TOKEN", "DISCORD_WEBHOOK_URL"):
        monkeypatch.setenv(k, "x")
    monkeypatch.setattr(social, "to_bluesky", lambda t, u: sent.setdefault("Bluesky", t) and "ok")
    monkeypatch.setattr(social, "to_mastodon", lambda t: sent.setdefault("Mastodon", t) and "ok")
    monkeypatch.setattr(social, "to_discord", lambda t: sent.setdefault("Discord", t) and "ok")
    monkeypatch.setattr(social, "CHANNELS", [
        ("Bluesky", ("BLUESKY_HANDLE",), lambda t, u: social.to_bluesky(t, u)),
        ("Mastodon", ("MASTODON_URL",), lambda t, u: social.to_mastodon(t)),
        ("Discord", ("DISCORD_WEBHOOK_URL",), lambda t, u: social.to_discord(t))])
    site = _live(_site(tmp_path, _now() - timedelta(hours=1)), action="")
    assert social.main(["social.py", site, "--send"]) == 0
    assert sent and not [t for t in sent.values() if "digest" in t]                 # empty: no line anywhere
    sent.clear()
    _live(site)
    assert social.main(["social.py", site, "--send"]) == 0
    for name, text in sent.items():
        assert text.endswith(f"https://internscout.org/digest/?utm_source={name.lower()}&utm_medium=social"), name
        assert len(text) <= social.LIMIT
    assert set(sent) == {"Bluesky", "Mastodon", "Discord"}
    assert social.draft(site)[0].count("digest") == 0                                 # the report's copy
    assert social.draft(site, "bluesky")[0].endswith("utm_source=bluesky&utm_medium=social")


def test_bluesky_links_both_addresses_by_byte():
    text = "5 new café internships.\n\nhttps://internscout.org/internships/x/\n\n" + social.signup_line("bluesky")
    facets = social.link_facets(text)
    raw = text.encode("utf-8")
    got = [raw[f["index"]["byteStart"]:f["index"]["byteEnd"]].decode() for f in facets]
    assert got == ["https://internscout.org/internships/x/", social.signup_url("bluesky")]
    assert [f["features"][0]["uri"] for f in facets] == got


def test_the_picture_channels_carry_the_line_once_live(tmp_path, monkeypatch):
    items = [{"company_name": c, "title": "Intern", "keys": {"MA"}} for c in ["Baker Tilly", "Crowe", "MFS"] * 2]
    monkeypatch.setattr(social, "candidates", lambda site: ([("accounting", items)], NOW, {"accounting": 200}))
    site = str(tmp_path)
    off = social.card_data(site, today=NOW)
    assert off["signup"] == {} and "digest" not in off["linkedin_text"] + off["instagram_caption"]
    on = social.card_data(_live(site), today=NOW)
    assert social.signup_line("linkedin") in on["linkedin_text"] and len(on["linkedin_text"]) <= social.LINKEDIN_MAX
    assert "internscout.org/digest" in on["instagram_caption"] and len(on["instagram_caption"]) <= social.IG_CAPTION_MAX
    assert on["signup"] == {"youtube": "https://internscout.org/digest/?utm_source=youtube&utm_medium=social"}
    # Each line still ends the post's own text, ahead of the slogan and the tags.
    assert on["linkedin_text"].index("digest") < on["linkedin_text"].index(social.SLOGAN)
    import youtube
    desc = youtube.description_for(on)
    assert "Every Monday by email: https://internscout.org/digest/?utm_source=youtube&utm_medium=social" in desc
    assert "digest" not in youtube.description_for(off)
