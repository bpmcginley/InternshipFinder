"""Default-off private assembly of one proven export and its exact Follow archive."""

from dataclasses import dataclass
from datetime import datetime
import hashlib
from pathlib import Path
import re
from tempfile import TemporaryDirectory

from .. import asset_versions, site_links
from ..follow_snapshot_archive import (
    INDEX,
    FollowArchiveBounds,
    plan_follow_snapshot_archive,
    select_follow_snapshot_for_enqueue,
)
from scripts import follow_archive_stage as archive_stage
from scripts.follow_archive_from_publication import plan_follow_archive_from_publication
from scripts.ingest_data_writer import _PublishedFollowProvenance
from scripts.check_site_contents import audit, read_allowlist, DEFAULT_ALLOWLIST
from . import follow_site_publication as site


@dataclass(frozen=True)
class ExportFile:
    path: str
    mode: str
    oid: str
    body: bytes


@dataclass(frozen=True)
class FollowArtifactInput:
    site: site.FollowSiteInput
    publication: _PublishedFollowProvenance
    export_files: tuple[ExportFile, ...]
    archive: archive_stage.StagedFollowArchive
    prior: object
    archive_at: datetime
    effective_lower: datetime
    bounds: FollowArchiveBounds
    catalog: object
    max_export_files: int
    max_export_bytes: int


@dataclass(frozen=True)
class PrivateFollowArtifact:
    directory: Path
    public_tree: str
    archive_index_sha256: str
    files: int
    references: int


def _fail():
    raise ValueError("Invalid private Follow artifact")


def _digest(body):
    return hashlib.sha256(body).hexdigest()


def _export(value):
    publication = value.publication
    if (
        type(publication) is not _PublishedFollowProvenance
        or type(publication.public_tree) is not str
        or not re.fullmatch(r"(?:[a-f0-9]{40}|[a-f0-9]{64})", publication.public_tree)
    ):
        _fail()
    if (
        any(
            type(n) is not int or not 0 < n <= 2**53 - 1
            for n in (value.max_export_files, value.max_export_bytes)
        )
        or type(value.export_files) is not tuple
        or not 0 < len(value.export_files) <= value.max_export_files
    ):
        _fail()
    algorithm = hashlib.sha1 if len(publication.public_tree) == 40 else hashlib.sha256

    def oid(kind, body):
        return algorithm(kind + b" " + str(len(body)).encode() + b"\0" + body).hexdigest()

    tree, files, folded, components, used = {}, {}, set(), {}, 0
    for record in value.export_files:
        if (
            type(record) is not ExportFile
            or type(record.path) is not str
            or not re.fullmatch(
                r"[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*", record.path
            )
            or len(record.path) > 512
            or type(record.mode) is not str
            or record.mode not in ("100644", "100755")
            or type(record.oid) is not str
            or type(record.body) is not bytes
        ):
            _fail()
        used += len(record.body)
        if (
            used > value.max_export_bytes
            or record.path.casefold() in folded
            or record.oid != oid(b"blob", record.body)
        ):
            _fail()
        folded.add(record.path.casefold())
        node = tree
        parts = record.path.split("/")
        for length in range(1, len(parts) + 1):
            prefix = "/".join(parts[:length])
            previous = components.setdefault(prefix.casefold(), prefix)
            if previous != prefix or len(components) > value.max_export_files:
                _fail()
        for name in parts[:-1]:
            node = node.setdefault(name, {})
            if type(node) is not dict:
                _fail()
        if parts[-1] in node:
            _fail()
        node[parts[-1]] = record
        files[record.path] = record.body

    def encode(node):
        body = bytearray()
        for name, child in sorted(
            node.items(),
            key=lambda pair: pair[0].encode() + (b"/" if type(pair[1]) is dict else b""),
        ):
            mode, identity = (
                ("40000", encode(child)) if type(child) is dict else (child.mode, child.oid)
            )
            body.extend(mode.encode() + b" " + name.encode() + b"\0" + bytes.fromhex(identity))
        return oid(b"tree", body)

    if encode(tree) != publication.public_tree:
        _fail()
    staged = publication.staged
    slim = {
        name for name in files if re.fullmatch(r"listings/(?:[A-Z]{2}|Canada|remote)\.json", name)
    }
    if not {"first.json", "majors.json", "listings/index.json"} <= files.keys() or (
        files["listings/index.json"] != staged.index_bytes
        or slim != staged.shards.keys()
        or any(files[name] != raw for name, raw in staged.shards.items())
    ):
        _fail()
    return files


def _archive(value):
    bounds = value.bounds
    archive_stage._check_bounds(bounds)
    receipt = value.archive
    if (
        type(receipt) is not archive_stage.StagedFollowArchive
        or type(receipt.files) is not tuple
        or not 0 < len(receipt.files) <= bounds.max_entries + 1
    ):
        _fail()
    root = archive_stage._parent(receipt.directory)
    files, used = {}, 0
    for item in receipt.files:
        if (
            type(item) is not archive_stage.ArchiveFileReceipt
            or type(item.path) is not str
            or not archive_stage._PATH.fullmatch(item.path)
            or item.path in files
            or type(item.size) is not int
            or not 0 < item.size <= bounds.max_archive_bytes
        ):
            _fail()
        used += item.size
        if used > bounds.max_archive_bytes:
            _fail()
        path = site._exact_target(root, item.path)
        info = path.lstat()
        if (
            not archive_stage._regular(info)
            or not path.is_file()
            or info.st_nlink != 1
            or info.st_size != item.size
        ):
            _fail()
        with path.open("rb") as stream:
            raw = stream.read(item.size + 1)
        if len(raw) != item.size or _digest(raw) != item.sha256:
            _fail()
        archive_stage._verify(path, raw)
        files[item.path] = raw
    if (
        set(site._inventory(root, bounds.max_entries + 3, bounds.max_archive_bytes)) != set(files)
        or INDEX not in files
        or _digest(files[INDEX]) != receipt.index_sha256
    ):
        _fail()
    return files


def _plan(value, prior, raw):
    expected = plan_follow_archive_from_publication(
        value.publication,
        prior,
        effective_lower=value.effective_lower,
        now=value.archive_at,
        bounds=value.bounds,
        catalog=value.catalog,
        max_source_bytes=value.max_export_bytes,
        max_source_rows=value.site.stage_options["max_source_rows"],
    )
    if (
        expected is None
        or expected.base_index_sha256 != value.archive.base_index_sha256
        or expected.files != raw
    ):
        _fail()


def _fresh(value, raw, now):
    if (
        not isinstance(now, datetime)
        or now.utcoffset() is None
        or now.microsecond % 1000
        or now < value.archive_at
    ):
        _fail()
    # Preserve original checked_at/raw bytes. If a cutoff passed, require a new
    # upstream archive receipt instead of extending retention or silently pruning.
    if (
        plan_follow_snapshot_archive(raw, None, now=now, bounds=value.bounds).files != raw
        or select_follow_snapshot_for_enqueue(
            raw, effective_lower=value.effective_lower, now=now, bounds=value.bounds
        )
        is None
    ):
        _fail()


def assemble_follow_artifact(
    source_dir=None, output_dir=None, *, enabled=False, inputs=None, clock=None
):
    """Return a newly assembled private directory, never a production publication.

    Caller owns stable real input directories and the private output parent. The
    original accepted receipt and complete raw Git entries come from trusted local
    acquisition. No Git, provider, branch, time or production setting is selected.
    """
    if enabled is not True:
        return None
    if (
        type(inputs) is not FollowArtifactInput
        or type(inputs.site) is not site.FollowSiteInput
        or not callable(clock)
    ):
        _fail()
    raw_export = _export(inputs)
    archive_stage._check_bounds(inputs.bounds)
    prior = archive_stage._capture(inputs.prior, inputs.bounds)
    raw_archive = _archive(inputs)
    _plan(inputs, prior, raw_archive)
    started = clock()
    _fresh(inputs, raw_archive, started)
    source = Path(source_dir)
    if source.is_symlink() or source.is_junction():
        _fail()
    source = source.resolve(strict=True)
    site._inventory(source, inputs.site.max_site_files, inputs.site.max_site_bytes)
    data = site._exact_target(source, "data")
    if set(site._inventory(data, inputs.max_export_files, inputs.max_export_bytes)) != set(
        raw_export
    ):
        _fail()
    for name, body in raw_export.items():
        archive_stage._verify(site._exact_target(data, name), body)
    output = Path(output_dir)
    parent = archive_stage._parent(output.parent)
    output = parent / output.name
    if (
        output.exists()
        or output.is_symlink()
        or output.is_junction()
        or source == parent
        or source in parent.parents
        or output in source.parents
    ):
        _fail()
    # Keep nested graph paths below common Windows path limits.
    with TemporaryDirectory(prefix=".fa-", dir=parent) as temporary:
        staged = Path(temporary) / "site"
        plan = site.publish_follow_site(source, staged, enabled=True, inputs=inputs.site)
        # A fresh raw source never supplies an existing archive namespace.
        for name in raw_archive:
            if site._exact_target(staged, name).exists():
                _fail()
        for name, body in raw_archive.items():
            path = staged / name
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("xb") as stream:
                if stream.write(body) != len(body):
                    _fail()
        asset_versions.version_assets(staged)
        site._inventory(staged, inputs.site.max_site_files, inputs.site.max_site_bytes)
        for name, body in raw_archive.items():
            archive_stage._verify(staged / name, body)
        links = site_links.audit(staged)
        if links["problems"]:
            _fail()
        # Exact private exceptions, not production allowlist changes or a new mode.
        additions = {
            inputs.site.catalog_path,
            plan.script_url[1:],
            *raw_archive,
            *(entry["path"] for entry in inputs.site.retained_wrappers),
        }
        patterns = read_allowlist(DEFAULT_ALLOWLIST) + [
            re.compile(re.escape(name)) for name in additions
        ]
        files, problems = audit(staged, patterns)
        if problems:
            _fail()
        ended = clock()
        if not isinstance(ended, datetime) or ended < started:
            _fail()
        _fresh(inputs, raw_archive, ended)
        site._absent_rename(staged, output)
    return PrivateFollowArtifact(
        output,
        inputs.publication.public_tree,
        inputs.archive.index_sha256,
        len(files),
        links["internal_references"],
    )
