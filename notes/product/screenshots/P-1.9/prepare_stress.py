"""Add an isolated hostile-name preview to temporary capture artifacts, never published output."""

import ast
import subprocess
import sys
from pathlib import Path

repo = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(repo / "backend"))
from internscout import seo_pages as sp

phase, site = sys.argv[1], Path(sys.argv[2])
source = (
    subprocess.check_output(
        ["git", "show", "f6e599ef:backend/internscout/seo_pages.py"], cwd=repo
    ).decode("utf-8")
    if phase == "before"
    else (repo / "backend/internscout/seo_pages.py").read_text(encoding="utf-8")
)
function = next(
    node
    for node in ast.parse(source).body
    if isinstance(node, ast.FunctionDef) and node.name == "employer_offer"
)
namespace = dict(sp.__dict__)
exec(
    compile(ast.Module(body=[function], type_ignores=[]), "employer-offer-preview", "exec"),
    namespace,
)
name = 'Synthetic International North & South <Research> "Hiring" Laboratory'
html = sp.page(
    "/synthetic-employer-entry.html",
    "Synthetic employer entry stress",
    "Synthetic fixture",
    "Synthetic employer entry stress",
    [],
    "<p>This local name tests wrapping and escaping. It is not a live employer.</p>"
    + namespace["employer_offer"](name),
    "November 10, 2026",
)
(site / "synthetic-employer-entry.html").write_text(html, encoding="utf-8", newline="\n")
print(f"{phase}: temporary hostile-name preview prepared")
