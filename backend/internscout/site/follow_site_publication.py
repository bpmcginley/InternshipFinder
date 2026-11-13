"""Explicit private Follow artifact assembly; no CLI, network or production defaults."""

from __future__ import annotations

from dataclasses import dataclass
import ctypes
import os
from pathlib import Path
import re
import shutil
from tempfile import TemporaryDirectory

from .. import core_graph
from . import employer_publication, publish, runtime
from .employer_posting_links import PostingLinks
from .follow_employer_publication import _assets, plan_employer_follow_publication
from .paired_annotation_stage import stage_paired_annotations


@dataclass(frozen=True)
class FollowSiteInput:
    # Trusted caller supplies all pins, bounds and prior/genesis selection explicitly.
    stage_options: dict
    plan_options: dict
    catalog_path: str
    retained_wrappers: tuple
    max_site_files: int  # All traversed directory entries, including directories.
    max_site_bytes: int


def _fail():
    raise ValueError("Invalid private Follow publication")


def _inventory(root, files, size):
    if root.is_symlink() or root.is_junction() or not root.is_dir():
        _fail()
    result, used, entries = {}, 0, 0
    pending = [root]
    while pending:
        with os.scandir(pending.pop()) as children:
            for entry in children:
                entries += 1
                if entries > files:
                    _fail()
                path = Path(entry.path)
                if entry.is_symlink() or path.is_junction():
                    _fail()
                if entry.is_dir(follow_symlinks=False):
                    pending.append(path)
                    continue
                if not entry.is_file(follow_symlinks=False):
                    _fail()
                used += entry.stat(follow_symlinks=False).st_size
                if used > size:
                    _fail()
                result[path.relative_to(root).as_posix()] = path
    return result


def _exact_target(root, relative):
    # A differently-cased component can alias the same Windows target. Reject it
    # even on case-sensitive systems, before writing any member of the batch.
    path = root
    for part in Path(relative).parts:
        if path.is_dir():
            matches = [
                child.name for child in path.iterdir() if child.name.casefold() == part.casefold()
            ]
            if matches and matches != [part]:
                _fail()
        path = path / part
    return path


def _read_reference(value, size):
    path = Path(value)
    if path.is_symlink() or path.is_junction() or not path.is_file() or path.stat().st_size > size:
        _fail()
    # The internal legacy CLI sees an absolute filename, never an option token.
    return str(path.resolve(strict=True))


def _absent_rename(source, destination):
    # Never replace even an empty destination created by a concurrent caller.
    if os.name == "nt":
        os.rename(source, destination)
        return
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, "renameat2", None)
    if rename is None:
        raise OSError("Atomic absent-target rename is unavailable")
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(source), -100, os.fsencode(destination), 1):
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


class _Prepared:
    def __init__(self, data, stage, options, retained, catalog_path):
        self.data, self.stage, self.options = data, stage, options
        self.retained, self.catalog_path = retained, catalog_path
        self.plan = None

    def configure(self, state):
        state.posting_links = PostingLinks.from_stage(self.stage.employer)

        def batch(models):
            if self.plan is not None:
                _fail()
            self.plan = plan_employer_follow_publication(
                self.data["listings"], self.stage, models, **self.options
            )
            if self.plan is None:
                _fail()
            state.follow_script = self.plan.script_url
            return self.plan.models

        return runtime.BuildHooks(load=lambda _: self.data, employer_batch=batch)

    def write(self, root):
        if self.plan is None:
            _fail()
        assets = dict(self.plan.assets)
        for name, body in self.retained.items():
            if name in assets and assets[name] != body:
                _fail()
            assets[name] = body
        if (
            len(assets) > self.options["max_asset_files"]
            or sum(map(len, assets.values())) > self.options["max_asset_bytes"]
        ):
            _fail()
        outputs = {"data/" + name: body for name, body in self.stage.files.items()}
        outputs[self.catalog_path] = self.stage.follow.catalog.payload
        outputs.update(assets)
        # Validate the complete physical namespace before any generated write.
        for name, body in outputs.items():
            path = _exact_target(root, name)
            if name == self.catalog_path and path.exists():
                _fail()
            if name in assets and path.exists() and path.read_bytes() != body:
                _fail()
        # No generated artifact write occurs until the complete model/asset plan succeeds.
        for name, body in outputs.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)


def publish_follow_site(
    source_dir=None,
    output_dir=None,
    *,
    enabled=False,
    inputs=None,
    live_sitemap=None,
    live_noindex=None,
):
    """Build a new absent private directory, leaving source and prior artifacts intact.

    Caller owns a stable regular source and private destination parent. Existing prior
    wrappers are supplied with their approved source hashes and exact graph references.
    No prior asset is expired here. This is not a freshness or release authority check.
    """
    if enabled is not True:
        return None
    if type(inputs) is not FollowSiteInput:
        _fail()
    for value in (inputs.max_site_files, inputs.max_site_bytes):
        if type(value) is not int or value < 1:
            _fail()
    if (
        type(inputs.stage_options) is not dict
        or type(inputs.plan_options) is not dict
        or type(inputs.retained_wrappers) is not tuple
    ):
        _fail()
    if type(inputs.catalog_path) is not str or not re.fullmatch(
        r"data/follow-[a-z0-9-]+\.json", inputs.catalog_path
    ):
        _fail()
    stage_options, options = dict(inputs.stage_options), dict(inputs.plan_options)
    if stage_options.get("enabled") is not True or options.get("enabled") is not True:
        _fail()
    source_dir, output_dir = Path(source_dir), Path(output_dir)
    parent = output_dir.parent.resolve(strict=True)
    if output_dir.exists() or output_dir.is_symlink() or output_dir.is_junction():
        _fail()
    if source_dir.is_symlink() or source_dir.is_junction():
        _fail()
    source_dir = source_dir.resolve(strict=True)
    output_dir = parent / output_dir.name
    if source_dir == parent or source_dir in parent.parents or output_dir in source_dir.parents:
        _fail()
    inventory = _inventory(source_dir, inputs.max_site_files, inputs.max_site_bytes)
    if _exact_target(source_dir, inputs.catalog_path).exists():
        _fail()
    for prefix in ("data/listings", "js/app", "js/app-modules", "js/follow-company-modules"):
        _exact_target(source_dir, prefix)
    if live_noindex is not None and live_sitemap is None:
        _fail()
    references = [
        _read_reference(value, inputs.max_site_bytes)
        for value in (live_sitemap, live_noindex)
        if value is not None
    ]
    captured = employer_publication.capture(
        str(source_dir),
        max_bytes=stage_options["max_source_bytes"] + stage_options["max_first_bytes"],
        max_files=26**2 + 4,
    )
    first = captured["first.json"]
    selected = {name: body for name, body in captured.items() if name != "first.json"}
    stage = stage_paired_annotations(selected, first, **stage_options)
    data = employer_publication.load_capture(str(source_dir), captured)
    current = core_graph.plan(source_dir, None, None, core_graph.APP)
    if options["graph_plan"][0] != current[0]:
        _fail()
    supplied = options["graph_plan"][1]
    if any(supplied.get(name) != body for name, body in current[1].items()):
        _fail()
    if options["standalone"] != (source_dir / "js/follow-company.mjs").read_bytes():
        _fail()
    retained = {}
    if len(inputs.retained_wrappers) > options["max_asset_files"]:
        _fail()
    for old in inputs.retained_wrappers:
        if type(old) is not dict or set(old) != {
            "source",
            "source_sha256",
            "app_sha256",
            "path",
            "body",
        }:
            _fail()
        prior_assets, url, _ = _assets(
            (f'/js/app-modules/{old["app_sha256"]}/entry.mjs', supplied),
            old["app_sha256"],
            old["source"],
            old["source_sha256"],
            options["max_asset_files"],
            options["max_asset_bytes"],
        )
        if (
            old["path"] != url[1:]
            or type(old["body"]) is not bytes
            or old["body"] != prior_assets[url[1:]]
        ):
            _fail()
        if old["path"] in retained:
            _fail()
        retained[old["path"]] = old["body"]
    present = {
        name for name in inventory if name.casefold().startswith("js/follow-company-modules/")
    }
    if present != set(retained) or any(
        inventory[name].read_bytes() != body for name, body in retained.items()
    ):
        _fail()
    prepared = _Prepared(data, stage, options, retained, inputs.catalog_path)
    with TemporaryDirectory(prefix=".internscout-follow-", dir=parent) as temporary:
        staging = Path(temporary) / "site"
        shutil.copytree(source_dir, staging)
        for name, body in captured.items():
            if (staging / "data" / name).read_bytes() != body:
                _fail()
        args = ["publish", str(staging), *references]
        publish.main(args, _follow=prepared)
        _inventory(staging, inputs.max_site_files, inputs.max_site_bytes)
        for name, body in retained.items():
            if (staging / name).read_bytes() != body:
                _fail()
        _absent_rename(staging, output_dir)
    return prepared.plan
