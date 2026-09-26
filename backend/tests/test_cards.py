"""growth/cards.py and the picture-channel text in growth/social.py."""
import importlib.util
import os
import sys

import pytest

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
sys.path.insert(0, os.path.join(ROOT, "growth"))
sys.path.insert(0, os.path.join(ROOT, "backend"))
import social  # noqa: E402

POST = {"eyebrow": "New this week · Sep 26", "count": 21, "headline": "new accounting internships",
        "where": "in the Northeast and remote",
        "employers": ["Baker Tilly", "Assured Guaranty", "Vialto Partners", "Crowe", "MFS"]}


def _cards():
    pytest.importorskip("PIL")
    spec = importlib.util.spec_from_file_location("cards", os.path.join(ROOT, "growth", "cards.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    try:
        mod.font("sans", 20)
    except RuntimeError:
        pytest.skip("no usable font on this machine")
    return mod


def test_the_card_is_a_4_by_5_jpeg(tmp_path):
    cards = _cards()
    from PIL import Image
    out = cards.render(POST, str(tmp_path / "card.jpg"))
    with Image.open(out) as im:
        assert im.format == "JPEG" and im.size == (1080, 1350)
    assert os.path.getsize(out) < 8 * 1024 * 1024      # Instagram's image size limit


def test_long_text_is_cut_to_fit_instead_of_running_off_the_card(tmp_path):
    cards = _cards()
    from PIL import Image, ImageDraw
    d = ImageDraw.Draw(Image.new("RGB", (10, 10)))
    fnt = cards.font("sans", 42)
    cut = cards.fit(d, "Lockheed Martin Corporation Space Systems Division Incorporated", fnt, 600)
    assert cut.endswith("…") and d.textlength(cut, font=fnt) <= 600
    long = dict(POST, headline="new mechanical engineering and aerospace internships for everyone",
                employers=["A" * 80] + POST["employers"])
    cards.render(long, str(tmp_path / "long.jpg"))       # renders without raising


def test_hashtags_come_from_the_field_name():
    assert social.hashtag("Data science and analytics") == "#DataScience"
    assert social.hashtag("Accounting") == "#Accounting"
    assert social.hashtag("") == ""


def test_captions_fit_each_network_and_carry_the_slogan_and_disclaimer(monkeypatch):
    items = [{"company_name": c} for c in ["Baker Tilly"] * 3 + ["Crowe", "MFS", "Vialto Partners"]]
    from datetime import datetime, timezone
    now = datetime(2026, 9, 26, 15, tzinfo=timezone.utc)
    monkeypatch.setattr(social, "candidates", lambda site: ([("accounting", items)], now, {"accounting": 200}))
    data = social.card_data("docs", today=now)
    assert data["count"] == 6 and data["employers"][0] == "Baker Tilly"
    assert data["card_name"] == "2026-09-26-accounting.jpg"
    assert data["card_url"].startswith("https://raw.githubusercontent.com/bpmcginley/InternshipFinder/social-cards/")
    for key, limit in (("instagram_caption", social.IG_CAPTION_MAX), ("linkedin_text", social.LINKEDIN_MAX)):
        text = data[key]
        assert len(text) <= limit
        assert social.SLOGAN in text and social.DISCLAIMER in text
    assert "link in bio" in data["instagram_caption"]           # Instagram captions aren't clickable
    assert data["url"] in data["linkedin_text"]                  # LinkedIn's are
    assert data["instagram_caption"].count("#") <= 30            # Instagram's hashtag limit
