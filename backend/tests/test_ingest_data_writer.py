"""Exercise the ingest writer with synthetic snapshots and a file-only remote."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

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

    def test_noop_and_valid_empty_export(self):
        writer.prepare(self.data, self.primary, self.state)
        observed = writer.revision(self.remote, writer.BRANCH)
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts/ingest_data_writer.py"),
                "publish",
                "data",
                "state",
                "--message",
                "No changes",
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
