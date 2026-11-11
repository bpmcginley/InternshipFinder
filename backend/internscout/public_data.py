"""Locate the exported listing data read by local tools and site builds."""

import os

PUBLIC_DATA_ENV = "INTERNSCOUT_PUBLIC_DATA"


def public_data_dir(site_dir: str | os.PathLike[str] | None = None) -> str:
    """Use the configured export directory or the site's existing data directory."""
    default = "docs/data" if site_dir is None else os.path.join(site_dir, "data")
    return os.environ.get(PUBLIC_DATA_ENV) or default
