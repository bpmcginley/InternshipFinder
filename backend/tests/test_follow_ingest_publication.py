"""Synthetic SQLite ingestion and file-only Git for the dormant publication seam."""

from dataclasses import replace
from datetime import timedelta
import json
import os
from pathlib import Path
import socket
import subprocess
import sys

import pytest

from internscout import export_static, pipeline, run_ingest
from scripts import ingest_data_writer as git
from scripts import follow_ingest_publication as publication
from scripts.follow_checkpoint_client import FollowCheckpointLoad
from scripts.follow_checkpoint_promotion import AcceptedFollowObservation, BoundFollowAcceptance
from scripts.follow_checkpoint_writer import FollowCheckpointWriter, FollowWriterCheckpointError
from scripts.follow_ingest_publication import FollowPublication, ingest_and_publish
from test_follow_checkpoint_writer import Store
from test_follow_lineage_checkpoint import accepted, encoded
from test_follow_writer_provenance import NOW, FrozenDateTime, database, raw


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    def deny(*args, **kwargs):
        raise AssertionError('Network forbidden')

    monkeypatch.setattr(socket, 'socket', deny)
    monkeypatch.setattr(socket, 'create_connection', deny)
    monkeypatch.setenv('GIT_ALLOW_PROTOCOL', 'file')
    monkeypatch.setenv('GIT_CONFIG_NOSYSTEM', '1')
    monkeypatch.setattr(run_ingest, 'save_cache', lambda: None)


@pytest.fixture
def attempt(accepted, tmp_path, monkeypatch):
    codec, receipt, proof, source, bounds, directory, listing = accepted
    repo = directory.parent.parent
    monkeypatch.setattr(publication, 'DATA_DIR', str(tmp_path / 'state'))
    now = NOW + timedelta(hours=1)

    class Later(FrozenDateTime):
        @classmethod
        def now(cls, tz=None):
            return now if tz is not None else now.replace(tzinfo=None)

    for module in (pipeline, export_static):
        monkeypatch.setattr(module, 'datetime', Later)
    fixture = tmp_path / 'roles.json'
    fixture.write_text(
        json.dumps(
            [
                listing | {'active': False},
                raw('Fixture Open', 'open'),
                raw('Fresh Synthetic', 'new'),
            ]
        ),
        encoding='utf8',
    )
    store = Store(FollowCheckpointLoad('active', encoded(accepted), None))
    elapsed = [0]

    def writer(checkout=repo):
        return FollowCheckpointWriter(
            checkout,
            store,
            bounds=bounds,
            deadline=10,
            clock=lambda: now,
            _monotonic=lambda: elapsed[0],
        )

    def observe(checkout=repo):
        tip = git.remote_tip(checkout)
        return AcceptedFollowObservation(tip, git.revision(checkout, f'{tip}:docs/data'), now)

    context = FollowPublication(writer(), source, observe(), observe, bounds)
    args = ['--fixture', str(fixture), '--metrics', str(tmp_path / 'metrics.json')]
    return (
        repo,
        tmp_path / 'state',
        codec,
        source,
        bounds,
        store,
        context,
        args,
        writer,
        observe,
        elapsed,
    )


def cold_recover(repo, context, store, writer, observe, tmp_path):
    remote = git.git(repo, 'remote', 'get-url', 'origin').stdout.decode().strip()
    cold = tmp_path / 'cold'
    git.git(tmp_path, 'clone', '--branch', 'data', remote, str(cold))
    restarted = writer(cold)
    verified = restarted.load(context.source, observe(cold))

    def bind(exact, observation):
        staged = git.validate_staged_follow_provenance(cold, exact.candidate_tree, exact.provenance)
        return BoundFollowAcceptance(
            exact.candidate_commit,
            git._bind_published_follow(
                cold,
                exact.candidate_commit,
                observation.commit,
                staged,
            ),
        )

    return restarted.recover(verified, bind_accepted=bind)


@pytest.mark.parametrize(
    'fault', ['none', 'push_ack', 'stage_ack', 'cas_ack', 'crash', 'late_stage', 'unrelated']
)
def test_actual_ingest_stage_push_and_recovery(attempt, tmp_path, monkeypatch, fault):
    repo, state, codec, source, bounds, store, context, args, writer, observe, elapsed = attempt
    before = store.state.accepted
    pushes = []
    stage = store.stage

    def checked_stage(payload):
        assert git.remote_tip(repo) == source.commit
        assert git.revision(repo, 'HEAD') != source.commit
        result = stage(payload)
        if fault == 'stage_ack':
            raise OSError('Synthetic lost stage reply')
        if fault == 'late_stage':
            elapsed[0] = 10
        return result

    monkeypatch.setattr(store, 'stage', checked_stage)
    push = git.push_existing

    def checked_push(checkout, expected):
        assert store.calls.count('stage') == 1 and store.state.pending is not None
        pushes.append(git.revision(checkout, 'HEAD'))
        if fault == 'unrelated' and len(pushes) == 1:
            other = tmp_path / 'other'
            remote = git.git(repo, 'remote', 'get-url', 'origin').stdout.decode().strip()
            git.git(tmp_path, 'clone', '--branch', 'data', remote, str(other))
            (other / 'unrelated.txt').write_text('Synthetic unrelated update', encoding='utf8')
            git.git(other, 'add', 'unrelated.txt')
            git.git(other, 'commit', '-m', 'Synthetic unrelated update')
            git.git(other, 'push', 'origin', 'HEAD:refs/heads/data')
            assert not push(checkout, expected)
            return False
        assert push(checkout, expected)
        if fault == 'crash':
            raise OSError('Synthetic process interruption')
        return fault != 'push_ack'

    monkeypatch.setattr(git, 'push_existing', checked_push)
    if fault == 'cas_ack':
        store.after_cas = lambda: (_ for _ in ()).throw(OSError('Synthetic lost CAS reply'))
    if fault == 'crash':
        with pytest.raises(OSError, match='process interruption'):
            ingest_and_publish(repo, state, 'Synthetic refresh', ingest_args=args, follow=context)
        assert cold_recover(repo, context, store, writer, observe, tmp_path) == 'promoted'
    else:
        result = ingest_and_publish(
            repo, state, 'Synthetic refresh', ingest_args=args, follow=context
        )
        assert result.publication[1] == git.remote_tip(repo)
        assert result.follow == ('held' if fault in ('cas_ack', 'late_stage') else 'promoted')
    assert len(pushes) == (2 if fault == 'unrelated' else 1)
    if fault == 'late_stage':
        assert store.state.accepted == before and 'cas' not in store.calls
        elapsed[0] = 0  # A fresh execution, not reuse of the expired writer.
        assert cold_recover(repo, context, store, writer, observe, tmp_path) == 'promoted'
    assert store.calls.count('stage') == store.calls.count('cas') == 1
    tip = observe()
    index = git.git(repo, 'cat-file', 'blob', f'{tip.commit}:docs/data/listings/index.json').stdout
    shards = {
        v['file']: git.git(repo, 'cat-file', 'blob', f"{tip.commit}:docs/data/{v['file']}").stdout
        for v in json.loads(index)['files'].values()
    }
    current = codec.AcceptedFollowSource(tip.commit, tip.public_tree, index, shards)
    prior = codec.decode_accepted_follow_checkpoint(before, source, now=NOW, bounds=bounds)
    restored = writer().load(current, tip)
    assert restored.pending is None
    assert restored.accepted.covers_after == prior.covers_after
    assert all(restored.accepted.lineage[key] == value for key, value in prior.lineage.items())
    if fault == 'none':
        second = replace(context, writer=writer(), source=current, observation=tip)
        monkeypatch.setattr(git, 'push_existing', lambda *_: pytest.fail('No-op pushed'))
        noop = ingest_and_publish(
            repo, state, 'Same synthetic output', ingest_args=args, follow=second
        )
        assert noop.publication == ('No changes.', tip.commit)
        assert noop.follow == 'no_publication'
        assert store.calls.count('stage') == store.calls.count('cas') == 1
    for blob in [index, *shards.values()]:
        assert b'verified_utc' not in blob and b'covers_after' not in blob


@pytest.mark.parametrize('fault', ['unavailable', 'disabled', 'stale_observation'])
def test_ordinary_publication_and_follow_hold_are_independent(attempt, fault):
    repo, state, _, source, _, store, context, args, *_ = attempt
    initial = store.state.accepted
    if fault == 'unavailable':
        store.state = FollowCheckpointLoad('unavailable', None, None)
    elif fault == 'disabled':
        context = None
    else:
        context = replace(context, observe=lambda: context.observation)
    result = ingest_and_publish(repo, state, 'Synthetic refresh', ingest_args=args, follow=context)
    assert result.publication[1] != source.commit
    assert result.follow == ('disabled' if fault == 'disabled' else 'held')
    assert 'cas' not in store.calls
    if fault == 'disabled':
        assert store.calls == [] and store.state.accepted == initial
    elif fault == 'unavailable':
        assert store.calls == ['load']
    else:
        assert store.state.accepted == initial and store.state.pending is not None


def test_noop_never_invokes_stage_or_push(accepted, tmp_path, monkeypatch):
    _, _, proof, source, _, directory, _ = accepted

    def forbidden(*args, **kwargs):
        pytest.fail('No-op must not stage or push')

    monkeypatch.setattr(git, 'push_existing', forbidden)
    result, receipt = git.publish_with_follow_provenance(
        directory.parent.parent,
        tmp_path / 'state',
        'No-op',
        proof,
        before_first_push=forbidden,
    )
    assert result == ('No changes.', source.commit) and receipt is None


def test_destination_override_rejected_before_ingest(attempt):
    repo, state, _, _, _, store, context, args, *_ = attempt
    for extra in (['--export', 'other'], ['--export=other']):
        with pytest.raises(ValueError, match='export destination'):
            ingest_and_publish(repo, state, 'No-op', ingest_args=args + extra, follow=context)
    assert store.calls == []


def test_explicit_forward_seed_uses_exact_source(attempt):
    from scripts.follow_checkpoint_writer import ForwardFollowSeed
    from scripts.follow_pending_checkpoint import PendingFollowPredecessor

    repo, state, _, source, _, store, context, args, *_ = attempt
    store.state = FollowCheckpointLoad('never_seeded', None, None)
    seed = ForwardFollowSeed(
        PendingFollowPredecessor(source.commit, source.public_tree, None),
        NOW,
        NOW,
    )
    context = replace(context, forward_seed=seed)
    result = ingest_and_publish(
        repo, state, 'Synthetic seeded run', ingest_args=args, follow=context
    )
    assert result.follow == 'promoted'
    assert store.calls.count('stage') == store.calls.count('cas') == 1


@pytest.mark.parametrize('fault', ['different', 'missing', 'symlink'])
def test_wrong_state_stops_before_checkpoint_and_ingest(attempt, tmp_path, monkeypatch, fault):
    repo, state, _, _, _, store, context, args, *_ = attempt
    wrong = tmp_path / 'wrong-state'
    if fault == 'different':
        wrong.mkdir()
    elif fault == 'missing':
        state.rmdir()
        wrong = state
    else:
        try:
            wrong.symlink_to(state, target_is_directory=True)
        except OSError:
            pytest.skip('Creating a directory symlink requires local privileges')
        monkeypatch.setattr(publication, 'DATA_DIR', str(wrong))
    monkeypatch.setattr(run_ingest, 'main', lambda *_a, **_k: pytest.fail('Ingest started'))
    with pytest.raises(ValueError, match='configured ingestion state'):
        ingest_and_publish(repo, wrong, 'Rejected', ingest_args=args, follow=context)
    assert store.calls == []
    assert not (wrong / 'ats_registry.json').exists()


def test_import_bound_state_rejects_empty_wrong_directory_and_preserves_caches(accepted, tmp_path):
    _, _, _, _, _, directory, _ = accepted
    repo = directory.parent.parent
    configured, wrong = tmp_path / 'configured-state', tmp_path / 'empty-wrong-state'
    configured.mkdir()
    wrong.mkdir()
    snapshots = {}
    for path in git.STATE:
        body = json.dumps({'synthetic_cache': Path(path).name}).encode()
        target = repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
        (configured / target.name).write_bytes(body)
        snapshots[path] = body
    git.git(repo, 'add', '--', 'backend/data')
    git.git(repo, 'commit', '-m', 'Synthetic tracked caches')
    git.git(repo, 'push', 'origin', 'HEAD:refs/heads/data')
    before = git.remote_tip(repo)
    fixture = tmp_path / 'fresh.json'
    fixture.write_text(json.dumps([raw('Synthetic Fresh', 'fresh')]), encoding='utf8')
    child = r"""
import os, socket, sys
from pathlib import Path
from internscout import config, discover, geo, probe
from internscout.sources import google_jobs
from scripts.follow_ingest_publication import ingest_and_publish
repo, configured, wrong, fixture, metrics, mode = map(Path, sys.argv[1:])
socket.socket = lambda *a, **k: (_ for _ in ()).throw(AssertionError('No network'))
socket.create_connection = socket.socket
assert Path(config.DATA_DIR).resolve() == configured.resolve()
for path in [discover.REGISTRY_PATH, discover.DROPPED_PATH, geo.CACHE_PATH,
             probe.CACHE_PATH, google_jobs.DAY_PATH]:
    assert Path(path).parent.resolve() == configured.resolve()
# Environment changes after imports must not rebind the already loaded writers.
os.environ['INTERNSCOUT_DATA'] = str(wrong)
args = ['--fixture', str(fixture), '--metrics', str(metrics)]
if str(mode) == 'reject':
    try:
        ingest_and_publish(repo, wrong, 'Must reject', ingest_args=args)
    except ValueError as error:
        assert 'configured ingestion state' in str(error)
    else:
        raise AssertionError('Mismatched state accepted')
else:
    result = ingest_and_publish(repo, configured / '..' / configured.name, 'Synthetic valid state', ingest_args=args)
    assert result.follow == 'disabled'
"""
    database_path = tmp_path / 'child.db'
    root = Path(__file__).resolve().parents[2]
    env = {
        **os.environ,
        'PYTHONPATH': os.pathsep.join([str(root), str(root / 'backend')]),
        'INTERNSCOUT_DATA': str(configured),
        'INTERNSCOUT_DB': database_path.as_posix(),
        'GIT_ALLOW_PROTOCOL': 'file',
    }
    for mode in ('reject', 'allow'):
        result = subprocess.run(
            [
                sys.executable,
                '-c',
                child,
                str(repo),
                str(configured),
                str(wrong),
                str(fixture),
                str(tmp_path / 'child-metrics.json'),
                mode,
            ],
            cwd=root,
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        if mode == 'reject':
            assert result.stdout == '' and not database_path.exists()
            assert git.remote_tip(repo) == before
        else:
            assert git.remote_tip(repo) != before
        for path, body in snapshots.items():
            assert (repo / path).read_bytes() == body
            assert (configured / Path(path).name).read_bytes() == body
            assert git.git(repo, 'cat-file', 'blob', f'origin/data:{path}').stdout == body
        assert list(wrong.iterdir()) == []
