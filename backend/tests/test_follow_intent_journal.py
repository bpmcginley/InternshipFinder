"""Bounded observer records and actual file-only Git, with no production authority."""

from dataclasses import FrozenInstanceError
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
import test_ingest_data_writer as native
from scripts import ingest_data_writer as writer
from scripts.follow_intent_journal import FollowIntentJournal, StoredFollowIntent


def intent(ordinal=1, predecessor="a", candidate="b", tree="c", width=40):
    return writer.PushIntent(ordinal, predecessor * width, candidate * width, tree * width)


def recorder(sink=lambda wire: StoredFollowIntent(wire), **options):
    return FollowIntentJournal(
        enabled=True,
        run_id=7,
        run_attempt=2,
        sink=sink,
        max_journal_bytes=options.pop("max_journal_bytes", 4096),
        max_entry_bytes=options.pop("max_entry_bytes", 1024),
        **options,
    )


def test_disabled_inspects_no_ports():
    class Bad:
        def __getattribute__(self, name):
            raise AssertionError("must not inspect")

    value = FollowIntentJournal(sink=Bad(), run_id=Bad())
    value(Bad(), Bad())
    assert value.snapshot().status == "disabled"


@pytest.mark.parametrize(
    "key,value",
    [
        ("run_id", True),
        ("run_attempt", 0),
        ("run_id", 2**53),
        ("max_journal_bytes", 4097),
        ("max_entry_bytes", 1025),
        ("max_entry_bytes", False),
        ("sink", None),
    ],
)
def test_invalid_configuration_never_reaches_sink(key, value):
    options = dict(
        enabled=True,
        run_id=7,
        run_attempt=2,
        sink=lambda _: pytest.fail(),
        max_journal_bytes=4096,
        max_entry_bytes=1024,
    )
    options[key] = value
    port = FollowIntentJournal(**options)
    assert port.snapshot().status == "held"
    with pytest.raises(ValueError):
        port(intent(), False)


@pytest.mark.parametrize("width", [40, 64])
def test_canonical_prefix_exact_ack_and_immutable_snapshot(width):
    recorded = []

    def sink(wire):
        recorded.append(wire)
        return StoredFollowIntent(wire)

    port = recorder(sink)
    expected = []
    for number, candidate in enumerate(["b", "b", "d"], 1):
        event = intent(number, candidate=candidate, width=width)
        port(event, False)
        expected.append(
            dict(
                run_id=7,
                run_attempt=2,
                ordinal=number,
                expected_predecessor="a" * width,
                candidate_commit=candidate * width,
                public_tree="c" * width,
            )
        )
        assert (
            recorded[-1]
            == json.dumps(expected, sort_keys=True, separators=(",", ":")).encode("ascii") + b"\n"
        )
    port(event, True)
    result = port.snapshot()
    assert result.status == "acknowledged" and result.journal == recorded[-1]
    assert result.acknowledged == event
    with pytest.raises(FrozenInstanceError):
        result.status = "held"
    object.__setattr__(result.acknowledged, "ordinal", 1)
    assert port.snapshot().acknowledged.ordinal == 3


@pytest.mark.parametrize(
    "bad",
    [
        intent(True),
        intent(0),
        intent(4),
        intent(candidate="G"),
        writer.PushIntent(1, "a" * 40, "b" * 64, "c" * 40),
        writer.PushIntent(1, None, "b" * 40, "c" * 40),
        SimpleNamespace(
            ordinal=1,
            expected_predecessor="a" * 40,
            candidate_commit="b" * 40,
            public_tree="c" * 40,
        ),
    ],
)
def test_invalid_intent_precedes_sink(bad):
    port = recorder(lambda _: pytest.fail())
    with pytest.raises(ValueError):
        port(bad, False)
    assert port.snapshot().status == "held"


@pytest.mark.parametrize(
    "events",
    [
        [(intent(), True)],
        [(intent(), 1)],
        [(intent(2), False)],
        [(intent(), False), (intent(), False)],
        [(intent(), False), (intent(2, tree="d"), False)],
        [(intent(), False), (intent(2, predecessor="d"), False)],
        [(intent(), False), (intent(2, candidate="d"), False), (intent(3), False)],
        [(intent(), False), (intent(candidate="d"), True)],
        [(intent(), False), (intent(), True), (intent(), True)],
        [(intent(), False), (intent(), True), (intent(2), False)],
    ],
)
def test_invalid_sequence_permanently_withholds_qualified_output(events):
    port = recorder()
    with pytest.raises(ValueError):
        for event, ack in events:
            port(event, ack)
    assert port.snapshot().status == "held"
    assert port.snapshot().journal is None and port.snapshot().acknowledged is None
    with pytest.raises(ValueError):
        port(intent(), True)


@pytest.mark.parametrize("reply", [None, True, b"", {"journal": b""}, StoredFollowIntent(b"wrong")])
def test_malformed_sink_receipt_is_not_acknowledgement(reply):
    port = recorder(lambda _: reply)
    with pytest.raises(ValueError):
        port(intent(), False)
    assert port.snapshot().status == "held"


def test_exact_byte_limits_before_sink():
    port = recorder()
    port(intent(), False)
    raw = port.snapshot().journal
    entry = len(raw) - 3  # Array brackets and final LF.
    exact = recorder(max_journal_bytes=len(raw), max_entry_bytes=entry)
    exact(intent(), False)
    exact(intent(), True)
    assert exact.snapshot().status == "acknowledged"
    for bounds in [dict(max_journal_bytes=len(raw) - 1), dict(max_entry_bytes=entry - 1)]:
        with pytest.raises(ValueError):
            recorder(lambda _: pytest.fail(), **bounds)(intent(), False)


def test_reentrant_sink_and_async_sink_fail_closed_without_executing_async_body():
    def sink(wire):
        with pytest.raises(ValueError):
            port(intent(), True)
        return StoredFollowIntent(wire)

    port = recorder(sink)
    with pytest.raises(ValueError):
        port(intent(), False)
    assert port.snapshot().status == "held"

    async def later(_):
        pytest.fail("asynchronous sink must not run")

    port = recorder(later)
    with pytest.raises(ValueError):
        port(intent(), False)
    assert port.snapshot().status == "held"


def test_sink_cannot_mutate_recorded_intent_identity():
    event = intent()

    def sink(wire):
        object.__setattr__(event, "candidate_commit", "d" * 40)
        return StoredFollowIntent(wire)

    port = recorder(sink)
    port(event, False)
    with pytest.raises(ValueError):
        port(event, True)
    assert port.snapshot().status == "held"


@pytest.fixture
def git_case(monkeypatch):
    monkeypatch.setattr(native, "writer", writer)
    case = native.IngestWriterTests("runTest")
    case.setUp()
    try:
        yield case
    finally:
        case.doCleanups()


def test_file_git_ack_requires_exact_prefix_recorded_before_push(git_case):
    case = git_case
    writer.prepare(case.data, case.primary, case.state)
    case.update_snapshot()
    predecessor = writer.revision(case.remote, writer.BRANCH)
    path = case.root / "synthetic-intent.json"

    def sink(wire):
        assert writer.revision(case.remote, writer.BRANCH) == predecessor
        path.write_bytes(wire)
        return StoredFollowIntent(path.read_bytes())

    port = recorder(sink)
    message, commit = writer.publish(case.data, case.state, "Synthetic", observe_push=port)
    assert message == "Published validated data snapshot."
    result = port.snapshot()
    assert result.status == "acknowledged" and result.acknowledged.candidate_commit == commit
    assert result.journal == path.read_bytes()
    assert writer.revision(case.remote, writer.BRANCH) == commit


@pytest.mark.parametrize("failure", ["throw", "malformed", "lost_ack"])
def test_file_git_listing_survives_unqualified_journal(git_case, failure):
    case = git_case
    writer.prepare(case.data, case.primary, case.state)
    case.update_snapshot()
    calls = []

    def sink(wire):
        calls.append(wire)
        if failure == "lost_ack":
            (case.root / "uncertain-intent.json").write_bytes(wire)
        if failure != "malformed":
            raise OSError("synthetic sink failure")
        return True

    port = recorder(sink)
    message, commit = writer.publish(case.data, case.state, "Synthetic", observe_push=port)
    assert message == "Published validated data snapshot."
    assert writer.revision(case.remote, writer.BRANCH) == commit
    assert len(calls) == 1 and port.snapshot().status == "held"
    assert port.snapshot().acknowledged is None


def test_file_git_lost_push_ack_does_not_qualify_from_matching_tip(git_case, monkeypatch):
    case = git_case
    writer.prepare(case.data, case.primary, case.state)
    case.update_snapshot()
    original = writer._push_existing

    def lost(*args):
        result = original(*args)
        assert result.returncode == 0
        return SimpleNamespace(returncode=1, stdout=b"", stderr=b"")

    monkeypatch.setattr(writer, "_push_existing", lost)
    port = recorder()
    message, commit = writer.publish(case.data, case.state, "Synthetic", observe_push=port)
    assert message == "Validated data snapshot already published."
    assert writer.revision(case.remote, writer.BRANCH) == commit
    assert port.snapshot().status == "pending" and port.snapshot().acknowledged is None


def test_file_git_noop_records_nothing(git_case):
    case = git_case
    writer.prepare(case.data, case.primary, case.state)
    port = recorder(lambda _: pytest.fail())
    assert writer.publish(case.data, case.state, "Synthetic", observe_push=port)[0] == "No changes."
    assert port.snapshot().journal is None and port.snapshot().acknowledged is None


def test_file_git_merge_retry_ack_binds_only_recorded_second_intent(git_case):
    case = git_case
    writer.prepare(case.data, case.primary, case.state)
    case.update_snapshot()
    other = case.other()
    native.write(other, "other.json", {"unrelated": "concurrent"})
    competing = case.commit(other, "other.json")
    case.git(other, "push", "origin", f"HEAD:{writer.BRANCH}")
    records = []

    def sink(wire):
        records.append(wire)
        return StoredFollowIntent(wire)

    port = recorder(sink)
    _, commit = writer.publish(case.data, case.state, "Synthetic retry", observe_push=port)
    rows = json.loads(port.snapshot().journal)
    assert len(records) == len(rows) == 2
    assert rows[0] == json.loads(records[0])[0]
    assert rows[1]["expected_predecessor"] == competing
    assert rows[1]["candidate_commit"] == commit != rows[0]["candidate_commit"]
    assert rows[1]["public_tree"] == rows[0]["public_tree"]
    assert port.snapshot().acknowledged.ordinal == 2
    assert writer.revision(case.remote, writer.BRANCH) == commit


def test_prefix_growth_bound_poison_prevents_later_ack():
    first = recorder()
    first(intent(), False)
    calls = []

    def sink(wire):
        calls.append(wire)
        return StoredFollowIntent(wire)

    port = recorder(sink, max_journal_bytes=len(first.snapshot().journal))
    port(intent(), False)
    with pytest.raises(ValueError):
        port(intent(2), False)
    assert len(calls) == 1 and port.snapshot().journal is None
    with pytest.raises(ValueError):
        port(intent(), True)
