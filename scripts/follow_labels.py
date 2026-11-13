"""Repository-only, default-off labels for an exact canonical Follow catalog."""

from collections import Counter
from dataclasses import dataclass
import hashlib
import re

from internscout import follow_catalog as codec
from internscout.classify import ALL_FIELDS
from internscout.site.follow_publication import prepare_follow_catalog, _prior
from internscout.vocabulary import (
    FIELD_DISPLAY_OVERRIDES,
    US_PLACE_LABELS,
    CANADIAN_PROVINCES,
)

_KINDS = ('companies', 'fields', 'states')
_OPTIONS = frozenset(
    (
        'enabled',
        'source_sha256',
        'prior_bytes',
        'prior_sha256',
        'genesis',
        'max_source_bytes',
        'max_source_rows',
        'max_keys',
        'max_bytes',
    )
)
_LABEL_KEYS = ['version', 'source_sha256', 'catalog_sha256', *_KINDS]
_DIGEST = re.compile(r'[a-f0-9]{64}')
_FIELD_LABELS = dict(FIELD_DISPLAY_OVERRIDES)
_STATE_LABELS = dict((*US_PLACE_LABELS, *CANADIAN_PROVINCES))


@dataclass(frozen=True)
class FollowLabels:
    payload: bytes
    source_sha256: str
    catalog_sha256: str
    labels_sha256: str
    prior_labels_sha256: str | None


def _fail():
    raise ValueError('Invalid or incomplete Follow label lineage')


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _pin(value):
    return type(value) is str and _DIGEST.fullmatch(value) is not None


def _label(value):
    # Match the existing Worker presentation port's plain, 200 UTF-16-unit label.
    if (
        type(value) is not str
        or not value
        or value != value.strip(codec._TRIM)
        or codec._BAD.search(value)
        or len(value.encode('utf-16-be')) > 400
    ):
        _fail()
    return value


def _previous(raw, digest, catalog_raw, catalog_digest, max_keys, max_bytes):
    if (
        type(raw) is not bytes
        or not 0 < len(raw) <= max_bytes
        or not _pin(digest)
        or _sha(raw) != digest
    ):
        _fail()
    valid = _prior(catalog_raw, catalog_digest, max_keys)
    catalog = codec._read(catalog_raw)
    value = codec._read(raw)
    if (
        type(value) is not dict
        or list(value) != _LABEL_KEYS
        or type(value['version']) is not int
        or value['version'] != 1
        or value['source_sha256'] != catalog['source_sha256']
        or value['catalog_sha256'] != catalog_digest
        or codec._json(value) != raw
    ):
        _fail()
    labels = {}
    for kind in _KINDS:
        pairs = value[kind]
        if type(pairs) is not list or len(pairs) != len(valid[kind]):
            _fail()
        group = {}
        for pair in pairs:
            if (
                type(pair) is not list
                or len(pair) != 2
                or type(pair[0]) is not str
                or pair[0] not in valid[kind]
                or pair[0] in group
            ):
                _fail()
            group[pair[0]] = _label(pair[1])
        labels[kind] = group
    return labels


def produce_follow_labels(
    selected=None,
    catalog_bytes=None,
    *,
    enabled=False,
    catalog_sha256=None,
    stage_options=None,
    prior_label_bytes=None,
    prior_label_sha256=None,
    max_label_bytes=None,
):
    """Return bytes/pins without I/O. Caller supplies trusted source and predecessor pins.

    Current names use the existing employer-page spelling choice over unique open
    roles. Retained-only names must come from a complete pinned predecessor label
    artifact. No source acquisition, output path, historical label or release is inferred.
    """
    if enabled is not True:
        return None
    if (
        type(stage_options) is not dict
        or stage_options.keys() != _OPTIONS
        or type(max_label_bytes) is not int
        or not 0 < max_label_bytes <= 2000000
        or type(catalog_bytes) is not bytes
        or not _pin(catalog_sha256)
    ):
        _fail()
    options = dict(stage_options)
    if any(
        type(options[key]) is not int or not 0 < options[key] <= cap
        for key, cap in (('max_bytes', 1000000), ('max_keys', 10000))
    ):
        _fail()
    if not 0 < len(catalog_bytes) <= options['max_bytes'] or _sha(catalog_bytes) != catalog_sha256:
        _fail()
    if type(selected) is not dict or len(selected) > 26**2 + 4:
        _fail()
    selected = dict(selected)
    # This validates every original shard, complete counts, duplicates, source pin
    # and explicit predecessor/genesis before any display name is selected.
    stage = prepare_follow_catalog(selected, **options)
    if stage is None or stage.payload != catalog_bytes or stage.catalog_sha256 != catalog_sha256:
        _fail()
    valid = _prior(catalog_bytes, catalog_sha256, options['max_keys'])
    catalog = codec._read(catalog_bytes)
    if options['genesis'] is True:
        if prior_label_bytes is not None or prior_label_sha256 is not None:
            _fail()
        previous = {kind: {} for kind in _KINDS}
    else:
        previous = _previous(
            prior_label_bytes,
            prior_label_sha256,
            options['prior_bytes'],
            options['prior_sha256'],
            options['max_keys'],
            max_label_bytes,
        )

    aliases = dict(catalog['aliases'])
    names = {key: Counter() for key in catalog['signup']['companies']}
    seen = set()
    index = codec._read(selected['listings/index.json'])
    for shard in index['files']:
        for row in codec._read(selected[f'listings/{shard}.json']):
            if row['id'] not in seen and row['status'] == 'open':
                names[aliases[row['company_name']]][row['company_name']] += 1
            seen.add(row['id'])
    current = {kind: {} for kind in _KINDS}
    for key, counts in names.items():
        if not counts:
            _fail()
        # Same deterministic rule as site.build.register_employers.
        current['companies'][key] = _label(
            min(counts, key=lambda name: (-counts[name], len(name), name))
        )
    for key in catalog['signup']['fields']:
        if key not in ALL_FIELDS:
            _fail()
        # Existing native Core fieldLabel behavior, only for qualified known keys.
        current['fields'][key] = _FIELD_LABELS.get(key) or (
            key.upper() if len(key) <= 3 else (key[0].upper() + key[1:]).replace('_', ' ')
        )
    for key in catalog['signup']['states']:
        if key not in _STATE_LABELS:
            _fail()
        current['states'][key] = _STATE_LABELS[key]

    envelope = dict(
        version=1,
        source_sha256=stage.source_sha256,
        catalog_sha256=catalog_sha256,
        companies=[],
        fields=[],
        states=[],
    )
    used = len(codec._json(envelope))
    if used > max_label_bytes:
        _fail()
    for kind in _KINDS:
        for key in codec._sorted(valid[kind]):
            label = current[kind].get(key, previous[kind].get(key))
            pair = [key, _label(label)]
            used += len(codec._json(pair)) + bool(envelope[kind])
            if used > max_label_bytes:
                _fail()
            envelope[kind].append(pair)
    payload = codec._json(envelope)
    if len(payload) != used:
        _fail()
    return FollowLabels(
        payload, stage.source_sha256, catalog_sha256, _sha(payload), prior_label_sha256
    )
