from dataclasses import FrozenInstanceError, replace
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import sys
from types import MappingProxyType

import pytest

from internscout.follow_snapshot import FollowSnapshotBounds, FollowSnapshotCatalog
from internscout.follow_snapshot_archive import FollowArchiveBounds
from internscout.follow_writer_provenance import ExportIdentity, FirstSeenLineage, WriterProvenance

# Scripts are outside the installed backend package; pin this checkout even from CI backend cwd.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts import ingest_data_writer as git
from scripts.follow_archive_from_publication import plan_follow_archive_from_publication
from scripts.follow_checkpoint_client import FollowCheckpointLoad
from scripts.follow_checkpoint_promotion import AcceptedFollowObservation
from scripts.follow_checkpoint_writer import ForwardFollowSeed
from scripts.follow_detached_recovery import AcceptedFollowOperation, recover_detached_follow
from scripts.follow_lineage_checkpoint import AcceptedFollowSource, FollowCheckpointBounds
from scripts.follow_pending_checkpoint import (
    PendingFollowPredecessor,
    prepare_pending_follow_checkpoint,
)

NOW = datetime(2026, 11, 11, 18, tzinfo=timezone.utc)
LOWER = NOW - timedelta(hours=1)
BOUNDS = FollowCheckpointBounds(12_000, 5, 80_000, 10)
ARCHIVE = FollowArchiveBounds(
    FollowSnapshotBounds(20_000, 10, 2_000, 86_400_000), 3_600_000, 3_600_000, 4, 90_000
)
CATALOG = FollowSnapshotCatalog(frozenset({'fixture'}), frozenset({'swe'}), frozenset({'MA'}))


class Store:
    def __init__(self, payload):
        self.state = FollowCheckpointLoad('never_seeded', None, payload)
        self.calls = []
        self.after_load = lambda: None
        self.reply = 'promoted'

    def load(self):
        self.calls.append('load')
        self.after_load()
        return self.state

    def compare_and_set(self, change):
        self.calls.append('cas')
        self.state = FollowCheckpointLoad('active', change.payload, None)
        if isinstance(self.reply, Exception):
            raise self.reply
        return self.reply


@pytest.fixture
def sample(tmp_path, monkeypatch):
    for key in list(os.environ):
        if key.upper().startswith('GIT_'):
            monkeypatch.delenv(key)
    for k, v in {
        'GIT_ALLOW_PROTOCOL': 'file',
        'GIT_CONFIG_NOSYSTEM': '1',
        'GIT_NO_LAZY_FETCH': '1',
        'GIT_CONFIG_GLOBAL': os.devnull,
        'GIT_AUTHOR_NAME': 'Fixture',
        'GIT_COMMITTER_NAME': 'Fixture',
        'GIT_AUTHOR_EMAIL': 'fixture@example.invalid',
        'GIT_COMMITTER_EMAIL': 'fixture@example.invalid',
    }.items():
        monkeypatch.setenv(k, v)
    repo = tmp_path / 'candidate'
    git.git(tmp_path, 'init', str(repo))

    def output(rows, at):
        data = repo / 'docs/data'
        (data / 'listings').mkdir(parents=True, exist_ok=True)
        index = {
            'generated_at': at.isoformat(),
            'files': {
                'MA': {
                    'file': 'listings/MA.json',
                    'desc': 'listings/MA.desc.json',
                    'count': len(rows),
                    'open': sum(r['status'] == 'open' for r in rows),
                }
            },
            'first': {'file': 'first.json', 'rows': 0},
        }
        files = {
            'listings/index.json': index,
            'listings/MA.json': rows,
            'listings/MA.desc.json': {},
            'first.json': [],
            'majors.json': {},
            'seo-posting-details.json': {},
            'stats.json': {'generated_at': at.isoformat()},
        }
        for path, value in files.items():
            (data / path).write_text(json.dumps(value), encoding='utf8')
        git.git(repo, 'add', '--all')
        git.git(repo, 'commit', '-m', 'Synthetic export')
        raw = (data / 'listings/index.json').read_bytes()
        shards = {'listings/MA.json': (data / 'listings/MA.json').read_bytes()}
        return AcceptedFollowSource(
            git.revision(repo, 'HEAD'), git.revision(repo, 'HEAD:docs/data'), raw, shards
        )

    prior = output([], LOWER)
    first = NOW.replace(tzinfo=None).isoformat()
    rows = [
        {
            'id': format(i, '016x'),
            'company_name': 'Fixture',
            'title': 'Software Intern',
            'regions': [],
            'location_raw': 'Boston, MA',
            'state': 'MA',
            'apply_url': f'https://example.test/role/{i}',
            'status': status,
            'first_seen': first,
            'field_tags': ['swe'],
        }
        for i, status in [(1, 'open'), (2, 'closed')]
    ]
    current = output(rows, NOW)
    identity = ExportIdentity(
        sha256(current.index_bytes).hexdigest(),
        {'MA': sha256(current.shards['listings/MA.json']).hexdigest()},
    )
    evidence = FirstSeenLineage(first, verified_utc=NOW)
    proof = WriterProvenance(
        identity,
        NOW,
        LOWER,
        MappingProxyType({rows[0]['id']: evidence}),
        MappingProxyType({(r['id'], first): evidence for r in rows}),
    )
    tree = git.revision(repo, 'HEAD^{tree}')
    staged = git.validate_staged_follow_provenance(repo, tree, proof)
    predecessor = PendingFollowPredecessor(prior.commit, prior.public_tree, None)
    pending = prepare_pending_follow_checkpoint(
        repo,
        candidate=current.commit,
        staged=staged,
        provenance=proof,
        predecessor=predecessor,
        prepared_at=NOW,
        bounds=BOUNDS,
    )
    observed = AcceptedFollowObservation(current.commit, current.public_tree, NOW)
    authority = AcceptedFollowOperation(
        123, 1, 1, prior.commit, current.commit, sha256(pending).hexdigest(), observed
    )
    store = Store(pending)
    args = dict(
        enabled=True,
        bounds=BOUNDS,
        deadline=10,
        clock=lambda: NOW,
        forward_seed=ForwardFollowSeed(predecessor, LOWER, LOWER),
        _monotonic=lambda: 0,
    )
    return repo, store, prior, authority, args, staged


def run(sample, authority=None, **overrides):
    repo, store, source, exact, args, _ = sample
    return recover_detached_follow(
        repo, store, source, exact if authority is None else authority, **(args | overrides)
    )


def plan(receipt):
    return plan_follow_archive_from_publication(
        receipt,
        {},
        effective_lower=LOWER,
        now=NOW,
        bounds=ARCHIVE,
        catalog=CATALOG,
        max_source_bytes=80_000,
        max_source_rows=10,
    )


def test_cold_recovery_reconstructs_exact_receipt_and_archive(sample):
    repo, store, _, a, _, staged = sample
    original = git._bind_published_follow(repo, a.pending_candidate, a.observation.commit, staged)
    # Only persisted bytes survive into the new recovery session; no original staged object supplied.
    result = run(sample)
    assert result.status == 'promoted' and result.receipt == original
    assert plan(result.receipt) == plan(original) and plan(result.receipt) is not None
    assert store.calls == ['load', 'cas']
    assert json.loads(store.state.accepted)['accepted_at'] == NOW.isoformat(
        timespec='microseconds'
    ).replace('+00:00', 'Z')
    with pytest.raises(FrozenInstanceError):
        a.ordinal = 2


def test_real_merge_retry_requires_fresh_original_candidate_checkout(sample):
    repo, store, prior, a, _, _ = sample
    git.git(repo, 'switch', '-c', 'unrelated', prior.commit)
    (repo / 'unrelated.txt').write_text('independent update', encoding='utf8')
    git.git(repo, 'add', 'unrelated.txt')
    git.git(repo, 'commit', '-m', 'Remote unrelated update')
    remote = git.revision(repo, 'HEAD')
    git.git(repo, 'switch', '--detach', a.pending_candidate)
    git.git(repo, 'merge', '--no-edit', remote)
    accepted = git.revision(repo, 'HEAD')
    assert git.git(repo, 'show', '-s', '--format=%P', accepted).stdout.split() == [
        a.pending_candidate.encode(),
        remote.encode(),
    ]
    authority = replace(
        a,
        ordinal=2,
        expected_predecessor=remote,
        observation=replace(a.observation, commit=accepted),
    )
    # Even restoring the original index cannot qualify a retry HEAD. No repair
    # occurs in the adapter; a separate private original-candidate checkout is needed.
    git.git(repo, 'read-tree', a.pending_candidate)
    assert run(sample, authority).receipt is None and store.calls == ['load']
    recovery = repo.parent / 'recovery'
    git.git(repo, 'worktree', 'add', '--detach', str(recovery), a.pending_candidate)
    store.calls.clear()
    result = run((recovery, *sample[1:]), authority)
    assert result.status == 'promoted' and result.receipt.commit == accepted
    assert plan(result.receipt) is not None and store.calls == ['load', 'cas']
    assert git.revision(repo, 'HEAD') == accepted
    assert git.revision(recovery, 'HEAD') == a.pending_candidate


@pytest.mark.parametrize('authority', [False, {}, 'accepted', 1])
def test_missing_authority_never_reads_store(sample, authority):
    assert run(sample, authority).status == 'held'
    assert sample[1].calls == []


def test_disabled_never_inspects_arguments():
    assert recover_detached_follow(None, None, None, None).status == 'disabled'


@pytest.mark.parametrize(
    'field,value',
    [
        ('ordinal', 0),
        ('ordinal', 4),
        ('run_id', True),
        ('run_attempt', -1),
        ('pending_generation', 'bad'),
    ],
)
def test_malformed_authority_no_private_io(sample, field, value):
    assert run(sample, replace(sample[3], **{field: value})).status == 'held'
    assert sample[1].calls == []


@pytest.mark.parametrize(
    'field', ['pending_generation', 'pending_candidate', 'expected_predecessor']
)
def test_mismatched_authority_never_promotes(sample, field):
    a = replace(sample[3], **{field: 'a' * (64 if field == 'pending_generation' else 40)})
    result = run(sample, a)
    assert result.status == 'held' and result.receipt is None
    assert sample[1].calls == ['load']


def test_changed_index_never_promotes_or_plans(sample):
    repo = sample[0]
    (repo / 'docs/data/first.json').write_text('[{}]')
    git.git(repo, 'add', '--all')
    result = run(sample)
    assert result.status == 'held' and result.receipt is None
    assert sample[1].calls == ['load']


def test_expired_pending_and_future_observation_hold(sample):
    assert run(sample, clock=lambda: NOW + timedelta(days=1)).status == 'held'
    assert sample[1].calls == ['load']
    sample[1].calls.clear()
    a = replace(
        sample[3],
        observation=replace(sample[3].observation, observed_at=NOW + timedelta(seconds=1)),
    )
    assert run(sample, a).status == 'held' and sample[1].calls == []


@pytest.mark.parametrize('reply', [RuntimeError('lost acknowledgement'), 'stale', None])
def test_uncertain_or_stale_promotion_has_no_receipt_or_retry(sample, reply):
    sample[1].reply = reply
    result = run(sample)
    assert result.status == 'held' and result.receipt is None
    assert sample[1].calls == ['load', 'cas']


def test_post_commit_deadline_withholds_receipt(sample):
    ticks = [0]
    store = sample[1]
    original = store.compare_and_set

    def delayed(change):
        result = original(change)
        ticks[0] = 10
        return result

    store.compare_and_set = delayed
    result = run(sample, _monotonic=lambda: ticks[0])
    assert result.status == 'held' and result.receipt is None
    assert store.calls == ['load', 'cas'] and store.state.pending is None


def test_separate_process_uses_only_persisted_lineage_and_external_authority(sample):
    import subprocess
    import sys
    from pathlib import Path

    repo, store, source, a, _, _ = sample
    handoff = repo.parent / 'synthetic-handoff.json'
    handoff.write_text(
        json.dumps(
            {
                'repo': str(repo),
                'pending': store.state.pending.hex(),
                'source': [
                    source.commit,
                    source.public_tree,
                    source.index_bytes.hex(),
                    {k: v.hex() for k, v in source.shards.items()},
                ],
                'authority': [
                    a.run_id,
                    a.run_attempt,
                    a.ordinal,
                    a.expected_predecessor,
                    a.pending_candidate,
                    a.pending_generation,
                    a.observation.commit,
                    a.observation.public_tree,
                    a.observation.observed_at.isoformat(),
                ],
            }
        )
    )
    code = """
import json,sys
from datetime import datetime
from hashlib import sha256
from test_follow_detached_recovery import *
h = json.load(open(sys.argv[1]))
s = h['source']; a = h['authority']
source = AcceptedFollowSource(s[0], s[1], bytes.fromhex(s[2]), {k: bytes.fromhex(v) for k,v in s[3].items()})
operation = AcceptedFollowOperation(*a[:6], AcceptedFollowObservation(a[6],a[7],datetime.fromisoformat(a[8])))
seed = ForwardFollowSeed(PendingFollowPredecessor(s[0],s[1],None),LOWER,LOWER)
store = Store(bytes.fromhex(h['pending']))
r = recover_detached_follow(h['repo'],store,source,operation,enabled=True,bounds=BOUNDS,deadline=10,clock=lambda:NOW,forward_seed=seed,_monotonic=lambda:0)
p = plan(r.receipt)
assert r.status == 'promoted' and store.calls == ['load','cas'] and p is not None
print(json.dumps({k:sha256(v).hexdigest() for k,v in p.files.items()},sort_keys=True))
"""
    root = Path(__file__).resolve().parents[2]
    env = dict(
        os.environ,
        PYTHONPATH=os.pathsep.join(map(str, [root, root / 'backend', root / 'backend/tests'])),
        PYTHONDONTWRITEBYTECODE='1',
    )
    child = subprocess.run(
        [sys.executable, '-c', code, str(handoff)],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        check=True,
        timeout=20,
    )
    expected = plan(run(sample).receipt)
    assert json.loads(child.stdout) == {k: sha256(v).hexdigest() for k, v in expected.files.items()}


def test_replacement_public_facts_cannot_promote(sample):
    repo, store, _, a, _, _ = sample
    (repo / 'docs/data/first.json').write_text('[{}]')
    git.git(repo, 'add', '--all')
    altered_tree = git.git(repo, 'write-tree').stdout.decode().strip()
    altered = (
        git.git(
            repo,
            'commit-tree',
            altered_tree,
            '-p',
            a.pending_candidate,
            '-m',
            'Different accepted export',
        )
        .stdout.decode()
        .strip()
    )
    git.git(repo, 'read-tree', a.pending_candidate)
    changed = replace(
        a,
        expected_predecessor=a.pending_candidate,
        observation=replace(
            a.observation, commit=altered, public_tree=git.revision(repo, altered + ':docs/data')
        ),
    )
    assert run(sample, changed).receipt is None and store.calls == ['load']


def test_authority_snapshot_survives_caller_replacement_after_load(sample):
    a = sample[3]
    sample[1].after_load = lambda: object.__setattr__(a, 'pending_generation', 'a' * 64)
    assert run(sample).status == 'promoted'


def test_exact_already_promoted_receipt_is_accepted(sample):
    sample[1].reply = 'already_promoted'
    result = run(sample)
    assert result.status == 'already_promoted' and result.receipt is not None


def test_oversized_real_accepted_commit_is_rejected_before_body_read(sample, monkeypatch):
    import scripts.follow_detached_recovery as adapter

    repo, store, _, a, _, _ = sample
    message = repo.parent / 'oversized-commit-message'
    message.write_bytes(b'x' * (BOUNDS.max_source_bytes + 100))
    oversized = (
        git.git(
            repo,
            'commit-tree',
            git.revision(repo, 'HEAD^{tree}'),
            '-p',
            a.pending_candidate,
            '-F',
            str(message),
        )
        .stdout.decode()
        .strip()
    )
    assert int(git.git(repo, 'cat-file', '-s', oversized).stdout) > BOUNDS.max_source_bytes
    calls = []
    real = adapter._candidate_git

    def inspect(checkout):
        read = real(checkout)

        def command(*args):
            calls.append(args)
            return read(*args)

        return command

    monkeypatch.setattr(adapter, '_candidate_git', inspect)
    changed = replace(
        a,
        ordinal=2,
        expected_predecessor=a.pending_candidate,
        observation=replace(a.observation, commit=oversized),
    )
    result = run(sample, changed)
    assert result.status == 'held' and result.receipt is None and store.calls == ['load']
    assert ('cat-file', '-s', oversized) in calls
    assert ('cat-file', 'commit', oversized) not in calls


@pytest.mark.parametrize('cap', [-1, 0, True, 1.5])
def test_invalid_source_cap_reuses_writer_guard_before_private_io(sample, cap):
    result = run(sample, bounds=replace(BOUNDS, max_source_bytes=cap))
    assert result.status == 'held' and result.receipt is None and sample[1].calls == []


@pytest.mark.parametrize('command', ['-s', 'commit'])
def test_late_accepted_inspection_never_reaches_promotion(sample, monkeypatch, command):
    import scripts.follow_detached_recovery as adapter

    ticks = [0]
    real = adapter._candidate_git

    def delayed(checkout):
        read = real(checkout)

        def run_git(*args):
            result = read(*args)
            if args[:2] == ('cat-file', command):
                ticks[0] = 10
            return result

        return run_git

    monkeypatch.setattr(adapter, '_candidate_git', delayed)
    result = run(sample, _monotonic=lambda: ticks[0])
    assert result.status == 'held' and result.receipt is None
    assert sample[1].calls == ['load']


def test_ambient_index_cannot_hide_changed_native_index(sample, monkeypatch):
    from shutil import copyfile

    repo, store, _, a, _, _ = sample
    saved = repo.parent / 'saved-index'
    copyfile(repo / '.git/index', saved)
    (repo / 'docs/data/first.json').write_text('[{}]')
    git.git(repo, 'add', '--all')
    assert git.git(repo, 'write-tree').stdout.decode().strip() != git.revision(
        repo, a.pending_candidate + '^{tree}'
    )
    monkeypatch.setenv('GIT_INDEX_FILE', str(saved))
    result = run(sample)
    assert result.status == 'held' and result.receipt is None and store.calls == []


def test_process_overrides_and_missing_isolation_hold_before_private_io(sample, monkeypatch):
    for key in (
        'git_dir',
        'GIT_WORK_TREE',
        'GIT_OBJECT_DIRECTORY',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES',
        'GIT_GRAFT_FILE',
        'GIT_CONFIG_COUNT',
        'GIT_CONFIG_PARAMETERS',
        'GIT_REPLACE_REF_BASE',
    ):
        with monkeypatch.context() as env:
            env.setenv(key, 'override')
            assert run(sample).status == 'held' and sample[1].calls == []
    for key in (
        'GIT_CONFIG_GLOBAL',
        'GIT_CONFIG_NOSYSTEM',
        'GIT_NO_LAZY_FETCH',
        'GIT_ALLOW_PROTOCOL',
    ):
        with monkeypatch.context() as env:
            env.delenv(key)
            assert run(sample).status == 'held' and sample[1].calls == []


def test_override_injected_during_load_cannot_reach_binding(sample, monkeypatch):
    sample[1].after_load = lambda: monkeypatch.setenv('GIT_INDEX_FILE', 'untrusted')
    assert run(sample).receipt is None and sample[1].calls == ['load']


def test_annotated_tag_cannot_stand_in_for_accepted_commit(sample):
    repo, store, _, a, _, _ = sample
    git.git(repo, 'tag', '-a', 'accepted-tag', '-m', 'Synthetic tag')
    tag = git.revision(repo, 'refs/tags/accepted-tag')
    authority = replace(a, observation=replace(a.observation, commit=tag))
    result = run(sample, authority)
    assert result.status == 'held' and result.receipt is None and store.calls == ['load']


def test_original_submillisecond_observation_is_preserved(sample):
    instant = NOW + timedelta(microseconds=500)
    authority = replace(sample[3], observation=replace(sample[3].observation, observed_at=instant))
    result = run(sample, authority, clock=lambda: instant)
    assert result.status == 'promoted' and result.receipt is not None
    assert json.loads(sample[1].state.accepted)['accepted_at'] == instant.isoformat(
        timespec='microseconds'
    ).replace('+00:00', 'Z')


def test_out_of_position_parent_header_cannot_attest_expected_edge(sample):
    repo, store, _, a, _, _ = sample
    raw = git.git(repo, 'cat-file', 'commit', a.pending_candidate).stdout
    # Make a genuine child of the candidate, then insert a false predecessor after
    # the committer header. Git's graph does not recognize that late header.
    raw = raw.replace(
        ('parent ' + a.expected_predecessor).encode(), ('parent ' + a.pending_candidate).encode(), 1
    )
    raw = raw.replace(b'\n\n', ('\nparent ' + a.expected_predecessor + '\n\n').encode(), 1)
    path = repo.parent / 'malformed-commit'
    path.write_bytes(raw)
    malformed = (
        git.git(repo, 'hash-object', '-t', 'commit', '-w', '--literally', str(path))
        .stdout.decode()
        .strip()
    )
    assert git.git(repo, 'show', '-s', '--format=%P', malformed).stdout.split() == [
        a.pending_candidate.encode()
    ]
    authority = replace(a, ordinal=2, observation=replace(a.observation, commit=malformed))
    result = run(sample, authority)
    assert result.status == 'held' and result.receipt is None and store.calls == ['load']
