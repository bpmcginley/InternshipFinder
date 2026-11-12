"""One opt-in couples approved privacy and form bytes; no provider calls."""

from pathlib import Path
import runpy
import shutil
import socket
import sys

import pytest

from internscout.asset_versions import version_assets
from internscout.site import publish
from tests.test_advisor_signup_build import fixture, files

ROOT = Path(__file__).resolve().parents[2]
TEXT = (
    b"If you choose Subscribe as an advisor, your email address and an advisor tag go "
    b"directly to Buttondown. Buttondown stores the tag to identify subscribers who "
    b"advise students."
)
WEEKLY = {
    "internships/for/computer-science-majors/weekly/index.html",
    "internships/for/undeclared-majors/weekly/index.html",
}


def public_fixture(root):
    site = fixture(root)
    for source in (ROOT / "docs").iterdir():
        if source.name in {"data", "index.html"}:
            continue
        if source.is_dir():
            shutil.copytree(source, site / source.name)
        else:
            shutil.copyfile(source, site / source.name)
    return site


@pytest.mark.parametrize(
    "fault",
    [
        "missing",
        "heading",
        "duplicate-heading",
        "anchor",
        "duplicate-anchor",
        "outside",
        "unclosed",
        "already",
        "utf8",
    ],
)
def test_bad_privacy_rejects_before_any_output(tmp_path, fault):
    site = fixture(tmp_path)
    privacy = site / "privacy.html"
    raw = privacy.read_bytes()
    anchor = next(
        line for line in raw.splitlines(keepends=True) if b"<li><strong>Buttondown holds" in line
    )
    if fault == "missing":
        privacy.unlink()
    else:
        changed = {
            "heading": raw.replace(b'<h2 id="digest">', b'<h2 id="other">'),
            "duplicate-heading": raw + b'<h2 id="digest">',
            "anchor": raw.replace(anchor, b""),
            "duplicate-anchor": raw + anchor,
            "outside": raw.replace(anchor, b"") + anchor,
            "unclosed": raw.replace(anchor, anchor.replace(b"</li>", b"")),
            "already": raw + TEXT,
            "utf8": raw + b"\xff",
        }[fault]
        privacy.write_bytes(changed)
    before = files(site)
    with pytest.raises((ValueError, OSError)):
        publish.main(["publish", str(site), "--advisor-signup"])
    assert files(site) == before


@pytest.mark.parametrize("ending", [b"\n", b"\r\n"])
def test_privacy_preserves_all_surrounding_bytes_and_unique_placement(tmp_path, ending):
    site = fixture(tmp_path)
    original = (site / "privacy.html").read_bytes().replace(b"\r\n", b"\n").replace(b"\n", ending)
    (site / "privacy.html").write_bytes(original)
    prepared = publish._advisor_privacy(str(site))
    insertion = b"      <li>" + TEXT + b"</li>" + ending
    assert prepared.count(TEXT) == 1
    assert prepared.replace(insertion, b"") == original
    assert prepared.index(TEXT) > prepared.index(b"Buttondown holds your address")
    assert prepared.index(TEXT) < prepared.index(b"The person running InternScout can see")
    assert (site / "privacy.html").read_bytes() == original


def test_normal_site_entry_pairs_stamped_artifact_and_fresh_rollback(tmp_path, monkeypatch):
    def denied(*args, **kwargs):
        raise AssertionError("External requests forbidden")

    monkeypatch.setattr(socket, "socket", denied)

    def build(name, enabled=False, changed_catalog=False):
        site = public_fixture(tmp_path / name)
        if changed_catalog:
            (site / "data/majors.json").write_text(
                '{"majors":[{"name":"New Major","tags":[]}]}', encoding="utf-8"
            )
        monkeypatch.setattr(
            sys,
            "argv",
            ["make_og_image", "--site", str(site), *(["--advisor-signup"] if enabled else [])],
        )
        runpy.run_module("scripts.make_og_image", run_name="__main__")
        version_assets(site)
        return files(site)

    off, on, rollback = build("off"), build("on", True), build("rollback")
    assert off == rollback
    assert off.keys() == on.keys()
    assert {path for path in off if off[path] != on[path]} == WEEKLY | {
        "privacy.html",
        "data/page-content-dates.json",
    }
    assert on["privacy.html"].count(TEXT) == 1
    for path in WEEKLY:
        assert on[path].count(b"Subscribe as an advisor") == 1
        assert b'href="/privacy#digest"' in on[path]
        assert b"digest-advisor-help" not in off[path]
    changed = build("changed", changed_catalog=True)
    assert not (WEEKLY & changed.keys())
    assert "internships/for/new-major-majors/weekly/index.html" in changed
    assert changed["privacy.html"] == off["privacy.html"]
    assert all(
        b"digest-advisor-help" not in body
        for path, body in changed.items()
        if path.endswith(".html")
    )
