"""Dormant finite caller for existing detached Follow recovery, never a publisher."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import json
from math import isfinite
import os
import re
from time import monotonic

from internscout.follow_snapshot_source import _utc
from scripts.follow_detached_recovery import (
    DetachedFollowRecovery,
    _authority,
    _detached_environment,
    recover_detached_follow,
)
from scripts.ingest_data_writer import _PublishedFollowProvenance

_FIELDS = {
    'run_id',
    'run_attempt',
    'ordinal',
    'expected_predecessor',
    'candidate_commit',
    'public_tree',
}


@dataclass(frozen=True)
class NamedFollowRef:
    """Trusted caller's fresh named-ref observation, not authentication by this record."""

    ref: str
    commit: str
    public_tree: str
    observed_at: datetime


@dataclass(frozen=True)
class FollowRecoveryHandoff:
    status: str
    checkpoint_status: str = 'not_attempted'
    receipt: _PublishedFollowProvenance | None = None


def _number(value, maximum):
    return type(value) is int and 0 < value <= maximum


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate journal member')
        result[key] = value
    return result


def _journal(raw, authority, maximum, entry_maximum):
    # Bound the immutable wire before decoding/JSON allocation. These fixed ceilings
    # exceed all three exact six-field records, without a new retention policy.
    if (
        not _number(maximum, 4096)
        or not _number(entry_maximum, 1024)
        or type(raw) is not bytes
        or not 0 < len(raw) <= maximum
    ):
        raise ValueError('journal byte bound')
    value = json.loads(raw.decode('ascii'), object_pairs_hook=_object)
    if type(value) is not list or not 1 <= len(value) <= 3:
        raise ValueError('journal entry bound')

    def canonical(item):
        return json.dumps(item, sort_keys=True, separators=(',', ':')).encode('ascii')

    if canonical(value) + b'\n' != raw:
        raise ValueError('noncanonical journal')
    groups = set()
    prior = None
    rows = []
    width = len(authority.pending_candidate)
    for ordinal, row in enumerate(value, 1):
        if (
            type(row) is not dict
            or set(row) != _FIELDS
            or len(canonical(row)) > entry_maximum
            or not _number(row['run_id'], 2**53 - 1)
            or not _number(row['run_attempt'], 2**53 - 1)
            or type(row['ordinal']) is not int
            or row['ordinal'] != ordinal
            or (row['run_id'], row['run_attempt']) != (authority.run_id, authority.run_attempt)
            or any(
                type(row[key]) is not str or not re.fullmatch(r'[a-f0-9]{%d}' % width, row[key])
                for key in ('expected_predecessor', 'candidate_commit', 'public_tree')
            )
            or row['public_tree'] != authority.observation.public_tree
        ):
            raise ValueError('journal identity')
        identity = tuple(
            row[key] for key in ('expected_predecessor', 'candidate_commit', 'public_tree')
        )
        if identity != prior:
            if row['candidate_commit'] in groups:
                raise ValueError('candidate reappeared or changed identity')
            groups.add(row['candidate_commit'])
        prior = identity
        rows.append(identity)
    if (
        rows[0][1] != authority.pending_candidate
        or len(rows) != authority.ordinal
        or rows[-1]
        != (
            authority.expected_predecessor,
            authority.observation.commit,
            authority.observation.public_tree,
        )
    ):
        raise ValueError('accepted operation differs from journal')
    return tuple(rows)


def recover_follow_handoff(
    checkout,
    client,
    source,
    journal,
    authority,
    observe_ref,
    *,
    enabled=False,
    max_journal_bytes=None,
    max_entry_bytes=None,
    bounds=None,
    deadline=None,
    clock=None,
    forward_seed=None,
    _monotonic=monotonic,
) -> FollowRecoveryHandoff:
    """Validate transient intents, recover once, then recheck fresh named-ref authority.

    The trusted caller independently authenticates the accepted operation and each
    named-ref observation. No journal, matching Git identity or typed record proves
    that authority. Original observation time/generation are preserved. Use a
    dedicated, isolated process with the existing #501 outer process deadline.
    """
    if enabled is not True:
        return FollowRecoveryHandoff('disabled')
    checkpoint_status = 'not_attempted'
    try:
        selected = _authority(authority)
        rows = _journal(journal, selected, max_journal_bytes, max_entry_bytes)
        if rows[0][0] != source.commit:
            raise ValueError('journal predecessor differs from verified source')
        if (
            type(deadline) not in (int, float)
            or not isfinite(deadline)
            or not callable(clock)
            or not callable(_monotonic)
            or not callable(observe_ref)
        ):
            raise ValueError('execution ports required')
        _detached_environment()
        environment = {k: v for k, v in os.environ.items() if k.upper().startswith('GIT_')}

        def isolated():
            _detached_environment()
            if {k: v for k, v in os.environ.items() if k.upper().startswith('GIT_')} != environment:
                raise ValueError('detached Git environment changed')

        last_mono = float('-inf')
        last_utc = None
        last_observed = selected.observation.observed_at

        def check():
            nonlocal last_mono
            isolated()
            value = _monotonic()
            isolated()
            if (
                type(value) not in (int, float)
                or not isfinite(value)
                or value < last_mono
                or value >= deadline
            ):
                raise ValueError('handoff deadline')
            last_mono = value
            return value

        def now():
            nonlocal last_utc
            check()
            value = clock()
            check()
            if type(value) is not datetime:
                raise ValueError('UTC clock required')
            value = _utc(value)
            if last_utc is not None and value < last_utc:
                raise ValueError('UTC rollback')
            last_utc = value
            return value

        def observe():
            nonlocal last_observed
            check()
            value = observe_ref()
            check()
            if type(value) is not NamedFollowRef or type(value.observed_at) is not datetime:
                raise ValueError('named-ref evidence required')
            observed = _utc(value.observed_at)
            if (
                value.ref != 'refs/heads/data'
                or type(value.ref) is not str
                or type(value.commit) is not str
                or type(value.public_tree) is not str
                or (value.commit, value.public_tree)
                != (selected.observation.commit, selected.observation.public_tree)
                or not last_observed <= observed <= now()
            ):
                raise ValueError('named ref no longer admits publication')
            last_observed = observed

        observe()
        check()
        checkpoint_status = 'unknown'
        recovered = recover_detached_follow(
            checkout,
            client,
            source,
            selected,
            enabled=True,
            bounds=bounds,
            deadline=deadline,
            clock=now,
            forward_seed=forward_seed,
            _monotonic=check,
        )
        if (
            type(recovered) is not DetachedFollowRecovery
            or recovered.status not in ('promoted', 'already_promoted')
            or recovered.receipt is None
        ):
            return FollowRecoveryHandoff('held', checkpoint_status)
        # Preserve acknowledged mutation even if authority/deadline fails below.
        checkpoint_status = recovered.status
        check()
        observe()
        check()
        return FollowRecoveryHandoff('recovered', checkpoint_status, recovered.receipt)
    except Exception:
        # A held result never exposes an archive/publication receipt or retries.
        return FollowRecoveryHandoff('held', checkpoint_status)
