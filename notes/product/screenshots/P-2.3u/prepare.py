"""Build both synthetic publication modes with the real offline golden pipeline."""

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[4]
sys.path[:0] = [str(ROOT / "backend"), str(ROOT / "backend/tests")]
import pytest
import golden_build
from test_employer_publication import build_opted_in

out = Path(sys.argv[1]).resolve()
if out.exists():
    raise SystemExit("Choose an absent output directory")
for phase in ["before", "after"]:
    work = out / phase
    golden_build.prepare(work)
    files = (
        golden_build.build(work)
        if phase == "before"
        else build_opted_in(work, pytest.MonkeyPatch())
    )
    if phase == "before":
        assert not golden_build.differences(files)
    print(phase, len(files), "synthetic publication files")
