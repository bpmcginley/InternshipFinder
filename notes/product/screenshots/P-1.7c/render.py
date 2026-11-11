"""Render synthetic before/after email evidence; never invoke the sender."""

import json
import subprocess
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
BASE = "e009644f"
fixture = json.loads((HERE / "digest-fixture.json").read_text(encoding="utf-8"))
source = ROOT / "growth/digest.py"
before = subprocess.check_output(["git", "show", f"{BASE}:growth/digest.py"], cwd=ROOT).decode(
    "utf-8"
)
outputs = {}
for phase, code in [("before", before), ("after", source.read_text(encoding="utf-8"))]:
    module = types.ModuleType(f"digest_preview_{phase}")
    module.__file__ = str(source)
    exec(compile(code, str(source), "exec"), module.__dict__)
    for extension, render in [("html", module.render_html), ("txt", module.render_text)]:
        output = render(fixture)
        (HERE / f"{phase}.{extension}").write_text(output, encoding="utf-8", newline="\n")
        outputs[phase, extension] = output

html_addition = (
    '<p style="margin:0 0 8px"><a href="https://github.com/bpmcginley/'
    'internships-every-major" style="color:#454a52;text-decoration:underline">'
    'Internships for every major on GitHub</a></p>\n'
)
text_addition = (
    "Internships for every major on GitHub: "
    "https://github.com/bpmcginley/internships-every-major\n\n"
)
for extension, addition in [("html", html_addition), ("txt", text_addition)]:
    assert outputs["after", extension].count(addition) == 1
    assert outputs["after", extension].replace(addition, "", 1) == outputs["before", extension]
print("HTML/text differ only by the proposed footer link; no mail sent.")
