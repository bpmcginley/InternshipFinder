"""Stage dashboard module graphs under immutable URLs."""

from collections.abc import Mapping, Set
from dataclasses import dataclass
import hashlib
from pathlib import Path
import re
import subprocess


ENTRY = "entry.mjs"
DIGEST = re.compile(r"[0-9a-f]{64}")
MODULE_NAME = re.compile(r"[a-z][a-z0-9-]*\.mjs")
IMPORT_LINE = re.compile(
    rb'^[ \t]*import[ \t]+(?:[^\r\n;]+?[ \t]+from[ \t]+)?(["\'])\./([a-z][a-z0-9-]*\.mjs)\1;[ \t]*$',
    re.M,
)
IMPORT_TOKEN = re.compile(rb"\bimport\b")
# Reject named and star export clauses at their opening token, including comments and
# line breaks before the clause. Declaration exports cannot refer to another module.
EXPORT_CLAUSE = re.compile(r"\bexport\b(?:[\s\ufeff]|/\*[\s\S]*?\*/|//[^\r\n\u2028\u2029]*)*[{*]")


@dataclass(frozen=True)
class Graph:
    name: str
    source: str
    output: str

    def is_entry(self, path: str) -> bool:
        return path == f"{self.source}/{ENTRY}" or bool(
            re.fullmatch(rf"{re.escape(self.output)}/[0-9a-f]{{64}}/entry\.mjs", path)
        )


CORE = Graph("Core", "js/core", "js/modules")
APP = Graph("App", "js/app", "js/app-modules")
BUY = Graph("Buy", "js/buy", "js/buy-modules")
GRAPHS = (CORE, APP, BUY)


@dataclass(frozen=True)
class History:
    repo: Path
    tip: str


class CoreGraphError(ValueError):
    """An immutable Core generation is incomplete or invalid."""


class CoreGraphContentError(CoreGraphError):
    """A readable snapshot cannot be published as a Core graph."""


def _is_link(path: Path) -> bool:
    return path.is_symlink() or bool(getattr(path, "is_junction", lambda: False)())


def _read(folder: Path, graph: Graph) -> dict[str, bytes]:
    if not folder.is_dir() or _is_link(folder):
        raise CoreGraphError(f"{graph.name} module directory is missing or invalid")
    files = {path.name: path for path in folder.iterdir()}
    _validate_names(files.keys(), graph)
    if any(not path.is_file() or _is_link(path) for path in files.values()):
        raise CoreGraphError(f"{graph.name} modules must be regular files")
    return {name: path.read_bytes() for name, path in files.items()}


def _validate_names(names: Set[str], graph: Graph) -> None:
    if ENTRY not in names or any(not MODULE_NAME.fullmatch(name) for name in names):
        raise CoreGraphContentError(
            f"{graph.name} generations require an entry and safe flat module names"
        )


def fingerprint(files: Mapping[str, bytes]) -> str:
    digest = hashlib.sha256()
    for name, content in sorted(files.items()):
        digest.update(name.encode("ascii") + b"\0")
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return digest.hexdigest()


def _validate_source(files: Mapping[str, bytes], graph: Graph) -> None:
    """Require single-line sibling imports and declaration exports."""
    pending, reachable = [ENTRY], set()
    while pending:
        name = pending.pop()
        if name in reachable:
            continue
        reachable.add(name)
        content = files[name].replace(b"\r\n", b"\n")
        try:
            source = content.decode("utf-8")
        except UnicodeDecodeError:
            raise CoreGraphContentError(f"{graph.name} modules must be UTF-8") from None
        if EXPORT_CLAUSE.search(source):
            raise CoreGraphContentError(f"{graph.name} modules must use declaration exports")
        imports = IMPORT_LINE.findall(content)
        dependencies = {name.decode("ascii") for _, name in imports}
        if len(imports) != len(IMPORT_TOKEN.findall(content)) or dependencies - files.keys():
            raise CoreGraphContentError(f"{graph.name} modules must use static sibling imports")
        pending.extend(dependencies)
    if reachable != files.keys():
        raise CoreGraphContentError(f"{graph.name} graph contains unreachable modules")


def _git(repo: Path, *args: str) -> bytes:
    result = subprocess.run(
        ["git", "--no-replace-objects", "-C", str(repo), *args], capture_output=True, check=False
    )
    if result.returncode:
        raise CoreGraphError("Cannot read Core generation from Git")
    return result.stdout


def _git_source(repo: Path, ref: str, graph: Graph) -> dict[str, bytes] | None:
    source = f"docs/{graph.source}"
    node = _git(repo, "ls-tree", "-z", ref, "--", source)
    if not node:
        return None  # A classic rollback removes the current native source.
    if not node.startswith(b"040000 tree "):
        raise CoreGraphContentError(f"{graph.name} Git source must be a directory")
    tree = f"{ref}:{source}"
    entries = _git(repo, "ls-tree", "-z", tree).split(b"\0")[:-1]
    if any(not entry.startswith(b"100644 blob ") for entry in entries):
        raise CoreGraphContentError(f"{graph.name} Git source must contain regular module files")
    names = {entry.partition(b"\t")[2].decode("ascii", "surrogateescape") for entry in entries}
    _validate_names(names, graph)
    files = {name: _git(repo, "show", f"{tree}/{name}") for name in names}
    _validate_source(files, graph)
    return files


def pin_history(repo: Path) -> History:
    if _git(repo, "rev-parse", "--is-shallow-repository").strip() != b"false":
        raise CoreGraphError("Core retention requires complete first-parent Git history")
    tip = _git(repo, "rev-parse", "--verify", "HEAD").decode("ascii").strip()
    return History(repo, tip)


def _git_generations(history: History, graph: Graph) -> tuple[str | None, dict[str, bytes]]:
    repo, tip = history.repo, history.tip
    current = _git_source(repo, tip, graph)
    revisions = _git(
        repo, "rev-list", "--first-parent", "--full-history", tip, "--", f"docs/{graph.source}"
    )
    retained: dict[str, bytes] = {}
    for ref in revisions.decode("ascii").splitlines():
        try:
            files = _git_source(repo, ref, graph)
        except CoreGraphContentError:
            # A rejected build can leave invalid source in first-parent history.
            # The checkout above is always strict, and Git read failures still abort.
            continue
        if files is None:
            continue
        digest = fingerprint(files)
        retained.update({f"{graph.output}/{digest}/{name}": data for name, data in files.items()})
    return (fingerprint(current) if current is not None else None), retained


def plan(
    root: Path, previous: Path | None, history: History | None, graph: Graph
) -> tuple[str | None, dict[str, bytes]]:
    source = root / graph.source
    pinned, staged = _git_generations(history, graph) if history is not None else (None, {})
    output = root / graph.output
    for directory in (output, previous):
        if directory is None or (directory == output and not directory.exists()):
            continue
        if not directory.is_dir() or _is_link(directory):
            raise CoreGraphError(f"Invalid {graph.name} generation directory")
        for folder in sorted(directory.iterdir()):
            if not DIGEST.fullmatch(folder.name):
                raise CoreGraphError(f"Invalid {graph.name} generation name")
            files = _read(folder, graph)
            _validate_source(files, graph)
            if fingerprint(files) != folder.name:
                raise CoreGraphError(f"{graph.name} generation does not match its fingerprint")
            if directory != output:
                staged.update(
                    {f"{graph.output}/{folder.name}/{name}": data for name, data in files.items()}
                )
    if not source.exists():
        if pinned is not None:
            raise CoreGraphError(
                f"Staged {graph.name} modules are missing from the pinned Git checkout"
            )
        return None, staged
    current = _read(source, graph)
    _validate_source(current, graph)
    active = fingerprint(current)
    if history is not None and active != pinned:
        raise CoreGraphError(f"Staged {graph.name} modules do not match the pinned Git checkout")
    staged.update({f"{graph.output}/{active}/{name}": data for name, data in current.items()})
    return f"/{graph.output}/{active}/{ENTRY}", staged
