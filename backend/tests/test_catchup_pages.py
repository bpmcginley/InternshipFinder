"""Offline verification of the bot-only ingest to Pages receipt handoff."""

from pathlib import Path
import runpy

import pytest

ROOT = Path(__file__).resolve().parents[2]
catchup = runpy.run_path(str(ROOT / "scripts/catchup_pages.py"))
selector = runpy.run_path(str(ROOT / ".github/actions/public-data/listing_data.py"))
REPO = "synthetic/example"
COMMIT = "a" * 40
TREE = "b" * 40
WRITER_SHA = "c" * 40
RECEIPT = {"run_id": 37, "run_attempt": 2, "commit": COMMIT, "tree": TREE}
ARTIFACT = 111
BOT = "github-actions[bot]"


def context(event):
    return {
        "GITHUB_EVENT_NAME": event,
        "GITHUB_REF": "refs/heads/main",
        "GITHUB_ACTOR": BOT,
        "GITHUB_TRIGGERING_ACTOR": BOT,
        "GITHUB_REPOSITORY": REPO,
    }


def writer():
    return context("workflow_dispatch") | {
        "CATCHUP_FORCE": "false",
        "GITHUB_RUN_ID": "37",
        "GITHUB_RUN_ATTEMPT": "2",
        "DATA_COMMIT": COMMIT,
        "DATA_TREE": TREE,
        "CATCHUP_ARTIFACT_ID": "111",
    }


def event():
    return {
        "action": catchup["EVENT"],
        "repository": {"full_name": REPO},
        "sender": {"login": BOT, "type": "Bot"},
        "client_payload": RECEIPT | {"artifact_id": ARTIFACT},
    }


def run_attempt(**changes):
    return {
        "id": 37,
        "run_attempt": 2,
        "path": catchup["INGEST"],
        "event": "workflow_dispatch",
        "head_branch": "main",
        "head_sha": WRITER_SHA,
        "repository": {"full_name": REPO},
        "head_repository": {"full_name": REPO},
        "actor": {"login": BOT},
        "triggering_actor": {"login": BOT},
        "status": "completed",
        "conclusion": "success",
    } | changes


def artifact(**changes):
    return {
        "id": ARTIFACT,
        "name": "catchup-publication-37-2",
        "expired": False,
        "size_in_bytes": 400,
        "workflow_run": {"id": 37, "head_sha": WRITER_SHA},
    } | changes


def test_exact_publication_receipt_and_payload(tmp_path):
    receipt = catchup["writer_receipt"](writer())
    assert receipt == RECEIPT
    assert catchup["artifact_name"](receipt) == "catchup-publication-37-2"
    path = tmp_path / "receipt.json"
    path.write_bytes(catchup["receipt_bytes"](receipt))
    assert catchup["read_receipt"](path) == receipt
    assert catchup["dispatch_payload"](writer(), receipt) == {
        "event_type": catchup["EVENT"],
        "client_payload": event()["client_payload"],
    }
    assert catchup["event_publication"](context("repository_dispatch"), event()) == (
        receipt,
        ARTIFACT,
    )
    for raw in (path.read_bytes() + b"\n", b" " * 1025, b'{"run_id":37,"run_id":37}'):
        path.write_bytes(raw)
        with pytest.raises(ValueError):
            catchup["read_receipt"](path)


@pytest.mark.parametrize(
    "changes",
    [
        {"GITHUB_EVENT_NAME": "schedule"},
        {"GITHUB_EVENT_NAME": "push"},
        {"CATCHUP_FORCE": "true"},
        {"GITHUB_ACTOR": "human"},
        {"GITHUB_TRIGGERING_ACTOR": "human"},
        {"GITHUB_REF": "refs/heads/topic"},
        {"DATA_COMMIT": ""},
        {"DATA_TREE": "wrong"},
        {"GITHUB_RUN_ATTEMPT": "0"},
    ],
)
def test_ordinary_or_failed_sender_cannot_create_receipt(changes):
    with pytest.raises(ValueError):
        catchup["writer_receipt"](writer() | changes)


@pytest.mark.parametrize(
    "changes",
    [
        {"repository": {"full_name": "other/repo"}},
        {"action": "other"},
        {"sender": {"login": "human", "type": "User"}},
        {"client_payload": RECEIPT | {"artifact_id": True}},
        {"client_payload": RECEIPT | {"artifact_id": ARTIFACT, "run_id": "37"}},
        {"client_payload": RECEIPT | {"artifact_id": ARTIFACT, "extra": "no"}},
    ],
)
def test_receiver_refuses_unbound_event(changes):
    with pytest.raises(ValueError):
        catchup["event_publication"](context("repository_dispatch"), event() | changes)


def test_waits_for_exact_completed_attempt_before_receipt_artifact_lookup():
    responses = iter(
        [run_attempt(status="in_progress", conclusion=None), run_attempt(), artifact()]
    )
    calls = []
    slept = []

    def get(path, *, timeout):
        calls.append(path)
        assert 0 < timeout <= 10
        return next(responses)

    assert (
        catchup["verified_artifact"](REPO, RECEIPT, ARTIFACT, get=get, sleep=slept.append)
        == ARTIFACT
    )
    assert calls == [f"repos/{REPO}/actions/runs/37/attempts/2"] * 2 + [
        f"repos/{REPO}/actions/artifacts/111"
    ]
    assert slept == [3]


@pytest.mark.parametrize(
    "changes",
    [
        {"run_attempt": 1},
        {"event": "schedule"},
        {"head_branch": "other"},
        {"path": ".github/workflows/catchup.yml"},
        {"conclusion": "failure"},
        {"triggering_actor": {"login": "human"}},
        {"head_repository": {"full_name": "other/repo"}},
    ],
)
def test_wrong_attempt_never_reads_artifact(changes):
    calls = []

    def get(path, **_):
        calls.append(path)
        return run_attempt(**changes)

    with pytest.raises(ValueError):
        catchup["verified_artifact"](REPO, RECEIPT, ARTIFACT, get=get)
    assert len(calls) == 1


@pytest.mark.parametrize(
    "changes",
    [
        {"name": "catchup-publication-37-1"},
        {"expired": True},
        {"size_in_bytes": 17000},
        {"workflow_run": {"id": 38, "head_sha": WRITER_SHA}},
        {"workflow_run": {"id": 37, "head_sha": "d" * 40}},
    ],
)
def test_wrong_attempt_artifact_is_not_accepted(changes):
    responses = iter([run_attempt(), artifact(**changes)])
    with pytest.raises(ValueError):
        catchup["verified_artifact"](REPO, RECEIPT, ARTIFACT, get=lambda *_, **__: next(responses))


def test_wait_expires_without_accepting_an_incomplete_writer():
    now = [0]
    with pytest.raises(ValueError):
        catchup["verified_artifact"](
            REPO,
            RECEIPT,
            ARTIFACT,
            get=lambda *_, **__: run_attempt(status="in_progress"),
            clock=lambda: now[0],
            sleep=lambda delay: now.__setitem__(0, now[0] + delay),
        )
    assert now[0] == catchup["WAIT_SECONDS"]


def test_catchup_data_ref_cannot_fall_back_or_advance():
    env = context("repository_dispatch") | {
        "CATCHUP_COMMIT": COMMIT,
        "CATCHUP_TREE": TREE,
        "CATCHUP_UPSTREAM_RUN": "37",
    }
    pin = selector["catchup_pin"](env)
    assert pin == (COMMIT, TREE, "37")
    selector["require_catchup_tip"](COMMIT, pin)
    for current in ("", "c" * 40):
        with pytest.raises(SystemExit, match="no longer"):
            selector["require_catchup_tip"](current, pin)
    for name in ("push", "workflow_dispatch", "workflow_run"):
        assert selector["catchup_pin"](env | context(name)) is None
    with pytest.raises(SystemExit, match="requires a verified"):
        selector["catchup_pin"](context("repository_dispatch"))


def test_receipt_cli_outputs_exact_public_attestation_or_nothing(tmp_path, monkeypatch, capsys):
    import json
    import sys

    metadata = tmp_path / "event.json"
    metadata.write_text(json.dumps(event()), encoding="utf-8")
    receipt = tmp_path / "catchup-publication" / catchup["RECEIPT_NAME"]
    receipt.parent.mkdir()
    receipt.write_bytes(catchup["receipt_bytes"](RECEIPT | {"tree": "c" * 40}))
    output = tmp_path / "github output.txt"
    for key, value in (
        context("repository_dispatch")
        | {
            "RUNNER_TEMP": str(tmp_path),
            "GITHUB_EVENT_PATH": str(metadata),
            "GITHUB_OUTPUT": str(output),
        }
    ).items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(sys, "argv", ["catchup_pages.py", "verify-receipt"])
    with pytest.raises(SystemExit):
        catchup["main"]()
    assert not output.exists()
    assert not capsys.readouterr().out
    receipt.write_bytes(catchup["receipt_bytes"](RECEIPT))
    catchup["main"]()
    assert output.read_text(encoding="utf-8").splitlines() == [
        f"commit={COMMIT}",
        f"tree={TREE}",
        "run_id=37",
    ]
    assert capsys.readouterr().out.strip() == (
        f"[catchup-publication] upstream_run=37 upstream_attempt=2 commit={COMMIT} tree={TREE}"
    )


@pytest.mark.parametrize("current,success", [(COMMIT, True), ("b" * 40, False), ("", False)])
def test_actual_pages_predeploy_gate_refuses_wrong_or_missing_tip(current, success):
    import os
    import shutil
    import subprocess
    import textwrap

    bash = shutil.which("bash")
    if not bash and Path("C:/Program Files/Git/bin/bash.exe").is_file():
        bash = "C:/Program Files/Git/bin/bash.exe"
    if not bash:
        pytest.skip("Bash is needed for the actual Pages deploy gate fixture")
    workflow = (ROOT / ".github/workflows/pages.yml").read_text(encoding="utf-8")
    step = workflow.split("      - name: Recheck the automatic catch-up data tip\n", 1)[1]
    gate = step.split("      - id: deployment", 1)[0]
    assert "if: github.event_name == 'repository_dispatch'" in gate
    assert "types: [completed]" in workflow and "queue: max" in workflow
    stub = '''
timeout() { [[ "$1" == 15s ]] || return 90; shift; "$@"; }
gh() {
  [[ "$1" == api && "$2" == repos/synthetic/example/git/ref/heads/data ]] || return 91
  printf '%s\\n' "$CURRENT_DATA_TIP"
}
'''
    result = subprocess.run(
        [
            bash,
            "--noprofile",
            "--norc",
            "-e",
            "-o",
            "pipefail",
            "-c",
            stub + textwrap.dedent(gate.split("        run: |\n", 1)[1]),
        ],
        env={
            **os.environ,
            "GITHUB_REPOSITORY": REPO,
            "EXPECTED_DATA_COMMIT": COMMIT,
            "CURRENT_DATA_TIP": current,
        },
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert (result.returncode == 0) is success
