"""Synthetic actual site entry plus asset stamps; output must be outside the checkout."""

from pathlib import Path
import json
import runpy
import socket
import sys

ROOT = Path(__file__).resolve().parents[4]
sys.path[:0] = [str(ROOT / "backend"), str(ROOT)]
from internscout.asset_versions import version_assets
from tests.test_advisor_publication import public_fixture, files, TEXT, WEEKLY

output = Path(sys.argv[1]).resolve()
assert not output.is_relative_to(ROOT)
output.mkdir(parents=True, exist_ok=True)
socket.socket = lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("Network forbidden"))
artifacts = {}
for name, enabled in [("before", False), ("after", True), ("rollback", False)]:
    site = public_fixture(output / name)
    sys.argv = ["make_og_image", "--site", str(site), *(["--advisor-signup"] if enabled else [])]
    runpy.run_module("scripts.make_og_image", run_name="__main__")
    version_assets(site)
    artifacts[name] = files(site)
assert artifacts["before"] == artifacts["rollback"]
delta = sorted(p for p in artifacts["before"] if artifacts["before"][p] != artifacts["after"][p])
assert set(delta) == WEEKLY | {"privacy.html", "data/page-content-dates.json"}
assert artifacts["after"]["privacy.html"].count(TEXT) == 1
(output / "build-report.json").write_text(
    json.dumps({"synthetic": True, "changed": delta, "fresh_rollback_exact": True}, indent=2) + "\n"
)
