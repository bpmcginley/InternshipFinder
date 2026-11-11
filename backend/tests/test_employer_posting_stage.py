import json

import pytest

from internscout.employer_posting_stage import CATALOG_PATH, stage_employer_postings


def _pack(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


def _role(role_id, company_name, apply_url, *, status="open"):
    return {
        "id": role_id,
        "company_name": company_name,
        "status": status,
        "apply_url": apply_url,
        "title": "Intern",
    }


def _stage(shards, first=(), *, edit_index=None):
    entries = {
        key: {
            "file": f"listings/{key}.json",
            "count": len(rows),
            "open": sum(row["status"] == "open" for row in rows),
        }
        for key, rows in shards.items()
    }
    index = {"files": entries, "first": {"file": "first.json", "rows": len(first)}}
    if edit_index:
        edit_index(index)
    return stage_employer_postings(
        _pack(index),
        {f"listings/{key}.json": _pack(rows) for key, rows in shards.items()},
        _pack(first),
    )


def test_projects_all_direct_roles_from_the_same_export():
    opened = _role("1", "Example Corp.", "https://jobs.example.com/open")
    closed = _role("2", "Other LLC", "https://jobs.example.com/closed", status="closed")
    alias = _role("3", "The Example Inc.", "http://jobs.example.com/also-open")
    no_link = _role("4", "Omit", None)
    relative = _role("5", "Omit", "/apply")
    malformed = _role("6", "Omit", "https:///apply")
    unsafe = _role("7", "Omit", "javascript:example")
    first = [opened, no_link]
    stage = _stage(
        {"remote": [opened, alias], "CA": [opened, closed, no_link, relative, malformed, unsafe]},
        first,
    )

    assert dict(stage.posting_keys) == {"1": "example", "2": "other", "3": "example"}
    assert stage.files[CATALOG_PATH] == b'["example","other"]'
    assert json.loads(stage.files["first.json"]) == [dict(opened, employer_key="example"), no_link]
    assert json.loads(stage.files["listings/CA.json"]) == [
        dict(opened, employer_key="example"),
        dict(closed, employer_key="other"),
        no_link,
        relative,
        malformed,
        unsafe,
    ]
    assert "employer_key" not in opened
    assert set(stage.files) == {
        "listings/CA.json",
        "listings/remote.json",
        "first.json",
        CATALOG_PATH,
    }
    with pytest.raises(TypeError):
        stage.files["first.json"] = b"[]"


def test_rejects_missing_extra_and_malformed_manifest_entries():
    role = _role("1", "Example", "https://example.com/apply")
    index = {
        "files": {"CA": {"file": "listings/CA.json", "count": 1, "open": 1}},
        "first": {"file": "first.json", "rows": 0},
    }
    raw = _pack(index)
    with pytest.raises(ValueError, match="Incomplete"):
        stage_employer_postings(raw, {}, b"[]")
    with pytest.raises(ValueError, match="Incomplete"):
        stage_employer_postings(
            raw, {"listings/CA.json": _pack([role]), "listings/NY.json": b"[]"}, b"[]"
        )
    with pytest.raises(ValueError, match="Invalid employer release JSON"):
        stage_employer_postings(b'{"files":{},"files":{}}', {}, b"[]")
    for field, value, expected in (
        ("file", "listings/NY.json", "shard path"),
        ("count", 2, "Listing count"),
        ("open", 0, "Open count"),
    ):
        with pytest.raises(ValueError, match=expected):
            _stage(
                {"CA": [role]}, edit_index=lambda data: data["files"]["CA"].update({field: value})
            )


def test_rejects_conflicting_or_unbound_occurrences():
    role = _role("1", "Example", "https://example.com/apply")
    different_name = dict(role, company_name="Different")
    different_url = dict(role, apply_url="https://example.com/elsewhere")
    with pytest.raises(ValueError, match="Conflicting"):
        _stage({"CA": [role], "remote": [different_name]})
    with pytest.raises(ValueError, match="Conflicting"):
        _stage({"CA": [role, role]})
    with pytest.raises(ValueError, match="First-screen"):
        _stage({"CA": [role]}, [different_url])
    with pytest.raises(ValueError, match="First-screen"):
        _stage({"CA": [role]}, [dict(role, id="unknown")])
    with pytest.raises(ValueError, match="unannotated"):
        _stage({"CA": [dict(role, employer_key="example")]})


def test_oversize_or_invalid_catalog_rejects_all_staging():
    roles = [
        _role(str(i), "example" + str(i) + ("x" * 188), "https://example.com/apply")
        for i in range(1350)
    ]
    with pytest.raises(ValueError, match="byte bound"):
        _stage({"CA": roles}, roles[:1])
    with pytest.raises(ValueError, match="Worker grammar"):
        _stage({"CA": [_role("1", "x" * 201, "https://example.com/apply")]})
