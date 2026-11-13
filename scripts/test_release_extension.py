"""Offline package reproducibility and provenance checks; no external services."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import package_extension
import profile_bridge
import release_extension
from release_extension import write_record


def seed_bridge(root):
    for path in (
        profile_bridge.SOURCE,
        profile_bridge.DASHBOARD,
        profile_bridge.BACKGROUND,
        profile_bridge.GENERATOR,
    ):
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(profile_bridge.ROOT / path, target)


class ReleasePackageTests(unittest.TestCase):
    def test_profile_bridge_copies_are_current(self):
        profile_bridge.check_copies(profile_bridge.generated_copies(profile_bridge.ROOT))

    def test_package_rejects_stale_bridge_and_uses_regenerated_entry(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            seed_bridge(root)
            ext = root / "extension"
            (ext / "manifest.json").write_text('{"version": "0.0.1"}', encoding="utf-8")
            src = root / profile_bridge.SOURCE
            data = json.loads(src.read_text(encoding="utf-8"))
            data[-1]["width"] = 61
            src.write_text(json.dumps(data), encoding="utf-8")
            background = root / profile_bridge.BACKGROUND
            before = background.read_bytes()
            dashboard = (root / profile_bridge.DASHBOARD).read_bytes()
            command = [sys.executable, str(root / profile_bridge.GENERATOR)]
            with (
                patch.object(package_extension, "ROOT", root),
                patch.object(package_extension, "EXT", ext),
                patch.object(package_extension, "DIST", root / "dist"),
            ):
                with self.assertRaisesRegex(ValueError, "stale profile bridge declaration"):
                    package_extension.build()
                self.assertFalse((root / "dist").exists())
                self.assertEqual(background.read_bytes(), before)

                subprocess.run(command, check=True)
                updated = before.replace(b"str(p.work_auth, 60)", b"str(p.work_auth, 61)")
                self.assertNotEqual(updated, before)
                self.assertEqual(background.read_bytes(), updated)
                self.assertEqual((root / profile_bridge.DASHBOARD).read_bytes(), dashboard)
                with zipfile.ZipFile(package_extension.build()) as archive:
                    self.assertEqual(
                        archive.read("background/index.js"), updated.replace(b"\r\n", b"\n")
                    )

    def test_generator_preflights_both_targets_before_writing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            seed_bridge(root)
            source = root / profile_bridge.SOURCE
            fields = json.loads(source.read_text(encoding="utf-8"))
            fields[-1]["key"] = "work_permission"
            source.write_text(json.dumps(fields), encoding="utf-8")
            dashboard = root / profile_bridge.DASHBOARD
            background = root / profile_bridge.BACKGROUND
            before_dashboard = dashboard.read_bytes().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
            before_background = background.read_bytes()
            dashboard.write_bytes(before_dashboard)
            broken = before_background.replace(b"function cleanProfile(p) {", b"function other(p) {")
            background.write_bytes(broken)
            command = [sys.executable, str(root / profile_bridge.GENERATOR)]

            failed = subprocess.run(command, capture_output=True)
            self.assertEqual(failed.returncode, 1)
            self.assertIn(b"extension/background/index.js", failed.stderr)
            self.assertEqual(dashboard.read_bytes(), before_dashboard)
            self.assertEqual(background.read_bytes(), broken)

            background.write_bytes(before_background)
            subprocess.run(command, check=True)
            self.assertEqual(
                dashboard.read_bytes(),
                before_dashboard.replace(b'work_auth: p.work_auth || ""', b'work_permission: p.work_permission || ""'),
            )
            self.assertEqual(
                background.read_bytes(),
                before_background.replace(b"work_auth: str(p.work_auth,", b"work_permission: str(p.work_permission,"),
            )
            subprocess.run([*command, "--check"], check=True)

    def test_release_record_rejects_untracked_bridge_source(self):
        with (
            patch.object(release_extension.subprocess, "check_output", side_effect=[b"", ""]),
            patch.object(package_extension, "build") as build,
        ):
            with self.assertRaisesRegex(SystemExit, "untracked package input: shared/profile_bridge"):
                release_extension.main()
            build.assert_not_called()

    def test_rebuild_ignores_checkout_timestamps_and_separates_identities(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ext = root / "extension"
            ext.mkdir()
            manifest = {
                "manifest_version": 3,
                "version": "0.5.8",
                "key": "developer identity",
                "permissions": ["storage"],
                "content_scripts": [
                    {
                        "matches": [
                            "https://internscout.org/*",
                            "http://localhost/*",
                            "http://127.0.0.1/*",
                        ]
                    }
                ],
            }
            (ext / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            runtime = ext / "runtime.js"
            runtime.write_bytes(b"const candidate = true;\n")
            (ext / "test").mkdir()
            (ext / "test" / "fixture.js").write_text("must not ship", encoding="utf-8")
            (ext / "README.md").write_text("developer notes", encoding="utf-8")
            with (
                patch.object(package_extension, "EXT", ext),
                patch.object(package_extension, "DIST", root / "dist"),
            ):
                developer = package_extension.build()
                first = developer.read_bytes()
                for p in ext.rglob("*"):
                    if p.is_file():
                        os.utime(p, (1800000000, 1800000000))
                runtime.write_bytes(b"const candidate = true;\r\n")
                self.assertEqual(first, package_extension.build().read_bytes())
                webstore = package_extension.build(webstore=True)
                for p, key_expected in [(developer, True), (webstore, False)]:
                    with zipfile.ZipFile(p) as z:
                        self.assertEqual(set(z.namelist()), {"manifest.json", "runtime.js"})
                        packaged = json.loads(z.read("manifest.json"))
                        self.assertEqual("key" in packaged, key_expected)
                        self.assertEqual(packaged["version"], "0.5.8")
                        self.assertEqual(packaged["permissions"], manifest["permissions"])
                        self.assertEqual(
                            packaged["content_scripts"][0]["matches"], ["https://internscout.org/*"]
                        )
                output = root / "record.json"
                record = write_record([developer, webstore], "a" * 40, output)
                self.assertEqual(json.loads(output.read_text(encoding="utf-8")), record)
                self.assertEqual(record["source_commit"], "a" * 40)
                self.assertEqual(record["assets"][0]["sha256"], hashlib.sha256(first).hexdigest())
                runtime.write_bytes(b"const candidate = false;\n")
                changed = package_extension.build()
                self.assertNotEqual(
                    first,
                    changed.read_bytes(),
                    "changed source must not look like an identical retry",
                )

    def test_publish_retry_verifies_existing_assets_before_any_upload(self):
        bash = shutil.which("bash")
        if not bash and Path("C:/Program Files/Git/bin/bash.exe").exists():
            bash = "C:/Program Files/Git/bin/bash.exe"
        if not bash:
            self.skipTest("Bash is needed for the release publisher fixture")
        # Exercise the actual workflow publisher with a shell function standing in for gh. Nothing
        # contacts GitHub; the remote assets and upload log are local temporary fixtures.
        stub = r'''
        gh() {
          [[ "$1" == release ]] || return 90
          local action="$2"; shift 2
          case "$action" in
            view)
              [[ "$RELEASE_EXISTS" == yes ]] || return 1
              if [[ "$*" == *--json* ]]; then
                for file in "$REMOTE"/*; do
                  [[ ! -f "$file" ]] || basename "$file"
                done
              fi ;;
            download)
              local name="" destination=""
              while [[ $# -gt 0 ]]; do
                case "$1" in
                  --pattern) name="$2"; shift ;;
                  --dir) destination="$2"; shift ;;
                esac
                shift
              done
              cp "$REMOTE/$name" "$destination/$name" ;;
            upload|create) printf '%s\n' "$action $*" >> "$CALL_LOG" ;;
            *) return 91 ;;
          esac
        }
        export -f gh
        source "$PUBLISHER"
        '''
        publisher = Path(__file__).with_name("publish_extension_release.sh").resolve()
        for scenario in ["identical", "changed-zip", "changed-source", "missing", "new"]:
            with (
                self.subTest(scenario=scenario),
                tempfile.TemporaryDirectory(prefix="extension release ") as tmp,
            ):
                root = Path(tmp)
                remote = root / "remote"
                remote.mkdir()
                files = [root / n for n in ["developer.zip", "webstore.zip", "source.json"]]
                for i, p in enumerate(files):
                    p.write_text(f"candidate {i}", encoding="utf-8")
                    shutil.copyfile(p, remote / p.name)
                if scenario == "changed-zip":
                    (remote / "webstore.zip").write_text("old build", encoding="utf-8")
                if scenario == "changed-source":
                    (remote / "source.json").write_text("another commit", encoding="utf-8")
                if scenario == "missing":
                    (remote / "webstore.zip").unlink()
                calls = root / "calls.log"
                env = {
                    **os.environ,
                    "DEVELOPER": files[0].as_posix(),
                    "WEBSTORE": files[1].as_posix(),
                    "RECORD": files[2].as_posix(),
                    "RUNNER_TEMP": root.as_posix(),
                    "REMOTE": remote.as_posix(),
                    "CALL_LOG": calls.as_posix(),
                    "PUBLISHER": publisher.as_posix(),
                    "GITHUB_REF_NAME": "ext-v0.5.8",
                    "RELEASE_EXISTS": "no" if scenario == "new" else "yes",
                }
                result = subprocess.run([bash, "-c", stub], env=env, capture_output=True, text=True)
                log = calls.read_text(encoding="utf-8") if calls.exists() else ""
                if scenario.startswith("changed"):
                    self.assertNotEqual(result.returncode, 0, result.stderr)
                    self.assertIn("Refusing to replace", result.stdout)
                    self.assertEqual(log, "", "all assets are checked before any upload")
                else:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    if scenario == "identical":
                        self.assertEqual(log, "", "an identical retry publishes nothing")
                    elif scenario == "missing":
                        self.assertEqual(len(log.splitlines()), 1)
                        self.assertIn("upload ext-v0.5.8", log)
                        self.assertIn("webstore.zip", log)
                        self.assertNotIn("clobber", log)
                    else:
                        self.assertIn("create ext-v0.5.8", log)
                        self.assertIn("--verify-tag", log)


if __name__ == "__main__":
    unittest.main()
