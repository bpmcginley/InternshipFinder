from __future__ import annotations

import base64
import hashlib
import json
import os
import subprocess
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from internscout.follow_snapshot import (
    FollowSnapshotBounds,
    FollowSnapshotCatalog,
    build_follow_snapshot,
)

LOW = datetime.fromisoformat("2028-02-28T00:00:00.000+00:00")
HIGH = datetime.fromisoformat("2028-02-29T00:00:00.000+00:00")
MILLISECOND = timedelta(milliseconds=1)
CATALOG = FollowSnapshotCatalog(
    companies=frozenset({"booz allen", "fixture", "company without roles"}),
    fields=frozenset({"biology", "engineering"}),
    states=frozenset({"MA", "NY", "CT"}),
)
BOUNDS = FollowSnapshotBounds(
    max_bytes=8_000, max_roles=5, max_text_bytes=2_000, max_window_ms=86_400_000
)
ENCODED_URL = "https://jobs.example.test/apply?q=caf%C3%A9%20%26%20O%27Brien#team%20%231"
ROLE = {
    "id": "4f3c2b1a09e8d7c6",
    "first_seen": HIGH,
    "status": "open",
    "company_name": "The Booz Allen Hamilton Corporation",
    "title": "Café Research 🧪",
    "location": "Boston, MA +1",
    "apply_url": ENCODED_URL,
    "field_tags": ["engineering", "biology"],
    "states": ["NY", "MA"],
}


def make(rows=(ROLE,), **overrides) -> bytes:
    return build_follow_snapshot(
        rows,
        **(
            {
                "generated_at": HIGH,
                "covers_after": LOW,
                "complete": True,
                "catalog": CATALOG,
                "bounds": BOUNDS,
            }
            | overrides
        ),
    )


def test_exact_deterministic_public_bytes():
    older = ROLE | {
        "id": "0" * 16,
        "first_seen": LOW + MILLISECOND,
        "company_name": "Fixture Inc",
        "states": [],
    }
    tied = ROLE | {
        "id": "1" * 16,
        "first_seen": HIGH.astimezone(timezone(timedelta(hours=-5))),
        "field_tags": ["biology", "engineering"],
        "states": ["MA", "NY"],
    }
    raw = make([ROLE, older, tied])
    assert raw == make([older, tied, ROLE])
    assert not raw.startswith(b"\xef\xbb\xbf") and not raw.endswith(b"\n")
    result = json.loads(raw)
    assert list(result) == ["version", "complete", "generated_at", "covers_after", "roles"]
    assert result["generated_at"] == "2028-02-29T00:00:00.000Z"
    assert result["covers_after"] == "2028-02-28T00:00:00.000Z"
    assert [r["id"] for r in result["roles"]] == [tied["id"], ROLE["id"], older["id"]]
    assert [r["first_seen"] for r in result["roles"]] == [
        "2028-02-29T00:00:00.000Z",
        "2028-02-29T00:00:00.000Z",
        "2028-02-28T00:00:00.001Z",
    ]
    assert result["roles"][1] == ROLE | {
        "company_key": "booz allen",
        "first_seen": "2028-02-29T00:00:00.000Z",
        "field_tags": ["biology", "engineering"],
        "states": ["MA", "NY"],
    }
    assert json.loads(make([]))["roles"] == []


@pytest.mark.parametrize(
    "overrides",
    [
        {"complete": False},
        {"complete": 1},
        {"generated_at": HIGH.replace(tzinfo=None)},
        {"generated_at": HIGH.replace(microsecond=1)},
        {"covers_after": HIGH},
        {"covers_after": LOW - MILLISECOND},
        {"covers_after": LOW.replace(microsecond=1)},
    ],
)
def test_invalid_window_cannot_masquerade_as_complete_empty(overrides):
    with pytest.raises(ValueError):
        make([], **overrides)


@pytest.mark.parametrize(
    "change",
    [
        {"first_seen": LOW},
        {"first_seen": HIGH + MILLISECOND},
        {"first_seen": HIGH.replace(tzinfo=None)},
        {"first_seen": HIGH.replace(microsecond=1)},
        {"status": "closed"},
        {"company_name": "Unknown Inc"},
        {"field_tags": ["biology", "biology"]},
        {"field_tags": ["not-approved"]},
        {"states": ["REMOTE"]},
        {"id": "4F3C2B1A09E8D7C6"},
        {"title": "line\nother"},
        {"title": "x" * 301},
        {"location": "🧪" * 151},
        {"description": "an extra source field"},
    ],
)
def test_invalid_row_rejects_the_entire_window(change):
    with pytest.raises(ValueError):
        make([ROLE, ROLE | {"id": "a" * 16} | change])


def test_duplicate_id_rejects_identical_and_conflicting_rows():
    for repeated in (ROLE, ROLE | {"title": "Changed"}):
        with pytest.raises(ValueError, match="duplicate"):
            make([ROLE, repeated])


@pytest.mark.parametrize(
    "url",
    [
        "https://jobs.example.test/encoded/%E6%9D%B1%E4%BA%AC?q=%2F#fragment",
        ENCODED_URL,
        "HTTP://Jobs.Example.Test:8080/a?q=%23#x",
        "https://jobs.example.test?tracking=encoded%2Bvalue#details",
    ],
)
def test_supported_url_keeps_exact_bytes(url):
    assert json.loads(make([ROLE | {"apply_url": url}]))["roles"][0]["apply_url"] == url


@pytest.mark.parametrize(
    "url",
    [
        "https://bücher.example/apply",
        "https://xn--bcher-kva.example/apply",
        "https://jobs.example.test/café",
        "https://jobs.example.test/?q=O'Brien",
        "https://jobs.example.test/%zz",
        "https://user@jobs.example.test/apply",
        "https://jobs.example.test:65536/apply",
        "https://jobs.example.test:0/apply",
        "https://jobs.example.test:/apply",
        "https://jobs.example.test/with space",
        "https://jobs.example.test/{unsafe}",
        "https://jobs.example.test\\path",
        "http://127.0.0.1/apply",
        "https://example.123/apply",
        "https:///jobs.example.test/apply",
    ],
)
def test_url_outside_subset_fails_whole_window(url):
    with pytest.raises(ValueError, match="URL"):
        make([ROLE | {"apply_url": url}])


def test_catalog_must_supply_explicit_sets():
    with pytest.raises(ValueError):
        make(catalog=replace(CATALOG, companies="booz allen"))
    with pytest.raises(ValueError):
        make(catalog=replace(CATALOG, fields=("biology", "engineering")))


def test_explicit_exact_bounds():
    size = len(make())
    assert len(make(bounds=replace(BOUNDS, max_bytes=size))) == size
    for invalid in (
        replace(BOUNDS, max_bytes=size - 1),
        replace(BOUNDS, max_roles=0),
        replace(BOUNDS, max_text_bytes=10),
        replace(BOUNDS, max_window_ms=86_399_999),
        replace(BOUNDS, max_roles=True),
        replace(BOUNDS, max_bytes=2**53),
    ):
        with pytest.raises(ValueError):
            make(bounds=invalid)
    with pytest.raises(ValueError):
        make([ROLE, ROLE | {"id": "a" * 16}], bounds=replace(BOUNDS, max_roles=1))
    assert make([ROLE | {"title": "🧪" * 150}])
    base = "https://jobs.example.test?q="
    exact = base + "x" * (1999 - len(base))
    assert make([ROLE | {"apply_url": exact}])
    with pytest.raises(ValueError, match="URL"):
        make([ROLE | {"apply_url": exact + "x"}])


def test_offline_worker_matcher_parity():
    matcher = os.environ.get("INTERN_SCOUT_FOLLOW_MATCHER")
    if not matcher:
        pytest.skip("Optional exact-head Worker parity probe requires a local matcher module")
    probe = Path(__file__).resolve().parents[2] / "worker/test-probes/follow-snapshot-parity.mjs"
    independent_upper = "2028-02-29T00:00:00.000Z"
    scope_start = "2028-02-28T00:00:00.000Z"
    scopes = [
        '{"kind":"company","company":"booz allen"}',
        '{"kind":"search","fields":["biology"],"states":["MA"]}',
        '{"kind":"company","company":"company without roles"}',
    ]
    older = ROLE | {
        "id": "0" * 16,
        "first_seen": LOW + MILLISECOND,
        "company_name": "Fixture Inc",
        "states": ["CT"],
        "apply_url": "https://jobs.example.test/caf%C3%A9?q=%2F#%E6%9D%B1%E4%BA%AC",
    }
    raw = make([older, ROLE])
    payload = {
        "snapshot": base64.b64encode(raw).decode(),
        "scopes": [
            {"scope_key": key, "confirmed_at": scope_start, "watermark": scope_start}
            for key in scopes
        ],
        "catalog": {key: sorted(value) for key, value in vars(CATALOG).items()},
        "limits": {
            "maxBytes": BOUNDS.max_bytes,
            "maxRoles": BOUNDS.max_roles,
            "maxTextBytes": BOUNDS.max_text_bytes,
            "maxWindowMs": BOUNDS.max_window_ms,
            "maxFollows": 5,
            "maxMatches": 5,
            "maxResultBytes": 8_000,
        },
        "upperBound": independent_upper,
    }

    def run(input_data):
        result = subprocess.run(
            ["node", str(probe), str(Path(matcher).resolve(strict=True))],
            input=json.dumps(input_data).encode(),
            capture_output=True,
            check=True,
            timeout=20,
        )
        return json.loads(result.stdout)

    result = run(payload)
    assert result["digest"] == hashlib.sha256(raw).hexdigest()
    assert result["match"]["status"] == "matched"
    assert [r["id"] for r in result["match"]["roles"]] == [ROLE["id"]]
    assert result["match"]["refs"] == [
        {"scopeKey": key, "roles": [ROLE["id"]]} for key in scopes[:2]
    ]
    assert [a["to"] for a in result["match"]["advances"]] == [independent_upper] * 3
    changed = run(payload | {"snapshot": base64.b64encode(b" " + raw).decode()})
    assert changed["match"] == result["match"]
    assert changed["digest"] != result["digest"]
    assert run(payload | {"upperBound": "2028-02-29T00:00:00.001Z"})["match"]["status"] == "invalid"
    gap = payload | {
        "scopes": [
            payload["scopes"][0]
            | {
                "confirmed_at": "2028-02-27T23:59:59.999Z",
                "watermark": "2028-02-27T23:59:59.999Z",
            }
        ]
    }
    assert run(gap)["match"] == {"status": "invalid", "reason": "follow_window"}
    empty = run(payload | {"snapshot": base64.b64encode(make([])).decode()})
    assert empty["match"]["status"] == "matched"
    assert empty["match"]["refs"] == []
    assert len(empty["match"]["advances"]) == 3
