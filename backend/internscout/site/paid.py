"""Placement services are only needed by the publishing path."""

from __future__ import annotations


def placement_services():
    from .. import placements

    return placements
