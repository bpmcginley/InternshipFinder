"""Offline real employer build pair. Outputs only to an explicitly supplied scratch directory."""
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
sys.path[:0] = [str(ROOT), str(ROOT / "backend"), str(ROOT / "backend/tests")]
from internscout.site import runtime
from tests.test_employer_follow import selected
from tests.seo_fixture_data import _row, _site
from test_seo_pages import _build_pages

out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
with TemporaryDirectory(prefix="internscout-employer-follow-fixture-") as tmp:
    rows = [_row(i, id=f"{i:016x}", company_name="Fixture Labs", follow_company_key="fixture") for i in range(8)]
    site = _site(Path(tmp), {"MA": rows})
    before = {p["path"]: p["html"] for p in _build_pages(site)}
    original = runtime._select_employer_page
    with patch.object(runtime, "_select_employer_page", lambda *a, **kw: selected(original(*a, **kw))):
        after = {p["path"]: p["html"] for p in _build_pages(site)}
    changed = [p for p in before if before[p] != after[p]]
    assert changed == ["/internships/at/fixture-labs/"]
    for kind, pages in [("before",before),("after",after)]:
        (out / (kind + ".html")).write_text(pages[changed[0]], encoding="utf-8")
    print("Real emitter: one optional employer page changed; all other fixture pages exact")
