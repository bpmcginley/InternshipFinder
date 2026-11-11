"""Offline checks for the public listing checkout's fallback and failure rules."""

import json
from pathlib import Path
import runpy
from types import SimpleNamespace

import pytest

SCRIPT = (
    Path(__file__).resolve().parents[2] / ".github" / "actions" / "public-data" / "listing_data.py"
)
SHA = "a" * 40


@pytest.fixture
def selector(monkeypatch):
    scope = runpy.run_path(str(SCRIPT))["resolve"].__globals__

    def loaded(returncode, stdout=""):
        git = SimpleNamespace(
            run=lambda *args, **kwargs: SimpleNamespace(returncode=returncode, stdout=stdout)
        )
        monkeypatch.setitem(scope, "subprocess", git)
        return SimpleNamespace(resolve=scope["resolve"], select=scope["select"])

    return loaded


def test_missing_ref_uses_existing_primary_export(tmp_path, selector):
    data = tmp_path / "docs" / "data"
    data.mkdir(parents=True)
    actions = selector(2)
    assert actions.resolve(tmp_path) == ""
    assert actions.select(tmp_path, "") == data


@pytest.mark.parametrize(
    ("returncode", "stdout"), [(128, ""), (0, f"{SHA} refs/heads/unexpected"), (0, "bad")]
)
def test_lookup_failure_or_invalid_response_refuses_fallback(tmp_path, selector, returncode, stdout):
    (tmp_path / "docs" / "data").mkdir(parents=True)
    with pytest.raises(SystemExit):
        selector(returncode, stdout).resolve(tmp_path)


def test_present_ref_requires_exact_complete_snapshot(tmp_path, selector):
    primary = tmp_path / "docs" / "data"
    primary.mkdir(parents=True)
    assert selector(0, f"{SHA} refs/heads/data\n").resolve(tmp_path) == SHA
    checkout = tmp_path / ".listing-data"
    with pytest.raises(SystemExit, match="was not checked out"):
        selector(0, SHA).select(tmp_path, SHA)
    checkout.mkdir()
    with pytest.raises(SystemExit, match="does not match"):
        selector(0, f"{tmp_path}\n{SHA}").select(tmp_path, SHA)
    actions = selector(0, f"{checkout}\n{SHA}")
    with pytest.raises(SystemExit, match="does not match"):
        actions.select(tmp_path, "b" * 40)

    export = checkout / "docs" / "data"
    shards = write_export(export)
    with pytest.raises(SystemExit, match="complete listing export"):
        actions.select(tmp_path, SHA)
    (shards / "MA.desc.json").write_text("{}", encoding="utf-8")
    assert actions.select(tmp_path, SHA) == export
    index = shards / "index.json"
    original = json.loads(index.read_text(encoding="utf-8"))
    duplicate = {"file": "listings/MA.desc.json", "desc": "listings/MA.desc.json"}
    backslash = {"file": r"listings/MA\child.json", "desc": r"listings/MA\child.desc.json"}
    for files in ({"MA": duplicate}, {r"MA\child": backslash}):
        index.write_text(json.dumps({**original, "files": files}), encoding="utf-8")
        with pytest.raises(SystemExit, match="complete listing export"):
            actions.select(tmp_path, SHA)
    index.write_text(json.dumps({**original, "files": {}}), encoding="utf-8")
    assert actions.select(tmp_path, SHA) == export


def write_export(export):
    shards = export / "listings"
    shards.mkdir(parents=True)
    for name in ("first.json", "majors.json", "stats.json", "seo-posting-details.json"):
        (export / name).write_text("{}", encoding="utf-8")
    (shards / "index.json").write_text(
        json.dumps(
            {
                "first": {"file": "first.json"},
                "files": {"MA": {"file": "listings/MA.json", "desc": "listings/MA.desc.json"}},
            }
        ),
        encoding="utf-8",
    )
    (shards / "MA.json").write_text("[]", encoding="utf-8")
    return shards


@pytest.mark.parametrize("location", ["checkout", "docs", "data", "extra"])
def test_present_ref_rejects_snapshot_links(tmp_path, selector, location):
    checkout = tmp_path / ".listing-data"
    export = checkout / "docs" / "data"
    shards = write_export(export)
    (shards / "MA.desc.json").write_text("{}", encoding="utf-8")
    actions = selector(0, f"{checkout}\n{SHA}")
    assert actions.select(tmp_path, SHA) == export

    links = {"checkout": checkout, "docs": export.parent, "data": export, "extra": export / "x"}
    link = links[location]
    target = tmp_path / "target"
    if link.is_dir():
        link.rename(target)
    else:
        target.write_text("{}", encoding="utf-8")
    try:
        link.symlink_to(target, target_is_directory=target.is_dir())
    except OSError:
        pytest.skip("symlink creation unavailable on this platform")
    with pytest.raises(SystemExit):
        actions.select(tmp_path, SHA)
