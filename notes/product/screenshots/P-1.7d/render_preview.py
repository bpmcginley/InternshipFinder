"""Offline synthetic README preview. Pass phase and output directory; install mistune 3.1.4 separately."""

import importlib.util
import json
from pathlib import Path
import sys
import subprocess
import tarfile
import tempfile

import mistune

repo = Path(__file__).resolve().parents[4]
phase, output = sys.argv[1], Path(sys.argv[2])
output.mkdir(parents=True, exist_ok=True)


def module(name, path, source=None):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    if source is None:
        spec.loader.exec_module(result)
    else:
        exec(compile(source, str(path), "exec"), result.__dict__)
    return result


baseline_source = None
if len(sys.argv) > 3:
    baseline_source = subprocess.run(
        ["git", "show", f"{sys.argv[3]}:growth/every_major_list.py"],
        cwd=repo,
        check=True,
        capture_output=True,
        encoding="utf-8",
    ).stdout
golden = module("golden_build", repo / "backend/tests/golden_build.py")
attempts = golden.frozen_runtime()
with tempfile.TemporaryDirectory(prefix="internscout-readme-fixture-") as directory:
    site = Path(directory)
    with tarfile.open(repo / "backend/tests/fixtures/golden/expected.tar.gz") as archive:
        archive.extractall(site, filter="data")
    generator = module("every_major_list", repo / "growth/every_major_list.py", baseline_source)
    files = generator.build(str(site))
    assert files == generator.build(str(site))
assert attempts == [], attempts
(output / f"{phase}-output.json").write_text(json.dumps(files, indent=2), encoding="utf-8")
markdown = files["README.md"]
html = mistune.create_markdown(escape=False, plugins=["table"])(markdown)
css = """
:root{color-scheme:light;--paper:#fff;--ink:#1f2328;--line:#d1d9e0;--link:#0969da;--note:#f6f8fa}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--paper:#0d1117;--ink:#f0f6fc;--line:#3d444d;--link:#4493f8;--note:#151b23}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 system-ui,sans-serif}
main{max-width:980px;margin:auto;padding:24px 32px}a{color:var(--link)}h1{font-size:32px;line-height:1.25}h2{font-size:24px}
h1,h2{padding-bottom:.3em;border-bottom:1px solid var(--line)}p,ul{margin:0 0 16px}h1,h2{margin:24px 0 16px}
.fixture{padding:8px 12px;background:var(--note);font-size:12px;border:1px solid var(--line)}
table{display:block;overflow:auto;max-width:100%;width:max-content;border-collapse:collapse;margin:0 0 16px}
td,th{padding:6px 13px;border:1px solid var(--line);text-align:left}tr:nth-child(2n){background:var(--note)}
@media(max-width:600px){main{padding:16px}h1{font-size:28px}}
"""
(output / f"{phase}.html").write_text(
    '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width">'
    f'<title>Synthetic README preview</title><style>{css}</style><main>'
    '<div class="fixture">Local synthetic fixture preview. Not GitHub UI or live listing counts.</div>'
    + html
    + '</main></html>',
    encoding="utf-8",
)
print(
    f"{phase}: {len(files)} deterministic Markdown files; README {len(markdown.encode())} bytes; no network"
)
