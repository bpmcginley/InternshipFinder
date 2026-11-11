"""Explicit capture is separate from same-export annotations and production activation."""

from pathlib import Path
import sys

import pytest

import golden_build
from internscout.site import employer_capture, employer_publication, publish
from test_employer_publication import export, tree

REPO = Path(__file__).resolve().parents[2]
TAG = '<script defer src="/js/count.js"></script>'
MARK = employer_capture.ATTRIBUTE.encode()


@pytest.mark.parametrize(
    "flags",
    [
        ["--employer-posting-capture"],
        ["--employer-posting-capture", "--employer-posting-capture", "--employer-postings"],
        ["--employer-posting-capture", "--employer-postings", "--employer-postings"],
    ],
)
def test_flags_reject_before_staging(tmp_path, monkeypatch, flags):
    monkeypatch.setattr(employer_publication, "prepare", lambda _: pytest.fail("must not stage"))
    with pytest.raises(ValueError, match="exactly one"):
        publish.main(["publish", str(tmp_path), *flags])
    assert list(tmp_path.iterdir()) == []


def test_invalid_export_cannot_reach_capture(tmp_path, monkeypatch):
    export(tmp_path)
    (tmp_path / "data/first.json").write_bytes(b"[]")
    before = tree(tmp_path)
    monkeypatch.setattr(employer_capture, "stamp", lambda *_: pytest.fail("must not capture"))
    with pytest.raises(ValueError):
        publish.main(
            ["publish", str(tmp_path), "--employer-postings", "--employer-posting-capture"]
        )
    assert tree(tmp_path) == before


@pytest.mark.parametrize(
    "tag",
    [
        "",
        TAG + TAG,
        TAG.replace("</script>", ""),
        TAG.replace('></script>', '/>'),
        TAG.replace("defer", "async"),
        TAG.replace("defer", 'data-employer-posting-counts="0" defer'),
    ],
)
def test_missing_duplicate_or_preconfigured_script_changes_no_target(tmp_path, tag):
    (tmp_path / "index.html").write_text(TAG, encoding="utf-8")
    folder = tmp_path / "internships/field"
    folder.mkdir(parents=True)
    (folder / "index.html").write_text(tag, encoding="utf-8")
    before = tree(tmp_path)
    with pytest.raises(ValueError):
        employer_capture.stamp(
            tmp_path, [{"path": "/internships/field/", "html": ' data-employer-key="alpha"'}]
        )
    assert tree(tmp_path) == before


def test_raw_guard_rejects_even_inert_counter_examples():
    for text in [f'<!-- {TAG} -->{TAG}', f'<script>const example = {TAG!r};</script>{TAG}']:
        with pytest.raises(ValueError, match="raw canonical"):
            employer_capture._mark(text)


def test_leaves_unrelated_pages_unchanged(tmp_path):
    text = f'<p>Unchanged page text</p>\n{TAG}\n'
    (tmp_path / "index.html").write_text(text, encoding="utf-8")
    for path in ["widget", "digest", "employers"]:
        (tmp_path / path).mkdir()
        (tmp_path / path / "index.html").write_text(TAG, encoding="utf-8")
    before = tree(tmp_path)
    employer_capture.stamp(tmp_path, [{"path": "/widget/", "html": ' data-employer-key="alpha"'}])
    after = tree(tmp_path)
    assert {p for p in before if before[p] != after[p]} == {"index.html"}
    assert after["index.html"].count(MARK) == 1
    assert after["index.html"].replace(MARK, b"") == before["index.html"]


@pytest.mark.parametrize("prefix", ["\u2028", "\u2029", "\r", "first\nsecond\u2028\r"])
def test_html_parser_offsets_count_only_lf(prefix):
    text = prefix + TAG
    marked = employer_capture._mark(text)
    assert marked == prefix + TAG.replace(">", employer_capture.ATTRIBUTE + ">", 1)


@pytest.mark.parametrize(
    "src",
    [
        "/js/count.js?v=old",
        "https://internscout.org/js/count.js?v=old",
        "//internscout.org/js/count.js",
        "../../js/count.js?x=1",
        "/js/%63ount.js",
        "/js/nested/../count.js",
        "https:///internscout.org/js/count.js",
        "https:////internscout.org/js/count.js",
        "////internscout.org/js/count.js",
        "https://%69nternscout.org/js/count.js",
        "https://internscout%2eorg/js/count.js",
        "https://ｉnternscout.org/js/count.js",
        "https://untrusted.example/count.js",
        "count.js?v=old",
        "https:count.js",
    ],
)
def test_potential_counter_filename_cannot_hide_duplicate(src):
    with pytest.raises(ValueError, match="counter script"):
        employer_capture._mark(TAG + f'<script defer src="{src}"></script>')


@pytest.mark.parametrize(
    "html",
    [
        TAG + "<!-->" + TAG + "<!-- -->",
        TAG + "<!--->" + TAG + "<!-- -->",
        TAG.replace("</script>", "</script extra>") + TAG,
        TAG.replace("</script>", "</script/>") + TAG,
        TAG + '<!--><script defer src="/js/co&#117;nt.js?v=old"></script><!-- -->',
        TAG + '<!-->src="' + TAG + '<!-- -->',
        TAG + '<script src=/x=y/../js/count.js></script>',
        TAG + '<script src=/x`y/../js/count.js></script>',
        TAG + '<script src=/x<y/../js/count.js></script>',
        TAG + '<script src=/x\u00a0y/../js/count.js></script>',
    ],
)
def test_raw_counter_guard_is_independent_of_html_comment_and_end_tag_parsing(html):
    with pytest.raises(ValueError, match="raw canonical"):
        employer_capture._mark(html)


@pytest.mark.parametrize("ending", ["\n", "\r\n"])
def test_capture_normalizes_only_exact_known_dashboard_comment(tmp_path, ending):
    comment = employer_capture.DASHBOARD_COMMENT.replace("\n", ending)
    path = tmp_path / "index.html"
    path.write_bytes((comment + ending + TAG).encode())
    employer_capture.stamp(tmp_path, [])
    expected = employer_capture.DASHBOARD_REPLACEMENT.replace("\n", ending) + ending + TAG
    assert path.read_bytes() == expected.replace(TAG, employer_capture._mark(TAG)).encode()


def test_whole_document_check_does_not_skip_other_counter_mentions(tmp_path):
    path = tmp_path / "index.html"
    before = ('<!-- historical count.js mention -->' + TAG).encode()
    path.write_bytes(before)
    with pytest.raises(ValueError, match="raw canonical"):
        employer_capture.stamp(tmp_path, [])
    assert path.read_bytes() == before


@pytest.mark.parametrize("flags", [[], ["--employer-postings"]])
@pytest.mark.parametrize("opening", ["", "<!-->", "<!--->"])
@pytest.mark.parametrize(
    "retained", ["index.html", "internships/stale-outside-current-build/index.html"]
)
def test_reused_default_and_annotation_targets_fail_before_any_publication(
    tmp_path, monkeypatch, flags, retained, opening
):
    export(tmp_path)  # A fresh valid export does not authorize a retained marked HTML page.
    (tmp_path / "index.html").write_text(TAG, encoding="utf-8")
    path = tmp_path / retained
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        opening + employer_capture._mark(TAG) + ("<!-- -->" if opening else ""), encoding="utf-8"
    )
    before = tree(tmp_path)
    monkeypatch.setattr(employer_publication, "prepare", lambda _: pytest.fail("must not stage"))
    with pytest.raises(ValueError, match="fresh unmarked publication target"):
        publish.main(["publish", str(tmp_path), *flags])
    assert tree(tmp_path) == before


def build_capture(work, monkeypatch, capture=True):
    original = golden_build.subprocess.run

    def run(command, **kwargs):
        if "--stage" in command and command[command.index("--stage") + 1] == "pages":
            code = '''
import sys, runpy
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from golden_build import stage
original = runpy.run_module
def invoke(name, **kwargs):
    if name == "scripts.make_og_image":
        sys.argv.extend(FLAGS)
    return original(name, **kwargs)
runpy.run_module = invoke
stage("pages", Path(sys.argv[2]))
'''
            flags = ["--employer-postings"] + (["--employer-posting-capture"] if capture else [])
            code = code.replace("FLAGS", repr(flags))
            command = [sys.executable, "-c", code, str(REPO / "backend/tests"), str(work)]
        return original(command, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(golden_build.subprocess, "run", run)
        return golden_build.build(work)


def test_actual_capture_changes_only_supported_script_attributes(tmp_path, monkeypatch):
    before_work, after_work = tmp_path / "before", tmp_path / "after"
    golden_build.prepare(before_work)
    golden_build.prepare(after_work)
    before = build_capture(before_work, monkeypatch, capture=False)
    after = build_capture(after_work, monkeypatch)
    assert after.keys() == before.keys()
    changed = {p for p in before if before[p] != after[p]}
    expected = {"index.html"} | {
        p
        for p in before
        if p.startswith("internships/")
        and p.endswith(".html")
        and b' data-employer-key="' in before[p]
    }
    assert changed == expected
    assert "internships/software-engineering/index.html" in changed
    assert "internships/highest-paying/index.html" in changed
    for path in changed:
        assert after[path].count(MARK) == 1, path
        restored = after[path].replace(MARK, b"")
        if path == "index.html":
            restored = restored.replace(
                employer_capture.DASHBOARD_REPLACEMENT.encode(),
                employer_capture.DASHBOARD_COMMENT.encode(),
                1,
            )
        assert restored == before[path], path
    assert after["data/page-content-dates.json"] == before["data/page-content-dates.json"]
    assert after["data/employer-posting-keys.json"] == before["data/employer-posting-keys.json"]
