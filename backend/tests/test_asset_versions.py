"""Asset fingerprints must change only real local resource URLs."""

import hashlib
from datetime import datetime
import json
import os
from pathlib import Path
import tarfile

import pytest

from internscout.asset_versions import AssetVersionError, main, version_assets
from internscout.page_dates import fingerprint

from golden_build import STAMP


def _put(root, name, content):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content if isinstance(content, bytes) else content.encode("utf-8"))
    return path


def _hash(content):
    return hashlib.sha256(content).hexdigest()[:12]


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
