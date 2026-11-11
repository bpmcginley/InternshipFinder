"""Synthetic real-export/stager inputs; no publisher, golden edit or network."""
from pathlib import Path
import json
import os
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]
sys.path[:0] = [str(ROOT / "backend"), str(ROOT / "backend/tests")]
from golden_build import prepare
from internscout.employer_posting_stage import stage_employer_postings

out = Path(sys.argv[1]).resolve()
if out.exists():
    raise SystemExit("Choose an absent output directory")
work = out / "fixture"
prepare(work)
env = {k:v for k,v in os.environ.items() if k.upper() in {"PATH","SYSTEMROOT","WINDIR","TEMP","TMP","COMSPEC"}}
env.update(PYTHONUTF8="1", PYTHONDONTWRITEBYTECODE="1", INTERNSCOUT_DB=str(work/"fixture.sqlite"),
           INTERNSCOUT_DATA=str(work/"backend/data"), INTERNSCOUT_GEOCODE="0")
subprocess.run([sys.executable,str(ROOT/"backend/tests/golden_build.py"),"--stage","export","--workspace",str(work)],cwd=work,env=env,check=True)
data = work / "site/data"
index = (data/"listings/index.json").read_bytes()
staged = stage_employer_postings(index,{m["file"]:(data/m["file"]).read_bytes() for m in json.loads(index)["files"].values()},(data/"first.json").read_bytes())
for name,raw in staged.files.items():
    (data/name).write_bytes(raw)
# Explicit local paid fixture uses a current public role; it must never gain annotations.
rows = json.loads((data/"first.json").read_bytes())
row = rows[0]
(data/"placements.json").write_text(json.dumps({"placements":[{"id":"synthetic-paid","listing_id":row["id"],"apply_url":row["apply_url"],"employer":row["company_name"],"start":"2026-11-01","end":"2026-12-01"}]}),encoding="utf-8")
for phase in ["before","after"]:
    site = out / phase
    shutil.copytree(ROOT/"docs",site,ignore=shutil.ignore_patterns("data"))
    shutil.copytree(data,site/"data")
    if phase == "before":
        (site/"js/app/rows.mjs").write_bytes(subprocess.check_output(["git","show","f73efa65:docs/js/app/rows.mjs"],cwd=ROOT))
print("Prepared two native dashboard trees with the same annotated synthetic export")
