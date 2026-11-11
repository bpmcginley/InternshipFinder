"""Asset fingerprints must change only real local resource URLs."""

import hashlib
from datetime import datetime
import json
import os
from pathlib import Path
import subprocess
import tarfile

import pytest

from internscout.asset_versions import AssetVersionError, main, version_assets
from internscout import core_graph
from internscout.core_graph import fingerprint as core_fingerprint
from internscout.page_dates import fingerprint

from golden_build import STAMP


def _put(root, name, content):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content if isinstance(content, bytes) else content.encode("utf-8"))
    return path


def _hash(content):
    return hashlib.sha256(content).hexdigest()[:12]


def _core_site(root, profile, *, extra=False):
    names = ["account.mjs", "bridge.mjs", "index.mjs", "listings.mjs", "profile.mjs", "ranking.mjs"]
    if extra:
        names.append("new-leaf2.mjs")
    modules = {name: b"const fixture = true;\n" for name in names}
    modules["entry.mjs"] = b"".join(f'import "./{name}";\n'.encode() for name in names)
    modules["profile.mjs"] = profile
    for name, content in modules.items():
        _put(root, f"js/core/{name}", content)
    page = _put(root, "index.html", '<script type="module" src="js/core/entry.mjs"></script>')
    return page, modules


def test_core_graph_leaf_change_preserves_prior_bare_urls_across_fresh_sites(tmp_path):
    previous = None
    expected = {}
    for generation in range(3):
        root = tmp_path / str(generation)
        page, modules = _core_site(root, f"export const version = {generation};\n".encode(), extra=generation == 2)
        digest = core_fingerprint(modules)
        expected[digest] = modules
        assert version_assets(root, retain_core_from=previous).changed_files == 1
        assert page.read_text() == f'<script type="module" src="/js/modules/{digest}/entry.mjs"></script>'
        previous = root / "js/modules"
        assert {
            folder.name: {path.name: path.read_bytes() for path in folder.iterdir()}
            for folder in previous.iterdir()
        } == expected
        assert version_assets(root).changed_files == 0


def test_corrupt_retained_core_or_invalid_html_leaves_fresh_staging_untouched(tmp_path):
    previous, current = tmp_path / "previous", tmp_path / "current"
    _, old = _core_site(previous, b"export const version = 1;\n")
    page, _ = _core_site(current, b"export const version = 2;\n")
    version_assets(previous)
    retained = previous / "js/modules"
    (retained / core_fingerprint(old) / "profile.mjs").write_bytes(b"corrupt")
    source = page.read_bytes()
    with pytest.raises(AssetVersionError, match="does not match its fingerprint"):
        version_assets(current, retain_core_from=retained)
    assert page.read_bytes() == source and not (current / "js/modules").exists()
    page.write_bytes(source + b'<script src="missing.js"></script>')
    with pytest.raises(AssetVersionError, match="missing or invalid"):
        version_assets(current)
    assert not (current / "js/modules").exists()


def test_classic_rollback_preserves_every_previously_published_core_url(tmp_path):
    deployed, rollback = tmp_path / "deployed", tmp_path / "rollback"
    _, modules = _core_site(deployed, b"export const version = 2;\n")
    version_assets(deployed)
    classic = b"window.IS = {};\n"
    _put(rollback, "js/core.js", classic)
    page = _put(rollback, "index.html", '<script defer src="js/core.js"></script>')
    version_assets(rollback, retain_core_from=deployed / "js/modules")
    assert page.read_text() == f'<script defer src="js/core.js?v={_hash(classic)}"></script>'
    for name, data in modules.items():
        assert (rollback / "js/modules" / core_fingerprint(modules) / name).read_bytes() == data


def test_git_retention_reads_committed_generations_and_rejects_stale_staging(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()

    def git(*args):
        return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True).stdout

    git("init", "--quiet")
    git("config", "core.autocrlf", "true")
    git("config", "user.name", "Fixture")
    git("config", "user.email", "fixture@example.invalid")
    attributes = Path(__file__).resolve().parents[2] / ".gitattributes"
    (repo / ".gitattributes").write_bytes(attributes.read_bytes())
    first, second = b"export const version = 1;\n", b"export const version = 2;\n"
    _, initial = _core_site(repo / "docs", first)
    git("add", ".gitattributes", "docs")
    git("commit", "--quiet", "-m", "First Core")
    first_ref = git("rev-parse", "HEAD").decode().strip()
    _, latest = _core_site(repo / "docs", second, extra=True)
    git("add", "docs")
    git("commit", "--quiet", "-m", "Second Core")
    # Force a fresh checkout while autocrlf is on. Modules retain canonical Git LF bytes.
    for name in latest:
        (repo / "docs/js/core" / name).unlink()
    git("checkout", "--", "docs/js/core")
    assert {name: (repo / "docs/js/core" / name).read_bytes() for name in latest} == latest
    git("replace", "HEAD", first_ref)
    stage = tmp_path / "stage"
    page, _ = _core_site(stage, first)
    with pytest.raises(AssetVersionError, match="do not match the pinned Git checkout"):
        version_assets(stage, retain_core_git=repo)
    assert "js/core/entry.mjs" in page.read_text() and not (stage / "js/modules").exists()
    _core_site(stage, second, extra=True)
    assert main([str(stage), "--retain-core-git", str(repo)]) == 0
    assert {path.name for path in (stage / "js/modules").iterdir()} == {
        core_fingerprint(initial), core_fingerprint(latest),
    }


def test_git_retention_recovers_classic_after_unpublishable_main_merge(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    repo.mkdir()

    def git(*args):
        return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True).stdout

    git("init", "--quiet", "-b", "main")
    git("config", "core.autocrlf", "false")
    git("config", "user.name", "Fixture")
    git("config", "user.email", "fixture@example.invalid")
    _, valid = _core_site(repo / "docs", b"export const version = 1;\n")
    git("add", "docs")
    git("commit", "--quiet", "-m", "Publishable Core")
    valid_ref = git("rev-parse", "HEAD").decode().strip()
    git("switch", "--quiet", "-c", "candidate")
    invalid_source = b"export { name }\nfrom './missing.mjs';\n"
    _core_site(repo / "docs", invalid_source)
    git("add", "docs")
    git("commit", "--quiet", "-m", "Unpublishable Core")
    git("switch", "--quiet", "main")
    git("merge", "--quiet", "--no-ff", "candidate")
    invalid_stage = tmp_path / "invalid"
    _core_site(invalid_stage, invalid_source)
    with pytest.raises(AssetVersionError, match="declaration exports"):
        version_assets(invalid_stage, retain_core_git=repo)
    assert not (invalid_stage / "js/modules").exists()

    git("rm", "--quiet", "-r", "docs/js/core")
    classic_html = '<script defer src="js/core.js"></script>'
    _put(repo, "docs/index.html", classic_html)
    git("add", "docs/index.html")
    git("commit", "--quiet", "-m", "Restore classic Core")
    rollback = tmp_path / "rollback"
    _put(rollback, "js/core.js", b"window.IS = {};\n")
    page = _put(rollback, "index.html", classic_html)
    git_reader = core_graph._git

    def unavailable_blob(repo, *args):
        if args == ("show", f"{valid_ref}:docs/js/core/profile.mjs"):
            raise core_graph.CoreGraphError("Cannot read Core generation from Git")
        return git_reader(repo, *args)

    with monkeypatch.context() as patch:
        patch.setattr(core_graph, "_git", unavailable_blob)
        with pytest.raises(AssetVersionError, match="Cannot read Core generation from Git"):
            version_assets(rollback, retain_core_git=repo)
    assert page.read_text() == classic_html and not (rollback / "js/modules").exists()
    assert version_assets(rollback, retain_core_git=repo).changed_files == 1
    generation, = (rollback / "js/modules").iterdir()
    assert generation.name == core_fingerprint(valid)
    assert {path.name: path.read_bytes() for path in generation.iterdir()} == valid


@pytest.mark.parametrize("source", [b'import "../outside.mjs";', b'const later = () => import("./ranking.mjs");'])
def test_core_graph_rejects_external_and_dynamic_imports_before_writing(tmp_path, source):
    page, _ = _core_site(tmp_path, source)
    with pytest.raises(AssetVersionError, match="static sibling imports"):
        version_assets(tmp_path)
    assert "js/core/entry.mjs" in page.read_text() and not (tmp_path / "js/modules").exists()


@pytest.mark.parametrize(
    "source",
    [
        b"export { name }\nfrom './missing.mjs';\n",
        b"export\n/* clause */ { name }\nfrom './missing.mjs';\n",
        b"export // clause\n* as other\nfrom './missing.mjs';\n",
        "export\ufeff// clause\u2028{ name } from './missing.mjs';\n".encode(),
    ],
)
def test_core_graph_rejects_multiline_reexports_before_writing(tmp_path, source):
    page, _ = _core_site(tmp_path, source)
    original = page.read_bytes()
    with pytest.raises(AssetVersionError, match="declaration exports"):
        version_assets(tmp_path)
    assert page.read_bytes() == original and not (tmp_path / "js/modules").exists()


def test_relative_root_relative_stylesheets_and_asset_bytes(tmp_path):
    script, style = b"const value = 1;\n", b"body { color: green }\n"
    js = _put(tmp_path, "js/app.js", script)
    css = _put(tmp_path, "css/site.css", style)
    page = _put(
        tmp_path,
        "nested/index.html",
        '<script src="../js/app.js"></script>\n'
        '<link rel="alternate StyleSheet" href="/css/site.css">',
    )
    report = version_assets(tmp_path)
    assert page.read_text() == (
        f'<script src="../js/app.js?v={_hash(script)}"></script>\n'
        f'<link rel="alternate StyleSheet" href="/css/site.css?v={_hash(style)}">'
    )
    assert (report.html_files, report.changed_files, report.asset_references) == (1, 1, 2)
    assert js.read_bytes() == script and css.read_bytes() == style


def test_preserves_non_url_bytes_unicode_crlf_bom_and_attribute_spelling(tmp_path):
    _put(tmp_path, "js/app.js", b"app")
    before = (
        '\ufeff<!doctype html>\r\n<p>\u00e9\u2028 unchanged &amp; text</p>\r\n'
        '<ScRiPt  data-note="src=\'missing.js\'" SRC = \'js/app.js\' defer></ScRiPt>\r\n'
    )
    path = _put(tmp_path, "index.html", before)
    version_assets(tmp_path)
    expected = before.replace("'js/app.js'", f"'js/app.js?v={_hash(b'app')}'")
    assert path.read_bytes() == expected.encode("utf-8")


def test_query_components_fragment_duplicates_and_repeat_run(tmp_path):
    _put(tmp_path, "app.js", b"first")
    path = _put(
        tmp_path,
        "index.html",
        '<script src="app.js?x=%2f&amp;flag&amp;v=manual&amp;%76=second&amp;y=a+b#anchor"></script>',
    )
    first = version_assets(tmp_path)
    expected = (
        '<script src="app.js?x=%2f&amp;flag&amp;y=a+b&amp;v='
        + _hash(b"first")
        + '#anchor"></script>'
    )
    assert path.read_text() == expected
    assert first.changed_files == 1
    assert version_assets(tmp_path).changed_files == 0
    assert path.read_text() == expected
    _put(tmp_path, "app.js", b"second")
    assert version_assets(tmp_path).changed_files == 1
    assert path.read_text() == expected.replace(_hash(b"first"), _hash(b"second"))


def test_unquoted_url_encoded_filename_and_empty_fragment(tmp_path):
    _put(tmp_path, "my app.js", b"value")
    path = _put(tmp_path, "index.html", "<script src=my%20app.js#></script>")
    version_assets(tmp_path)
    assert path.read_text() == f"<script src=my%20app.js?v={_hash(b'value')}#></script>"


def test_attribute_entities_and_unquoted_whitespace_stay_valid(tmp_path):
    _put(tmp_path, "a&b.js", b"ampersand")
    _put(tmp_path, "a b.js", b"space")
    path = _put(
        tmp_path,
        "index.html",
        '<script src="a&amp;b.js?flag=1&amp;v=old"></script><script src=a&#32;b.js></script>',
    )
    version_assets(tmp_path)
    assert path.read_text() == (
        f'<script src="a&amp;b.js?flag=1&amp;v={_hash(b"ampersand")}"></script>'
        f'<script src=a&#32;b.js?v={_hash(b"space")}></script>'
    )
    assert version_assets(tmp_path).changed_files == 0


@pytest.mark.parametrize(
    "source",
    [
        '<script src="https://example.com/a.js?v=old"></script>',
        '<script src="//internscout.org/a.js"></script>',
        '<script src="data:text/javascript,console.log(1)"></script>',
        '<script src="#fragment"></script><script src="?x=1"></script>',
        '<a href="app.js">app.js</a><img src="app.js"><link rel="preload" href="app.js">',
        '<!-- <script src="missing.js"></script> -->&lt;script src="missing.js"&gt;',
        '<script>const sample = \'<script src="missing.js">\';</script>',
        '<script>const sample = "<script/>";</script>',
        '<textarea><script src="missing.js"></script></textarea>',
        '<textarea><script src="missing.js"/></textarea>',
        '<title><script src="missing.js"></script></title>',
        '<template>&lt;script src="missing.js"&gt;</template>',
        '<plaintext><script src="missing.js"/>',
    ],
)
def test_non_resources_and_inert_text_are_exactly_unchanged(tmp_path, source):
    path = _put(tmp_path, "index.html", source)
    report = version_assets(tmp_path)
    assert path.read_bytes() == source.encode("utf-8")
    assert report.changed_files == report.asset_references == 0


def test_real_script_after_textarea_and_inline_script_is_still_versioned(tmp_path):
    _put(tmp_path, "app.js", b"app")
    source = (
        '<textarea><script src="missing.js"></textarea>'
        '<script>const sample = \'<script src="missing.js">\';</script>'
        '<script src="app.js"></script>'
    )
    path = _put(tmp_path, "index.html", source)
    version_assets(tmp_path)
    assert path.read_text() == source.replace('src="app.js"', f'src="app.js?v={_hash(b"app")}"')


@pytest.mark.parametrize(
    "tag",
    [
        "script",
        "style",
        "textarea",
        "title",
        "xmp",
        "iframe",
        "noembed",
        "noframes",
        "plaintext",
        "noscript",
    ],
)
def test_self_closing_text_container_rejects_before_any_write(tmp_path, tag):
    _put(tmp_path, "app.js", b"app")
    first = _put(tmp_path, "a.html", '<script src="app.js"></script>')
    inline = f'<{tag}/>const sample = \'<script src="app.js">\';</{tag}>'
    last = _put(tmp_path, "z.html", inline)
    before = first.read_bytes(), last.read_bytes()
    with pytest.raises(AssetVersionError, match="Self-closing text containers"):
        version_assets(tmp_path)
    assert (first.read_bytes(), last.read_bytes()) == before


def test_self_closing_void_stylesheet_tag_is_still_versioned(tmp_path):
    _put(tmp_path, "site.css", b"body{}")
    path = _put(tmp_path, "index.html", '<link rel="stylesheet" href="site.css"/>')
    version_assets(tmp_path)
    assert path.read_text() == f'<link rel="stylesheet" href="site.css?v={_hash(b"body{}")}"/>'


@pytest.mark.parametrize(
    "url", ["missing.js", "../outside.js", "%2e%2e/outside.js", "/../outside.js"]
)
def test_invalid_assets_fail_before_any_html_is_written(tmp_path, url):
    root = tmp_path / "site"
    _put(tmp_path, "outside.js", b"outside")
    _put(root, "app.js", b"app")
    first = _put(root, "a.html", '<script src="app.js"></script>')
    bad = _put(root, "z.html", f'<script src="{url}"></script>')
    before = first.read_bytes(), bad.read_bytes()
    with pytest.raises(AssetVersionError, match="missing|escapes"):
        version_assets(root)
    assert (first.read_bytes(), bad.read_bytes()) == before


@pytest.mark.parametrize(
    "source",
    [
        '<base href="/elsewhere/"><script src="app.js"></script>',
        '<script src="app.js" src="other.js"></script>',
        '<script src="index.html"></script>',
        '<script src="js%5capp.js"></script>',
    ],
)
def test_ambiguous_or_unstable_asset_inputs_are_rejected(tmp_path, source):
    _put(tmp_path, "app.js", b"app")
    path = _put(tmp_path, "index.html", source)
    with pytest.raises(AssetVersionError):
        version_assets(tmp_path)
    assert path.read_bytes() == source.encode("utf-8")


def test_local_asset_case_is_checked_even_on_windows(tmp_path):
    _put(tmp_path, "app.js", b"app")
    _put(tmp_path, "index.html", '<script src="App.js"></script>')
    with pytest.raises(AssetVersionError, match="missing"):
        version_assets(tmp_path)


def test_filesystem_links_are_rejected_without_following_them(tmp_path):
    root = tmp_path / "site"
    _put(root, "index.html", '<script src="linked.js"></script>')
    target = _put(tmp_path, "outside.js", b"outside")
    try:
        (root / "linked.js").symlink_to(target)
    except OSError:
        pytest.skip("This account cannot create filesystem links")
    with pytest.raises(AssetVersionError, match="Filesystem links"):
        version_assets(root)
    assert target.read_bytes() == b"outside"


@pytest.mark.skipif(os.name != "nt", reason="Windows junction behavior")
def test_windows_junction_is_rejected_without_touching_its_target(tmp_path):
    import _winapi

    root = tmp_path / "site"
    target = tmp_path / "target"
    _put(target, "app.js", b"outside")
    _put(root, "index.html", '<script src="linked/app.js"></script>')
    link = root / "linked"
    _winapi.CreateJunction(str(target), str(link))
    try:
        with pytest.raises(AssetVersionError, match="Filesystem links"):
            version_assets(root)
        assert (target / "app.js").read_bytes() == b"outside"
    finally:
        # Remove the junction itself, never recursively remove its destination.
        link.rmdir()


def test_cli_prints_counts_and_suppresses_source_values(tmp_path, capsys):
    _put(tmp_path, "app.js", b"app")
    path = _put(tmp_path, "index.html", '<script src="app.js"></script>')
    assert main([str(tmp_path)]) == 0
    assert '"asset_references": 1' in capsys.readouterr().out
    path.write_text('<script src="missing.js?token=do-not-log"></script>')
    assert main([str(tmp_path)]) == 1
    output = capsys.readouterr()
    assert "failed" in output.err
    assert "missing.js" not in output.err and "do-not-log" not in output.err
    assert str(tmp_path) not in output.err


def test_actual_golden_asset_changes_preserve_semantic_fingerprints_and_dates(tmp_path):
    archive_path = Path(__file__).parent / "fixtures/golden/expected.tar.gz"
    with tarfile.open(archive_path, "r:gz") as archive:
        for member in archive.getmembers():
            assert member.isfile() and not Path(member.name).is_absolute()
            assert ".." not in Path(member.name).parts
        archive.extractall(tmp_path, filter="data")
    # Force actual URL changes even after the committed archive already contains current hashes.
    assets = ("js/count.js", "widget/share.css")
    for name in assets:
        path = tmp_path / name
        path.write_bytes(path.read_bytes() + b"\n/* asset cache regression */\n")
    before = {
        path.relative_to(tmp_path).as_posix(): path.read_bytes()
        for path in tmp_path.rglob("*")
        if path.is_file()
    }
    stamp = datetime.fromisoformat(STAMP)

    def route(name):
        if name == "index.html":
            return "/"
        return "/" + name[:-10] if name.endswith("/index.html") else "/" + name

    fingerprints = {
        name: fingerprint(route(name), content.decode("utf-8"), stamp, None)
        for name, content in before.items()
        if name.endswith(".html")
    }
    report = version_assets(tmp_path)
    assert report.changed_files > 1
    assert version_assets(tmp_path).changed_files == 0
    for name, content in before.items():
        after = (tmp_path / name).read_bytes()
        if name in fingerprints:
            assert (
                fingerprint(route(name), after.decode("utf-8"), stamp, None) == fingerprints[name]
            )
        else:
            assert after == content
    for name in assets:
        digest = _hash(before[name])
        references = [
            (tmp_path / path).read_text(encoding="utf-8")
            for path in fingerprints
            if name in before[path].decode("utf-8")
        ]
        assert references and all("v=" + digest in text for text in references)
    dates = json.loads((tmp_path / "data/page-content-dates.json").read_bytes())["pages"]
    assert dates["/pricing/"]["lastmod"] == "2026-11-01"
    assert dates["/about/"]["lastmod"] == "2026-11-10"
    # The date fingerprint still detects real visible link changes; it has not been weakened.
    pricing = before["pricing/index.html"].decode("utf-8")
    changed = pricing.replace('href="/"', 'href="/changed-visible-link/"', 1)
    assert changed != pricing
    assert fingerprint("/pricing/", changed, stamp, None) != fingerprints["pricing/index.html"]
