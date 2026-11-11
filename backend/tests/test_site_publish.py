"""The Pages image adapter publishes through the standalone entry point."""

import os
from pathlib import Path
import shutil
import subprocess
import sys

from tests.seo_fixture_data import _row, _site


REPO = Path(__file__).resolve().parents[2]
GUARDED_ADAPTER = r"""
from importlib.abc import MetaPathFinder
import runpy
import sys

repository, site = sys.argv[1:]
forbidden = {"internscout.seo_pages", "internscout.placements"}
attempts = []


class BlockLegacyAndPlacements(MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname in forbidden:
            attempts.append(fullname)
            raise AssertionError(f"Unexpected publisher dependency {fullname}")


def deny_network(event, args):
    if event in {"socket.connect", "socket.getaddrinfo", "socket.sendto"}:
        attempts.append(event)
        raise AssertionError("Publisher attempted a network request")


sys.path.insert(0, repository)
sys.meta_path.insert(0, BlockLegacyAndPlacements())
sys.addaudithook(deny_network)
sys.argv = ["make_og_image", "--site", site]
runpy.run_module("scripts.make_og_image", run_name="__main__")
assert "internscout.site.publish" in sys.modules
assert not attempts and not forbidden.intersection(sys.modules)
"""


def test_site_adapter_publishes_without_legacy_or_placement_services(tmp_path):
    site = tmp_path / "site"
    _site(site, {"MA": [_row(i) for i in range(30)]})
    shutil.copyfile(REPO / "docs" / "icon128.png", site / "icon128.png")
    home = site / "index.html"
    home.write_text("<!-- browse:start --><!-- browse:end -->", encoding="utf-8")
    env = {
        key: value
        for key, value in os.environ.items()
        if key.upper() in {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC"}
    }
    env.update(PYTHONDONTWRITEBYTECODE="1", PYTHONUTF8="1")
    result = subprocess.run(
        [sys.executable, "-c", GUARDED_ADAPTER, str(REPO), str(site)],
        cwd=REPO / "backend",
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
    )
    assert result.returncode == 0, result.stderr
    assert '<script type="application/json" id="landing-share-views">' in home.read_text(
        encoding="utf-8"
    )
    assert list((site / "internships").rglob("share.png"))
    assert (site / "sitemap.xml").is_file()
    assert (site / "data" / "roles" / "index.json").is_file()
    assert not (site / "data" / "placements.json").exists()
