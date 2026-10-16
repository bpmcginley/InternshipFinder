"""Offline package reproducibility and provenance checks; no external services."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import package_extension
from release_extension import write_record


class ReleasePackageTests(unittest.TestCase):
    def test_rebuild_ignores_checkout_timestamps_and_separates_identities(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ext = root / "extension"
            ext.mkdir()
            manifest = {"manifest_version": 3, "version": "0.5.8", "key": "developer identity",
                        "permissions": ["storage"], "content_scripts": [{"matches": [
                            "https://internscout.org/*", "http://localhost/*", "http://127.0.0.1/*"]}]}
            (ext / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            runtime = ext / "runtime.js"
            runtime.write_bytes(b"const candidate = true;\n")
            (ext / "test").mkdir()
            (ext / "test" / "fixture.js").write_text("must not ship", encoding="utf-8")
            (ext / "README.md").write_text("developer notes", encoding="utf-8")
            with patch.object(package_extension, "EXT", ext), patch.object(package_extension, "DIST", root / "dist"):
                developer = package_extension.build()
                first = developer.read_bytes()
                for p in ext.rglob("*"):
                    if p.is_file():
                        os.utime(p, (1800000000, 1800000000))
                self.assertEqual(first, package_extension.build().read_bytes())
                webstore = package_extension.build(webstore=True)
                for p, key_expected in [(developer, True), (webstore, False)]:
                    with zipfile.ZipFile(p) as z:
                        self.assertEqual(set(z.namelist()), {"manifest.json", "runtime.js"})
                        packaged = json.loads(z.read("manifest.json"))
                        self.assertEqual("key" in packaged, key_expected)
                        self.assertEqual(packaged["version"], "0.5.8")
                        self.assertEqual(packaged["permissions"], manifest["permissions"])
                        self.assertEqual(packaged["content_scripts"][0]["matches"], ["https://internscout.org/*"])
                output = root / "record.json"
                record = write_record([developer, webstore], "a" * 40, output)
                self.assertEqual(json.loads(output.read_text(encoding="utf-8")), record)
                self.assertEqual(record["source_commit"], "a" * 40)
                self.assertEqual(record["assets"][0]["sha256"], hashlib.sha256(first).hexdigest())
                runtime.write_bytes(b"const candidate = false;\n")
                changed = package_extension.build()
                self.assertNotEqual(first, changed.read_bytes(), "changed source must not look like an identical retry")

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
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory(prefix="extension release ") as tmp:
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
                env = {**os.environ, "DEVELOPER": files[0].as_posix(), "WEBSTORE": files[1].as_posix(),
                       "RECORD": files[2].as_posix(), "RUNNER_TEMP": root.as_posix(),
                       "REMOTE": remote.as_posix(), "CALL_LOG": calls.as_posix(),
                       "PUBLISHER": publisher.as_posix(), "GITHUB_REF_NAME": "ext-v0.5.8",
                       "RELEASE_EXISTS": "no" if scenario == "new" else "yes"}
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
