"""Qualify a hard GNU timeout around the real file-only Git publisher."""

from contextlib import suppress
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

import pytest

import test_ingest_data_writer as writer_fixture

pytestmark = pytest.mark.skipif(sys.platform != "linux", reason="requires Linux GNU timeout")
writer = writer_fixture.writer

HOOK = r'''
import json
import os
from pathlib import Path
import signal
import sys
import time

signal.signal(signal.SIGTERM, signal.SIG_IGN)
directory = Path(os.environ["FOLLOW_DEADLINE_FIXTURE"])
pid = os.getpid()
stat = Path("/proc/self/stat").read_text().rsplit(")", 1)[1].split()
old, new, ref = sys.stdin.read().split()
entry = dict(pid=pid, group=os.getpgrp(), started=stat[19], old=old, new=new, ref=ref)
with (directory / "calls").open("a", encoding="utf8") as calls:
    calls.write("receive hook entered\n")
receipt = directory / "entered.tmp"
receipt.write_text(json.dumps(entry), encoding="utf8")
receipt.replace(directory / "entered.json")
cleanup_limit = time.monotonic() + 15
while not (directory / "release").exists():
    if time.monotonic() >= cleanup_limit:
        raise SystemExit(70)
    time.sleep(0.02)
(directory / "late").write_text("receive hook resumed", encoding="utf8")
'''


@pytest.fixture
def repos(request):
    repos = writer_fixture.IngestWriterTests()
    request.addfinalizer(repos.doCleanups)
    repos.setUp()
    writer.prepare(repos.data, repos.primary, repos.state)
    repos.update_snapshot()
    return repos


def receive_entry(process, path):
    until = time.monotonic() + 8
    while not path.is_file():
        assert process.poll() is None, "publisher stopped before entering the receive hook"
        assert time.monotonic() < until, "receive hook did not enter"
        time.sleep(0.02)
    return json.loads(path.read_bytes())


def running(entry):
    try:
        fields = Path(f"/proc/{entry['pid']}/stat").read_text().rsplit(")", 1)[1].split()
    except (FileNotFoundError, ProcessLookupError):
        return False
    # A zombie cannot run any late hook code. The start tick prevents PID reuse from counting.
    return fields[19] == entry["started"] and fields[0] not in {"Z", "X"}


def fresh_tip(repos):
    output = writer.git(
        repos.root, "ls-remote", "--exit-code", "--heads", repos.remote.as_uri(), writer.BRANCH
    ).stdout
    tip, ref = output.decode("ascii").split()
    assert ref == writer.BRANCH
    return tip


@pytest.mark.parametrize("hook_name", ["pre-receive", "post-receive"])
def test_hard_deadline_stops_real_publish_and_leaves_observable_git_tip(repos, hook_name):
    timeout = shutil.which("timeout")
    assert timeout, "GNU timeout is required in the Linux test lane"
    version = subprocess.check_output([timeout, "--version"], text=True, timeout=5)
    assert "GNU coreutils" in version
    predecessor = fresh_tip(repos)
    hook = repos.remote / "hooks" / hook_name
    hook.write_text("#!/usr/bin/env python3\n" + HOOK, encoding="utf8")
    hook.chmod(0o755)
    env_keys = {
        "PATH",
        "GIT_ALLOW_PROTOCOL",
        "GIT_CONFIG_NOSYSTEM",
        "GIT_CONFIG_GLOBAL",
        "GIT_AUTHOR_NAME",
        "GIT_AUTHOR_EMAIL",
        "GIT_COMMITTER_NAME",
        "GIT_COMMITTER_EMAIL",
    }
    env = {key: value for key, value in os.environ.items() if key in env_keys}
    env["FOLLOW_DEADLINE_FIXTURE"] = str(repos.root)
    entry = None
    with subprocess.Popen(
        [
            timeout,
            "--signal=KILL",
            "4s",
            sys.executable,
            writer.__file__,
            "publish",
            str(repos.data),
            str(repos.state),
            "--message",
            "Synthetic deadline snapshot",
        ],
        cwd=repos.root,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    ) as process:
        try:
            entry = receive_entry(process, repos.root / "entered.json")
            assert entry["group"] == process.pid and running(entry)
            candidate = writer.revision(repos.data, "HEAD")
            assert (entry["old"], entry["new"], entry["ref"]) == (
                predecessor,
                candidate,
                writer.BRANCH,
            )
            assert candidate != predecessor
            assert writer.revision(repos.data, f"{candidate}^") == predecessor
            expected = predecessor if hook_name == "pre-receive" else candidate
            assert fresh_tip(repos) == expected
            assert process.poll() is None  # The publisher still awaits Git's result.

            stdout, _ = process.communicate(timeout=10)
            # Direct Popen reports the signal as negative; a shell reports 128 + SIGKILL.
            assert process.returncode == -signal.SIGKILL
            assert b"[ingest-data]" not in stdout
            until = time.monotonic() + 2
            while running(entry):
                assert time.monotonic() < until, "the receive hook survived the group deadline"
                time.sleep(0.02)
            (repos.root / "release").touch()
            assert not (repos.root / "late").exists()

            # Observe Git independently after the timeout. Neither case issues another push.
            observed = fresh_tip(repos)
            assert observed == expected
            assert writer.revision(repos.remote, f"{observed}:{writer.PUBLIC}") == writer.revision(
                repos.data, f"{expected}:{writer.PUBLIC}"
            )
            assert (repos.root / "calls").read_text(encoding="utf8").splitlines() == [
                "receive hook entered"
            ]
        finally:
            if process.poll() is None:
                with suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
            if entry is not None and running(entry):
                with suppress(ProcessLookupError):
                    os.kill(entry["pid"], signal.SIGKILL)
