"""Page-build console output keeps its workflow annotation protocol."""

import json

from internscout import seo_pages
from tests.seo_fixture_data import _row, _site
from tests.test_seo_pages import _pl


def test_json_page_build_keeps_annotations_and_omits_the_output_path(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("INTERNSCOUT_LOG_FORMAT", "json")
    monkeypatch.setattr(seo_pages, "today_utc", lambda: "2026-09-23")
    site = _site(tmp_path / "site", {"MA": [_row(i) for i in range(5)] + ["bad row"]})
    placements = tmp_path / "placements.json"
    placements.write_text(
        json.dumps(
            {
                "placements": [
                    _pl(id="p-gone", listing_id="nope", apply_url="https://example.com/gone")
                ]
            }
        ),
        encoding="utf-8",
    )
    # Using a directory as the report path exercises the second annotation without a remote call.
    seo_pages.main(
        ["seo_pages", site, "--placements", str(placements), "--placements-report", str(tmp_path)]
    )
    out = capsys.readouterr()
    annotations = out.out.splitlines()[:2]
    assert annotations == [
        "::warning::placement p-gone dropped: listing_gone (listing nope)",
        "::warning::placements report not written",
    ]
    diagnostics = [json.loads(line) for line in out.out.splitlines()[2:]]
    assert diagnostics[0] == {"level": "INFO", "message": "[seo] placements: 0 kept, 1 dropped"}
    assert diagnostics[1]["message"].startswith("[seo] role index: ")
    assert diagnostics[2]["message"].endswith("pages, sitemap.xml and robots.txt")
    assert len(diagnostics) == 3
    assert site not in diagnostics[2]["message"]
    assert json.loads(out.err) == {
        "level": "WARNING",
        "message": "[seo] warning: skipped 1 malformed listing rows (see well_formed)",
    }
