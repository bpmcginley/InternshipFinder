"""Test the portable landing images with the repository's local icon."""

from io import BytesIO
from pathlib import Path
from runpy import run_path

from PIL import Image
import pytest


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = run_path(str(ROOT / "scripts" / "make_og_image.py"))
ICON = ROOT / "extension" / "icons" / "icon128.png"
landing_card = SCRIPT["landing_card"]


@pytest.mark.parametrize(
    ("heading", "term"),
    [
        ("Finance internships", None),
        ("Mechanical engineering internships", None),
        ("Software engineering internships", "Summer 2027"),
    ],
)
def test_landing_card_is_portable_and_repeatable(heading, term):
    content = landing_card(ICON, heading, term=term)
    assert content == landing_card(ICON, heading, term=term)
    assert len(content) < 100_000
    with Image.open(BytesIO(content)) as card:
        assert card.format == "PNG"
        assert card.mode == "RGB"
        assert card.size == (1200, 630)
        assert card.getpixel((0, 0)) == SCRIPT["ACCENT"]
        assert card.getpixel((0, 629)) == SCRIPT["PAPER"]
        title = card.crop((84, 210, 1117, 430))
        assert any(color == SCRIPT["PAPER"] for _, color in title.getcolors(4096))


def test_card_identifies_the_field_and_term():
    field = landing_card(ICON, "Finance internships")
    assert field != landing_card(ICON, "Biology internships")
    assert field != landing_card(ICON, "Finance internships", term="Summer 2027")


@pytest.mark.parametrize("heading", ["", "   ", "W" * 300])
def test_invalid_card_titles_fail_before_publication(heading):
    with pytest.raises(ValueError, match="title"):
        landing_card(ICON, heading)


@pytest.mark.parametrize("term", ["", " ", " Summer 2027", "Summer 2027\n", "Summer\u20282027"])
def test_invalid_term_fails_before_publication(term):
    with pytest.raises(ValueError, match="term"):
        landing_card(ICON, "Finance internships", term=term)
