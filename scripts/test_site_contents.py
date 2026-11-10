"""Publication-boundary tests, independent of the large generated site."""
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
import tempfile
import unittest

import check_site_contents as checker


class SiteContentsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.patterns = checker.read_allowlist(checker.DEFAULT_ALLOWLIST)

    def put(self, name):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("fixture", encoding="utf-8")
        return path

    def test_public_assets_and_generated_families(self):
        names = ["index.html", ".nojekyll", "widget/README.md", "employers/buy/index.html",
                 "fonts/OFL-IBM-Plex-Sans.txt", "js/core.js", "data/listings/MA.desc.json",
                 "data/listings/Canada.json", "data/listings/remote.json", "data/roles/_.json",
                 "data/page-content-dates.json", "data/widget.json", "sitemap.xml", "llms-full.txt",
                 "internships/index.html", "internships/at/fixture-employer/index.html",
                 "internships/near/boston/computer-science/feed.xml", "numbers/index.html"]
        for name in names:
            self.put(name)
        files, problems = checker.audit(self.root, self.patterns)
        self.assertEqual(problems, [])
        self.assertEqual(files, sorted(names))

    def test_unexpected_files_including_inside_allowed_directories(self):
        for name in ["stray.md", "widget/notes.md", "widget/README.md.bak", "js/notes.md",
                     "data/listings/notes.json", "data/roles/private.json", ".env",
                     "internships/near/boston/notes.md", "internships/at/fixture/debug.txt",
                     "product-review/CONTEXT.md", "coverage-research/result.json"]:
            with self.subTest(name=name):
                path = self.put(name)
                _, problems = checker.audit(self.root, self.patterns)
                self.assertIn(f"unexpected file: {name}", problems)
                path.unlink()

    def test_symlinks_are_rejected_even_for_allowed_names(self):
        target = self.put("index.html")
        link = self.root / "privacy.html"
        try:
            link.symlink_to(target)
        except OSError:
            self.skipTest("symlink creation unavailable on this platform")
        _, problems = checker.audit(self.root, self.patterns)
        self.assertIn("filesystem link: privacy.html", problems)
        link.unlink()
        (self.root / "widget").symlink_to(self.root, target_is_directory=True)
        _, problems = checker.audit(self.root, self.patterns)
        self.assertIn("filesystem link: widget", problems)
        _, problems = checker.audit(self.root / "widget", self.patterns)
        self.assertEqual(problems, ["site root must be a real directory"])

    def test_empty_unknown_directories_and_missing_root_fail(self):
        self.put("index.html")
        (self.root / "private").mkdir()
        self.assertIn("empty directory: private", checker.audit(self.root, self.patterns)[1])
        self.assertTrue(checker.audit(self.root / "missing", self.patterns)[1])

    def test_cli_failure_and_inventory(self):
        self.put("widget/README.md")
        with redirect_stdout(StringIO()) as output:
            self.assertEqual(checker.main([str(self.root), "--list"]), 0)
        self.assertIn("widget/README.md", output.getvalue())
        self.put("stray.md")
        with redirect_stdout(StringIO()) as output:
            self.assertEqual(checker.main([str(self.root)]), 1)
        self.assertIn("unexpected file: stray.md", output.getvalue())


if __name__ == "__main__":
    unittest.main()
