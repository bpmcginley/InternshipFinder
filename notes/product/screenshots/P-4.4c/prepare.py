"""Prepare before/after pages from the exact golden shell and opt-in renderer."""

from datetime import datetime, timezone
from pathlib import Path
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "backend"))

from internscout.site.advisor import Edition
from internscout.site.digest import SIGNUP_HEADING, Signup
from internscout.site.render.advisor import render


def prepare(output):
    path = "/internships/for/accounting-majors/weekly/"
    model = Edition(
        "Accounting",
        path,
        [],
        datetime(2026, 11, 10, 12, tzinfo=timezone.utc),
        "ready",
        "/internships/for/",
    )
    signup = Signup(
        action="https://buttondown.com/api/emails/embed-subscribe/advisor-fixture",
        archive="",
        pitch="",
        field="finance",
        field_name="Finance",
        heading=SIGNUP_HEADING,
        what=False,
        placement="landing",
    )
    before = render(model, listing_rows=lambda *_: "")["body"]
    after = render(model, listing_rows=lambda *_: "", advisor_signup=signup)["body"]
    with tarfile.open(ROOT / "backend/tests/fixtures/golden/expected.tar.gz", "r:gz") as archive:
        source = archive.extractfile(path.strip("/") + "/index.html").read().decode()
        assert source.count(before) == 1 and after.startswith(before)
        output.mkdir(parents=True)
        (output / "before.html").write_bytes(source.encode())
        (output / "after.html").write_bytes(source.replace(before, after, 1).encode())
        for asset in (
            "fonts/ibm-plex-sans-latin.woff2",
            "fonts/source-serif-4-latin.woff2",
            "icon128.png",
            "js/count.js",
        ):
            target = output / asset
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.extractfile(asset).read())


if __name__ == "__main__":
    prepare(Path(sys.argv[1]))
