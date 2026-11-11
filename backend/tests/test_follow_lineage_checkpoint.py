from __future__ import annotations

import json
from dataclasses import replace
from datetime import timedelta
from hashlib import sha256

import pytest

from internscout import export_static, pipeline
from internscout.follow_writer_provenance import FollowWriterCapture
from test_follow_writer_provenance import (
    BASELINE,
    NOW,
    FrozenDateTime,
    database,
    observe_seed,
    raw,
    seed,
)
from test_ingest_data_writer import ROOT


@pytest.fixture
def accepted(tmp_path, database, monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT))
    from scripts import follow_lineage_checkpoint as codec
    from scripts import ingest_data_writer as w

    for key, value in {
        "GIT_ALLOW_PROTOCOL": "file",
        "GIT_AUTHOR_NAME": "Fixture",
        "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
        "GIT_COMMITTER_NAME": "Fixture",
        "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
    }.items():
        monkeypatch.setenv(key, value)
    repo, remote, state = (tmp_path / name for name in ("data", "file-remote.git", "state"))
    state.mkdir()
    w.git(tmp_path, "init", str(repo))
    w.git(tmp_path, "init", "--bare", str(remote))
    w.git(repo, "symbolic-ref", "HEAD", w.BRANCH)
    w.git(repo, "commit", "--allow-empty", "-m", "Synthetic baseline")
    w.git(repo, "remote", "add", "origin", str(remote))
    w.git(repo, "push", "-u", "origin", f"HEAD:{w.BRANCH}")

    directory = repo / "docs/data"
    capture = observe_seed(seed(directory, []))
    listing = raw("Fixture Reopen", "closed")
    rows = [listing | {"active": False}, raw("Fixture Open", "open")]
    pipeline.run(rows, verbose=False, follow_capture=capture)
    export_static.export(str(directory), follow_capture=capture)
    (_, commit), receipt = w.publish_with_follow_provenance(
        repo, state, "Synthetic refresh", capture.result
    )
    assert receipt is not None and receipt.commit == commit == w.revision(remote, w.BRANCH)
    tree = w.revision(remote, f"{commit}:docs/data")
    assert receipt.public_tree == tree
    source = codec.AcceptedFollowSource(
        commit,
        tree,
        w.git(remote, "cat-file", "blob", f"{commit}:docs/data/listings/index.json").stdout,
        {
            path: w.git(remote, "cat-file", "blob", f"{commit}:docs/data/{path}").stdout
            for path in receipt.staged.shards
        },
    )
    bounds = codec.FollowCheckpointBounds(12_000, 5, 80_000, 10)
    return codec, receipt, capture.result, source, bounds, directory, listing


def encoded(accepted):
    codec, receipt, proof, _, bounds, *_ = accepted
    return codec.encode_accepted_follow_checkpoint(receipt, proof, accepted_at=NOW, bounds=bounds)


def rewrite(record):
    return json.dumps(record, sort_keys=True, separators=(",", ":")).encode()


def test_closed_lineage_from_real_accepted_receipt_reopens_without_guessing(accepted, monkeypatch):
    codec, receipt, full, source, bounds, directory, listing = accepted
    checkpoint = encoded(accepted)
    assert checkpoint == rewrite(json.loads(checkpoint))
    assert b"example.test" not in checkpoint
    decoded = codec.decode_accepted_follow_checkpoint(checkpoint, source, now=NOW, bounds=bounds)
    assert len(full.lineage) == 2 and len(receipt.staged._rows) == 1
    assert decoded.lineage == full.lineage
    closed_key = next(key for key in decoded.by_listing_url if key[1].endswith("/closed"))
    assert decoded.by_listing_url[closed_key].verified_utc == NOW

    class Later(FrozenDateTime):
        @classmethod
        def now(cls, tz=None):
            value = NOW + timedelta(hours=1)
            return value if tz is not None else value.replace(tzinfo=None)

    monkeypatch.setattr(export_static, "datetime", Later)
    monkeypatch.setattr(pipeline, "datetime", Later)
    next_capture = FollowWriterCapture(
        covers_after=decoded.covers_after,
        prior_identity=decoded.identity,
        prior_lineage=decoded.lineage,
    )
    assert pipeline.run([listing], verbose=False, follow_capture=next_capture)["new"] == 0
    export_static.export(str(directory), follow_capture=next_capture)
    assert next_capture.result is not None
    assert next_capture.result.rows[closed_key[0]].verified_utc == NOW
    assert next_capture.result.covers_after == BASELINE


def test_substitute_open_and_contradictory_closed_proofs_fail(accepted):
    codec, receipt, full, _, bounds, *_ = accepted
    open_id = next(iter(receipt.staged._rows))
    open_proof = full.rows[open_id]
    closed_key = next(key for key in full.lineage if key[0] != open_id)
    invalid = [
        replace(full, rows={open_id: replace(open_proof, verified_utc=NOW - timedelta(seconds=1))}),
        replace(
            full,
            lineage=dict(full.lineage)
            | {
                closed_key: replace(
                    full.lineage[closed_key], verified_utc=NOW - timedelta(seconds=1)
                )
            },
        ),
        replace(
            full,
            lineage=dict(full.lineage)
            | {closed_key: replace(full.lineage[closed_key], raw_first_seen="2026-11-11T17:59:59")},
        ),
    ]
    for proof in invalid:
        with pytest.raises(ValueError):
            codec.encode_accepted_follow_checkpoint(receipt, proof, accepted_at=NOW, bounds=bounds)
    with pytest.raises(ValueError):
        codec.encode_accepted_follow_checkpoint(
            receipt.staged, full, accepted_at=NOW, bounds=bounds
        )

    with pytest.raises(ValueError, match="candidate tree"):
        codec.encode_accepted_follow_checkpoint(
            replace(receipt, staged=replace(receipt.staged, candidate_tree="wrong")),
            full,
            accepted_at=NOW,
            bounds=bounds,
        )
    with pytest.raises(ValueError, match="acceptance or coverage"):
        codec.encode_accepted_follow_checkpoint(
            receipt,
            full,
            accepted_at=NOW - timedelta(microseconds=1),
            bounds=bounds,
        )


def test_checkpoint_expiry_bounds_identity_and_canonical_format(accepted):
    codec, receipt, full, source, bounds, *_ = accepted
    checkpoint = encoded(accepted)
    exact = replace(bounds, max_bytes=len(checkpoint), max_rows=2)
    assert (
        codec.encode_accepted_follow_checkpoint(receipt, full, accepted_at=NOW, bounds=exact)
        == checkpoint
    )
    decode = codec.decode_accepted_follow_checkpoint
    assert decode(checkpoint, source, now=NOW + timedelta(days=7, microseconds=-1), bounds=exact)
    for invalid_bytes, invalid_source, now, caps in (
        (checkpoint, source, NOW + timedelta(days=7), exact),
        (checkpoint, source, NOW - timedelta(microseconds=1), exact),
        (checkpoint, replace(source, commit="f" * 40), NOW, exact),
        (checkpoint, replace(source, public_tree="e" * 40), NOW, exact),
        (checkpoint, replace(source, index_bytes=source.index_bytes + b" "), NOW, exact),
        (checkpoint, source, NOW, replace(exact, max_rows=1)),
        (checkpoint, source, NOW, replace(exact, max_bytes=len(checkpoint) - 1)),
        (checkpoint + b" ", source, NOW, bounds),
    ):
        with pytest.raises(ValueError):
            decode(invalid_bytes, invalid_source, now=now, bounds=caps)
    record = json.loads(checkpoint)
    record["rows"].append(record["rows"][0])
    with pytest.raises(ValueError):
        decode(rewrite(record), source, now=NOW, bounds=bounds)


def test_exact_url_associations_reject_conflicting_raw_timestamps(accepted):
    codec, _, _, source, bounds, *_ = accepted
    record = json.loads(encoded(accepted))
    shard = "listings/MA.json"
    rows = json.loads(source.shards[shard])
    rows[1]["apply_url"] = rows[0]["apply_url"]
    alias = rewrite(rows)
    record["shard_sha256"]["MA"] = sha256(alias).hexdigest()
    aliased = replace(source, shards=dict(source.shards) | {shard: alias})
    assert (
        len(
            codec.decode_accepted_follow_checkpoint(
                rewrite(record), aliased, now=NOW, bounds=bounds
            ).by_listing_url
        )
        == 2
    )
    rows[1]["first_seen"] = "2026-11-11T17:59:59"
    changed = rewrite(rows)
    record["shard_sha256"]["MA"] = sha256(changed).hexdigest()
    with pytest.raises(ValueError, match="contradictory raw URL association"):
        codec.decode_accepted_follow_checkpoint(
            rewrite(record), replace(source, shards={shard: changed}), now=NOW, bounds=bounds
        )
