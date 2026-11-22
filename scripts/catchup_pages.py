"""Bind one automatic catch-up ingest publication to its exact Pages input."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time

EVENT = "internscout-catchup-publication"
BOT = "github-actions[bot]"
INGEST = ".github/workflows/ingest.yml"
RECEIPT_NAME = "catchup-publication.json"
RECEIPT_LIMIT = 1024
WAIT_SECONDS = 60


def fail():
    raise ValueError("Automatic catch-up publication could not be verified.")


def oid(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{40}", value)


def number(value):
    return type(value) is int and 0 < value < 2**53


def publication(value):
    if (
        not isinstance(value, dict)
        or set(value) != {"run_id", "run_attempt", "commit", "tree"}
        or not all(number(value[key]) for key in ("run_id", "run_attempt"))
        or not all(oid(value[key]) for key in ("commit", "tree"))
    ):
        fail()
    return value


def artifact_name(receipt):
    return f"catchup-publication-{receipt['run_id']}-{receipt['run_attempt']}"


def api(path, *, body=None, timeout=10):
    if not os.environ.get("GH_TOKEN"):
        fail()
    command = ["gh", "api", path]
    if body is not None:
        command += ["--method", "POST", "--input", "-"]
    result = subprocess.run(
        command,
        input=json.dumps(body).encode() if body is not None else None,
        capture_output=True,
        timeout=timeout,
        check=False,
    )
    if result.returncode:
        fail()
    return json.loads(result.stdout) if body is None else None


def repo_name(environ):
    repo = environ.get("GITHUB_REPOSITORY", "")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        fail()
    return repo


def bot_context(environ, event):
    if (
        environ.get("GITHUB_EVENT_NAME") != event
        or environ.get("GITHUB_REF") != "refs/heads/main"
        or environ.get("GITHUB_ACTOR") != BOT
        or environ.get("GITHUB_TRIGGERING_ACTOR") != BOT
    ):
        fail()


def writer_receipt(environ):
    bot_context(environ, "workflow_dispatch")
    if environ.get("CATCHUP_FORCE") != "false":
        fail()
    return publication(
        {
            "run_id": int(environ["GITHUB_RUN_ID"]),
            "run_attempt": int(environ["GITHUB_RUN_ATTEMPT"]),
            "commit": environ["DATA_COMMIT"],
            "tree": environ["DATA_TREE"],
        }
    )


def dispatch_payload(environ, receipt):
    if receipt != writer_receipt(environ):
        fail()
    artifact_id = int(environ["CATCHUP_ARTIFACT_ID"])
    if not number(artifact_id):
        fail()
    return {"event_type": EVENT, "client_payload": {**receipt, "artifact_id": artifact_id}}


def event_publication(environ, event):
    bot_context(environ, "repository_dispatch")
    repo = repo_name(environ)
    if (
        event.get("action") != EVENT
        or event.get("repository", {}).get("full_name") != repo
        or event.get("sender", {}).get("login") != BOT
        or event.get("sender", {}).get("type") != "Bot"
        or not isinstance(event.get("client_payload"), dict)
    ):
        fail()
    payload = dict(event["client_payload"])
    artifact_id = payload.pop("artifact_id", None)
    if not number(artifact_id):
        fail()
    return publication(payload), artifact_id


def verified_artifact(
    repo, receipt, artifact_id, *, get=api, clock=time.monotonic, sleep=time.sleep
):
    run_id, attempt = receipt["run_id"], receipt["run_attempt"]
    deadline = clock() + WAIT_SECONDS

    def remaining():
        seconds = deadline - clock()
        if seconds <= 0:
            fail()
        return seconds

    while True:
        run = get(
            f"repos/{repo}/actions/runs/{run_id}/attempts/{attempt}", timeout=min(10, remaining())
        )
        if (
            not number(run.get("id"))
            or run["id"] != run_id
            or not number(run.get("run_attempt"))
            or run["run_attempt"] != attempt
            or run.get("path") != INGEST
            or run.get("event") != "workflow_dispatch"
            or run.get("head_branch") != "main"
            or not oid(run.get("head_sha"))
            or any(
                run.get(field, {}).get("full_name") != repo
                for field in ("repository", "head_repository")
            )
            or any(
                run.get(field, {}).get("login") != BOT for field in ("actor", "triggering_actor")
            )
        ):
            fail()
        if run.get("status") == "completed":
            if run.get("conclusion") != "success":
                fail()
            break
        if run.get("status") not in {"queued", "in_progress", "requested", "waiting", "pending"}:
            fail()
        sleep(min(3, remaining()))
    artifact = get(f"repos/{repo}/actions/artifacts/{artifact_id}", timeout=min(10, remaining()))
    remaining()
    workflow = artifact.get("workflow_run", {})
    size = artifact.get("size_in_bytes")
    if (
        not number(artifact.get("id"))
        or artifact["id"] != artifact_id
        or artifact.get("name") != artifact_name(receipt)
        or artifact.get("expired") is not False
        or not number(size)
        or size > 16 * 1024
        or not number(workflow.get("id"))
        or workflow["id"] != run_id
        or workflow.get("head_sha") != run["head_sha"]
    ):
        fail()
    return artifact_id


def receipt_bytes(receipt):
    return (json.dumps(receipt) + "\n").encode("utf-8")


def read_receipt(path):
    if path.is_symlink() or not path.is_file():
        fail()
    with path.open("rb") as source:
        raw = source.read(RECEIPT_LIMIT + 1)
    if len(raw) > RECEIPT_LIMIT:
        fail()
    receipt = publication(json.loads(raw))
    if raw != receipt_bytes(receipt):
        fail()
    return receipt


def outputs(environ, **values):
    with open(environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        for key, value in values.items():
            output.write(f"{key}={value}\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("receipt", "dispatch", "verify-run", "verify-receipt"))
    args = parser.parse_args()
    environ = os.environ
    path = Path(environ["RUNNER_TEMP"]) / "catchup-publication" / RECEIPT_NAME
    try:
        if args.command == "receipt":
            receipt = writer_receipt(environ)
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(receipt_bytes(receipt))
            outputs(environ, artifact_name=artifact_name(receipt))
        elif args.command == "dispatch":
            api(
                f"repos/{repo_name(environ)}/dispatches",
                body=dispatch_payload(environ, read_receipt(path)),
            )
        else:
            event = json.loads(Path(environ["GITHUB_EVENT_PATH"]).read_bytes())
            receipt, artifact_id = event_publication(environ, event)
            if args.command == "verify-run":
                verified_artifact(repo_name(environ), receipt, artifact_id)
                outputs(environ, artifact_id=artifact_id, run_id=receipt["run_id"])
            else:
                if read_receipt(path) != receipt:
                    fail()
                outputs(
                    environ,
                    commit=receipt["commit"],
                    tree=receipt["tree"],
                    run_id=receipt["run_id"],
                )
                print(
                    "[catchup-publication] "
                    f"upstream_run={receipt['run_id']} upstream_attempt={receipt['run_attempt']} "
                    f"commit={receipt['commit']} tree={receipt['tree']}"
                )
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError):
        parser.exit(1, "Automatic catch-up publication could not be verified.\n")


if __name__ == "__main__":
    main()
