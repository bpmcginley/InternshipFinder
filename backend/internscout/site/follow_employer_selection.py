"""Dormant model enrichment from a validated paired stage and its organic render input."""

from copy import deepcopy
from collections.abc import Mapping
from dataclasses import dataclass, replace
import hashlib
import json
from types import MappingProxyType

from .. import follow_catalog as codec
from . import employer, source
from .paired_annotation_stage import PairedAnnotationStage


def _fail():
    raise ValueError('Invalid same-export employer Follow selection')


def _budget(value, remaining):
    """Bound nested input before copying or JSON encoding, including mutated caller rows."""
    if remaining < 1:
        _fail()
    kind = type(value)
    if kind is str:
        if len(value) > remaining:
            _fail()
        remaining -= len(value.encode('utf-8'))
    elif kind in (dict, list, set):
        if len(value) > remaining:
            _fail()
        remaining -= 1
        if kind is dict:
            for key, item in value.items():
                if type(key) is not str:
                    _fail()
                remaining = _budget(item, _budget(key, remaining))
        else:
            for item in value:
                remaining = _budget(item, remaining)
    elif kind in (int, float, bool, type(None)):
        if kind is int and value.bit_length() > remaining * 8:
            _fail()
        remaining -= 1
    else:
        _fail()
    if remaining < 0:
        _fail()
    return remaining


def _facts(row, *, limit, public=False, derive=False):
    if type(row) is not dict:
        _fail()
    try:
        _budget(row, limit)
    except (RecursionError, UnicodeError):
        _fail()
    value = dict(row)
    if 'keys' in value:
        keys = value.pop('keys')
        if not public:
            if type(keys) is not set or any(type(key) is not str for key in keys):
                _fail()
            value['keys'] = sorted(keys)
    if derive:
        # source.load adds a derived US metro to the original JSON region. Reuse its
        # exact classifier; do not ignore any other public row fact or normalize names.
        if value.get('regions'):
            value['regions'] = [dict(region) for region in value['regions']]
        for region in value.get('regions') or []:
            metro = source.us_metro(region) if region.get('kind') != 'canada' else None
            if metro:
                region['metro'] = metro
    encoded = json.dumps(
        value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False
    )
    if len(encoded.encode('utf-8')) > limit:
        _fail()
    return encoded


@dataclass(frozen=True)
class EmployerFollowSelection:
    stage: PairedAnnotationStage
    _source: list[dict]
    _source_count: int
    _rows: Mapping[str, tuple[dict, str, str, int, int]]
    _aliases: Mapping[str, str]
    _companies: frozenset[str]

    def select(self, model, *, enabled=False):
        """Copy and enrich one current organic model; omission preserves exact identity."""
        if enabled is not True:
            return model
        if (
            type(model) is not employer.Page
            or model.follow_company is not None
            or type(model.items) is not list
            or not model.items
            or len(model.items) > self._source_count
            or len(self._source) != self._source_count
        ):
            _fail()
        items = []
        for row in model.items:
            if type(row) is not dict or type(row.get('id')) is not str:
                _fail()
            captured = self._rows.get(row['id'])
            if (
                captured is None
                or captured[0] is not row
                or self._source[captured[3]] is not row
                or _facts(row, limit=captured[4]) != captured[1]
            ):
                _fail()
            items.append(dict(deepcopy(row), follow_company_key=captured[2]))
        return employer.with_company_follow(
            replace(model, items=items, spellings=list(model.spellings)),
            aliases=self._aliases,
            companies=self._companies,
        )


def prepare_follow_employer_selection(
    organic_rows=None, stage=None, *, enabled=False, max_rows=None, max_bytes=None
) -> EmployerFollowSelection | None:
    """Bind source.load's rows to an already validated SAME-original paired stage.

    This is not receipt acquisition or authentication. The caller must retain the
    existing source/catalog/preview/prior pins and freshness gates from staging.
    No files, globals, caller rows, models or receipts are modified here.
    """
    if enabled is not True:
        return None
    if (
        type(stage) is not PairedAnnotationStage
        or type(organic_rows) is not list
        or any(type(n) is not int or not 0 < n <= codec._MAX_INTEGER for n in (max_rows, max_bytes))
        or len(organic_rows) > max_rows
        or len(stage.follow.files) > 26**2 + 1
    ):
        _fail()
    payload = stage.follow.catalog.payload
    raw_files = tuple(stage.follow.files.values())
    if (
        type(payload) is not bytes
        or any(type(raw) is not bytes for raw in raw_files)
        or len(payload) + sum(map(len, raw_files)) > max_bytes
        or hashlib.sha256(payload).hexdigest() != stage.follow.catalog.catalog_sha256
    ):
        _fail()
    catalog = codec._read(payload)
    aliases = MappingProxyType(dict(catalog['aliases']))
    companies = frozenset(catalog['signup']['companies'])
    identities, occurrences = {}, 0
    for raw in raw_files:
        rows = codec._read(raw)
        if type(rows) is not list:
            _fail()
        occurrences += len(rows)
        if occurrences > max_rows:
            _fail()
        for row in rows:
            if type(row) is not dict:
                _fail()
            if row.get('status') != 'open':
                continue
            key = row.get('follow_company_key')
            if type(row.get('id')) is not str or key not in companies:
                _fail()
            original = {k: v for k, v in row.items() if k != 'follow_company_key'}
            identity = (_facts(original, limit=max_bytes, public=True, derive=True), key)
            if identities.setdefault(row['id'], identity) != identity:
                _fail()
    captured, used = {}, 0
    for position, row in enumerate(organic_rows):
        if type(row) is not dict or type(row.get('id')) is not str:
            _fail()
        identity = identities.get(row['id'])
        if (
            row['id'] in captured
            or identity is None
            or any(k in row for k in ('follow_company_key', 'employer_key'))
            or _facts(row, limit=max_bytes, public=True) != identity[0]
        ):
            _fail()
        facts = _facts(row, limit=max_bytes)
        size = len(facts.encode('utf-8'))
        used += size
        if used > max_bytes:
            _fail()
        captured[row['id']] = (row, facts, identity[1], position, size)
    return EmployerFollowSelection(
        stage, organic_rows, len(organic_rows), MappingProxyType(captured), aliases, companies
    )
