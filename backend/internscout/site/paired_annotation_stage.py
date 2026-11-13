"""Dormant paired annotations from one original export; no publication or I/O."""

from collections.abc import Mapping
from dataclasses import dataclass
import json
from types import MappingProxyType

from .. import follow_catalog as codec
from ..employer_posting_stage import CATALOG_PATH, EmployerPostingStage, stage_employer_postings
from .follow_company_stage import FollowCompanyStage, stage_follow_companies


@dataclass(frozen=True)
class PairedAnnotationStage:
    files: Mapping[str, bytes]
    employer: EmployerPostingStage
    follow: FollowCompanyStage


def _facts(row):
    # Python equality alone equates true with 1, including nested values.
    return json.dumps(
        row, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    )


def stage_paired_annotations(
    selected=None, first_bytes=None, *, enabled=False, max_combined_bytes=None, **follow_options
) -> PairedAnnotationStage | None:
    """Compose independently validated raw stages and return their unchanged receipts.

    All existing Follow pins, prior/genesis and bounds are mandatory as before. The
    caller owns export selection/freshness and must publish the returned bytes and
    catalogs together. Neither stage may consume the other's annotated output.
    """
    if enabled is not True:
        return None
    if (
        type(selected) is not dict
        or len(selected) > 26**2 + 4
        or type(max_combined_bytes) is not int
        or not 0 < max_combined_bytes <= codec._MAX_INTEGER
    ):
        codec._invalid()
    original = dict(selected)
    follow = stage_follow_companies(original, first_bytes, enabled=True, **follow_options)
    index = codec._read(original["listings/index.json"])
    paths = {f"listings/{key}.json" for key in index["files"]}
    employer = stage_employer_postings(
        original["listings/index.json"], {path: original[path] for path in paths}, first_bytes
    )
    paths.add("first.json")
    if set(follow.files) != paths or set(employer.files) != paths | {CATALOG_PATH}:
        codec._invalid()
    aliases = dict(codec._read(follow.catalog.payload)["aliases"])
    output = {CATALOG_PATH: employer.files[CATALOG_PATH]}
    used = len(output[CATALOG_PATH])
    for path in sorted(paths):
        before = codec._read(first_bytes if path == "first.json" else original[path])
        counter = codec._read(employer.files[path])
        company = codec._read(follow.files[path])
        if any(type(rows) is not list or len(rows) != len(before) for rows in (counter, company)):
            codec._invalid()
        combined = []
        for row, left, right in zip(before, counter, company, strict=True):
            if any(type(value) is not dict for value in (row, left, right)) or any(
                key in row for key in ("employer_key", "follow_company_key")
            ):
                codec._invalid()
            expected = (
                (left, "employer_key", employer.posting_keys.get(row["id"])),
                (
                    right,
                    "follow_company_key",
                    aliases.get(row["company_name"]) if row["status"] == "open" else None,
                ),
            )
            if any(
                (key in annotated) != (value is not None) or annotated.get(key) != value
                for annotated, key, value in expected
            ):
                codec._invalid()
            merged = dict(row)
            for annotated, key in ((left, "employer_key"), (right, "follow_company_key")):
                facts = {name: value for name, value in annotated.items() if name != key}
                if _facts(facts) != _facts(row):
                    codec._invalid()
                if key in annotated:
                    merged[key] = codec._key(annotated[key], "companies")
            combined.append(merged)
        encoded = codec._json(combined)
        used += len(encoded)
        if used > max_combined_bytes:
            codec._invalid()
        output[path] = encoded
    return PairedAnnotationStage(MappingProxyType(output), employer, follow)
