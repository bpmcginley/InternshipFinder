"""Synthetic full publisher before/after builds; no provider request or real listings."""

from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "backend"))
from internscout.site import publish
from tests.test_advisor_signup_build import fixture

output = Path(sys.argv[1]).resolve()
output.mkdir(parents=True, exist_ok=True)
page = "internships/for/computer-science-majors/weekly/index.html"
for name, args in (("before", []), ("after", ["--advisor-signup"])):
    site = fixture(output / name)
    publish.main(["publish", str(site), *args])
    shutil.copyfile(site / page, output / (name + ".html"))
for source in (ROOT / "docs" / "fonts").glob("*.woff2"):
    target = output / "fonts" / source.name
    target.parent.mkdir(exist_ok=True)
    shutil.copyfile(source, target)
shutil.copyfile(ROOT / "docs" / "icon128.png", output / "icon128.png")
