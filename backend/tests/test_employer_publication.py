"""Default-off publication captures, stages and renders one selected public export."""

from collections import Counter
from html import unescape
import json
from pathlib import Path
import re
import shutil
import sys

import pytest

import golden_build
from internscout.site import employer_publication, publish
from tests.seo_fixture_data import _row, _site

REPO = Path(__file__).resolve().parents[2]
MARK = re.compile(rb' data-employer-key="[^"]*"')


def tree(root):
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()}


def export(site, name="Alpha"):
    rows = [_row(i, company_name=name, salary="$30 per hour") for i in range(30)]
    rows += [_row(30, company_name="Closed Co", status="closed"), _row(31, apply_url=None)]
    shards = {"MA": rows, "remote": [rows[0]]}
    _site(site, shards)
    index = json.loads((site / "data/listings/index.json").read_bytes())
    for key, values in shards.items():
        index["files"][key].update(
            count=len(values), open=sum(r["status"] == "open" for r in values)
        )
    index["first"] = {"file": "first.json", "rows": 3}
    (site / "data/listings/index.json").write_text(json.dumps(index), encoding="utf-8")
    (site / "data/first.json").write_text(json.dumps(rows[:3]), encoding="utf-8")
    (site / "data/unrelated.bin").write_bytes(b"unchanged unrelated public asset")
    return rows


def test_capture_once_stage_full_membership_and_leave_unrelated_bytes(tmp_path, monkeypatch):
    site = tmp_path / "site"
    rows = export(site)
    before = tree(site)
    reads = Counter()
    real_read = Path.read_bytes

    def read(path):
        if path.is_relative_to(site):
            reads[path.relative_to(site).as_posix()] += 1
        return real_read(path)

    monkeypatch.setattr(Path, "read_bytes", read)
    calls = []
    monkeypatch.setattr(
        employer_publication, "public_data_dir", lambda _: calls.append(1) or site / "data"
    )
    data, links = employer_publication.prepare(str(site))
    assert calls == [1]
    assert all(count == 1 for count in reads.values())
    monkeypatch.setattr(Path, "read_bytes", real_read)
    after = tree(site)
    assert after.keys() - before.keys() == {"data/employer-posting-keys.json"}
    changed = {key for key in before if before[key] != after[key]}
    assert changed == {"data/listings/MA.json", "data/listings/remote.json", "data/first.json"}
    assert json.loads(after["data/employer-posting-keys.json"]) == ["alpha", "closed"]
    for path in changed:
        annotated = json.loads(after[path])
        for row in annotated:
            if row["apply_url"]:
                assert row["employer_key"] in {"alpha", "closed"}
            else:
                assert "employer_key" not in row
        assert [
            {k: v for k, v in r.items() if k != "employer_key"} for r in annotated
        ] == json.loads(before[path])
    assert links.attribute(rows[0]) == ' data-employer-key="alpha"'
    assert links.attribute(rows[30]) == ' data-employer-key="closed"'
    assert links.attribute(rows[31]) == ""
    assert all(row["status"] == "open" for row in data["listings"])
    assert all("employer_key" not in row for row in data["listings"])
    (site / "data/listings/MA.json").write_bytes(b"[]")
    assert any(row["id"] == rows[0]["id"] for row in data["listings"])


@pytest.mark.parametrize(
    "broken", ["missing", "count", "first", "duplicate", "bad-index", "unsafe-path", "bad-majors"]
)
def test_invalid_export_writes_nothing(tmp_path, broken):
    site = tmp_path / "site"
    export(site)
    index = site / "data/listings/index.json"
    if broken == "missing":
        (site / "data/listings/MA.json").unlink()
    elif broken == "count":
        value = json.loads(index.read_bytes())
        value["files"]["MA"]["count"] += 1
        index.write_text(json.dumps(value), encoding="utf-8")
    elif broken == "first":
        (site / "data/first.json").write_text(json.dumps([_row(999)] * 3), encoding="utf-8")
    elif broken == "duplicate":
        index.write_bytes(index.read_bytes().replace(b'{', b'{"files":{},', 1))
    elif broken == "bad-index":
        index.write_bytes(b"[]")
    elif broken == "unsafe-path":
        value = json.loads(index.read_bytes())
        value["files"]["../escape"] = value["files"].pop("MA")
        index.write_text(json.dumps(value), encoding="utf-8")
    else:
        (site / "data/majors.json").write_bytes(b"invalid JSON")
    before = tree(site)
    with pytest.raises((ValueError, FileNotFoundError)):
        employer_publication.prepare(str(site))
    assert tree(site) == before


def test_external_selected_export_must_match_target_before_writes(tmp_path, monkeypatch):
    selected, site = tmp_path / "selected", tmp_path / "site"
    export(selected)
    shutil.copytree(selected, site)
    monkeypatch.setenv("INTERNSCOUT_PUBLIC_DATA", str(selected / "data"))
    original = tree(selected)
    (site / "data/first.json").write_bytes(b"[]")
    before = tree(site)
    with pytest.raises(ValueError, match="differs"):
        employer_publication.prepare(str(site))
    assert tree(site) == before
    shutil.copyfile(selected / "data/first.json", site / "data/first.json")
    employer_publication.prepare(str(site))
    assert tree(selected) == original


def test_second_fresh_release_replaces_membership_and_preview(tmp_path):
    site = tmp_path / "target"
    for name in ["Alpha", "Beta"]:
        incoming = tmp_path / name
        rows = export(incoming, name)
        shutil.copytree(incoming, site, dirs_exist_ok=True)
        _, links = employer_publication.prepare(str(site))
        catalog = json.loads((site / "data/employer-posting-keys.json").read_bytes())
        assert catalog == sorted([name.lower(), "closed"])
        assert (
            json.loads((site / "data/first.json").read_bytes())[0]["employer_key"] == name.lower()
        )
        assert name.lower() in links.attribute(rows[0])
        if name == "Beta":
            assert "alpha" not in catalog


def test_duplicate_flag_fails_before_preparation(tmp_path, monkeypatch):
    monkeypatch.setattr(employer_publication, "prepare", lambda _: pytest.fail("must not stage"))
    with pytest.raises(ValueError, match="Duplicate"):
        publish.main(["publish", str(tmp_path), "--employer-postings", "--employer-postings"])


def build_opted_in(work, monkeypatch):
    """Use the real golden export/publisher/assets/link entry points, changing only the opt-in."""
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
        sys.argv.append("--employer-postings")
    return original(name, **kwargs)
runpy.run_module = invoke
stage("pages", Path(sys.argv[2]))
'''
            command = [sys.executable, "-c", code, str(REPO / "backend/tests"), str(work)]
        return original(command, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(golden_build.subprocess, "run", run)
        return golden_build.build(work)


def test_actual_publication_matches_default_except_exact_annotations_and_catalog(
    tmp_path, monkeypatch
):
    before_work, after_work = tmp_path / "before", tmp_path / "after"
    golden_build.prepare(before_work)
    golden_build.prepare(after_work)
    before = golden_build.build(before_work)
    assert not golden_build.differences(before)
    after = build_opted_in(after_work, monkeypatch)
    assert after.keys() - before.keys() == {"data/employer-posting-keys.json"}
    assert not before.keys() - after.keys()
    catalog = set(json.loads(after["data/employer-posting-keys.json"]))
    all_keys, annotations = set(), 0
    shards = {
        "data/" + entry["file"]
        for entry in json.loads(before["data/listings/index.json"])["files"].values()
    }
    bindings = {
        (row["employer_key"], row["apply_url"])
        for path in shards
        for row in json.loads(after[path])
        if "employer_key" in row
    }
    for path, raw in before.items():
        if path == "data/first.json" or path in shards:
            rows = json.loads(after[path])
            all_keys.update(row["employer_key"] for row in rows if "employer_key" in row)
            assert [
                {k: v for k, v in row.items() if k != "employer_key"} for row in rows
            ] == json.loads(raw)
        elif path.endswith(".html"):
            assert MARK.sub(b"", after[path]) == raw, path
            for anchor in re.findall(rb'<a\b[^>]+>', after[path]):
                key = MARK.search(anchor)
                if key:
                    annotations += 1
                    company = unescape(key[0].decode().split('="')[1][:-1])
                    href = unescape(re.search(rb' href="([^"]*)"', anchor)[1].decode())
                    assert company in catalog and (company, href) in bindings
                    assert b'data-aa' not in anchor and b'sponsored' not in anchor
            assert b'data-employer-posting-counts' not in after[path]  # Browser capture stays off.
        else:
            assert after[path] == raw, path
    assert all_keys == catalog and annotations > 0
    assert MARK.search(after["internships/highest-paying/index.html"])
    assert after["digest/index.html"] == before["digest/index.html"]
    assert after["index.html"] == before["index.html"]
    assert after["data/page-content-dates.json"] == before["data/page-content-dates.json"]
    allowlist = (REPO / "scripts/site-allowlist.txt").read_text(encoding="utf-8").splitlines()
    assert r"data/employer-posting-keys\.json" in allowlist
    assert any(
        re.fullmatch(pattern, "data/employer-posting-keys.json")
        for pattern in allowlist
        if pattern and not pattern.startswith("#")
    )
