"""The list's short opening keeps current counts and routes into the existing field lists."""

import importlib.util
from datetime import datetime, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "every_major_intro", ROOT / "growth/every_major_list.py"
)
eml = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(eml)

USAGE = (
    "**How to use this list:** Choose a field below, or open its full list for more roles. "
    "Apply links go to employer sites. Employers can close roles after this list updates, "
    "so check the posting before applying. [Report a problem or suggest an improvement]"
    "(https://github.com/bpmcginley/InternshipFinder/issues)."
)


@pytest.mark.parametrize(
    "fields,employers,summary",
    [
        (["nursing"], 1, "Explore 1 field at 1 employer in the US and Canada."),
        (["nursing", "mechanical"], 3, "Explore 2 fields at 3 employers in the US and Canada."),
    ],
)
def test_first_screen_uses_current_counts_and_preserves_field_routes(fields, employers, summary):
    roles = [
        {
            "title": f"Synthetic intern {i}",
            "company_name": f"Fixture employer {i % employers}",
            "apply_url": f"https://jobs.example.com/{i}",
        }
        for i in range(7)
    ]
    ctx = {
        "roles": roles,
        "fields": {field: roles for field in fields},
        "links": {field: (f"https://internscout.org/?field={field}", 9) for field in fields},
        "employer_count": employers,
        "employers": {},
        "total": 19,
        "new": [],
        "new_page": False,
        "now": datetime(2026, 11, 10, tzinfo=timezone.utc),
    }
    readme = eml.render(ctx, 5)
    opening, contents = readme.split("## Contents", 1)
    assert "**7 open Summer 2027 internships, co-ops and research roles.**" in opening
    assert summary in opening
    assert "Free to browse. Apply directly on employer sites." in opening
    assert "**Updated November 10, 2026.**" in opening
    assert (
        "[Search all 19 open roles on InternScout](https://internscout.org), free, no account."
        in opening
    )
    assert opening.count("Star this repository to follow updates.") == 1
    assert readme.count(USAGE) == 1 and USAGE in opening
    assert len(readme.encode()) < eml.README_BUDGET
    for field in fields:
        slug = eml.site_taxonomy.field_slug(field)
        assert contents.count(f"[fields/{slug}.md](fields/{slug}.md)") == 1
        assert f"[One page with all of them](fields/{slug}.md)" in contents
        assert f"](https://internscout.org/?field={field})" in contents
        assert "[Apply](https://jobs.example.com/0)" in eml.render_field(field, ctx)
    assert eml.REPO == "bpmcginley/internships-every-major"
