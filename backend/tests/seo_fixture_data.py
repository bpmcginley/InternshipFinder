"""Synthetic listing rows and minimal public site exports used by tests."""

import json


def _row(i, state="MA", tags=("mechanical",), **over):
    row = {
        "id": f"id{i}",
        "company_name": f"Company {i}",
        "title": f"Mechanical Intern {i}",
        "field_tags": list(tags),
        "stage": ["internship"],
        "term": "Summer 2027",
        "salary": None,
        "posted_at": "2026-09-20T00:00:00",
        "first_seen": f"2026-09-2{i % 3}T00:00:00",
        "regions": [{"loc": f"Town {i}, {state}", "kind": "x", "state": state}],
        "apply_url": f"https://jobs.example.com/{i}",
        "status": "open",
        "is_remote": False,
        "insights": None,
    }
    row.update(over)
    return row


def _site(tmp_path, files, majors=None):
    data = tmp_path / "data" / "listings"
    data.mkdir(parents=True)
    index = {"generated_at": "2026-09-23T10:00:00+00:00", "files": {}}
    for key, rows in files.items():
        (data / f"{key}.json").write_text(json.dumps(rows), encoding="utf-8")
        index["files"][key] = {"file": f"listings/{key}.json"}
    (data / "index.json").write_text(json.dumps(index), encoding="utf-8")
    (tmp_path / "data" / "majors.json").write_text(
        json.dumps({"majors": majors or []}), encoding="utf-8"
    )
    return str(tmp_path)


def _pay_site(tmp_path):
    """30 roles at $20-$49 an hour across six employers, and pay that must never be ranked as hourly:
    yearly salaries, salaries in thousands, and a role only in Canada (Canadian dollars)."""
    rows = [_row(i, company_name=f"Pay Co {i % 6}", salary=f"${20 + i}/hr") for i in range(30)]
    rows += [_row(100 + i, company_name="Salary Co", salary="$150,000 a year") for i in range(5)]
    rows += [_row(200 + i, company_name="Thousands Co", salary="$120k") for i in range(5)]
    canada = [
        _row(
            300,
            company_name="Maple Co",
            salary="$95/hr",
            regions=[{"loc": "Toronto, ON", "kind": "canada", "state": "ON"}],
        )
    ]
    return _site(tmp_path, {"MA": rows, "ON": canada})
