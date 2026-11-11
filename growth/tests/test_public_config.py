"""Generated area settings must agree with the public source."""

import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GENERATOR = Path("scripts/generate_public_config.py")
SOURCE = Path("config/public.json")
SITE = (
    Path("docs/index.html"),
    Path("docs/js/count.js"),
    Path("docs/js/buy.js"),
    Path("docs/employers/index.html"),
)
OUTPUTS = (
    Path("growth/public_config.py"),
    Path("extension/lib/config.js"),
    Path("worker/src/public-config.js"),
    *SITE,
)


def test_committed_public_config_is_current():
    subprocess.run([sys.executable, ROOT / GENERATOR, "--check"], check=True)


def test_source_change_requires_regenerating_all_areas(tmp_path):
    for name in (GENERATOR, SOURCE, *OUTPUTS):
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, tmp_path / name)
    source = tmp_path / SOURCE
    old_origin = json.loads(source.read_text(encoding="utf-8"))["workerOrigin"]
    origin = "https://worker.example.test"
    source.write_text(json.dumps({"workerOrigin": origin}), encoding="utf-8")

    command = [sys.executable, tmp_path / GENERATOR]
    before = [(tmp_path / name).read_bytes() for name in OUTPUTS]
    site_before = {name: (tmp_path / name).read_bytes() for name in SITE}
    stale = subprocess.run([*command, "--check"], capture_output=True, text=True)
    assert stale.returncode == 1
    assert all(name.as_posix() in stale.stderr for name in OUTPUTS)
    assert [(tmp_path / name).read_bytes() for name in OUTPUTS] == before

    subprocess.run(command, check=True)
    subprocess.run([*command, "--check"], check=True)
    assert all(origin in (tmp_path / name).read_text(encoding="utf-8") for name in OUTPUTS)
    for name, content in site_before.items():
        assert (tmp_path / name).read_bytes() == content.replace(
            old_origin.encode(), origin.encode()
        )
