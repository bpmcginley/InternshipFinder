"""Build a separate, explicitly synthetic class-year visual fixture in a fresh temp path."""

from pathlib import Path
import sys

root = Path(__file__).resolve().parents[4]
sys.path[:0] = [str(root / "backend"), str(root / "backend/tests")]
import golden_build
from test_seo_pages import _site
from test_site_launch import fixture_rows

work = Path(sys.argv[1]).resolve()
if work.exists():
    raise SystemExit("Choose a new temporary output path")
golden_build.prepare(work)
_site(work / "site", {"MA": fixture_rows()})
golden_build.stage("pages", work)
