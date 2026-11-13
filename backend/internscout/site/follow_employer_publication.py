"""Pure opt-in employer Follow preflight; no publisher, history selection or I/O."""

from dataclasses import dataclass
import hashlib
import re
from types import MappingProxyType
from collections.abc import Mapping

from .. import core_graph
from ..follow_catalog import _MAX_INTEGER
from . import employer
from .follow_employer_selection import prepare_follow_employer_selection
from .paired_annotation_stage import PairedAnnotationStage
from .taxonomy import SLUG_MAX


_IMPORTS = (
    (
        b'import { followSelection, FOLLOW_COPY, normalizeFollowEmail } from "./app/follow-form.mjs";',
        'follow-form.mjs',
    ),
    (b'import { createDashboardFollowRequest } from "./app/follow.mjs";', 'follow.mjs'),
)
# Whole reviewed modules from #594, LF-normalized for checkout independence.
# A helper change requires an explicit reviewed compatibility repin, not regex inference.
_HELPERS = {
    'follow-form.mjs': '5168fac76be78d40525c28194bf6bef97909c542dabb91a17fd7385f916637f8',
    'follow.mjs': '1e7372b96015dc7ec6cf3e0215ab77a5b608c939f43ba2cf9bce7171e91985a1',
}
_OPENING = b'// Explicit employer markup only; no auth/storage/catalog discovery or default page reference.'
_GRAPH_PATH = re.compile(r'js/app-modules/([0-9a-f]{64})/([a-z][a-z0-9-]*\.mjs)')
_PAGE_PATH = re.compile(r'/internships/at/([a-z0-9]+(?:-[a-z0-9]+)*)/')


def _fail():
    raise ValueError('Invalid employer Follow publication plan')


@dataclass(frozen=True)
class EmployerFollowPublication:
    stage: PairedAnnotationStage
    models: tuple[employer.Page, ...]
    assets: Mapping[str, bytes]
    script_url: str
    app_sha256: str
    standalone_sha256: str


def _assets(graph_plan, app_sha256, standalone, standalone_sha256, max_files, max_bytes):
    if (
        type(graph_plan) is not tuple
        or len(graph_plan) != 2
        or type(graph_plan[0]) is not str
        or type(graph_plan[1]) is not dict
        or not 0 < len(graph_plan[1]) < max_files
        or type(app_sha256) is not str
        or not core_graph.DIGEST.fullmatch(app_sha256)
        or graph_plan[0] != f'/js/app-modules/{app_sha256}/entry.mjs'
        or type(standalone_sha256) is not str
        or not core_graph.DIGEST.fullmatch(standalone_sha256)
        or type(standalone) is not bytes
        or len(standalone) > max_bytes
    ):
        _fail()
    size = len(standalone)
    for path, body in graph_plan[1].items():
        if (
            type(path) is not str
            or len(path) > max_bytes
            or not _GRAPH_PATH.fullmatch(path)
            or type(body) is not bytes
        ):
            _fail()
        size += len(body)
        if size > max_bytes:
            _fail()
    if hashlib.sha256(standalone).hexdigest() != standalone_sha256:
        _fail()
    assets = dict(graph_plan[1])
    generations = {}
    for path, body in assets.items():
        match = _GRAPH_PATH.fullmatch(path)
        generations.setdefault(match[1], {})[match[2]] = body
    for digest, files in generations.items():
        core_graph._validate_names(files.keys(), core_graph.APP)
        core_graph._validate_source(files, core_graph.APP)
        if core_graph.fingerprint(files) != digest:
            _fail()
    current = generations.get(app_sha256)
    if current is None:
        _fail()
    for name, digest in _HELPERS.items():
        if (
            name not in current
            or hashlib.sha256(current[name].replace(b'\r\n', b'\n')).hexdigest() != digest
        ):
            _fail()
    text = standalone.decode('utf-8')
    if (
        core_graph.EXPORT_CLAUSE.search(text)
        or len(core_graph.IMPORT_TOKEN.findall(standalone)) != 2
    ):
        _fail()
    newline = b'\r\n' if standalone.startswith(_OPENING + b'\r\n') else b'\n'
    opening = newline.join((_OPENING, *[item[0] for item in _IMPORTS])) + newline
    if not standalone.startswith(opening):
        _fail()
    cursor = len(_OPENING) + len(newline)
    parts = [standalone[:cursor]]
    for declaration, name in _IMPORTS:
        target = f'/js/app-modules/{app_sha256}/{name}'.encode('ascii')
        parts.append(declaration.replace(b'./app/' + name.encode('ascii'), target))
        parts.append(newline)
        cursor += len(declaration) + len(newline)
    assembled = b''.join(parts) + standalone[cursor:]
    digest = hashlib.sha256(assembled).hexdigest()
    path = f'js/follow-company-modules/{digest}.mjs'
    assets[path] = assembled
    if sum(map(len, assets.values())) > max_bytes:
        _fail()
    return MappingProxyType(assets), '/' + path, digest


def plan_employer_follow_publication(
    organic_rows=None,
    stage=None,
    models=None,
    *,
    enabled=False,
    graph_plan=None,
    app_sha256=None,
    standalone=None,
    standalone_sha256=None,
    max_rows=None,
    max_source_bytes=None,
    max_models=None,
    max_model_rows=None,
    max_asset_files=None,
    max_asset_bytes=None,
) -> EmployerFollowPublication | None:
    """Validate a whole explicitly selected batch before returning any publishable plan.

    The trusted caller supplies core_graph.plan(APP), its CURRENT expected generation,
    pinned approved standalone source bytes, and a validated same-export paired stage.
    This authenticates no release and selects no paths, Git revisions, bounds or policies.
    Caller retains previous assembled wrappers and their graph generations across builds.
    """
    if enabled is not True:
        return None
    if (
        any(
            type(n) is not int or not 0 < n <= _MAX_INTEGER
            for n in (
                max_rows,
                max_source_bytes,
                max_models,
                max_model_rows,
                max_asset_files,
                max_asset_bytes,
            )
        )
        or type(models) is not list
        or not 0 < len(models) <= max_models
    ):
        _fail()
    paths, occurrences = set(), 0
    for model in models:
        if type(model) is not employer.Page or type(model.path) is not str:
            _fail()
        match = _PAGE_PATH.fullmatch(model.path)
        if (
            not match
            or len(match[1]) > SLUG_MAX
            or model.path == '/internships/at/altera-corporation/'  # publish._write_site redirect
            or model.path in paths
            or type(model.items) is not list
            or not model.items
        ):
            _fail()
        paths.add(model.path)
        occurrences += len(model.items)
        if occurrences > max_model_rows:
            _fail()
    try:
        assets, script_url, assembled_sha256 = _assets(
            graph_plan, app_sha256, standalone, standalone_sha256, max_asset_files, max_asset_bytes
        )
        selection = prepare_follow_employer_selection(
            organic_rows, stage, enabled=True, max_rows=max_rows, max_bytes=max_source_bytes
        )
        selected = [selection.select(model, enabled=True) for model in models]
    except (ValueError, TypeError, KeyError, RecursionError, UnicodeError):
        _fail()
    return EmployerFollowPublication(
        stage, tuple(selected), assets, script_url, app_sha256, assembled_sha256
    )
