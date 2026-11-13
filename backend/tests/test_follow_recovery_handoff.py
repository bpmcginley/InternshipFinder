"""File-only Git and existing synthetic checkpoint tests, never a real provider."""

from dataclasses import replace
from datetime import timedelta
import json

import pytest

from test_follow_detached_recovery import NOW, git, plan, sample as sample
from scripts.follow_recovery_handoff import NamedFollowRef, recover_follow_handoff


def wire(rows):
    return json.dumps(rows, sort_keys=True, separators=(',', ':')).encode('ascii') + b'\n'


def intent(a, ordinal=1, predecessor=None, candidate=None):
    return {
        'run_id': a.run_id,
        'run_attempt': a.run_attempt,
        'ordinal': ordinal,
        'expected_predecessor': predecessor or a.expected_predecessor,
        'candidate_commit': candidate or a.pending_candidate,
        'public_tree': a.observation.public_tree,
    }


@pytest.fixture
def handoff(sample):
    repo, store, source, authority, options, _ = sample
    remote = repo.parent / 'accepted.git'
    git.git(repo.parent, 'init', '--bare', str(remote))
    git.git(repo, 'push', str(remote), f'{authority.observation.commit}:refs/heads/data')
    reads = []

    def observe():
        # Actual named-ref acquisition is fixture-only file transport. The fixture
        # supplies independent accepted-operation authority, not inferred from Git.
        raw = git.git(repo, 'ls-remote', '--heads', str(remote), 'refs/heads/data').stdout
        commit, ref = raw.decode('ascii').strip().split()
        reads.append(commit)
        return NamedFollowRef(ref, commit, git.revision(repo, f'{commit}:docs/data'), NOW)

    def run(*, rows=None, exact=authority, observed=observe, checkout=repo, **overrides):
        return recover_follow_handoff(
            checkout,
            store,
            source,
            wire([intent(authority)]) if rows is None else rows,
            exact,
            observed,
            **(options | {'max_journal_bytes': 4096, 'max_entry_bytes': 1024} | overrides),
        )

    return run, reads, remote, observe


def test_native_handoff_reuses_exact_recovery_and_archive_plan(sample, handoff):
    run, reads, _, _ = handoff
    result = run()
    assert result.status == 'recovered' and result.checkpoint_status == 'promoted'
    assert result.receipt.commit == sample[3].observation.commit
    assert plan(result.receipt) is not None
    assert reads == [sample[3].observation.commit] * 2
    assert sample[1].calls == ['load', 'cas']
    assert git.revision(sample[0], 'HEAD') == sample[3].pending_candidate


def test_disabled_does_not_inspect_inputs():
    assert recover_follow_handoff(None, None, None, None, None, None).status == 'disabled'


def test_matching_git_without_accepted_operation_is_not_authority(sample, handoff):
    result = handoff[0](exact=None)
    assert result.status == 'held' and result.checkpoint_status == 'not_attempted'
    assert handoff[1] == [] and sample[1].calls == []


def test_original_private_generation_remains_required(sample, handoff):
    result = handoff[0](exact=replace(sample[3], pending_generation='e' * 64))
    assert result.status == 'held' and result.receipt is None
    assert sample[1].calls == ['load']


def test_accepted_authority_is_copied_before_observer_can_mutate_caller_record(sample, handoff):
    run, _, _, observe = handoff

    def change():
        value = observe()
        object.__setattr__(sample[3], 'pending_generation', 'e' * 64)
        return value

    assert run(observed=change).status == 'recovered'
    assert sample[1].calls == ['load', 'cas']


@pytest.mark.parametrize(
    'mode',
    [
        'empty',
        'oversized',
        'duplicate-key',
        'escaped-key',
        'noncanonical',
        'wrong-run',
        'wrong-attempt',
        'gap',
        'duplicate-ordinal',
        'reordered',
        'bool',
        'extra',
        'wrong-tree',
        'wrong-predecessor',
        'candidate-reappears',
        'same-candidate-new-parent',
    ],
)
def test_invalid_journal_is_held_before_named_ref_or_store(sample, handoff, mode):
    run, reads, _, _ = handoff
    a = sample[3]
    rows = [intent(a)]
    if mode == 'empty':
        rows = []
    if mode == 'wrong-run':
        rows[0]['run_id'] += 1
    if mode == 'wrong-attempt':
        rows[0]['run_attempt'] += 1
    if mode == 'gap':
        rows[0]['ordinal'] = 2
    if mode == 'duplicate-ordinal':
        rows.append(intent(a))
    if mode == 'reordered':
        rows = [intent(a, 2), intent(a)]
    if mode == 'bool':
        rows[0]['ordinal'] = True
    if mode == 'extra':
        rows[0]['detail'] = 'not permitted'
    if mode == 'wrong-tree':
        rows[0]['public_tree'] = 'e' * 40
    if mode == 'wrong-predecessor':
        rows[0]['expected_predecessor'] = 'e' * 40
    if mode == 'candidate-reappears':
        rows = [intent(a), intent(a, 2, candidate='e' * 40), intent(a, 3)]
    if mode == 'same-candidate-new-parent':
        rows.append(intent(a, 2, predecessor='e' * 40))
    raw = wire(rows)
    if mode == 'oversized':
        raw = b' ' * 4097
    if mode == 'duplicate-key':
        raw = raw.replace(b'"ordinal":1', b'"ordinal":1,"ordinal":1')
    if mode == 'escaped-key':
        raw = raw.replace(b'"ordinal":1', b'"ordinal":1,"ordina\\u006c":1')
    if mode == 'noncanonical':
        raw = raw[:-1]
    result = run(rows=raw)
    assert result.status == 'held' and result.checkpoint_status == 'not_attempted'
    assert result.receipt is None and reads == [] and sample[1].calls == []


def test_same_identity_retry_ordinals_remain_bound_to_accepted_last_attempt(sample, handoff):
    run, reads, _, _ = handoff
    a = replace(sample[3], ordinal=2)
    result = run(rows=wire([intent(a), intent(a, 2)]), exact=a)
    assert result.status == 'recovered' and len(reads) == 2 and sample[1].calls == ['load', 'cas']


def test_real_two_parent_retry_is_observed_from_original_private_candidate(sample, handoff):
    run, reads, remote, observe = handoff
    repo, store, prior, a, _, _ = sample
    git.git(repo, 'switch', '-c', 'unrelated', prior.commit)
    (repo / 'unrelated.txt').write_text('Synthetic update', encoding='utf8')
    git.git(repo, 'add', 'unrelated.txt')
    git.git(repo, 'commit', '-m', 'Unrelated fixture')
    predecessor = git.revision(repo, 'HEAD')
    git.git(repo, 'switch', '--detach', a.pending_candidate)
    git.git(repo, 'merge', '--no-edit', predecessor)
    accepted = git.revision(repo, 'HEAD')
    git.git(repo, 'push', str(remote), f'{accepted}:refs/heads/data')
    recovery = repo.parent / 'private-recovery'
    git.git(repo, 'worktree', 'add', '--detach', str(recovery), a.pending_candidate)
    exact = replace(
        a,
        ordinal=2,
        expected_predecessor=predecessor,
        observation=replace(a.observation, commit=accepted),
    )
    rows = [intent(a), intent(exact, 2, candidate=accepted)]
    result = run(rows=wire(rows), exact=exact, checkout=recovery, observed=observe)
    assert result.status == 'recovered' and result.receipt.commit == accepted
    assert reads == [accepted, accepted] and store.calls == ['load', 'cas']
    assert git.revision(recovery, 'HEAD') == a.pending_candidate


@pytest.mark.parametrize('mode', ['commit', 'tree', 'ref', 'old-time', 'future-time', 'raise'])
def test_unqualified_initial_named_ref_never_reads_private_store(sample, handoff, mode):
    run, _, _, observe = handoff

    def changed():
        value = observe()
        if mode == 'raise':
            raise OSError('Synthetic private error')
        field, replacement = {
            'commit': ('commit', 'e' * 40),
            'tree': ('public_tree', 'e' * 40),
            'ref': ('ref', 'refs/heads/other'),
            'old-time': ('observed_at', NOW - timedelta(microseconds=1)),
            'future-time': ('observed_at', NOW + timedelta(microseconds=1)),
        }[mode]
        return replace(value, **{field: replacement})

    result = run(observed=changed)
    assert result.status == 'held' and result.checkpoint_status == 'not_attempted'
    assert result.receipt is None and sample[1].calls == []


def test_final_native_ref_change_withholds_receipt_but_reports_acknowledged_promotion(
    sample, handoff
):
    run, reads, remote, observe = handoff
    repo, store, _, a, _, _ = sample

    def changed():
        if reads:
            new = (
                git.git(
                    repo,
                    'commit-tree',
                    git.revision(repo, 'HEAD^{tree}'),
                    '-p',
                    a.observation.commit,
                    '-m',
                    'Superseding fixture',
                )
                .stdout.decode()
                .strip()
            )
            git.git(repo, 'push', str(remote), f'{new}:refs/heads/data')
        return observe()

    result = run(observed=changed)
    assert (
        result.status == 'held'
        and result.checkpoint_status == 'promoted'
        and result.receipt is None
    )
    assert store.state.accepted is not None and store.calls == ['load', 'cas'] and len(reads) == 2


def test_lost_promotion_acknowledgement_is_unknown_without_ref_retry(sample, handoff):
    sample[1].reply = OSError('Synthetic uncertain commit')
    result = handoff[0]()
    assert (
        result.status == 'held' and result.checkpoint_status == 'unknown' and result.receipt is None
    )
    assert sample[1].state.accepted is not None and sample[1].calls == ['load', 'cas']
    assert len(handoff[1]) == 1


def test_exact_acknowledged_replay_preserves_original_time_and_generation(sample, handoff):
    sample[1].reply = 'already_promoted'
    original = sample[3]
    result = handoff[0]()
    assert result.status == 'recovered' and result.checkpoint_status == 'already_promoted'
    assert original == sample[3]
    assert json.loads(sample[1].state.accepted)['accepted_at'] == NOW.isoformat(
        timespec='microseconds'
    ).replace('+00:00', 'Z')


def test_submillisecond_original_observation_is_not_replaced_by_fresh_ref_time(sample, handoff):
    run, _, _, observe = handoff
    original = NOW + timedelta(microseconds=500)
    fresh = NOW + timedelta(seconds=1)
    authority = replace(sample[3], observation=replace(sample[3].observation, observed_at=original))
    result = run(
        exact=authority, observed=lambda: replace(observe(), observed_at=fresh), clock=lambda: fresh
    )
    assert result.status == 'recovered'
    assert json.loads(sample[1].state.accepted)['accepted_at'] == original.isoformat(
        timespec='microseconds'
    ).replace('+00:00', 'Z')


def test_exact_wire_and_entry_caps_remain_sufficient(sample, handoff):
    row = intent(sample[3])
    raw = wire([row])
    size = len(json.dumps(row, sort_keys=True, separators=(',', ':')).encode('ascii'))
    result = handoff[0](rows=raw, max_journal_bytes=len(raw), max_entry_bytes=size)
    assert result.status == 'recovered'


def test_deadline_after_final_observation_withholds_receipt_without_reset(sample, handoff):
    run, reads, _, observe = handoff
    elapsed = [0]

    def late():
        value = observe()
        if len(reads) == 2:
            elapsed[0] = 10
        return value

    result = run(observed=late, _monotonic=lambda: elapsed[0])
    assert (
        result.status == 'held'
        and result.checkpoint_status == 'promoted'
        and result.receipt is None
    )
    assert sample[1].calls == ['load', 'cas']


@pytest.mark.parametrize(
    'bounds',
    [
        {'max_journal_bytes': 0},
        {'max_entry_bytes': True},
        {'max_entry_bytes': 10},
        {'max_journal_bytes': 4097},
    ],
)
def test_strict_wire_bounds_precede_observation(sample, handoff, bounds):
    result = handoff[0](**bounds)
    assert result.status == 'held' and sample[1].calls == [] and handoff[1] == []


def test_prohibited_initial_git_environment_prevents_first_native_observer(
    sample, handoff, monkeypatch
):
    monkeypatch.setenv('GIT_INDEX_FILE', str(sample[0].parent / 'untrusted-index'))
    result = handoff[0]()
    assert result.status == 'held' and result.checkpoint_status == 'not_attempted'
    assert result.receipt is None and handoff[1] == [] and sample[1].calls == []


@pytest.mark.parametrize(
    'key,value',
    [
        ('GIT_INDEX_FILE', 'synthetic-invalid-index'),
        ('GIT_AUTHOR_NAME', 'Changed fixture identity'),
    ],
)
def test_cas_environment_change_holds_unknown_before_final_observer(
    sample, handoff, monkeypatch, key, value
):
    store = sample[1]
    original = store.compare_and_set

    def changed(change):
        result = original(change)
        monkeypatch.setenv(key, value)
        return result

    store.compare_and_set = changed
    result = handoff[0]()
    assert (
        result.status == 'held' and result.checkpoint_status == 'unknown' and result.receipt is None
    )
    assert store.calls == ['load', 'cas'] and store.state.accepted is not None
    assert len(handoff[1]) == 1


@pytest.mark.parametrize('phase', ['first', 'final'])
def test_observer_environment_change_withholds_receipt_after_native_read(
    sample, handoff, monkeypatch, phase
):
    run, reads, _, observe = handoff

    def changed():
        result = observe()
        if len(reads) == (1 if phase == 'first' else 2):
            monkeypatch.setenv('GIT_AUTHOR_NAME', 'Changed fixture identity')
        return result

    result = run(observed=changed)
    assert result.status == 'held' and result.receipt is None
    if phase == 'first':
        assert result.checkpoint_status == 'not_attempted' and sample[1].calls == []
    else:
        assert result.checkpoint_status == 'promoted' and sample[1].calls == ['load', 'cas']


@pytest.mark.parametrize('port', ['clock', '_monotonic'])
def test_clock_environment_change_stops_before_further_authority_work(
    sample, handoff, monkeypatch, port
):
    def changed():
        monkeypatch.setenv('GIT_INDEX_FILE', 'synthetic-invalid-index')
        return NOW if port == 'clock' else 0

    result = handoff[0](**{port: changed})
    assert (
        result.status == 'held'
        and result.checkpoint_status == 'not_attempted'
        and result.receipt is None
    )
    assert sample[1].calls == []
    assert len(handoff[1]) == (1 if port == 'clock' else 0)
