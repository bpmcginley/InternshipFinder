"""Publish local previews and exact public dashboard views for emitted pages."""

from __future__ import annotations

from html import escape
import json
from pathlib import Path
import re
from typing import Protocol

_LANDING = re.compile(r"/internships/(?:[a-z0-9-]+/)+")
_CARD = re.compile(r"/internships/[a-z0-9-]+/(?:[a-z0-9-]+/)?")
_FIELD = re.compile(r"(?:[a-z_]{2,32})?")
_PLACE = re.compile(r"(?:all|remote|Canada|[A-Z]{2})")


class Renderer(Protocol):
    def __call__(self, icon_path: Path, heading: str, *, term: str | None = None) -> bytes: ...


def dashboard_views(pages: list[dict]) -> str:
    views = {}
    for page in pages:
        view = page.get("share_view")
        if view is None or not page["index"]:
            continue
        field, place = view
        path = page["path"]
        if _FIELD.fullmatch(field) and _PLACE.fullmatch(place) and _LANDING.fullmatch(path):
            key = f"{field}/{place}"
            if key in views and views[key] != path:
                raise ValueError("Two generated pages match one dashboard view")
            views[key] = path
    if not views:
        return ""
    # Only validated keys and same-origin slug paths enter this non-executable script.
    payload = json.dumps(views, sort_keys=True, separators=(",", ":"))
    return f'<script type="application/json" id="landing-share-views">{payload}</script>'


def publish(
    site_dir: Path,
    pages: list[dict],
    site_url: str,
    render: Renderer,
) -> list[dict]:
    icon = site_dir / "icon128.png"
    generic = f'<meta property="og:image" content="{site_url}/og-preview.png"/>'
    result = []
    for page in pages:
        card = page.get("share_card")
        if card is None:
            result.append(page)
            continue
        path = page["path"]
        if not _CARD.fullmatch(path) or page["html"].count(generic) != 1:
            raise ValueError("Invalid generated preview target")
        heading, term = card
        relative = path.lstrip("/") + "share.png"
        image = site_dir / relative
        image.parent.mkdir(parents=True, exist_ok=True)
        image.write_bytes(render(icon, heading, term=term))
        url = escape(f"{site_url}/{relative}", quote=True)
        alt = escape(" ".join(value for value in (term, heading) if value), quote=True)
        meta = "\n".join(
            (
                f'<meta property="og:image" content="{url}"/>',
                '<meta property="og:image:width" content="1200"/>',
                '<meta property="og:image:height" content="630"/>',
                f'<meta property="og:image:alt" content="{alt}"/>',
                f'<meta name="twitter:image" content="{url}"/>',
            )
        )
        result.append({**page, "html": page["html"].replace(generic, meta, 1)})
    return result
