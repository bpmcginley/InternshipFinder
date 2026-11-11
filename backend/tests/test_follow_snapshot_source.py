from __future__ import annotations

import json
from dataclasses import replace
from datetime import datetime, timedelta
from hashlib import sha256

import pytest

from internscout.follow_snapshot import FollowSnapshotBounds, FollowSnapshotCatalog
from internscout.follow_snapshot_source import FollowExportCapture, snapshot_from_fixed_export

LOWER = datetime.fromisoformat("2028-02-29T00:00:00.000000+00:00")
EXACT = datetime.fromisoformat("2028-02-29T00:00:00.002500+00:00")
BOUNDS = FollowSnapshotBounds(12_000, 20, 2_000, 86_400_000)
CATALOG = FollowSnapshotCatalog(
    companies=frozenset({"booz allen", "still-valid company"}),
    fields=frozenset({"biology", "engineering"}),
    states=frozenset({"MA", "NY"}),
)
BASE_ROW = {
    "id": "0123456789abcdef",
    "status": "open",
    "first_seen": "2028-02-29T00:00:00.001001+00:00",
    "company_name": "The Booz Allen Hamilton Corporation",
    "title": "Café Research",
    "apply_url": "https://jobs.example.test/apply?q=caf%C3%A9#team",
    "field_tags": ["biology", "not-a-follow-scope", "biology"],
    "regions": [
        {"loc": "Boston, MA", "state": "MA", "kind": "us"},
        {"loc": "Albany, NY", "state": "NY", "kind": "us"},
    ],
    "score_parts": {"source": 1},
}


def encode(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def make_capture(by_shard=None, *, generated=EXACT, lower=LOWER, legacy=False):
    if by_shard is None:
        by_shard = {"MA": [BASE_ROW]}
    files = {
        key: {
            "file": f"listings/{key}.json",
            "count": len(rows),
            "open": sum(row["status"] == "open" for row in rows),
            "desc": f"listings/{key}.desc.json",
        }
        for key, rows in by_shard.items()
    }
    shards = {f"listings/{key}.json": encode(rows) for key, rows in by_shard.items()}
    index = encode({"generated_at": generated.isoformat(), "files": files})
    proof = FollowExportCapture(
        generated_at=generated,
        covers_after=lower,
        index_sha256=sha256(index).hexdigest(),
        shard_sha256={key: sha256(shards[f"listings/{key}.json"]).hexdigest() for key in files},
        complete=True,
        legacy_utc_first_seen=legacy,
    )
    return index, shards, proof


def run(inputs, **overrides):
    index, shards, capture = inputs
    return snapshot_from_fixed_export(
        index,
        shards,
        **(
            {
                "capture": capture,
                "catalog": CATALOG,
                "bounds": BOUNDS,
                "max_source_bytes": 80_000,
                "max_source_rows": 50,
            }
            | overrides
        ),
    )


def replace_index(inputs, raw):
    _, shards, proof = inputs
    return raw, shards, replace(proof, index_sha256=sha256(raw).hexdigest())


def test_complete_fixed_capture_collapses_exact_cross_shard_copies():
    reordered = dict(reversed(tuple(BASE_ROW.items())))
    raw = run(make_capture({"MA": [BASE_ROW], "NY": [reordered]}))
    assert raw == run(make_capture({"NY": [BASE_ROW], "MA": [reordered]}))
    assert json.loads(raw) == {
        "version": 1,
        "complete": True,
        "generated_at": "2028-02-29T00:00:00.002Z",
        "covers_after": "2028-02-29T00:00:00.000Z",
        "roles": [
            {
                "id": BASE_ROW["id"],
                "company_key": "booz allen",
                "field_tags": ["biology"],
                "states": ["MA", "NY"],
                "first_seen": "2028-02-29T00:00:00.002Z",
                "status": "open",
                "company_name": BASE_ROW["company_name"],
                "title": BASE_ROW["title"],
                "location": "Boston, MA +1",
                "apply_url": BASE_ROW["apply_url"],
            }
        ],
    }


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("2028-02-28T23:59:59.999999Z", None),
        ("2028-02-29T00:00:00.000000Z", None),
        ("2028-02-29T00:00:00.000001Z", "2028-02-29T00:00:00.001Z"),
        ("2028-02-28T19:00:00.001000-05:00", "2028-02-29T00:00:00.001Z"),
        ("2028-02-29T00:00:00.001001Z", "2028-02-29T00:00:00.002Z"),
        ("2028-02-29T00:00:00.002000Z", "2028-02-29T00:00:00.002Z"),
        ("2028-02-29T00:00:00.002001Z", None),
        ("2028-02-29T00:00:00.002500Z", None),
    ],
)
def test_floor_upper_ceil_role_preserves_both_exact_boundaries(raw, expected):
    roles = json.loads(run(make_capture({"MA": [BASE_ROW | {"first_seen": raw}]})))["roles"]
    assert [role["first_seen"] for role in roles] == ([] if expected is None else [expected])


def test_sub_millisecond_tail_is_eligible_in_next_complete_window():
    tail = BASE_ROW | {"first_seen": "2028-02-29T00:00:00.002001Z"}
    boundary = BASE_ROW | {"id": "a" * 16, "first_seen": "2028-02-29T00:00:00.002000Z"}
    assert (
        json.loads(run(make_capture({"MA": [tail, boundary]})))["roles"][0]["id"] == boundary["id"]
    )
    next_capture = make_capture(
        {"MA": [tail, boundary]},
        lower=LOWER + timedelta(milliseconds=2),
        generated=EXACT + timedelta(milliseconds=2),
    )
    roles = json.loads(run(next_capture))["roles"]
    assert [(role["id"], role["first_seen"]) for role in roles] == [
        (tail["id"], "2028-02-29T00:00:00.003Z")
    ]


def test_legacy_naive_first_seen_requires_explicit_capture_provenance():
    rows = {"MA": [BASE_ROW | {"first_seen": "2028-02-29T00:00:00.001001"}]}
    with pytest.raises(ValueError, match="aware"):
        run(make_capture(rows))
    assert run(make_capture(rows, legacy=True)) == run(make_capture())


@pytest.mark.parametrize(
    "raw",
    [
        "2028-02-29T00:00:00.002501Z",
        "2028-02-29T00:00:00.001000-00:00",
        "2028-02-29T00:00:00.001000+00:60",
        "2028-02-30T00:00:00.001000Z",
        "2028-02-29",
        None,
    ],
)
def test_ambiguous_or_future_first_seen_rejects_whole_capture(raw):
    other = BASE_ROW | {"id": "a" * 16, "first_seen": raw}
    with pytest.raises(ValueError):
        run(make_capture({"MA": [BASE_ROW, other]}, legacy=True))


def test_potentially_eligible_invalid_roles_do_not_turn_into_empty_windows():
    for bad in (
        {"apply_url": "https://xn--bcher-kva.example/apply"},
        {"regions": [{"loc": "Boston", "state": []}]},
        {"regions": [], "location_raw": None},
        {"field_tags": [False]},
        {"company_name": "Unrecognized Employer"},
    ):
        with pytest.raises(ValueError):
            run(make_capture({"MA": [BASE_ROW | bad]}))


def test_known_closed_and_old_roles_do_not_match_and_remote_has_no_state_key():
    old = BASE_ROW | {"id": "a" * 16, "first_seen": "2028-01-30T00:00:00Z"}
    closed = BASE_ROW | {"id": "b" * 16, "status": "closed"}
    assert json.loads(run(make_capture({"MA": [old, closed]})))["roles"] == []
    remote = BASE_ROW | {
        "regions": [{"loc": "Remote", "state": "Remote", "kind": "remote"}],
    }
    role = json.loads(run(make_capture({"remote": [remote]})))["roles"][0]
    assert role["states"] == []
    assert role["location"] == "Remote"


def test_capture_is_bound_to_exact_index_and_all_shard_bytes():
    index, shards, proof = make_capture({"MA": [BASE_ROW], "NY": [BASE_ROW]})
    assert run((index, shards, proof))
    for changed in (
        {"listings/MA.json": shards["listings/MA.json"]},
        shards | {"listings/CA.json": shards["listings/MA.json"]},
        shards | {"listings/NY.json": encode([BASE_ROW | {"title": "Same count, stale bytes"}])},
    ):
        with pytest.raises(ValueError):
            run((index, changed, proof))
    with pytest.raises(ValueError, match="bytes do not match"):
        run((index + b" ", shards, proof))


@pytest.mark.parametrize(
    ("key", "value"),
    [("file", "../MA.json"), ("count", 2), ("open", 0), ("count", True), ("open", True)],
)
def test_index_counts_and_paths_must_match(key, value):
    inputs = make_capture()
    index = json.loads(inputs[0])
    index["files"]["MA"][key] = value
    with pytest.raises(ValueError):
        run(replace_index(inputs, encode(index)))


def test_index_generation_and_independent_manifest_must_match():
    inputs = make_capture({"MA": [BASE_ROW], "NY": [BASE_ROW]})
    index = json.loads(inputs[0])
    index["files"].pop("NY")
    with pytest.raises(ValueError, match="manifest"):
        run(replace_index(inputs, encode(index)))
    index = json.loads(inputs[0])
    for wrong in ("2028-02-29T00:00:00.002499Z", "2028-02-29T00:00:00.002500"):
        index["generated_at"] = wrong
        with pytest.raises(ValueError):
            run(replace_index(inputs, encode(index)))


@pytest.mark.parametrize(
    "raw",
    [
        b'{"generated_at":"2028-02-29T00:00:00.002500Z","files":{},"files":{}}',
        b'{"generated_at":"2028-02-29T00:00:00.002500Z","files":{},"extra":NaN}',
        b'{"generated_at":"2028-02-29T00:00:00.002500Z","files":{},"extra":1e999}',
        b"\xff",
    ],
)
def test_malformed_index_rejects_even_with_matching_capture_digest(raw):
    with pytest.raises(ValueError, match="UTF-8 JSON"):
        run(replace_index(make_capture(), raw))


def test_duplicate_within_shard_and_conflicting_copies_are_rejected():
    with pytest.raises(ValueError, match="duplicate ID"):
        run(make_capture({"MA": [BASE_ROW, BASE_ROW]}))
    for change in ({"title": "Different"}, {"status": "closed"}, {"score_parts": {"source": True}}):
        with pytest.raises(ValueError, match="conflicting"):
            run(make_capture({"MA": [BASE_ROW], "NY": [BASE_ROW | change]}))


def test_incomplete_or_unaligned_capture_cannot_be_declared_empty():
    index, shards, proof = make_capture()
    for changed in (
        replace(proof, complete=False),
        replace(proof, covers_after=LOWER + timedelta(microseconds=1)),
        replace(proof, covers_after=LOWER + timedelta(milliseconds=2)),
        replace(proof, generated_at=EXACT.replace(tzinfo=None)),
        replace(proof, shard_sha256={}),
    ):
        with pytest.raises(ValueError):
            run((index, shards, changed))


def test_exact_input_and_output_bounds_are_independent():
    index, shards, proof = make_capture({"MA": [BASE_ROW], "NY": [BASE_ROW]})
    size = len(index) + sum(map(len, shards.values()))
    inputs = index, shards, proof
    raw = run(inputs, max_source_bytes=size, max_source_rows=2)
    with pytest.raises(ValueError, match="source byte bound"):
        run(inputs, max_source_bytes=size - 1)
    with pytest.raises(ValueError, match="source row bound"):
        run(inputs, max_source_rows=1)
    with pytest.raises(ValueError, match="snapshot exceeds byte bound"):
        run(inputs, bounds=replace(BOUNDS, max_bytes=len(raw) - 1))
