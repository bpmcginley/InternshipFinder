"""Prepare and publish one complete ingest snapshot on the existing data branch."""

import argparse
from dataclasses import dataclass
from datetime import datetime
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile

BRANCH = "refs/heads/data"
TRACKING = "refs/remotes/origin/data"
PUBLIC = "docs/data"
STATE = tuple(
    f"backend/data/{name}.json"
    for name in ("ats_registry", "dropped_boards", "geocache", "probe_cache", "google_jobs_day")
)
REFERENCE = ("search_console_pages.json", "sector_employers.json", "sector_gaps.json")
OWNED = (PUBLIC, *STATE)
REQUIRED = {
    "listings/index.json",
    "first.json",
    "majors.json",
    "stats.json",
    "seo-posting-details.json",
}


def git(checkout, *args, check=True, env=None):
    result = subprocess.run(["git", *args], cwd=checkout, capture_output=True, check=False, env=env)
    if check and result.returncode:
        raise ValueError(f"Git {args[0]} failed in the data checkout")
    return result


def revision(checkout, ref):
    return git(checkout, "rev-parse", "--verify", ref).stdout.decode("ascii").strip()


def owned(path):
    return path in STATE or path.startswith(PUBLIC + "/")


def object_without_duplicates(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError("Duplicate JSON key in ingest snapshot")
        obj[key] = value
    return obj


def reject_nonfinite(_):
    raise ValueError("Non-finite JSON number in ingest snapshot")


def parse_json(data):
    try:
        return json.loads(
            data, object_pairs_hook=object_without_duplicates, parse_constant=reject_nonfinite
        )
    except (UnicodeError, json.JSONDecodeError):
        raise ValueError("Invalid JSON in ingest snapshot") from None


def check_counts(declared, actual):
    if type(declared) is not int or declared != actual:
        raise ValueError("Declared ingest snapshot count does not match the referenced file")


def validate_tree(checkout, tree):
    paths = [PUBLIC]
    if git(checkout, "ls-tree", tree, "--", "backend/data").stdout:
        paths.append("backend/data")
    archive = git(checkout, "archive", "--format=tar", tree, "--", *paths).stdout
    files = {}
    names = set()
    with tarfile.open(fileobj=io.BytesIO(archive)) as snapshot:
        for member in snapshot:
            if member.name in STATE and member.isdir():
                raise ValueError("Unexpected state directory in ingest snapshot")
            if not owned(member.name) or member.isdir():
                continue
            name = member.name.casefold()
            if not member.isfile() or name in names or not member.name.endswith(".json"):
                raise ValueError("Aliased or unexpected file in ingest snapshot")
            names.add(name)
            with snapshot.extractfile(member) as payload:
                value = parse_json(payload.read())
                if member.name in STATE and not isinstance(value, dict):
                    raise ValueError("Expected an ingest state object")
                files[member.name.removeprefix(PUBLIC + "/")] = value

    if not REQUIRED <= files.keys():
        raise ValueError("Required public file missing from ingest snapshot")
    if any(not isinstance(files[name], dict) for name in REQUIRED - {"first.json"}):
        raise ValueError("Invalid public object in ingest snapshot")
    index = files["listings/index.json"]
    generated = index.get("generated_at")
    if not isinstance(generated, str) or generated != files["stats.json"].get("generated_at"):
        raise ValueError("Snapshot index and statistics have different generation dates")
    try:
        offset = datetime.fromisoformat(generated).utcoffset()
    except ValueError:
        offset = None
    if offset is None:
        raise ValueError("Snapshot generation date must include a timezone")
    entries = index.get("files")
    first = index.get("first")
    preview = files["first.json"]
    if (
        not isinstance(entries, dict)
        or not isinstance(first, dict)
        or not isinstance(preview, list)
    ):
        raise ValueError("Invalid listing index or preview in ingest snapshot")
    if first.get("file") != "first.json":
        raise ValueError("Invalid preview file reference in ingest snapshot")
    check_counts(first.get("rows"), len(preview))

    referenced = {"listings/index.json"}
    for key, entry in entries.items():
        if not key or any(c in key for c in "/\\:"):
            raise ValueError("Invalid shard key in ingest snapshot")
        shard = f"listings/{key}.json"
        desc = f"listings/{key}.desc.json"
        if (
            not isinstance(entry, dict)
            or entry.get("file") != shard
            or entry.get("desc") != desc
            or shard in referenced
            or desc in referenced
        ):
            raise ValueError("Aliased shard file reference in ingest snapshot")
        rows = files.get(shard)
        if (
            not isinstance(rows, list)
            or any(not isinstance(row, dict) for row in rows)
            or not isinstance(files.get(desc), dict)
        ):
            raise ValueError("Referenced shard or sidecar missing or invalid")
        open_ids = {
            str(row["id"])
            for row in rows
            if row.get("status") == "open" and type(row.get("id")) in (int, str)
        }
        if any(
            key not in open_ids or not isinstance(value, str) for key, value in files[desc].items()
        ):
            raise ValueError("Invalid description for an open shard listing")
        referenced.update((shard, desc))
        check_counts(entry.get("count"), len(rows))
        check_counts(entry.get("open"), sum(row.get("status") == "open" for row in rows))
    if set(files) - set(STATE) != referenced | REQUIRED:
        raise ValueError("Unexpected public file in ingest snapshot")


def data_base(checkout):
    branch = git(checkout, "symbolic-ref", "--quiet", "HEAD").stdout.decode("ascii").strip()
    if branch != BRANCH:
        raise ValueError("Expected the isolated data branch checkout")
    base = revision(checkout, TRACKING)
    if revision(checkout, "HEAD") != base:
        raise ValueError("Data checkout must start at the fetched data snapshot")
    return base


def check_regular(path):
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise ValueError("Expected a regular ingest state file")


def copy_state(source, target):
    check_regular(source)
    check_regular(target)
    if source.is_file():
        shutil.copyfile(source, target)
    else:
        target.unlink(missing_ok=True)


def prepare(checkout, primary, state):
    if checkout.resolve() == primary.resolve() or state.resolve().is_relative_to(primary.resolve()):
        raise ValueError("Expected isolated data checkout and ingest state")
    validate_tree(checkout, data_base(checkout))
    state.mkdir(parents=True, exist_ok=False)
    for name in REFERENCE:
        source = primary / "backend/data" / name
        if not source.is_file() or source.is_symlink():
            raise ValueError("Required primary reference data is missing")
        copy_state(source, state / name)
    for path in STATE:
        copy_state(checkout / path, state / Path(path).name)


def ensure_owned_stage(checkout):
    staged = git(checkout, "diff", "--cached", "--no-renames", "--name-only", "-z").stdout
    if any(not owned(name.decode("utf8")) for name in staged.split(b"\0") if name):
        raise ValueError("Refusing unrelated staged files in the data checkout")


def stage_snapshot(checkout, state):
    ensure_owned_stage(checkout)
    git(checkout, "add", "-A", "--", PUBLIC)
    for directory in (checkout / "backend", checkout / "backend/data"):
        if directory.is_symlink() or (directory.exists() and not directory.is_dir()):
            raise ValueError("Expected regular ingest state directories")
    for path in STATE:
        target = checkout / path
        target.parent.mkdir(parents=True, exist_ok=True)
        copy_state(state / target.name, target)
        tracked = git(checkout, "ls-files", "--", path).stdout
        if target.is_file() or tracked:
            git(checkout, "add", "-A", "--", path)
    ensure_owned_stage(checkout)


def ancestor(checkout, earlier, later):
    return git(checkout, "merge-base", "--is-ancestor", earlier, later, check=False).returncode == 0


def same_snapshot(checkout, earlier, later):
    return (
        git(checkout, "diff", "--quiet", earlier, later, "--", *OWNED, check=False).returncode == 0
    )


@dataclass(frozen=True)
class PushIntent:
    ordinal: int
    expected_predecessor: str
    candidate_commit: str
    public_tree: str


def _push_existing(checkout, expected, candidate=None):
    # The hook sees the server's advertised old OID in this push, including an absent ref.
    # A normal push checks that same OID on the server when it updates the ref.
    with tempfile.TemporaryDirectory(prefix="ingest-push-") as folder:
        hook = Path(folder) / "pre-push"
        check_candidate = (
            b'  [ "$local_oid" = "$INTERN_SCOUT_DATA_PUSH_CANDIDATE" ] || exit 1\n'
            if candidate is not None
            else b""
        )
        hook.write_bytes(
            b'#!/bin/sh\n'
            b'while read -r local_ref local_oid remote_ref remote_oid; do\n'
            b'  [ "$remote_ref" = refs/heads/data ] && '
            b'[ "$remote_oid" = "$INTERN_SCOUT_DATA_EXPECTED_TIP" ] || exit 1\n'
            + check_candidate
            + b'done\n'
        )
        hook.chmod(0o755)
        push_env = {**os.environ, "INTERN_SCOUT_DATA_EXPECTED_TIP": expected}
        if candidate is not None:
            push_env["INTERN_SCOUT_DATA_PUSH_CANDIDATE"] = candidate
        return git(
            checkout,
            "-c",
            f"core.hooksPath={Path(folder).as_posix()}",
            *(("-c", f"core.abbrev={len(candidate)}") if candidate is not None else ()),
            "push",
            *(("--porcelain",) if candidate is not None else ()),
            "origin",
            f"{'HEAD' if candidate is None else candidate}:{BRANCH}",
            check=False,
            env=push_env,
        )


def push_existing(checkout, expected):
    return _push_existing(checkout, expected).returncode == 0


def _acknowledges_push(result, intent):
    if result.returncode != 0:
        return False
    records = [line for line in result.stdout.splitlines() if b"\t" in line]
    source = f"{intent.candidate_commit}:{BRANCH}".encode("ascii")
    summary = f"{intent.expected_predecessor}..{intent.candidate_commit}".encode("ascii")
    return records == [b" \t" + source + b"\t" + summary]


def remote_tip(checkout):
    git(checkout, "fetch", "--no-tags", "origin", f"{BRANCH}:{TRACKING}")
    return revision(checkout, TRACKING)


def publication_marker(checkout, commit):
    tree = revision(checkout, f"{commit}:{PUBLIC}")
    return f"[ingest-data] commit={commit} tree={tree}"


def publish(checkout, state, message, *, observe_push=None):
    """Optionally report intent before push and direct acknowledgement after it.

    The trusted observer must return promptly. Its records require separate
    run, attempt and pending-checkpoint authentication before recovery.
    """
    base = data_base(checkout)
    git(checkout, "ls-remote", "--exit-code", "--heads", "origin", BRANCH)
    if not state.is_dir() or state.is_symlink():
        raise ValueError("Isolated ingest state is missing")
    stage_snapshot(checkout, state)
    tree = git(checkout, "write-tree").stdout.decode("ascii").strip()
    validate_tree(checkout, tree)
    if tree == revision(checkout, "HEAD^{tree}"):
        remote = remote_tip(checkout)
        if not same_snapshot(checkout, base, remote):
            raise ValueError("Concurrent update changed ingest-owned data; refusing no-op")
        return "No changes.", remote
    git(checkout, "commit", "-m", message)
    if revision(checkout, "HEAD^{tree}") != tree:
        raise ValueError("Committed tree differs from the validated snapshot")
    candidate = revision(checkout, "HEAD")
    expected = base
    for attempt in range(3):
        pushed_commit = None
        if observe_push is None:
            pushed = push_existing(checkout, expected)
        else:
            current = revision(checkout, "HEAD")
            public_tree = revision(checkout, f"{current}:{PUBLIC}")
            if not all(
                re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", oid) and len(oid) == len(current)
                for oid in (expected, current, public_tree)
            ):
                raise ValueError("Invalid Follow push identity")
            intent = PushIntent(attempt + 1, expected, current, public_tree)
            try:
                observe_push(intent, False)
            except Exception:
                observe_push = None
            result = _push_existing(checkout, expected, current)
            pushed = result.returncode == 0
            pushed_commit = current
            if observe_push is not None and _acknowledges_push(result, intent):
                try:
                    observe_push(intent, True)
                except Exception:
                    # The listing was pushed. Optional evidence cannot revoke that result.
                    pass
        if pushed:
            return "Published validated data snapshot.", pushed_commit or revision(checkout, "HEAD")
        remote = remote_tip(checkout)
        if ancestor(checkout, candidate, remote):
            if same_snapshot(checkout, candidate, remote):
                return "Validated data snapshot already published.", remote
            raise ValueError("Data snapshot changed after publication")
        if (
            not ancestor(checkout, base, remote)
            or git(
                checkout, "log", "--full-history", "--format=%H", f"{base}..{remote}", "--", *OWNED
            ).stdout
        ):
            raise ValueError("Concurrent update changed ingest-owned data; refusing retry")
        if attempt == 2:
            break
        git(checkout, "merge", "--no-edit", remote)
        if not same_snapshot(checkout, candidate, "HEAD"):
            raise ValueError("Retry changed the validated data snapshot")
        expected = remote
    raise ValueError("Could not publish the validated data snapshot")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    validator = commands.add_parser("validate")
    validator.add_argument("checkout", type=Path)
    validator.add_argument("--ref", default="HEAD")
    preparation = commands.add_parser("prepare")
    preparation.add_argument("checkout", type=Path)
    preparation.add_argument("primary", type=Path)
    preparation.add_argument("state", type=Path)
    publication = commands.add_parser("publish")
    publication.add_argument("checkout", type=Path)
    publication.add_argument("state", type=Path)
    publication.add_argument("--message", required=True)
    publication.add_argument("--github-output", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "validate":
            validate_tree(args.checkout, revision(args.checkout, f"{args.ref}^{{tree}}"))
            print("Validated ingest snapshot.")
        elif args.command == "prepare":
            prepare(args.checkout, args.primary, args.state)
        else:
            message, commit = publish(args.checkout, args.state, args.message)
            print(message)
            marker = publication_marker(args.checkout, commit)
            print(marker)
            if args.github_output is not None and message != "No changes.":
                # Both values come from the same successful publication used by the log marker.
                with args.github_output.open("a", encoding="utf-8") as output:
                    output.write("\n".join(marker.split()[1:]) + "\n")
    except ValueError as error:
        parser.exit(1, f"{error}\n")
    except (OSError, tarfile.TarError):
        parser.exit(1, "Could not read or write the ingest snapshot\n")


if __name__ == "__main__":
    main()
