"""Compare the current golden archive with an extracted parent baseline. Pass baseline directory."""

import re
import sys
import tarfile
import json
from datetime import datetime, timezone
from pathlib import Path

repo = Path(__file__).resolve().parents[4]
baseline = Path(sys.argv[1])
css = (
    "footer a{color:var(--ink2)}\n"
    ".distribution-links{gap:8px 24px;margin-bottom:16px}\n"
    ".distribution-links a,.widget-follow a{display:inline-flex;align-items:center;min-height:44px;"
    "text-decoration:underline;text-underline-offset:3px}\n@media"
)
changed_html = field_lines = 0
other_changes = []
with tarfile.open(repo / "backend/tests/fixtures/golden/expected.tar.gz") as archive:
    sys.path.insert(0, str(repo / "backend"))
    from internscout.page_dates import fingerprint

    prior = json.loads(
        (repo / "backend/tests/fixtures/golden/inputs/page-content-dates.json").read_text(
            encoding="utf-8"
        )
    )["pages"]
    pricing = archive.extractfile("pricing/index.html").read().decode("utf-8")
    assert prior["/pricing/"] == {
        "digest": fingerprint(
            "/pricing/", pricing, datetime(2026, 11, 10, 12, tzinfo=timezone.utc)
        ),
        "lastmod": "2026-11-01",
    }
    assert prior["/about/"] == {"digest": "0" * 64, "lastmod": "2026-11-01"}
    assert set(archive.getnames()) == {
        p.relative_to(baseline).as_posix() for p in baseline.rglob("*") if p.is_file()
    }
    for item in archive:
        before = (baseline / item.name).read_bytes()
        after = archive.extractfile(item).read()
        if before == after:
            continue
        if not item.name.endswith(".html"):
            other_changes.append(item.name)
            continue
        changed_html += 1
        text = after.decode("utf-8")
        field_lines += text.count('<p class="follow widget-follow">')
        text = text.replace(css, "footer a{color:var(--ink2)}@media")
        text = re.sub(r'<nav class="distribution-links".*?</nav>', "", text, flags=re.S)
        text = re.sub(r'<p class="follow widget-follow">.*?</p>', "", text, flags=re.S)
        assert text.encode("utf-8") == before, item.name
assert changed_html == 555 and field_lines == 10
assert other_changes == ["data/page-content-dates.json"], other_changes
print(
    f"{changed_html} HTML changes contain only reviewed additions; {field_lines} field lines; only page hashes otherwise"
)
