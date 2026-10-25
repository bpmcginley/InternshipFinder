"""Tuesday's Instagram search carousel (2026-10-25): growth/social.py carousel, which draws the week's
real-search slides from growth/campaign.py, and the carousel publish in growth/instagram.py."""
import importlib.util
import json
import os
import sys
from datetime import datetime, timezone

import pytest

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
sys.path.insert(0, os.path.join(ROOT, "growth"))
sys.path.insert(0, os.path.join(ROOT, "backend"))
import social  # noqa: E402
from test_seo_pages import _row, _site  # noqa: E402

_spec = importlib.util.spec_from_file_location("instagram_c", os.path.join(ROOT, "growth", "instagram.py"))
ig = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ig)

TUESDAY = datetime(2026, 10, 27, 15, tzinfo=timezone.utc)
URLS = [f"https://x/2026-10-27-search-finance-{i}.jpg" for i in range(1, 6)]


def _fonts():
    pytest.importorskip("PIL")
    import cards
    try:
        cards.font("sans", 20)
    except RuntimeError:
        pytest.skip("no usable font on this machine")


def _post(tmp_path, **extra):
    post = tmp_path / "post.json"
    post.write_text(json.dumps({"instagram_caption": "card caption", "card_url": "https://x/card.jpg",
                                "reel": False, **extra}), encoding="utf-8")
    return post


def _send(monkeypatch, tmp_path, post):
    monkeypatch.setenv("INSTAGRAM_TOKEN", "t")
    monkeypatch.setattr(ig, "token_for_run", lambda secret, cf: "tok")
    monkeypatch.setattr(ig, "wait_for_image", lambda url: None)
    result = tmp_path / "status.json"
    code = ig.main(["instagram.py", str(post), "--send", f"--status-file={result}"])
    return code, json.loads(result.read_text())


def test_the_carousel_is_the_weeks_real_search_drawn_as_feed_slides(tmp_path):
    _fonts()
    rows = [_row(i, state="NY", tags=("finance",), company_name=f"Bank {i % 6}", salary="$30/hr")
            for i in range(20)]
    site = _site(tmp_path, {"NY": rows})
    out = tmp_path / "out"
    out.mkdir()
    got = social.carousel(site, str(out), TUESDAY)
    names = got["carousel_names"]
    assert 2 <= len(names) <= 10
    assert names[0] == "2026-10-27-search-finance-1.jpg"
    assert got["carousel_urls"] == [social.CARD_BASE + n for n in names]
    from PIL import Image
    for n in names:
        img = Image.open(out / n)
        assert img.format == "JPEG" and img.size == (1080, 1350)
    caption = got["carousel_caption"]
    assert "Link in bio" in caption and "http" not in caption
    assert len(caption) <= social.IG_CAPTION_MAX


def test_no_search_worth_showing_means_no_carousel(tmp_path):
    rows = [_row(i, state="NY", tags=("finance",)) for i in range(3)]     # under campaign.MIN_SEARCH
    site = _site(tmp_path, {"NY": rows})
    assert social.carousel(site, str(tmp_path), TUESDAY) == {}


def test_write_out_adds_the_carousel_on_a_card_day_only(monkeypatch, tmp_path):
    made = []
    monkeypatch.setattr(social, "carousel", lambda site, out, today: made.append(today) or
                        {"carousel_names": ["a.jpg", "b.jpg"], "carousel_urls": URLS[:2], "carousel_caption": "c"})
    import cards
    monkeypatch.setattr(cards, "render", lambda data, path: None)
    for reel in (False, True):
        monkeypatch.setattr(social, "card_data", lambda site, today=None, reel=reel: {"reel": reel})
        data = social.write_out("docs", str(tmp_path / str(reel)), TUESDAY)
        written = json.loads((tmp_path / str(reel) / "post.json").read_text(encoding="utf-8"))
        assert ("carousel_urls" in written) is (not reel) and data == written
    assert made == [TUESDAY]


def test_a_carousel_that_cannot_be_drawn_leaves_the_card(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(social, "carousel", lambda *a: (_ for _ in ()).throw(RuntimeError("no font")))
    monkeypatch.setattr(social, "card_data", lambda site, today=None: {"reel": False})
    import cards
    monkeypatch.setattr(cards, "render", lambda data, path: None)
    assert social.write_out("docs", str(tmp_path), TUESDAY) == {"reel": False}
    assert "no carousel this time" in capsys.readouterr().out


def test_publish_carousel_makes_each_item_then_the_carousel_then_publishes(monkeypatch):
    calls = []

    def fake(method, path, params):
        calls.append((method, path, dict(params)))
        if path == "me":
            return {"user_id": "1789"}
        if path == "1789/media":
            return {"id": f"c-{sum(1 for c in calls if c[1] == '1789/media')}"}
        if path.startswith("c-"):
            return {"status_code": "FINISHED"}
        if path == "1789/media_publish":
            return {"id": "m-7"}
        raise AssertionError(path)
    monkeypatch.setattr(ig, "_request", fake)
    assert ig.publish_carousel("tok", URLS[:3], "caption", sleep=lambda s: None) == "m-7"
    made = [c[2] for c in calls if c[1] == "1789/media"]
    assert [m.get("image_url") for m in made[:3]] == URLS[:3]
    assert all(m["is_carousel_item"] == "true" and "caption" not in m for m in made[:3])
    assert made[3] == {"media_type": "CAROUSEL", "children": "c-1,c-2,c-3", "caption": "caption",
                       "access_token": "tok"}
    assert calls[-1][2]["creation_id"] == "c-4"


def test_a_carousel_needs_two_to_ten_images(monkeypatch):
    monkeypatch.setattr(ig, "_request", lambda *a: pytest.fail("nothing is sent"))
    for urls in (URLS[:1], URLS * 3):
        with pytest.raises(ig.InstagramError, match="2 to 10"):
            ig.publish_carousel("tok", urls, "c")


def test_a_tuesday_posts_the_carousel_and_not_the_card(monkeypatch, tmp_path, capsys):
    post = _post(tmp_path, carousel_urls=URLS, carousel_caption="search caption")
    sent = []
    monkeypatch.setattr(ig, "publish_carousel", lambda token, urls, caption: sent.append((urls, caption)) or "m-1")
    monkeypatch.setattr(ig, "publish", lambda *a: pytest.fail("do not also publish a card"))
    code, status = _send(monkeypatch, tmp_path, post)
    assert code == 0 and sent == [(URLS, "search caption")]
    assert status["requested"] == "carousel" and status["outcome"] == "published_carousel"
    assert "::warning" not in capsys.readouterr().out


def test_a_failed_carousel_still_posts_the_card(monkeypatch, tmp_path, capsys):
    post = _post(tmp_path, carousel_urls=URLS, carousel_caption="search caption")
    monkeypatch.setattr(ig, "publish_carousel", lambda *a: (_ for _ in ()).throw(ig.InstagramError("HTTP 400")))
    posted = []
    monkeypatch.setattr(ig, "publish", lambda token, url, caption: posted.append((url, caption)) or "m-2")
    code, status = _send(monkeypatch, tmp_path, post)
    assert code == 0 and posted == [("https://x/card.jpg", "card caption")]
    assert status["outcome"] == "card_fallback" and status["reason"] == "carousel_publish_failed"
    assert "::warning title=Instagram carousel unavailable::" in capsys.readouterr().out
    assert "HTTP 400" not in json.dumps(status)


def test_an_unconfirmed_carousel_publish_is_not_retried_as_a_card(monkeypatch, tmp_path):
    post = _post(tmp_path, carousel_urls=URLS)
    monkeypatch.setattr(ig, "publish_carousel", lambda *a: (_ for _ in ()).throw(ig.PublishOutcomeUnknown("lost")))
    monkeypatch.setattr(ig, "publish", lambda *a: pytest.fail("the carousel may already be up"))
    code, status = _send(monkeypatch, tmp_path, post)
    assert code == 1 and status["outcome"] == "unknown"


def test_a_post_without_a_carousel_is_still_a_card(monkeypatch, tmp_path):
    post = _post(tmp_path)
    monkeypatch.setattr(ig, "publish_carousel", lambda *a: pytest.fail("no carousel in post.json"))
    monkeypatch.setattr(ig, "publish", lambda *a: "m-3")
    code, status = _send(monkeypatch, tmp_path, post)
    assert code == 0 and status["requested"] == "card" and status["outcome"] == "published_card"


def test_the_workflow_serves_the_carousel_slides_beside_the_card():
    wf = open(os.path.join(ROOT, ".github", "workflows", "social.yml"), encoding="utf-8").read()
    step = wf.split("Put brand media where Instagram can fetch it", 1)[1].split("- name:", 1)[0]
    assert "carousel_names" in step and 'cp "out/$f" "cards/$f"' in step
    assert step.index("carousel_names") < step.index("git push")
