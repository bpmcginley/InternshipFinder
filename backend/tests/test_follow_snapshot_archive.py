from __future__ import annotations

import json
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from hashlib import sha256

import pytest

from internscout.follow_snapshot import (
    FollowSnapshotBounds,
    FollowSnapshotCatalog,
    build_follow_snapshot,
)
from internscout.follow_snapshot_archive import (
    INDEX,
    FollowArchiveBounds,
    FollowArchivePlan,
    plan_follow_snapshot_archive as plan,
    select_follow_snapshot_for_enqueue as select,
    validate_follow_archive_transition as validate,
)

DAY = timedelta(days=1)
MS = timedelta(milliseconds=1)
AT = datetime(2028, 1, 1, 23, 59, tzinfo=timezone.utc)
BOUND = FollowArchiveBounds(
    snapshot=FollowSnapshotBounds(8_000, 10, 2_000, 3 * 86_400_000),
    max_enqueue_age_ms=86_400_000,
    publish_margin_ms=86_400_000,
    max_entries=5,
    max_archive_bytes=40_000,
)
CATALOG = FollowSnapshotCatalog(frozenset({"fixture"}), frozenset(), frozenset())
ROLE = {
    "id": "a" * 16,
    "status": "open",
    "company_name": "Fixture LLC",
    "title": "Synthetic role",
    "location": "Boston, MA",
    "apply_url": "https://jobs.example.test/apply",
    "field_tags": [],
    "states": [],
}


def candidate(at=AT, *, days=3, title=None):
    roles = [] if title is None else [ROLE | {"title": title, "first_seen": at}]
    return build_follow_snapshot(
        roles,
        generated_at=at,
        covers_after=at - days * DAY,
        complete=True,
        catalog=CATALOG,
        bounds=BOUND.snapshot,
    )


def accept(files, at, raw=None, bounds=BOUND):
    proposed = plan(files, candidate(at) if raw is None else raw, now=at, bounds=bounds)
    validate(files, proposed, now=at, bounds=bounds)
    return proposed.files


def index(files):
    return json.loads(files[INDEX])


def entry(files):
    return index(files)["entries"][-1]


def path(raw):
    return f"data/follows/{sha256(raw).hexdigest()}.json"


def encode_manifest(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def test_first_valid_snapshot_wins_and_pins_exact_bytes():
    first = candidate(AT, title="First")
    files = accept({}, AT, first)
    digest = sha256(first).hexdigest()
    assert files[path(first)] == first
    assert index(files)["latest"] == digest
    assert entry(files) == {
        "generated_at": "2028-01-01T23:59:00.000Z",
        "sha256": digest,
        "bytes": len(first),
        "enqueue_until": "2028-01-02T23:59:00.000Z",
        "retain_until": "2028-01-05T23:59:00.000Z",
    }
    assert plan(files, first, now=AT, bounds=BOUND).files == files
    with pytest.raises(ValueError, match="conflicting"):
        plan(files, candidate(AT, title="Different bytes"), now=AT, bounds=BOUND)
    later = AT + MS
    assert accept(files, later, candidate(later, title="Later same day")) == files
    with pytest.raises(TypeError):
        files[path(first)] = b"changed"


def test_five_entry_utc_boundary_keeps_every_unexpired_pin():
    files = accept({}, AT)
    originals = dict(files)
    for day in range(1, 5):
        files = accept(files, AT + day * DAY - timedelta(minutes=1))
    assert len(index(files)["entries"]) == 5
    original = path(candidate())
    assert files[original] == originals[original]
    before = AT + 4 * DAY - MS
    assert plan(files, None, now=before, bounds=BOUND).files == files
    expiry = AT + 4 * DAY
    pruned = plan(files, None, now=expiry, bounds=BOUND)
    validate(files, pruned, now=expiry, bounds=BOUND)
    assert original not in pruned.files
    assert len(index(pruned.files)["entries"]) == 4
    assert index(pruned.files)["latest"] == index(files)["latest"]


def test_pruning_all_blobs_preserves_clock_and_generation_fences():
    files = accept({}, AT)
    expiry = AT + 4 * DAY
    empty = plan(files, None, now=expiry, bounds=BOUND)
    validate(files, empty, now=expiry, bounds=BOUND)
    assert set(empty.files) == {INDEX}
    assert index(empty.files)["latest"] is None
    assert index(empty.files)["high_water"] == "2028-01-01T23:59:00.000Z"
    assert plan(empty.files, None, now=expiry, bounds=BOUND).files == empty.files
    with pytest.raises(ValueError, match="clock rollback"):
        plan(empty.files, None, now=expiry - MS, bounds=BOUND)
    with pytest.raises(ValueError, match="enqueue lifetime"):
        plan(empty.files, candidate(), now=expiry, bounds=BOUND)


def test_concurrent_replan_uses_current_base_and_cannot_rollback():
    original = accept({}, AT)
    next_day = AT + DAY
    first = plan(original, candidate(next_day, title="First"), now=next_day, bounds=BOUND)
    other_at = next_day + MS
    other = plan(original, candidate(other_at, title="Competing"), now=other_at, bounds=BOUND)
    validate(original, first, now=next_day, bounds=BOUND)
    with pytest.raises(ValueError, match="stale archive base"):
        validate(first.files, other, now=other_at, bounds=BOUND)
    rerun = plan(first.files, candidate(other_at, title="Competing"), now=other_at, bounds=BOUND)
    assert rerun.files == first.files
    validate(first.files, rerun, now=other_at, bounds=BOUND)
    forged = FollowArchivePlan(sha256(first.files[INDEX]).hexdigest(), original)
    with pytest.raises(ValueError, match="unsafe prune or archive rollback"):
        validate(first.files, forged, now=other_at, bounds=BOUND)


def test_staged_plan_cannot_drop_still_live_old_blob_even_with_new_latest():
    files = accept({}, AT)
    future = AT + DAY
    appended = plan(files, candidate(future), now=future, bounds=BOUND)
    manifest = index(appended.files)
    omitted = manifest["entries"].pop(0)
    modified = dict(appended.files)
    modified.pop(f"data/follows/{omitted['sha256']}.json")
    modified[INDEX] = encode_manifest(manifest)
    forged = FollowArchivePlan(appended.base_index_sha256, modified)
    with pytest.raises(ValueError, match="unsafe prune"):
        validate(files, forged, now=future, bounds=BOUND)


def test_gap_stale_and_future_watermark_never_offer_older_fallback():
    first = candidate()
    files = accept({}, AT, first)
    assert select(files, effective_lower=AT - 3 * DAY, now=AT, bounds=BOUND) == first
    assert select(files, effective_lower=AT, now=AT, bounds=BOUND) == first
    assert select(files, effective_lower=AT - 3 * DAY - MS, now=AT, bounds=BOUND) is None
    assert select(files, effective_lower=AT + MS, now=AT, bounds=BOUND) is None
    assert select(files, effective_lower=AT, now=AT + DAY, bounds=BOUND) is None
    assert select(files, effective_lower=AT, now=AT - MS, bounds=BOUND) is None
    later = AT + DAY - timedelta(minutes=1)
    narrower = candidate(later, days=1)
    next_files = accept(files, later, narrower)
    assert select(next_files, effective_lower=AT - DAY, now=later, bounds=BOUND) is None
    assert files[path(first)] == next_files[path(first)]


def test_oversized_invalid_or_stale_candidate_leaves_previous_archive_intact():
    files = accept({}, AT)
    saved = dict(files)
    future = AT + 4 * DAY
    for bad in (b"x" * (BOUND.snapshot.max_bytes + 1), b"{}", candidate(AT)):
        with pytest.raises(ValueError):
            plan(files, bad, now=future, bounds=BOUND)
        assert dict(files) == saved


def test_capacity_rejects_instead_of_dropping_unexpired_blobs():
    bounds = replace(BOUND, max_entries=1)
    files = accept({}, AT, bounds=bounds)
    with pytest.raises(ValueError, match="archive file count"):
        plan(files, candidate(AT + DAY), now=AT + DAY, bounds=bounds)
    assert len(index(files)["entries"]) == 1
    exact = sum(map(len, files.values()))
    assert (
        plan({}, candidate(), now=AT, bounds=replace(bounds, max_archive_bytes=exact)).files
        == files
    )
    with pytest.raises(ValueError, match="archive byte bound"):
        plan({}, candidate(), now=AT, bounds=replace(bounds, max_archive_bytes=exact - 1))


@pytest.mark.parametrize(
    "variant", ["missing", "extra", "bytes", "deadline", "latest", "duplicate"]
)
def test_malformed_committed_archive_is_rejected(variant):
    raw = candidate()
    files = dict(accept({}, AT, raw))
    manifest = index(files)
    if variant == "missing":
        files.pop(path(raw))
    elif variant == "extra":
        files["data/follows/unexpected.json"] = b"{}"
    elif variant == "bytes":
        files[path(raw)] += b" "
    elif variant == "deadline":
        manifest["entries"][0]["retain_until"] = manifest["entries"][0]["enqueue_until"]
        files[INDEX] = encode_manifest(manifest)
    elif variant == "latest":
        manifest["latest"] = "0" * 64
        files[INDEX] = encode_manifest(manifest)
    else:
        files[INDEX] = b'{"version":1,' + files[INDEX][1:]
    with pytest.raises(ValueError):
        plan(files, None, now=AT, bounds=BOUND)


def test_incomplete_window_future_and_older_generation_cannot_publish():
    files = accept({}, AT)
    raw = json.loads(candidate(AT + MS))
    for bad in (
        encode_manifest(raw | {"complete": False}),
        encode_manifest(raw | {"covers_after": raw["generated_at"]}),
        candidate(AT + DAY),
        candidate(AT - MS),
    ):
        with pytest.raises(ValueError):
            plan(files, bad, now=AT, bounds=BOUND)


def test_raw_source_shape_cannot_enter_the_public_archive():
    raw = json.loads(candidate(title="Fixture"))
    role = raw["roles"][0]
    for malformed in (
        role | {"private_notes": "synthetic"},
        role | {"title": {"raw": "synthetic"}},
        1,
    ):
        with pytest.raises(ValueError, match="public role shape"):
            plan({}, encode_manifest(raw | {"roles": [malformed]}), now=AT, bounds=BOUND)
