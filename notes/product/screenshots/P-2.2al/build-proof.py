"""Build both versions offline without changing the shared golden fixtures."""

import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[4]
SPEC = importlib.util.spec_from_file_location("golden", ROOT / "backend/tests/golden_build.py")
GOLDEN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GOLDEN)
BASE = "6827576b64790afc2a4a659a316a5a983beb29bb"
results = {}
with tempfile.TemporaryDirectory(prefix="internscout-disclosure-proof-") as directory:
    for phase in ("before", "after"):
        work = Path(directory) / phase
        GOLDEN.prepare(work)
        if phase == "before":
            for name in ("privacy.html", "terms.html"):
                (work / "site" / name).write_bytes(
                    subprocess.check_output(["git", "show", f"{BASE}:docs/{name}"], cwd=ROOT)
                )
        results[phase] = GOLDEN.build(work)
    assert not GOLDEN.differences(results["before"]), "Baseline is not the exact golden output"
    before, after = (GOLDEN.manifest(results[p]) for p in ("before", "after"))
    changed = [p for p in sorted(before.keys() | after.keys()) if before.get(p) != after.get(p)]
    assert changed == ["privacy.html", "terms.html"], changed
    report = {
        "base": BASE,
        "files": len(after),
        "changed": changed,
        "before": {p: before[p] for p in changed},
        "after": {p: after[p] for p in changed},
        "sharedFixturesChanged": False,
    }
    Path(__file__).with_name("build-results.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, indent=2))
