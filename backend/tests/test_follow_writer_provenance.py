from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from shutil import copytree

import pytest
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import Session, sessionmaker

from internscout import export_static, pipeline
from internscout.db import Base
from internscout.follow_writer_provenance import FollowWriterCapture, _fixed_export
from internscout.models import Listing

NOW = datetime(2026, 11, 11, 18, tzinfo=timezone.utc)
BASELINE = NOW - timedelta(hours=1)


class FrozenDateTime(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW if tz is not None else NOW.replace(tzinfo=None)


@pytest.fixture
def database(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{(tmp_path / 'synthetic.db').as_posix()}")
    Base.metadata.create_all(engine)

    class IsolatedSession(Session):
        pass

    sessions = sessionmaker(bind=engine, class_=IsolatedSession)
    for module in (pipeline, export_static):
        monkeypatch.setattr(module, "SessionLocal", sessions)
        monkeypatch.setattr(module, "init_db", lambda: None)
        monkeypatch.setattr(module, "datetime", FrozenDateTime)
    try:
        yield sessions, IsolatedSession
    finally:
        engine.dispose()


def raw(name, suffix):
    return {
        "company_name": name,
        "title": "Software Engineering Intern",
        "locations": ["Boston, MA"],
        "source": "fixture",
        "employment_type": "Intern",
        "url": f"https://jobs.example.test/{suffix}",
    }


def seed(directory, rows):
    export_static.write_shards(rows, str(directory), (BASELINE - timedelta(minutes=1)).isoformat())
    return _fixed_export(directory)[0]


def observe_seed(identity):
    return FollowWriterCapture(
        covers_after=BASELINE, seed_observed_by=BASELINE, prior_identity=identity
    )


def public_bytes(directory):
    return {p.relative_to(directory): p.read_bytes() for p in directory.rglob("*") if p.is_file()}


def test_committed_sqlite_origin_and_carry_selection_with_exact_public_byte_parity(
    tmp_path, database
):
    sessions, _ = database
    enabled, disabled = tmp_path / "enabled", tmp_path / "disabled"
    rows = [raw("Fixture Fresh", "fresh"), raw("Fixture Existing", "existing")]
    assert pipeline.run(rows[1:], verbose=False)["new"] == 1
    with sessions() as db:
        existing = export_static._listing_dict(db.scalar(select(Listing)))
    # Competing raw-URL predecessor is intentionally different. ID wins.
    id_stamp, url_stamp = "2026-11-01T10:00:00", "2026-11-02T11:00:00"
    identity = seed(
        enabled,
        [
            existing | {"apply_url": "https://jobs.example.test/prior-url", "first_seen": id_stamp},
            existing | {"id": "f" * 16, "first_seen": url_stamp},
        ],
    )
    copytree(enabled, disabled)
    capture = observe_seed(identity)
    assert pipeline.run(rows, verbose=False, follow_capture=capture)["new"] == 1
    export_static.export(str(enabled), follow_capture=capture)
    export_static.export(str(disabled))
    assert public_bytes(enabled) == public_bytes(disabled)
    proof = capture.result
    assert proof is not None
    assert (
        proof.identity.index_sha256
        == sha256((enabled / "listings/index.json").read_bytes()).hexdigest()
    )
    assert (
        proof.identity.shard_sha256["MA"]
        == sha256((enabled / "listings/MA.json").read_bytes()).hexdigest()
    )
    old = proof.rows[existing["id"]]
    assert (old.raw_first_seen, old.verified_utc, old.observed_by) == (id_stamp, None, BASELINE)
    fresh = next(value for key, value in proof.rows.items() if key != existing["id"])
    assert (fresh.raw_first_seen, fresh.verified_utc, fresh.observed_by) == (
        NOW.replace(tzinfo=None).isoformat(),
        NOW,
        None,
    )

    # A later isolated caller can pass the trusted lineage with its exact identity.
    second = FollowWriterCapture(
        covers_after=BASELINE, prior_identity=proof.identity, prior_lineage=proof.lineage
    )
    assert pipeline.run(rows, verbose=False, follow_capture=second)["new"] == 0
    export_static.export(str(enabled), follow_capture=second)
    assert second.result is not None
    assert second.result.rows == proof.rows


def test_url_fallback_and_search_carry_record_the_selected_predecessor(tmp_path, database):
    sessions, _ = database
    current = raw("Fixture Current", "existing")
    pipeline.run([current], verbose=False)
    with sessions() as db:
        existing = export_static._listing_dict(db.scalar(select(Listing)))
    recent = (BASELINE - timedelta(minutes=5)).replace(tzinfo=None).isoformat()
    older = existing | {"id": "b" * 16, "first_seen": recent}
    search = existing | {
        "id": "c" * 16,
        "apply_url": "https://jobs.example.test/search-only",
        "via_search": True,
        "first_seen": recent,
        "last_seen": recent,
    }
    collapsed = [
        search
        | {
            "id": str(i) * 16,
            "apply_url": f"https://boards.greenhouse.io/example/jobs/{i}",
            "ats": "greenhouse",
            "via_search": False,
        }
        for i in range(1, 4)
    ]
    identity = seed(tmp_path / "public", [older, search, *collapsed])
    capture = observe_seed(identity)
    export_static.export(str(tmp_path / "public"), follow_capture=capture)
    assert capture.result is not None
    assert set(capture.result.rows) == {existing["id"], search["id"], *(r["id"] for r in collapsed)}
    assert all(value.observed_by == BASELINE for value in capture.result.rows.values())


def test_failed_sqlite_commit_does_not_release_new_row_origin(tmp_path, database):
    sessions, session_type = database
    directory = tmp_path / "public"
    capture = observe_seed(seed(directory, []))

    def reject(_session):
        raise RuntimeError("synthetic commit failure")

    event.listen(session_type, "before_commit", reject)
    with pytest.raises(RuntimeError, match="synthetic"):
        pipeline.run([raw("Fixture Retry", "retry")], verbose=False, follow_capture=capture)
    event.remove(session_type, "before_commit", reject)
    with sessions() as db:
        assert db.scalar(select(Listing)) is None
    # An unobserved retry must not borrow evidence from the failed transaction.
    pipeline.run([raw("Fixture Retry", "retry")], verbose=False)
    export_static.export(str(directory), follow_capture=capture)
    assert capture.result is None


def test_predecessor_digest_and_seed_bound_fail_before_any_export_write(tmp_path, database):
    directory = tmp_path / "public"
    identity = seed(directory, [])
    with pytest.raises(ValueError, match="coverage start"):
        FollowWriterCapture(
            covers_after=BASELINE,
            prior_identity=identity,
            seed_observed_by=BASELINE + timedelta(microseconds=1),
        )
    before = public_bytes(directory)
    capture = observe_seed(replace(identity, index_sha256="0" * 64))
    with pytest.raises(ValueError, match="differ"):
        export_static.export(str(directory), follow_capture=capture)
    assert public_bytes(directory) == before
