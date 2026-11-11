"""Test a local-only fetch helper against a scratch Git origin."""

import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "fetch_listing_data", ROOT / "scripts/fetch_listing_data.py"
)
fetch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetch)


class FetchTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="public listing test ")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        env = patch.dict(
            os.environ,
            {
                "GIT_ALLOW_PROTOCOL": "file",
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_CONFIG_GLOBAL": str(self.root / "unused-git-config"),
                "GIT_AUTHOR_NAME": "Fixture",
                "GIT_AUTHOR_EMAIL": "test@example.invalid",
                "GIT_COMMITTER_NAME": "Fixture",
                "GIT_COMMITTER_EMAIL": "test@example.invalid",
            },
        )
        env.start()
        self.addCleanup(env.stop)
        self.bare, self.writer, self.local = (
            self.root / n for n in ("origin", "writer", "consumer")
        )
        self.git(self.root, "init", "--bare", "--initial-branch=main", str(self.bare))
        self.git(self.root, "init", "--initial-branch=main", str(self.writer))
        self.git(self.writer, "remote", "add", "origin", str(self.bare))
        self.put(self.writer, "docs/index.html", b"site code")
        self.put(self.writer, "backend/data/reference.json", b"reference")
        self.commit(self.writer)
        self.git(self.writer, "push", "origin", "HEAD:refs/heads/main")
        self.git(self.writer, "checkout", "-b", "data")
        self.put(self.writer, "docs/data/listings/old.json", b"old fixture")
        self.put(self.writer, "docs/data/index.json", b"first snapshot")
        self.put(self.writer, "backend/data/registry.json", b"not for local public fetch")
        self.seed = self.commit(self.writer)
        self.git(self.writer, "push", "origin", "HEAD:refs/heads/data")
        self.git(self.root, "clone", "--branch", "main", str(self.bare), str(self.local))
        self.target = self.local / "docs/data"

    def git(self, root, *args):
        return fetch.git(root, *args)

    def put(self, root, name, data):
        p = root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)

    def commit(self, repo):
        self.git(repo, "add", "-A")
        self.git(repo, "commit", "-m", "Synthetic update")
        return self.git(repo, "rev-parse", "HEAD").decode().strip()

    def advance(self):
        (self.writer / "docs/data/listings/old.json").unlink()
        self.put(self.writer, "docs/data/listings/new.json", b"new fixture")
        self.put(self.writer, "docs/data/index.json", b"second snapshot")
        self.put(self.writer, "backend/data/registry.json", b"updated private fixture")
        new = self.commit(self.writer)
        self.git(self.writer, "push", "origin", "HEAD:refs/heads/data")
        return new

    def test_pin_survives_remote_advance_and_installs_only_public(self):
        actual = fetch.materialize

        def after_pin(root, pin, stage):
            self.assertEqual(pin, self.seed)
            self.advance()
            actual(root, pin, stage)

        with patch.object(fetch, "materialize", side_effect=after_pin):
            self.assertEqual(fetch.install(self.local), self.seed)
        self.assertEqual((self.target / "index.json").read_bytes(), b"first snapshot")
        self.assertTrue((self.target / "listings/old.json").is_file())
        self.assertFalse((self.local / "backend/data/registry.json").exists())
        self.assertEqual((self.local / "docs/index.html").read_bytes(), b"site code")
        self.assertEqual((self.local / "backend/data/reference.json").read_bytes(), b"reference")

    def test_updates_previous_snapshot_and_preserves_deletions(self):
        self.assertEqual(fetch.install(self.local), self.seed)
        latest = self.advance()
        self.assertEqual(fetch.install(self.local), latest)
        self.assertEqual(fetch.install(self.local), latest)
        self.assertFalse((self.target / "listings/old.json").exists())
        self.assertEqual((self.target / "listings/new.json").read_bytes(), b"new fixture")

    def test_second_installer_cannot_enter_the_first_worktrees_transaction(self):
        actual = fetch.materialize

        def while_locked(root, pin, stage):
            with self.assertRaisesRegex(ValueError, "already locked"):
                fetch.install(root)
            actual(root, pin, stage)

        with patch.object(fetch, "materialize", side_effect=while_locked):
            self.assertEqual(fetch.install(self.local), self.seed)
        self.assertEqual(fetch.install(self.local), self.seed)

    def test_exact_preexisting_snapshot_can_be_adopted(self):
        self.put(self.local, "docs/data/listings/old.json", b"old fixture")
        self.put(self.local, "docs/data/index.json", b"first snapshot")
        self.assertEqual(fetch.install(self.local), self.seed)
        latest = self.advance()
        self.assertEqual(fetch.install(self.local), latest)

    def test_tracked_snapshot_is_untouched(self):
        self.put(self.local, "docs/data/index.json", b"tracked content")
        self.commit(self.local)
        with self.assertRaisesRegex(ValueError, "tracked"):
            fetch.install(self.local)
        self.assertEqual((self.target / "index.json").read_bytes(), b"tracked content")

    def test_unrecognized_and_mixed_snapshots_are_untouched(self):
        self.put(self.local, "docs/data/local.txt", b"local work")
        with self.assertRaisesRegex(ValueError, "not installed unchanged"):
            fetch.install(self.local)
        self.assertEqual((self.target / "local.txt").read_bytes(), b"local work")
        (self.target / "local.txt").unlink()
        self.target.rmdir()
        fetch.install(self.local)
        self.advance()
        self.put(self.local, "docs/data/local.txt", b"keep me")
        with self.assertRaisesRegex(ValueError, "not installed unchanged"):
            fetch.install(self.local)
        self.assertEqual((self.target / "local.txt").read_bytes(), b"keep me")
        self.assertTrue((self.target / "listings/old.json").is_file())
        self.assertFalse((self.target / "listings/new.json").exists())

    def test_failed_rename_restores_previous_tree_and_marker(self):
        fetch.install(self.local)
        before = fetch.fingerprint(self.target)
        marker = self.local / ".git/internscout-public-snapshot.json"
        stored = marker.read_bytes()
        latest = self.advance()

        for fail_at in ("incoming", marker.name):
            with self.subTest(fail_at=fail_at):

                def fail_install(src, dest):
                    if src.name == fail_at or (fail_at == marker.name and dest.name == fail_at):
                        raise OSError("Simulated rename failure")
                    os.replace(src, dest)

                with self.assertRaises(OSError):
                    fetch.install(self.local, replace=fail_install)
                self.assertEqual(fetch.fingerprint(self.target), before)
                self.assertEqual(marker.read_bytes(), stored)
        self.assertEqual(fetch.install(self.local), latest)

    def test_keyboard_interrupt_after_each_directory_rename_restores_old_snapshot(self):
        fetch.install(self.local)
        before = fetch.fingerprint(self.target)
        marker = self.local / ".git/internscout-public-snapshot.json"
        stored = marker.read_bytes()
        latest = self.advance()

        for phase in ("backup", "install"):
            with self.subTest(phase=phase):

                def interrupt_after_rename(src, dest):
                    os.replace(src, dest)
                    if (phase == "backup" and dest.name == "previous") or (
                        phase == "install" and src.name == "incoming"
                    ):
                        raise KeyboardInterrupt

                with self.assertRaises(KeyboardInterrupt):
                    fetch.install(self.local, replace=interrupt_after_rename)
                self.assertEqual(fetch.fingerprint(self.target), before)
                self.assertEqual(marker.read_bytes(), stored)
                self.assertFalse(marker.with_suffix(".lock").exists())
        self.assertEqual(fetch.install(self.local), latest)

    def test_marker_cleanup_failure_does_not_strand_install_lock(self):
        fetch.install(self.local)
        self.advance()
        marker = self.local / ".git/internscout-public-snapshot.json"
        before = marker.read_bytes()
        real_unlink = Path.unlink

        def fail_marker_replace(src, dest):
            if dest == marker:
                raise OSError("Simulated marker rename failure")
            os.replace(src, dest)

        def fail_marker_cleanup(path, *args, **kwargs):
            if path.name.startswith("internscout-marker-"):
                raise OSError("Simulated marker cleanup failure")
            return real_unlink(path, *args, **kwargs)

        with patch.object(Path, "unlink", fail_marker_cleanup), self.assertRaises(OSError):
            fetch.install(self.local, replace=fail_marker_replace)
        self.assertFalse(marker.with_suffix(".lock").exists())
        self.assertEqual(marker.read_bytes(), before)
        self.assertEqual((self.target / "index.json").read_bytes(), b"first snapshot")

    def test_missing_branch_refuses_without_writes(self):
        self.git(self.bare, "update-ref", "-d", "refs/heads/data")
        with self.assertRaisesRegex(ValueError, "fetch"):
            fetch.install(self.local)
        self.assertFalse(self.target.exists())
        self.assertFalse((self.local / ".git/internscout-public-snapshot.json").exists())

    def test_windows_unsafe_paths_and_archive_scope(self):
        for name in (
            "../escape",
            "dir/../../escape",
            "C:/escaped",
            "dir\\escape",
            "//host/path",
            "folder:stream",
            "CON.json",
            "dir/NUL",
            "dir/trailing.",
            "dir/trailing ",
            ".git/index",
        ):
            with self.subTest(name=name), self.assertRaises(ValueError):
                fetch.parts_of(name)
        self.put(self.writer, ".gitattributes", b"docs/data/listings/old.json export-ignore\n")
        self.commit(self.writer)
        self.git(self.writer, "push", "origin", "HEAD:refs/heads/data")
        with self.assertRaisesRegex(ValueError, "Archive omitted"):
            fetch.install(self.local)
        self.assertFalse(self.target.exists())


if __name__ == "__main__":
    unittest.main()
