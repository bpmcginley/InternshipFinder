"""Editable imports must work independently of pytest's legacy helper paths."""

import os
from pathlib import Path
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[2]
ISOLATED = """
import sys
def deny_network(event, args):
    if event in {"socket.connect", "socket.getaddrinfo", "socket.sendto"}:
        raise AssertionError("packaging smoke test attempted network access")
sys.addaudithook(deny_network)
"""


def _outside_checkout(tmp_path, source, *args):
    # Preserve only process startup variables, never credentials or PYTHONPATH.
    env = {
        key: value
        for key, value in os.environ.items()
        if key.upper() in {"SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP", "TMPDIR"}
    }
    result = subprocess.run(
        [sys.executable, "-I", "-c", ISOLATED + source, str(ROOT), *args],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    # Do not include exception/source values from imported modules in CI logs.
    assert result.returncode == 0, "isolated packaging check failed; raw diagnostics suppressed"
    return result.stdout


@pytest.mark.parametrize(
    ("module", "relative"),
    [
        ("internscout", "backend/internscout/__init__.py"),
        ("internscout.sources", "backend/internscout/sources/__init__.py"),
        ("growth", "growth/__init__.py"),
        ("growth.digest", "growth/digest.py"),
        ("growth.outreach", "growth/outreach.py"),
    ],
)
def test_editable_import_has_current_checkout_provenance(tmp_path, module, relative):
    _outside_checkout(
        tmp_path,
        """
import importlib
from pathlib import Path
module = importlib.import_module(sys.argv[2])
assert Path(module.__file__).resolve() == (Path(sys.argv[1]) / sys.argv[3]).resolve()
""",
        module,
        relative,
    )


def test_installed_resources_and_dependency_metadata(tmp_path):
    _outside_checkout(
        tmp_path,
        """
import importlib.metadata
import importlib.resources
import json
from pathlib import Path
package = importlib.resources.files("internscout")
for name in ("top_degree_fields.json", "us_top50_metros.json"):
    assert json.loads(package.joinpath(name).read_text(encoding="utf-8"))
expected = {
    line.strip() for line in (Path(sys.argv[1]) / "backend/requirements.txt").read_text().splitlines()
    if line.strip() and not line.lstrip().startswith("#")
}
assert set(importlib.metadata.requires("internscout")) == expected
""",
    )


@pytest.mark.parametrize("target", ["internscout.run_ingest", "growth/digest.py", "growth/outreach.py"])
def test_existing_module_and_script_help_entrypoints(tmp_path, target):
    output = _outside_checkout(
        tmp_path,
        """
from pathlib import Path
import runpy
root, target = Path(sys.argv[1]), sys.argv[2]
sys.argv = [target, "--help"]
if target.endswith(".py"):
    # Match Python's script invocation: its containing directory is sys.path[0].
    script = root / target
    sys.path.insert(0, str(script.parent))
    runpy.run_path(str(script), run_name="__main__")
else:
    runpy.run_module(target, run_name="__main__")
""",
        target,
    )
    assert "usage:" in output.lower()
