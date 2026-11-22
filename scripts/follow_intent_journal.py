"""Detached bounded pre-push journal port; no storage, publication or authority defaults."""

from dataclasses import dataclass
import inspect
import json
import re

from scripts.ingest_data_writer import PushIntent


def _number(value, maximum):
    return type(value) is int and 0 < value <= maximum


def _wire(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("ascii")


@dataclass(frozen=True)
class StoredFollowIntent:
    """Trusted sink's synchronous acknowledgement of the exact complete prefix."""

    journal: bytes


@dataclass(frozen=True)
class FollowIntentSnapshot:
    status: str
    journal: bytes | None = None
    acknowledged: PushIntent | None = None


class FollowIntentJournal:
    """One publisher invocation only; inspect snapshot after publish returns.

    The sink must return promptly and authenticate its own storage acknowledgement.
    A matching receipt is not proof of durability or accepted-operation authority.
    """

    def __init__(
        self,
        *,
        enabled=False,
        run_id=None,
        run_attempt=None,
        sink=None,
        max_journal_bytes=None,
        max_entry_bytes=None,
    ):
        self._status = "disabled"
        self._rows = ()
        self._intents = ()
        self._journal = None
        self._ack = None
        self._busy = False
        if enabled is not True:
            return
        self._status = "held"
        if not (
            _number(run_id, 2**53 - 1)
            and _number(run_attempt, 2**53 - 1)
            and _number(max_journal_bytes, 4096)
            and _number(max_entry_bytes, 1024)
            and callable(sink)
        ):
            return
        self._run = (run_id, run_attempt)
        self._sink = sink
        self._maximum = max_journal_bytes
        self._entry_maximum = max_entry_bytes
        self._status = "pending"

    def snapshot(self):
        if self._status in ("disabled", "held"):
            return FollowIntentSnapshot(self._status)
        # Do not expose the private instance retained for subsequent callback matching.
        ack = PushIntent(*self._ack) if self._ack else None
        return FollowIntentSnapshot(self._status, self._journal, ack)

    def __call__(self, intent, acknowledged):
        if self._status == "disabled":
            return
        try:
            if self._status != "pending" or self._busy or type(intent) is not PushIntent:
                raise ValueError
            self._busy = True
            values = (
                intent.ordinal,
                intent.expected_predecessor,
                intent.candidate_commit,
                intent.public_tree,
            )
            ordinal, predecessor, candidate, tree = values
            if (
                type(acknowledged) is not bool
                or not _number(ordinal, 3)
                or any(
                    type(s) is not str or not re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", s)
                    for s in (predecessor, candidate, tree)
                )
                or len({len(predecessor), len(candidate), len(tree)}) != 1
            ):
                raise ValueError
            if acknowledged:
                if not self._intents or values != self._intents[-1]:
                    raise ValueError
                self._ack = values
                self._status = "acknowledged"
                return
            if ordinal != len(self._intents) + 1:
                raise ValueError
            if self._intents:
                last = self._intents[-1]
                if tree != last[3] or len(candidate) != len(last[2]):
                    raise ValueError
                if values[1:] != last[1:] and any(candidate == old[2] for old in self._intents):
                    raise ValueError
            row = dict(
                zip(
                    (
                        "run_id",
                        "run_attempt",
                        "ordinal",
                        "expected_predecessor",
                        "candidate_commit",
                        "public_tree",
                    ),
                    (*self._run, *values),
                )
            )
            if len(_wire(row)) > self._entry_maximum:
                raise ValueError
            rows = (*self._rows, row)
            wire = _wire(rows) + b"\n"
            if len(wire) > self._maximum:
                raise ValueError
            receipt = self._sink(wire)
            if inspect.iscoroutine(receipt):
                receipt.close()
            if (
                self._status != "pending"
                or type(receipt) is not StoredFollowIntent
                or type(receipt.journal) is not bytes
                or receipt.journal != wire
            ):
                raise ValueError
            self._rows = rows
            self._intents = (*self._intents, values)
            self._journal = wire
        except Exception:
            self._status = "held"
            self._journal = self._ack = None
            self._rows = self._intents = ()
            # #650 disables this optional observer and preserves ordinary listing publication.
            raise ValueError("Follow intent journal unavailable") from None
        finally:
            self._busy = False
