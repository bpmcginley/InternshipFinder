"""growth/reels.py (the Thursday Reel), the Reel publish in growth/instagram.py, and the Reel day and
role slides in growth/social.py."""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone

import pytest

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
sys.path.insert(0, os.path.join(ROOT, "growth"))
sys.path.insert(0, os.path.join(ROOT, "backend"))
import social  # noqa: E402

_spec = importlib.util.spec_from_file_location("instagram_r", os.path.join(ROOT, "growth", "instagram.py"))
ig = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ig)

POST = {"eyebrow": "New this week · Oct 1", "count": 21, "headline": "new accounting internships",
        "where": "in the Northeast and remote",
        "roles": [{"company": "Baker Tilly", "title": "Audit Intern, Summer 2027", "place": "Boston, MA", "pay": "$30.00"},
                  {"company": "Crowe", "title": "Tax Intern", "place": "New York, NY +2", "pay": ""},
                  {"company": "Lockheed Martin Corporation Space Systems Division",
                   "title": "Financial Analyst Intern – Program Finance, Cost Accounting and Estimating (Summer 2027)",
                   "place": "Remote", "pay": "Paid"}]}


def _reels():
    pytest.importorskip("PIL")
    spec = importlib.util.spec_from_file_location("reels", os.path.join(ROOT, "growth", "reels.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    try:
        mod.font("sans", 20)
    except RuntimeError:
        pytest.skip("no usable font on this machine")
    return mod


def test_slides_are_vertical_and_last_about_fifteen_seconds():
    reels = _reels()
    shown = reels.slides(POST)
    assert len(shown) == 5                                   # title, three roles, the end
    assert all(img.size == (1080, 1920) for img, _ in shown)
    assert 10 <= sum(s for _, s in shown) <= 20


def test_nothing_is_drawn_where_the_reels_screen_puts_its_buttons():
    reels = _reels()
    from PIL import ImageChops, Image
    for img, _ in reels.slides(POST):
        bottom = img.crop((0, reels.SAFE_BOTTOM, 1080, 1920))
        plain = Image.new("RGB", bottom.size, bottom.getpixel((5, bottom.height - 5)))
        assert ImageChops.difference(bottom, plain).getbbox() is None


def test_the_ffmpeg_call_crossfades_each_slide_into_the_next():
    reels = _reels()
    cmd = reels.ffmpeg_command(["a.png", "b.png", "c.png"], [3.0, 2.2, 3.0], "out.mp4")
    graph = cmd[cmd.index("-filter_complex") + 1]
    assert graph.count("xfade") == 2
    assert "offset=2.825" in graph and "offset=5.025" in graph      # each cut, less half a fade
    assert cmd[-1] == "out.mp4" and "libx264" in cmd and "+faststart" in cmd
    assert "anullsrc=channel_layout=stereo:sample_rate=44100" in cmd


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg not installed")
def test_a_reel_is_an_mp4_instagram_takes(tmp_path):
    reels = _reels()
    out = reels.render(POST, str(tmp_path / "reel.mp4"))
    assert os.path.getsize(out) < 100 * 1024 * 1024
    if shutil.which("ffprobe"):
        info = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", out],
                                         capture_output=True, text=True).stdout)
        video = next(s for s in info["streams"] if s["codec_type"] == "video")
        assert (video["width"], video["height"], video["codec_name"]) == (1080, 1920, "h264")
        assert any(s["codec_type"] == "audio" for s in info["streams"])
        assert 10 <= float(info["format"]["duration"]) <= 20


def test_thursdays_are_reel_days_and_each_slide_is_a_different_employer(monkeypatch):
    items = [{"company_name": c, "title": f"{c} Intern {i}", "regions": [{"loc": "Boston, MA", "state": "MA"}]}
             for i, c in enumerate(["Baker Tilly"] * 3 + ["Crowe", "MFS", "Vialto Partners", "PwC"])]
    thursday = datetime(2026, 10, 8, 15, tzinfo=timezone.utc)
    monkeypatch.setattr(social, "candidates", lambda site: ([("accounting", items)], thursday, {"accounting": 200}))
    data = social.card_data("docs", today=thursday)
    assert data["reel"] is True
    assert [r["company"] for r in data["roles"]] == ["Baker Tilly", "Crowe", "MFS", "Vialto Partners"]
    assert data["roles"][0]["place"] == "Boston, MA"
    tuesday = datetime(2026, 10, 6, 15, tzinfo=timezone.utc)
    assert social.card_data("docs", today=tuesday)["reel"] is False
    # 2026-10-01 is a Thursday but stays a card: the first post since Meta lifted its block.
    assert social.card_data("docs", today=datetime(2026, 10, 1, 15, tzinfo=timezone.utc))["reel"] is False


def test_a_reel_is_created_uploaded_processed_and_published(monkeypatch, tmp_path):
    video = tmp_path / "reel.mp4"
    video.write_bytes(b"\x00" * 1000)
    calls, statuses, uploads = [], iter(["IN_PROGRESS", "FINISHED"]), []

    def fake(method, path, params):
        calls.append((method, path, dict(params)))
        if path == "me":
            return {"user_id": "1789"}
        if path == "1789/media":
            return {"id": "c-9", "uri": "https://rupload.facebook.com/ig-api-upload/v99.0/c-9"}
        if path == "c-9":
            return {"status_code": next(statuses)}
        if path == "1789/media_publish":
            return {"id": "m-9"}
        raise AssertionError(path)
    monkeypatch.setattr(ig, "_request", fake)
    got = ig.publish_reel("tok", str(video), "caption", sleep=lambda s: None,
                          upload=lambda uri, token, data: uploads.append((uri, token, len(data))))
    assert got == "m-9"
    made = calls[1][2]
    assert made["media_type"] == "REELS" and made["upload_type"] == "resumable" and made["share_to_feed"] == "true"
    assert "video_url" not in made
    assert uploads == [("https://rupload.facebook.com/ig-api-upload/v99.0/c-9", "tok", 1000)]
    assert calls[-1][2]["creation_id"] == "c-9"


def test_a_failed_reel_still_posts_the_card(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("INSTAGRAM_TOKEN", "SECRET-TOKEN-VALUE")
    monkeypatch.delenv("CLOUDFLARE_API_TOKEN", raising=False)
    monkeypatch.setattr(ig, "token_for_run", lambda secret, cf: "tok")
    (tmp_path / "reel.mp4").write_bytes(b"\x00" * 10)
    post = tmp_path / "post.json"
    post.write_text(json.dumps({"instagram_caption": "c", "card_url": "https://x/card.jpg", "reel": True}), encoding="utf-8")
    monkeypatch.setattr(ig, "publish_reel", lambda *a, **k: (_ for _ in ()).throw(ig.InstagramError("the video upload failed: HTTP 400")))
    monkeypatch.setattr(ig, "wait_for_image", lambda url: None)
    posted = []
    monkeypatch.setattr(ig, "publish", lambda token, url, caption: posted.append(url) or "m-1")
    assert ig.main(["instagram.py", str(post), "--send"]) == 0
    out = capsys.readouterr().out
    assert posted == ["https://x/card.jpg"] and "posting the card instead" in out
    assert "SECRET-TOKEN-VALUE" not in out


def test_without_a_reel_file_a_reel_day_posts_the_card(monkeypatch, tmp_path):
    monkeypatch.setenv("INSTAGRAM_TOKEN", "t")
    monkeypatch.setattr(ig, "token_for_run", lambda secret, cf: "tok")
    post = tmp_path / "post.json"
    post.write_text(json.dumps({"instagram_caption": "c", "card_url": "https://x/card.jpg", "reel": True}), encoding="utf-8")
    monkeypatch.setattr(ig, "publish_reel", lambda *a, **k: pytest.fail("no reel.mp4, so no Reel"))
    monkeypatch.setattr(ig, "wait_for_image", lambda url: None)
    monkeypatch.setattr(ig, "publish", lambda token, url, caption: "m-1")
    assert ig.main(["instagram.py", str(post), "--send"]) == 0
