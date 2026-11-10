"""Which board scans prove absence, and how a listing is matched to the board that proved it.

An adapter signals a complete scan by setting co["_scan_complete"] (sources.common.mark_complete)
only when it read every result its API reported. run_ingest.scan_boards collects those boards
as (ats, token) pairs; pipeline.run and export_static.export both read the same set, so the
database and the published site agree about which missing postings are closed.

Two kinds of completeness:

FULL_LIST adapters read the employer's whole board in one unfiltered list (Greenhouse, Lever,
Ashby, Recruitee, Workable, BambooHR, Rippling, ADP). A posting missing from a complete scan is
gone, however it was first discovered.

SEARCH_SCOPED adapters only ever ask the board for student-shaped keywords (Workday, Oracle,
SmartRecruiters, Taleo, Eightfold, iCIMS career sites). Their evidence says "every result of
every keyword was read", not "every job on the board was read". A posting the adapter itself
found before was a result of one of those searches, so its absence from all of them is a
closure. A posting known only from Google Jobs or a community list may simply not match the
keywords (a "Summer Analyst" never answers searchText="intern"), so that evidence cannot close it.

Adapters in neither set (iCIMS portal, SuccessFactors, Jobvite, JazzHR) scrape HTML with no
result total to check against, and never signal completion.
"""
from __future__ import annotations
from urllib.parse import urlsplit

FULL_LIST = frozenset({"greenhouse", "lever", "ashby", "recruitee", "workable", "bamboohr",
                       "rippling", "adp"})
SEARCH_SCOPED = frozenset({"workday", "oracle", "smartrecruiters", "taleo", "eightfold",
                           "icims_site"})
AUTHORITATIVE = FULL_LIST | SEARCH_SCOPED
# Adapters whose registry token is the board's host, which discover.ats_of cannot read back out
# of a posting URL (it has no "?icims=1" on it). The source link's own name says which ATS it is.
HOST_TOKEN = frozenset({"icims_site"})


def evidence_key(ats: str, token: str) -> tuple[str, str]:
    """A registry board as the (ats, token) a posting URL reads back to, lowercased.

    Registry tokens carry extras a posting URL does not: Taleo's portal id ("tenant|section|portal")
    and Eightfold's employer domain ("tenant|domain.com"). Left on, a complete scan of those boards
    could never match any of their postings, so the evidence would be silently unusable.
    """
    token = token.lower()
    if ats == "taleo":
        token = "|".join(token.split("|")[:2])
    elif ats == "eightfold":
        token = token.split("|", 1)[0]
    return ats, token


def canonical(completed) -> set[tuple[str, str]]:
    return {evidence_key(ats, token) for ats, token in (completed or ())}


def url_board(url: str | None, source: str | None = None) -> tuple[str, str] | None:
    """The (ats, token) board a posting URL belongs to, or None when it cannot be recovered."""
    from .discover import ats_of
    ats, token = ats_of(url)
    if token:
        return evidence_key(ats, token)
    if source in HOST_TOKEN and url:
        try:
            host = (urlsplit(url).hostname or "").lower()
        except ValueError:
            return None
        return (source, host) if host else None
    return None


def export_board(listing: dict, completed: set) -> tuple[str, str] | None:
    """The completed board an exported listing belongs to, or None.

    An exported row keeps its apply URL but not its source links, so a host-token board is tried
    under each host-token ATS: the host itself is that board's registry token.
    """
    url = listing.get("apply_url")
    board = url_board(url)
    if board:
        return board if board in completed else None
    for ats in HOST_TOKEN:
        board = url_board(url, ats)
        if board and board in completed:
            return board
    return None
