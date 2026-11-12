"""Checkout graph stamping preserves a classic entry and cached native assets."""

from pathlib import Path
import subprocess

import pytest

from internscout.asset_versions import AssetVersionError, version_assets
from internscout.core_graph import fingerprint


CLASSIC = '<script defer src="/js/buy.js"></script>'
MARKER = '<span id="buy-native-entry" hidden data-src="/js/buy/entry.mjs"></span>'
MODULES = {"entry.mjs": b'import "./form.mjs";\n', "form.mjs": b"export const form = 1;\n"}


def _put(root: Path, path: str, content: bytes) -> Path:
    file = root / path
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_bytes(content)
    return file


def _checkout(root: Path, html: str, *, modules: bool = True) -> Path:
    _put(root, "js/buy.js", b"window.fixture = true;\n")
    if modules:
        for name, data in MODULES.items():
            _put(root, f"js/buy/{name}", data)
    return _put(root, "employers/buy/index.html", html.encode())


def test_buy_stamps_only_a_bare_loader_marker_and_the_existing_classic_script(tmp_path):
    page = _checkout(tmp_path, CLASSIC + MARKER)
    assert version_assets(tmp_path).changed_files == 1
    digest = fingerprint(MODULES)
    assert f'data-src="/js/buy-modules/{digest}/entry.mjs"' in page.read_text()
    assert '<script defer src="/js/buy.js?v=' in page.read_text()
    generation = tmp_path / "js/buy-modules" / digest
    assert {path.name: path.read_bytes() for path in generation.iterdir()} == MODULES
    assert version_assets(tmp_path).changed_files == 0


@pytest.mark.parametrize("invalid", [
    '<script type="module" src="/js/buy/entry.mjs"></script>',
    MARKER.replace("/js/buy/entry.mjs", "https://outside.example/entry.mjs"),
    MARKER.replace("entry.mjs", "entry.mjs?v=1"),
    MARKER.replace(" hidden", ""),
    MARKER + MARKER,
])
def test_buy_marker_must_use_the_classic_loader_and_canonical_graph(tmp_path, invalid):
    page = _checkout(tmp_path, CLASSIC + invalid)
    original = page.read_bytes()
    with pytest.raises(AssetVersionError, match="Buy"):
        version_assets(tmp_path)
    assert page.read_bytes() == original
    assert not (tmp_path / "js/buy-modules").exists()


def test_classic_rollback_can_still_serve_cached_buy_modules_from_git(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()

    def git(*args):
        subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)

    git("init", "--quiet")
    git("config", "core.autocrlf", "false")
    git("config", "user.name", "Fixture")
    git("config", "user.email", "fixture@example.invalid")
    docs = repo / "docs"
    _checkout(docs, CLASSIC + MARKER)
    git("add", "docs")
    git("commit", "--quiet", "-m", "Native checkout")
    git("rm", "--quiet", "-r", "docs/js/buy")
    _checkout(docs, CLASSIC, modules=False)
    git("add", "docs")
    git("commit", "--quiet", "-m", "Restore classic checkout")

    stage = tmp_path / "stage"
    page = _checkout(stage, CLASSIC, modules=False)
    version_assets(stage, retain_core_git=repo)
    generation = stage / "js/buy-modules" / fingerprint(MODULES)
    assert {path.name: path.read_bytes() for path in generation.iterdir()} == MODULES
    assert page.read_text().startswith('<script defer src="/js/buy.js?v=')
    assert "buy-native-entry" not in page.read_text()
