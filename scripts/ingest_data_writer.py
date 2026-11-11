"""Prepare and publish one complete ingest snapshot on the existing data branch."""

import argparse
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from hashlib import sha256
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
from types import MappingProxyType

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


def git(checkout, *args, check=True, env=None, no_replace=False):
    command = ["git", "--no-replace-objects"] if no_replace else ["git"]
    result = subprocess.run(
        [*command, *args], cwd=checkout, capture_output=True, check=False, env=env
    )
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


def validate_tree(checkout, tree, *, _listing_bytes=None):
    no_replace = _listing_bytes is not None
    paths = [PUBLIC]
    if git(checkout, "ls-tree", tree, "--", "backend/data", no_replace=no_replace).stdout:
        paths.append("backend/data")
    archive = git(
        checkout, "archive", "--format=tar", tree, "--", *paths, no_replace=no_replace
    ).stdout
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
            path = member.name.removeprefix(PUBLIC + "/")
            if (
                _listing_bytes is not None
                and member.name.startswith(f"{PUBLIC}/listings/")
                and not member.name.endswith(".desc.json")
            ):
                # Git archive may apply working-tree conversion to text files.
                # Validate and retain the exact object bytes for the proof.
                raw = git(
                    checkout, "cat-file", "blob", f"{tree}:{member.name}", no_replace=True
                ).stdout
                _listing_bytes[path] = raw
                value = parse_json(raw)
            else:
                with snapshot.extractfile(member) as payload:
                    value = parse_json(payload.read())
            if member.name in STATE and not isinstance(value, dict):
                raise ValueError("Expected an ingest state object")
            files[path] = value

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


def ensure_owned_stage(checkout, *, no_replace=False):
    options = ("--ignore-submodules=none", "--no-ext-diff", "--no-textconv") if no_replace else ()
    staged = git(
        checkout,
        "diff",
        "--cached",
        "--no-renames",
        "--name-only",
        "-z",
        *options,
        no_replace=no_replace,
    ).stdout
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


@dataclass(frozen=True)
class _StagedFollowProvenance:
    candidate_tree: str
    generated_at: datetime
    covers_after: datetime
    index_bytes: bytes
    shards: Mapping[str, bytes]
    index_sha256: str
    shard_sha256: Mapping[str, str]
    _rows: Mapping

    def for_adapter(self, provenance_type, evidence_type):
        """Construct #334 evidence from the exact validated staged candidate."""
        return provenance_type(
            self.index_sha256,
            self.shard_sha256,
            {
                role_id: evidence_type(proof.raw_first_seen, proof.verified_utc, proof.observed_by)
                for role_id, proof in self._rows.items()
            },
        )


def validate_staged_follow_provenance(checkout, candidate_tree, provenance):
    """Verify an opted-in proof against the current, exact writer candidate without publishing."""
    ensure_owned_stage(checkout, no_replace=True)
    if (
        provenance is None
        or git(checkout, "write-tree", no_replace=True).stdout.decode("ascii").strip()
        != candidate_tree
    ):
        raise ValueError("Expected follow proof and exact staged candidate")

    listing_bytes = {}
    validate_tree(checkout, candidate_tree, _listing_bytes=listing_bytes)
    staged_listing_paths = (
        git(
            checkout,
            "ls-tree",
            "-r",
            "--name-only",
            "-z",
            candidate_tree,
            "--",
            f"{PUBLIC}/listings",
            no_replace=True,
        )
        .stdout.decode("utf-8")
        .split("\0")
    )
    if {
        path.removeprefix(PUBLIC + "/")
        for path in staged_listing_paths
        if path and not path.endswith(".desc.json")
    } != listing_bytes.keys():
        raise ValueError("Staged follow listing paths differ from the validated archive")
    index_bytes = listing_bytes.pop("listings/index.json")
    index = parse_json(index_bytes)
    identity = provenance.identity
    if (
        sha256(index_bytes).hexdigest() != identity.index_sha256
        or datetime.fromisoformat(index["generated_at"]) != provenance.generated_at
        or not index["files"]
        or index["files"].keys() != identity.shard_sha256.keys()
    ):
        raise ValueError("Follow proof does not match the staged listing index")

    digests = {}
    for key, entry in index["files"].items():
        path = entry["file"]
        digests[key] = sha256(listing_bytes[path]).hexdigest()
    if digests != identity.shard_sha256:
        raise ValueError("Follow proof does not match the staged listing shards")

    if (
        git(checkout, "write-tree", no_replace=True).stdout.decode("ascii").strip()
        != candidate_tree
    ):
        raise ValueError("Staged candidate changed during follow verification")

    return _StagedFollowProvenance(
        candidate_tree,
        provenance.generated_at,
        provenance.covers_after,
        index_bytes,
        MappingProxyType(listing_bytes),
        identity.index_sha256,
        MappingProxyType(digests),
        MappingProxyType(dict(provenance.rows)),
    )


def ancestor(checkout, earlier, later):
    return git(checkout, "merge-base", "--is-ancestor", earlier, later, check=False).returncode == 0


def same_snapshot(checkout, earlier, later):
    return (
        git(checkout, "diff", "--quiet", earlier, later, "--", *OWNED, check=False).returncode == 0
    )


def push_existing(checkout, expected):
    # The hook sees the server's advertised old OID in this push, including an absent ref.
    # A normal push checks that same OID on the server when it updates the ref.
    with tempfile.TemporaryDirectory(prefix="ingest-push-") as folder:
        hook = Path(folder) / "pre-push"
        hook.write_bytes(
            b'#!/bin/sh\n'
            b'while read -r local_ref local_oid remote_ref remote_oid; do\n'
            b'  [ "$remote_ref" = refs/heads/data ] && '
            b'[ "$remote_oid" = "$INTERN_SCOUT_DATA_EXPECTED_TIP" ] || exit 1\n'
            b'done\n'
        )
        hook.chmod(0o755)
        result = git(
            checkout,
            "-c",
            f"core.hooksPath={Path(folder).as_posix()}",
            "push",
            "origin",
            f"HEAD:{BRANCH}",
            check=False,
            env={**os.environ, "INTERN_SCOUT_DATA_EXPECTED_TIP": expected},
        )
    return result.returncode == 0


def remote_tip(checkout):
    git(checkout, "fetch", "--no-tags", "origin", f"{BRANCH}:{TRACKING}")
    return revision(checkout, TRACKING)


def publication_marker(checkout, commit):
    tree = revision(checkout, f"{commit}:{PUBLIC}")
    return f"[ingest-data] commit={commit} tree={tree}"


def publish(checkout, state, message):
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
        if push_existing(checkout, expected):
            return "Published validated data snapshot.", revision(checkout, "HEAD")
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
            print(publication_marker(args.checkout, commit))
    except ValueError as error:
        parser.exit(1, f"{error}\n")
    except (OSError, tarfile.TarError):
        parser.exit(1, "Could not read or write the ingest snapshot\n")


if __name__ == "__main__":
    main()
