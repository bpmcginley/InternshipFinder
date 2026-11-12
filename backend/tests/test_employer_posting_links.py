"""Synthetic same-release annotations; no emitter, provider or publication."""

from dataclasses import replace
from datetime import datetime, timezone
import json
import re

import pytest

from internscout import page_dates
from internscout.employer_posting_stage import CATALOG_PATH, stage_employer_postings
from internscout.site import publish, runtime
from internscout.site.employer_posting_links import PostingLinks
from tests.seo_fixture_data import _row, _site

pytestmark = pytest.mark.without_seo_facade


STAMP = datetime(2026, 9, 23, 10, tzinfo=timezone.utc)
MARK = re.compile(r' data-employer-key="[^"]*"')


def stage(rows):
    def pack(value):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()

    index = {
        "files": {
            "MA": {
                "file": "listings/MA.json",
                "count": len(rows),
                "open": sum(row["status"] == "open" for row in rows),
            }
        },
        "first": {"file": "first.json", "rows": 1},
    }
    return stage_employer_postings(pack(index), {"listings/MA.json": pack(rows)}, pack(rows[:1]))


def fixture_rows():
    return [
        _row(
            i,
            company_name="Example & Research LLC" if i < 3 else f"Employer {i}",
            ats="greenhouse",
            apply_url=f"https://boards.greenhouse.io/example/jobs/{i}",
            salary="$30 - $35 an hour",
        )
        for i in range(30)
    ]


def run(links, call, *args):
    return runtime.invoke(
        runtime.BuildState(posting_links=links), runtime.BuildHooks(), call, *args
    )


def test_annotation_preserves_shared_and_pay_actions_and_offer_marker():
    rows = fixture_rows()
    links = PostingLinks.from_stage(stage(rows))
    rendered = [dict(row, keys={"MA"}) for row in rows]
    for call, args in [
        (runtime.listing_rows, (rendered, STAMP)),
        (runtime.pay_rows, ([(row, 30, 35) for row in rows], STAMP)),
    ]:
        before, after = run(None, call, *args), run(links, call, *args)
        assert MARK.sub("", after) == before
        assert after.count('data-employer-key=') == len(rows)
        assert 'data-employer-key="example &amp; research"' in after
        assert runtime.OFFER_MARK in after
        assert not re.search(r'<a class="aa"[^>]*data-employer-key', after)
        assert run(None, call, *args) == before  # No state leaks to the next build.


@pytest.mark.parametrize(
    "change",
    [
        {"company_name": "Different employer"},
        {"apply_url": "https://example.com/reused-id"},
        {"apply_url": "javascript:bad"},
    ],
)
def test_known_id_cannot_borrow_key_for_another_posting(change):
    rows = fixture_rows()
    links = PostingLinks.from_stage(stage(rows))
    with pytest.raises(ValueError, match="Rendered posting differs"):
        links.attribute(dict(rows[0], **change))


def test_unknown_or_missing_role_is_not_annotated_and_input_is_copied():
    rows = fixture_rows()
    staged = stage(rows)
    mutable_keys = dict(staged.posting_keys)
    links = PostingLinks.from_stage(replace(staged, posting_keys=mutable_keys))
    mutable_keys.clear()
    assert links.attribute(rows[0])
    assert links.attribute(dict(rows[0], id="saved-only")) == ""
    assert links.attribute({}) == ""
    with pytest.raises(TypeError):
        links.bindings["new"] = ("other", "https://example.com")


@pytest.mark.parametrize("key", ["bad\nkey", "x" * 201, "uncatalogued", None])
def test_reject_invalid_or_different_keys_before_render(key):
    staged = stage(fixture_rows())
    keys = dict(staged.posting_keys, id0=key)
    with pytest.raises(ValueError):
        PostingLinks.from_stage(replace(staged, posting_keys=keys))


def test_reject_incomplete_shards_catalog_and_url_conflicts():
    staged = stage(fixture_rows())
    with pytest.raises(ValueError, match="Incomplete"):
        PostingLinks.from_stage(replace(staged, files={CATALOG_PATH: staged.files[CATALOG_PATH]}))
    with pytest.raises(ValueError, match="catalog"):
        PostingLinks.from_stage(replace(staged, files=dict(staged.files, **{CATALOG_PATH: b'[]'})))
    files = dict(staged.files)
    rows = json.loads(files["listings/MA.json"])
    rows[0]["apply_url"] = "https://example.com/conflicting"
    files["listings/NY.json"] = json.dumps(rows).encode()
    with pytest.raises(ValueError, match="Conflicting"):
        PostingLinks.from_stage(replace(staged, files=files))


def test_alias_and_repeated_occurrences_share_the_same_key():
    rows = fixture_rows()
    rows[0]["company_name"] = "Booz Allen Hamilton"
    rows[1]["company_name"] = "Booz Allen"
    staged = stage(rows)
    links = PostingLinks.from_stage(
        replace(
            staged,
            files=dict(staged.files, **{"listings/NY.json": staged.files["listings/MA.json"]}),
        )
    )
    assert links.attribute(rows[0]) == links.attribute(rows[1]) == ' data-employer-key="booz allen"'


def test_complete_page_build_changes_only_organic_attributes(tmp_path):
    rows = fixture_rows()
    site = _site(tmp_path, {"MA": rows}, majors=[{"name": "Engineering", "tags": ["mechanical"]}])
    links = PostingLinks.from_stage(stage(rows))
    before = run(None, runtime.build, site, frozenset(), frozenset(), frozenset())
    after = run(links, runtime.build, site, frozenset(), frozenset(), frozenset())
    assert len(after) == len(before)
    changed = []
    for old, new in zip(before, after, strict=True):
        assert old.keys() == new.keys()
        for key in old:
            if key == "html":
                assert MARK.sub("", new[key]) == old[key]
                assert page_dates.fingerprint(
                    new["path"], new[key], STAMP
                ) == page_dates.fingerprint(old["path"], old[key], STAMP)
                if MARK.search(new[key]):
                    changed.append(new["path"])
            else:
                assert new[key] == old[key]
    assert "/internships/mechanical-engineering/" in changed
    assert "/internships/highest-paying/" in changed
    # Paid placement rendering is a separate path, even for the same organic role.
    paid = run(links, publish._placement_box, rows[0], {"id": "synthetic", "end": "2027-01-01"})
    assert 'rel="sponsored noopener"' in paid
    assert not MARK.search(paid)


def test_renderers_without_optional_state_leave_links_unannotated():
    rows = [dict(row, keys={"MA"}) for row in fixture_rows()]
    assert MARK.search(runtime.listing_rows(rows, STAMP)) is None
    assert MARK.search(runtime.pay_rows([(rows[0], 30, 35)], STAMP)) is None


@pytest.mark.parametrize(
    "url",
    [
        "javascript:bad",
        "/relative",
        "https://:password@example.com/",
        "https://example.com:bad/",
        "https://example.com/\\bad",
    ],
)
def test_no_non_direct_staged_links(url):
    staged = stage(fixture_rows())
    files = dict(staged.files)
    rows = json.loads(files["listings/MA.json"])
    rows[0]["apply_url"] = url
    files["listings/MA.json"] = json.dumps(rows).encode()
    with pytest.raises(ValueError, match="identity differs"):
        PostingLinks.from_stage(replace(staged, files=files))


def test_catalog_uses_original_names_without_recanonicalizing_keys():
    rows = fixture_rows()
    rows[0]["company_name"] = "The The Acme"
    links = PostingLinks.from_stage(stage(rows))
    assert links.attribute(rows[0]) == ' data-employer-key="the acme"'


def test_annotated_row_data_does_not_enable_renderer_by_itself():
    rows = [dict(row, keys={"MA"}, employer_key="untrusted") for row in fixture_rows()]
    assert MARK.search(run(None, runtime.listing_rows, rows, STAMP)) is None
    assert MARK.search(run(None, runtime.pay_rows, [(rows[0], 30, 35)], STAMP)) is None
