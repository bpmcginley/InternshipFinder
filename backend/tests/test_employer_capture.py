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


def test_parser_ignores_script_examples_and_leaves_unrelated_pages(tmp_path):
    text = f'<!-- {TAG} --><script>const example = {TAG!r};</script>\n{TAG}\n'
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
        assert after[path].replace(MARK, b"") == before[path], path
    assert after["data/page-content-dates.json"] == before["data/page-content-dates.json"]
    assert after["data/employer-posting-keys.json"] == before["data/employer-posting-keys.json"]
