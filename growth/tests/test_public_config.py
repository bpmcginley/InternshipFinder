"""Both generated area settings must agree with the public source."""

import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GENERATOR = Path("scripts/generate_public_config.py")


def test_committed_public_config_is_current():
    subprocess.run([sys.executable, ROOT / GENERATOR, "--check"], check=True)


def test_source_change_requires_regenerating_both_areas(tmp_path):
    paths = (
        GENERATOR,
        Path("config/public.json"),
        Path("growth/public_config.py"),
        Path("extension/lib/config.js"),
    )
    for name in paths:
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, tmp_path / name)
    source = tmp_path / paths[1]
    origin = "https://worker.example.test"
    source.write_text(json.dumps({"workerOrigin": origin}), encoding="utf-8")

    command = [sys.executable, tmp_path / GENERATOR]
    before = [(tmp_path / name).read_bytes() for name in paths[2:]]
    stale = subprocess.run([*command, "--check"], capture_output=True, text=True)
    assert stale.returncode == 1
    assert all(name.as_posix() in stale.stderr for name in paths[2:])
    assert [(tmp_path / name).read_bytes() for name in paths[2:]] == before

    subprocess.run(command, check=True)
    subprocess.run([*command, "--check"], check=True)
    assert all(origin in (tmp_path / name).read_text(encoding="utf-8") for name in paths[2:])
