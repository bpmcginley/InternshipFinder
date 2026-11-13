"""Exercise the ingest writer with synthetic snapshots and a file-only remote."""

from dataclasses import replace
from datetime import datetime, timedelta
from hashlib import sha256
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from internscout.follow_writer_provenance import ExportIdentity, FirstSeenLineage, WriterProvenance

ROOT = Path(__file__).resolve().parents[2]


def load_module(path):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


writer = load_module(ROOT / "scripts/ingest_data_writer.py")
reader = load_module(ROOT / ".github/actions/public-data/listing_data.py")
STAMP = "2026-11-11T05:00:00Z"

INDEX = "docs/data/listings/index.json"
SHARD = "docs/data/listings/MA.json"
SIDECAR = "docs/data/listings/MA.desc.json"
NEW_SHARD = "docs/data/listings/NY.json"
NEW_SIDECAR = "docs/data/listings/NY.desc.json"


def write(root, path, value):
    file = root / path
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(value), encoding="utf8")


def index(key="MA"):
    return {
        "generated_at": STAMP,
        "files": {
            key: {
                "file": f"listings/{key}.json",
                "desc": f"listings/{key}.desc.json",
                "count": 2,
                "open": 1,
            }
        }
        if key
        else {},
        "first": {"file": "first.json", "rows": 0},
    }


class IngestWriterTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="ingest-writer-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        settings = patch.dict(
            os.environ,
            {
                "GIT_ALLOW_PROTOCOL": "file",
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_CONFIG_GLOBAL": str(self.root / "empty-config"),
                "GIT_AUTHOR_NAME": "Test",
                "GIT_AUTHOR_EMAIL": "test@example.invalid",
                "GIT_COMMITTER_NAME": "Test",
                "GIT_COMMITTER_EMAIL": "test@example.invalid",
            },
        )
        settings.start()
        self.addCleanup(settings.stop)
        self.remote = self.root / "origin.git"
        self.primary = self.root / "primary"
        self.data = self.root / "data"
        self.state = self.root / "state"
        self.git(self.root, "init", "--bare", "--initial-branch=main", str(self.remote))
        self.git(self.root, "init", "--initial-branch=main", str(self.primary))
        self.git(self.primary, "remote", "add", "origin", str(self.remote))
        self.write_public(self.primary)
        for path in writer.STATE:
            write(self.primary, path, {"state": "seed"})
        for name in writer.REFERENCE:
            write(self.primary, f"backend/data/{name}", {"ref": "seed"})
        write(self.primary, "other.json", {"unrelated": "seed"})
        write(self.primary, ".github/workflows/ingest.yml", {"writer": "main"})
        self.commit(self.primary, ".")
        self.git(self.primary, "push", "origin", "HEAD:refs/heads/main")
        self.git(self.primary, "push", "origin", f"HEAD:{writer.BRANCH}")
        self.git(self.root, "clone", "--branch", "data", str(self.remote), str(self.data))

    def git(self, checkout, *args):
        return writer.git(checkout, *args).stdout

    def commit(self, checkout, *paths):
        self.git(checkout, "add", "-A", "--", *paths)
        self.git(checkout, "commit", "-m", "Synthetic snapshot update")
        return writer.revision(checkout, "HEAD")

    def write_public(self, checkout, key="MA"):
        write(checkout, INDEX, index(key))
        for name in ("majors", "seo-posting-details"):
            write(checkout, f"docs/data/{name}.json", {})
        write(checkout, "docs/data/stats.json", {"generated_at": STAMP})
        write(checkout, "docs/data/first.json", [])
        if key:
            write(
                checkout,
                f"docs/data/listings/{key}.json",
                [{"id": "open", "status": "open"}, {"id": "closed", "status": "closed"}],
            )
            write(checkout, f"docs/data/listings/{key}.desc.json", {"open": "Synthetic role"})

    def update_snapshot(self):
        (self.data / SHARD).unlink()
        (self.data / SIDECAR).unlink()
        self.write_public(self.data, "NY")
        (self.state / Path(writer.STATE[-1]).name).unlink()
        write(self.state, Path(writer.STATE[0]).name, {"state": "new"})

    def other(self):
        path = self.root / "other"
        self.git(self.root, "clone", "--branch", "data", str(self.remote), str(path))
        return path

    def test_relative_prepare_absolute_publish_and_immutable_retry(self):
        for name in writer.REFERENCE:
            write(self.primary, f"backend/data/{name}", {"ref": "main"})
        write(self.primary, writer.STATE[0], {"state": "old-main"})
        result = subprocess.run(
            [
                sys.executable,
                str(Path(writer.__file__).resolve()),
                "prepare",
                "data",
                "primary",
                "state",
            ],
            cwd=self.root,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0)
        for name in writer.REFERENCE:
            self.assertEqual(json.loads((self.state / name).read_bytes()), {"ref": "main"})
        self.assertEqual(
            json.loads((self.state / Path(writer.STATE[0]).name).read_bytes()), {"state": "seed"}
        )
        self.update_snapshot()
        write(self.data, "dirty.json", {})
        write(self.data, f"backend/data/{writer.REFERENCE[0]}", {"ref": "local dirty"})
        other = self.other()
        write(other, "other.json", {"unrelated": "remote"})
        remote = self.commit(other, "other.json")
        self.git(other, "push", "origin", f"HEAD:{writer.BRANCH}")

        with patch.object(writer, "push_existing", wraps=writer.push_existing) as push:
            self.assertEqual(
                writer.publish(self.data, self.state, "Publish")[0],
                "Published validated data snapshot.",
            )
        self.assertEqual(push.call_count, 2)
        self.assertTrue(writer.ancestor(self.remote, remote, writer.BRANCH))
        self.assertEqual(self.git(self.data, "rev-list", "--parents", "-1", "HEAD").count(b" "), 2)
        self.assertEqual(
            json.loads(self.git(self.remote, "show", f"{writer.BRANCH}:other.json")),
            {"unrelated": "remote"},
        )
        self.assertTrue(
            self.git(self.remote, "ls-tree", "-r", writer.BRANCH, "--", NEW_SHARD, NEW_SIDECAR)
        )
        self.assertFalse(
            self.git(
                self.remote, "ls-tree", "-r", writer.BRANCH, "--", SHARD, SIDECAR, writer.STATE[-1]
            )
        )
        self.assertTrue((self.data / "dirty.json").is_file())
        self.assertEqual(
            json.loads((self.data / f"backend/data/{writer.REFERENCE[0]}").read_bytes()),
            {"ref": "local dirty"},
        )
        self.assertEqual(
            json.loads(
                self.git(self.remote, "show", f"{writer.BRANCH}:backend/data/{writer.REFERENCE[0]}")
            ),
            {"ref": "seed"},
        )
        writer.validate_tree(self.remote, writer.BRANCH)

    def test_competing_owned_history_refused_even_if_reverted(self):
        writer.prepare(self.data, self.primary, self.state)
        self.update_snapshot()
        other = self.other()
        (other / writer.STATE[1]).unlink()
        self.commit(other, writer.STATE[1])
        self.git(other, "revert", "--no-edit", "HEAD")
        self.git(other, "push", "origin", f"HEAD:{writer.BRANCH}")
        tip = writer.revision(self.remote, writer.BRANCH)
        with self.assertRaisesRegex(ValueError, "Concurrent update"):
            writer.publish(self.data, self.state, "Publish")
        self.assertEqual(writer.revision(self.remote, writer.BRANCH), tip)

    def test_push_checks_advertised_oid_and_does_not_create_missing_ref(self):
        before = writer.revision(self.data, "HEAD")
        write(self.data, "other.json", {"unrelated": "next"})
        new_remote = self.commit(self.data, "other.json")
        self.git(self.data, "push", "origin", f"HEAD:{writer.BRANCH}")
        write(self.data, writer.STATE[0], {})
        self.commit(self.data, writer.STATE[0])
        self.assertFalse(writer.push_existing(self.data, before))
        self.assertEqual(writer.revision(self.remote, writer.BRANCH), new_remote)
        self.git(self.remote, "update-ref", "-d", writer.BRANCH)
        self.assertFalse(writer.push_existing(self.data, new_remote))
        self.assertNotEqual(
            writer.git(self.remote, "show-ref", "--verify", writer.BRANCH, check=False).returncode,
            0,
        )

    def test_staged_tree_validation_refuses_invalid_snapshot(self):
        writer.prepare(self.data, self.primary, self.state)
        good_tree = writer.revision(self.data, "HEAD^{tree}")
        tip = writer.revision(self.remote, writer.BRANCH)
        for case in (
            "duplicate",
            "wrong-total",
            "wrong-open",
            "missing",
            "alias",
            "date",
            "timezone",
            "closed-sidecar",
            "non-string-sidecar",
            "extra-public",
            "colon-key",
        ):
            with self.subTest(case=case):
                current = index()
                if case == "duplicate":
                    (self.data / INDEX).write_text('{"files": {}, "files": {}}', encoding="utf8")
                elif case == "missing":
                    (self.data / SIDECAR).unlink()
                elif case in {"date", "timezone"}:
                    generated = "2026-11-12T05:00:00Z" if case == "date" else "2026-11-11T05:00:00"
                    write(self.data, "docs/data/stats.json", {"generated_at": generated})
                    if case == "timezone":
                        current["generated_at"] = generated
                        write(self.data, INDEX, current)
                elif case in {"closed-sidecar", "non-string-sidecar"}:
                    write(
                        self.data,
                        SIDECAR,
                        {"closed": "text"} if case == "closed-sidecar" else {"open": []},
                    )
                elif case == "extra-public":
                    write(self.data, "docs/data/extra.json", {})
                elif case == "colon-key":
                    current["files"]["M:A"] = current["files"].pop("MA")
                    write(self.data, INDEX, current)
                else:
                    entry = current["files"]["MA"]
                    entry[{"wrong-total": "count", "wrong-open": "open", "alias": "file"}[case]] = (
                        "listings/index.json" if case == "alias" else 4
                    )
                    write(self.data, INDEX, current)
                writer.validate_tree(self.data, good_tree)
                with self.assertRaises(ValueError):
                    writer.publish(self.data, self.state, "Publish")
                self.assertEqual(writer.revision(self.data, "HEAD"), tip)
                self.assertEqual(writer.revision(self.remote, writer.BRANCH), tip)
                self.git(self.data, "restore", "--staged", "--worktree", "--", writer.PUBLIC)

    def test_staged_state_must_be_regular_json_object(self):
        writer.prepare(self.data, self.primary, self.state)
        path = writer.STATE[0]
        write(self.state, Path(path).name, [])
        with self.assertRaisesRegex(ValueError, "state object"):
            writer.publish(self.data, self.state, "Bad state")
        (self.data / path).unlink()
        write(self.data, f"{path}/unexpected.json", {})
        self.git(self.data, "add", "-A", "--", path)
        tree = self.git(self.data, "write-tree").decode("ascii").strip()
        with self.assertRaisesRegex(ValueError, "state directory"):
            writer.validate_tree(self.data, tree)

    def test_safe_reader_and_writer_markers(self):
        writer.prepare(self.data, self.primary, self.state)
        write(self.state, Path(writer.STATE[0]).name, {})
        real_push = writer.push_existing

        def lost_ack(checkout, expected):
            self.assertTrue(real_push(checkout, expected))
            return False

        with patch.object(writer, "push_existing", side_effect=lost_ack):
            message, commit = writer.publish(self.data, self.state, "Publish")
        self.assertEqual(message, "Validated data snapshot already published.")
        tree = writer.revision(self.remote, f"{commit}:{writer.PUBLIC}")
        self.assertEqual(
            writer.publication_marker(self.data, commit),
            f"[ingest-data] commit={commit} tree={tree}",
        )

        event_file = self.root / "event.json"
        fixed = f"[listing-data] source=data commit={commit} tree={tree}"
        directory = self.data / writer.PUBLIC
        with patch.dict(
            os.environ, {"GITHUB_EVENT_NAME": "workflow_run", "GITHUB_EVENT_PATH": str(event_file)}
        ):
            write(self.root, event_file.name, {"workflow_run": {"id": 723, "other": "not logged"}})
            self.assertEqual(
                reader.selection_marker(directory, from_data=True), fixed + " upstream_run=723"
            )
            for invalid in (True, -1, "123"):
                write(self.root, event_file.name, {"workflow_run": {"id": invalid}})
                self.assertEqual(reader.selection_marker(directory, from_data=True), fixed)
        with patch.dict(
            os.environ, {"GITHUB_EVENT_NAME": "push", "GITHUB_EVENT_PATH": str(event_file)}
        ):
            self.assertEqual(reader.selection_marker(directory, from_data=True), fixed)
            fallback = self.primary / writer.PUBLIC
            main = writer.revision(self.primary, "HEAD")
            main_tree = writer.revision(self.primary, f"{main}:{writer.PUBLIC}")
            self.assertEqual(
                reader.selection_marker(fallback, from_data=False),
                f"[listing-data] source=main-fallback commit={main} tree={main_tree}",
            )

    def test_successful_publish_can_emit_exact_github_outputs_without_changing_stdout(self):
        writer.prepare(self.data, self.primary, self.state)
        self.update_snapshot()
        output = self.root / "writer outputs.txt"
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts/ingest_data_writer.py"),
                "publish",
                "data",
                "state",
                "--message",
                "Synthetic catch-up snapshot",
                "--github-output",
                str(output),
            ],
            cwd=self.root,
            capture_output=True,
            text=True,
            check=True,
        )
        commit = writer.revision(self.remote, writer.BRANCH)
        tree = writer.revision(self.remote, f"{commit}:{writer.PUBLIC}")
        self.assertEqual(
            result.stdout.splitlines(),
            [
                "Published validated data snapshot.",
                f"[ingest-data] commit={commit} tree={tree}",
            ],
        )
        self.assertEqual(
            output.read_text(encoding="utf-8").splitlines(), [f"commit={commit}", f"tree={tree}"]
        )

    def follow_proof(self):
        path = self.data / INDEX
        raw_index = path.read_bytes()
        shards = {
            key: sha256((self.data / "docs/data" / entry["file"]).read_bytes()).hexdigest()
            for key, entry in json.loads(raw_index)["files"].items()
        }
        at = datetime.fromisoformat(STAMP)
        proof = FirstSeenLineage(at.replace(tzinfo=None).isoformat(), verified_utc=at)
        return WriterProvenance(
            ExportIdentity(sha256(raw_index).hexdigest(), shards),
            at,
            at - timedelta(hours=1),
            {"open": proof},
            {},
        )

    def assert_follow_receipt(self, published, receipt, expected_message):
        message, commit = published
        self.assertEqual(message, expected_message)
        self.assertEqual(commit, writer.revision(self.remote, writer.BRANCH))
        self.assertEqual(receipt.commit, commit)
        self.assertEqual(
            receipt.public_tree, writer.revision(self.remote, f"{commit}:{writer.PUBLIC}")
        )
        self.assertEqual(
            receipt.staged.index_bytes,
            self.git(self.remote, "cat-file", "blob", f"{commit}:{INDEX}"),
        )
        for path, data in receipt.staged.shards.items():
            self.assertEqual(
                data,
                self.git(self.remote, "cat-file", "blob", f"{commit}:{writer.PUBLIC}/{path}"),
            )
        return commit

    def test_follow_receipt_binds_normal_push_and_survives_checkout_change(self):
        writer.prepare(self.data, self.primary, self.state)
        self.update_snapshot()
        proof = self.follow_proof()
        result, receipt = writer.publish_with_follow_provenance(
            self.data, self.state, "Publish", proof
        )
        self.assert_follow_receipt(result, receipt, "Published validated data snapshot.")
        expected = receipt.staged.for_adapter(lambda *args: args, lambda *args: args)
        (self.data / INDEX).write_bytes(b"changed")
        (self.data / NEW_SHARD).unlink()
        self.assertEqual(
            receipt.staged.for_adapter(lambda *args: args, lambda *args: args), expected
        )

    def test_follow_receipt_binds_final_unrelated_retry_merge(self):
        writer.prepare(self.data, self.primary, self.state)
        self.update_snapshot()
        other = self.other()
        write(other, "other.json", {"unrelated": "remote"})
        unrelated = self.commit(other, "other.json")
        self.git(other, "push", "origin", f"HEAD:{writer.BRANCH}")
        with patch.object(writer, "push_existing", wraps=writer.push_existing) as push:
            result, receipt = writer.publish_with_follow_provenance(
                self.data, self.state, "Publish", self.follow_proof()
            )
        accepted = self.assert_follow_receipt(result, receipt, "Published validated data snapshot.")
        self.assertEqual(push.call_count, 2)
        self.assertTrue(writer.ancestor(self.remote, unrelated, accepted))
        self.assertNotEqual(
            receipt.staged.candidate_tree, writer.revision(self.remote, f"{accepted}^{{tree}}")
        )

    def test_follow_receipt_binds_equivalent_remote_after_lost_ack(self):
        writer.prepare(self.data, self.primary, self.state)
        self.update_snapshot()
        real_push = writer.push_existing
        accepted_candidate = None

        def lost_ack(checkout, expected):
            nonlocal accepted_candidate
            self.assertTrue(real_push(checkout, expected))
            accepted_candidate = writer.revision(checkout, "HEAD")
            other = self.other()
            write(other, "other.json", {"unrelated": "after the push"})
            self.commit(other, "other.json")
            self.git(other, "push", "origin", f"HEAD:{writer.BRANCH}")
            return False

        with patch.object(writer, "push_existing", side_effect=lost_ack):
            result, receipt = writer.publish_with_follow_provenance(
                self.data, self.state, "Publish", self.follow_proof()
            )
        accepted = self.assert_follow_receipt(
            result, receipt, "Validated data snapshot already published."
        )
        self.assertNotEqual(accepted, accepted_candidate)
        self.assertTrue(writer.ancestor(self.remote, accepted_candidate, accepted))

    def test_lost_ack_with_owned_change_still_refuses_publication_result(self):
        writer.prepare(self.data, self.primary, self.state)
        self.update_snapshot()
        real_push = writer.push_existing

        def lost_ack(checkout, expected):
            self.assertTrue(real_push(checkout, expected))
            other = self.other()
            write(other, writer.STATE[0], {"state": "changed after acceptance"})
            self.commit(other, writer.STATE[0])
            self.git(other, "push", "origin", f"HEAD:{writer.BRANCH}")
            return False

        with (
            patch.object(writer, "push_existing", side_effect=lost_ack),
            patch.object(writer, "_bind_published_follow") as bind,
            self.assertRaisesRegex(ValueError, "Data snapshot changed after publication"),
        ):
            writer.publish_with_follow_provenance(
                self.data, self.state, "Publish", self.follow_proof()
            )
        bind.assert_not_called()

    def test_noop_and_bad_follow_proof_keep_ordinary_result(self):
        writer.prepare(self.data, self.primary, self.state)
        original = writer.revision(self.remote, writer.BRANCH)
        with patch.object(writer, "validate_staged_follow_provenance") as verify:
            self.assertEqual(
                writer.publish_with_follow_provenance(
                    self.data, self.state, "No changes", self.follow_proof()
                ),
                (("No changes.", original), None),
            )
        verify.assert_not_called()

        self.update_snapshot()
        proof = self.follow_proof()
        proof = replace(proof, identity=replace(proof.identity, index_sha256="0" * 64))
        result, receipt = writer.publish_with_follow_provenance(
            self.data, self.state, "Publish", proof
        )
        self.assertIsNone(receipt)
        self.assertEqual(
            result,
            ("Published validated data snapshot.", writer.revision(self.remote, writer.BRANCH)),
        )

    def test_follow_binding_failure_does_not_replace_accepted_publication_result(self):
        writer.prepare(self.data, self.primary, self.state)
        self.update_snapshot()
        revision = writer.revision

        def unavailable(checkout, ref, **kwargs):
            if ref.endswith(f":{writer.PUBLIC}"):
                raise OSError("synthetic immutable public tree lookup failure")
            return revision(checkout, ref, **kwargs)

        with patch.object(writer, "revision", side_effect=unavailable):
            result, receipt = writer.publish_with_follow_provenance(
                self.data, self.state, "Publish", self.follow_proof()
            )
        self.assertIsNone(receipt)
        self.assertEqual(
            result, ("Published validated data snapshot.", revision(self.remote, writer.BRANCH))
        )

    def test_follow_receipt_ignores_replacement_commit_after_accepted_push(self):
        writer.prepare(self.data, self.primary, self.state)
        self.update_snapshot()
        real_push = writer.push_existing

        def push_and_replace(checkout, expected):
            self.assertTrue(real_push(checkout, expected))
            accepted = writer.revision(checkout, "HEAD")
            path = checkout / NEW_SHARD
            path.write_bytes(path.read_bytes() + b" ")
            self.git(checkout, "add", "--", NEW_SHARD)
            other_tree = self.git(checkout, "write-tree").decode("ascii").strip()
            self.git(checkout, "restore", "--staged", "--worktree", "--", NEW_SHARD)
            replacement = (
                self.git(
                    checkout, "commit-tree", other_tree, "-p", accepted, "-m", "Replacement view"
                )
                .decode("ascii")
                .strip()
            )
            self.git(checkout, "replace", accepted, replacement)
            self.assertNotEqual(
                writer.revision(checkout, f"{accepted}:{writer.PUBLIC}"),
                writer.revision(self.remote, f"{accepted}:{writer.PUBLIC}"),
            )
            return True

        with patch.object(writer, "push_existing", side_effect=push_and_replace):
            result, receipt = writer.publish_with_follow_provenance(
                self.data, self.state, "Publish", self.follow_proof()
            )
        self.assert_follow_receipt(result, receipt, "Published validated data snapshot.")

    def test_replacement_cannot_mask_true_owned_change_in_reconciled_commit(self):
        writer.prepare(self.data, self.primary, self.state)
        self.update_snapshot()
        real_push = writer.push_existing

        def lost_ack(checkout, expected):
            self.assertTrue(real_push(checkout, expected))
            candidate = writer.revision(checkout, "HEAD")
            other = self.other()
            shard = other / NEW_SHARD
            shard.write_bytes(shard.read_bytes() + b" ")
            changed = self.commit(other, NEW_SHARD)
            self.git(other, "push", "origin", f"HEAD:{writer.BRANCH}")
            self.assertEqual(writer.remote_tip(checkout), changed)
            original_tree = writer.revision(checkout, f"{candidate}^{{tree}}")
            replacement = (
                self.git(
                    checkout, "commit-tree", original_tree, "-p", candidate, "-m", "Masked view"
                )
                .decode("ascii")
                .strip()
            )
            self.git(checkout, "replace", changed, replacement)
            self.assertTrue(writer.same_snapshot(checkout, candidate, changed))
            self.assertNotEqual(
                writer.git(
                    checkout, "ls-tree", "-z", candidate, "--", *writer.OWNED, no_replace=True
                ).stdout,
                writer.git(
                    checkout, "ls-tree", "-z", changed, "--", *writer.OWNED, no_replace=True
                ).stdout,
            )
            return False

        with patch.object(writer, "push_existing", side_effect=lost_ack):
            result, receipt = writer.publish_with_follow_provenance(
                self.data, self.state, "Publish", self.follow_proof()
            )
        self.assertEqual(
            result,
            (
                "Validated data snapshot already published.",
                writer.revision(self.remote, writer.BRANCH),
            ),
        )
        self.assertIsNone(receipt)

    def test_external_diff_cannot_hide_true_private_state_change_after_lost_ack(self):
        writer.prepare(self.data, self.primary, self.state)
        self.update_snapshot()
        real_push = writer.push_existing

        def lost_ack(checkout, expected):
            self.assertTrue(real_push(checkout, expected))
            candidate = writer.revision(checkout, "HEAD")
            other = self.other()
            write(other, writer.STATE[0], {"state": "changed on the remote"})
            changed = self.commit(other, writer.STATE[0])
            self.git(other, "push", "origin", f"HEAD:{writer.BRANCH}")
            self.assertEqual(writer.remote_tip(checkout), changed)

            diff = checkout / ".git/trusted-diff"
            diff.write_bytes(b"#!/bin/sh\nexit 0\n")
            diff.chmod(0o755)
            self.git(checkout, "config", "diff.external", diff.as_posix())
            self.git(checkout, "config", "diff.trustExitCode", "true")
            self.assertTrue(writer.same_snapshot(checkout, candidate, changed))
            self.assertEqual(
                writer.revision(checkout, f"{candidate}:{writer.PUBLIC}"),
                writer.revision(checkout, f"{changed}:{writer.PUBLIC}"),
            )
            return False

        with patch.object(writer, "push_existing", side_effect=lost_ack):
            result, receipt = writer.publish_with_follow_provenance(
                self.data, self.state, "Publish", self.follow_proof()
            )
        self.assertEqual(
            result,
            (
                "Validated data snapshot already published.",
                writer.revision(self.remote, writer.BRANCH),
            ),
        )
        self.assertIsNone(receipt)

    def test_legacy_graft_cannot_invent_accepted_ancestry_for_follow_proof(self):
        writer.prepare(self.data, self.primary, self.state)
        self.update_snapshot()
        writer.stage_snapshot(self.data, self.state)
        tree = self.git(self.data, "write-tree").decode("ascii").strip()
        staged = writer.validate_staged_follow_provenance(self.data, tree, self.follow_proof())
        candidate = (
            self.git(self.data, "commit-tree", tree, "-m", "Original candidate").decode().strip()
        )
        unrelated = (
            self.git(self.data, "commit-tree", tree, "-m", "Unrelated exact tree").decode().strip()
        )
        self.assertNotEqual(candidate, unrelated)
        (self.data / ".git/info/grafts").write_text(f"{unrelated} {candidate}\n", encoding="ascii")
        self.assertTrue(writer.ancestor(self.data, candidate, unrelated))
        self.assertFalse(writer.ancestor(self.data, candidate, unrelated, no_replace=True))
        self.assertIsNone(writer._bind_published_follow(self.data, candidate, unrelated, staged))

    def test_unconfirmed_push_never_binds_a_follow_receipt(self):
        writer.prepare(self.data, self.primary, self.state)
        self.update_snapshot()
        original = writer.revision(self.remote, writer.BRANCH)
        with (
            patch.object(writer, "push_existing", return_value=False),
            patch.object(writer, "_bind_published_follow") as bind,
            self.assertRaisesRegex(ValueError, "Could not publish"),
        ):
            writer.publish_with_follow_provenance(
                self.data, self.state, "Publish", self.follow_proof()
            )
        bind.assert_not_called()
        self.assertEqual(writer.revision(self.remote, writer.BRANCH), original)

    def test_noop_and_valid_empty_export(self):
        writer.prepare(self.data, self.primary, self.state)
        observed = writer.revision(self.remote, writer.BRANCH)
        output = self.root / "writer outputs.txt"
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts/ingest_data_writer.py"),
                "publish",
                "data",
                "state",
                "--message",
                "No changes",
                "--github-output",
                str(output),
            ],
            cwd=self.root,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(
            result.stdout.splitlines(),
            ["No changes.", writer.publication_marker(self.data, observed)],
        )
        self.assertFalse(output.exists())
        (self.data / SHARD).unlink()
        (self.data / SIDECAR).unlink()
        self.write_public(self.data, None)
        self.assertEqual(
            writer.publish(self.data, self.state, "Empty snapshot")[0],
            "Published validated data snapshot.",
        )
        writer.validate_tree(self.remote, writer.BRANCH)

    def test_old_main_writer_catchup_and_ordinary_rollback(self):
        seed = writer.revision(self.remote, writer.BRANCH)
        write(
            self.primary,
            SHARD,
            [
                {"id": "open", "status": "open", "old_writer": True},
                {"id": "closed", "status": "closed"},
            ],
        )
        self.commit(self.primary, SHARD)
        self.git(self.primary, "push", "origin", "HEAD:refs/heads/main")
        self.assertFalse(writer.same_snapshot(self.remote, seed, "main"))
        self.git(self.data, "fetch", "origin", "main")
        self.git(self.data, "restore", "--source=FETCH_HEAD", "--worktree", "--", writer.PUBLIC)
        writer.prepare(self.data, self.primary, self.state)
        writer.publish(self.data, self.state, "Catch up old writer")
        self.assertTrue(writer.same_snapshot(self.remote, "main", writer.BRANCH))
        write(self.primary, ".github/workflows/ingest.yml", {"writer": "data"})
        activation = self.commit(self.primary, ".github/workflows/ingest.yml")
        self.git(self.primary, "push", "origin", "HEAD:refs/heads/main")
        data = self.other()
        state = self.root / "next-state"
        writer.prepare(data, self.primary, state)
        write(state, Path(writer.STATE[0]).name, {})
        writer.publish(data, state, "Data writer")
        self.git(self.primary, "revert", "--no-edit", activation)
        self.git(self.primary, "push", "origin", "HEAD:refs/heads/main")
        self.assertFalse(writer.same_snapshot(self.remote, "main", writer.BRANCH))
        self.git(self.primary, "fetch", "origin", writer.BRANCH)
        self.git(
            self.primary,
            "restore",
            "--source=FETCH_HEAD",
            "--staged",
            "--worktree",
            "--",
            *writer.OWNED,
        )
        self.git(self.primary, "commit", "-m", "Catch up main before reader rollback")
        self.git(self.primary, "push", "origin", "HEAD:refs/heads/main")
        self.assertTrue(writer.same_snapshot(self.remote, "main", writer.BRANCH))


if __name__ == "__main__":
    unittest.main()
