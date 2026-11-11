"""Optional direct-link annotations from one validated public release stage."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from html import escape
from types import MappingProxyType

from ..employer_catalog import build_employer_catalog
from ..employer_posting_stage import (
    CATALOG_BYTES,
    CATALOG_PATH,
    EmployerPostingStage,
    _direct_posting,
)
from .source import employer_key


@dataclass(frozen=True)
class PostingLinks:
    """Copied public ID/key/URL bindings; never inferred from arbitrary renderer rows."""

    bindings: Mapping[str, tuple[str, str]]

    @classmethod
    def from_stage(cls, stage: EmployerPostingStage) -> PostingLinks:
        """The caller stages and renders the same independently pinned export.

        Bind URLs as well as IDs so a different posting cannot borrow an annotation.
        No output is written and no publication or counting is enabled here.
        """
        if not isinstance(stage, EmployerPostingStage):
            raise ValueError("Expected a validated employer posting stage")
        keys = dict(stage.posting_keys)
        if any(not isinstance(role_id, str) or not role_id for role_id in keys):
            raise ValueError("Invalid staged posting ID")
        bindings, names = {}, set()
        for path, raw in stage.files.items():
            if not path.startswith("listings/") or not path.endswith(".json"):
                continue
            for row in json.loads(raw):
                role_id = row["id"]
                key = row.get("employer_key")
                if key is None:
                    if role_id in keys:
                        raise ValueError("Missing staged posting key")
                    continue
                url = row.get("apply_url")
                if (
                    keys.get(role_id) != key
                    or employer_key(row["company_name"]) != key
                    or not _direct_posting(url)
                ):
                    raise ValueError("Staged posting identity differs")
                binding = (key, url)
                if bindings.setdefault(role_id, binding) != binding:
                    raise ValueError("Conflicting staged posting URL")
                names.add(row["company_name"])
        if bindings.keys() != keys.keys():
            raise ValueError("Incomplete staged posting bindings")
        # The catalog accepts names, not keys: canonicalization is not necessarily idempotent.
        catalog = build_employer_catalog(tuple(names), complete=True, max_bytes=CATALOG_BYTES)
        if catalog != stage.files.get(CATALOG_PATH):
            raise ValueError("Staged posting keys differ from the release catalog")
        return cls(MappingProxyType(bindings))

    def attribute(self, row: dict) -> str:
        binding = self.bindings.get(str(row.get("id")))
        if binding is None:
            return ""
        key, url = binding
        if row.get("apply_url") != url or employer_key(row.get("company_name") or "") != key:
            raise ValueError("Rendered posting differs from its employer release")
        return f' data-employer-key="{escape(key, quote=True)}"'
