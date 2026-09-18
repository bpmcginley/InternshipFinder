"""Collapse the same role seen across sources by dedupe_key (in a single batch)."""
from __future__ import annotations
import re
from collections import defaultdict
from urllib.parse import urlsplit

# A Greenhouse job carries its number in the query and the rest of the URL varies by how it was
# found: the board says "coinbase.com/careers/positions/8168315?gh_jid=8168315" and the embed link
# Google Jobs hands back says "boards.greenhouse.io/embed/job_app?token=8168315".
_GH_ID = re.compile(r"(?:gh_jid|token)=(\d+)")
# Workday serves the same job with or without a locale segment, and Ashby appends /application to
# the apply link. Neither changes which job it is.
_LOCALE = re.compile(r"/[a-z]{2}-[A-Z]{2}(?=/)")
_APPLY_TAIL = re.compile(r"/appl(?:y|ication)/?$")


def same_job(a: str | None, b: str | None) -> bool:
    """Do these two apply URLs open the same posting?

    Deliberately strict: it asks whether the URLs name one job, not whether two jobs look alike.
    Two Ryan Companies "Safety Engineer Intern" postings, one in Phoenix and one in Dallas, are
    two jobs a student can apply to separately and must stay two listings.
    """
    ca, cb = _canon_job(a), _canon_job(b)
    return bool(ca) and ca == cb


def _canon_job(url: str | None) -> str | None:
    if not url:
        return None
    gh = _GH_ID.search(url)
    if gh:
        return f"gh:{gh.group(1)}"
    s = urlsplit(url)
    if not s.netloc:
        return None
    # The query is where a source writes how it arrived - ?icims=1, ?ats=successfactors, ?embed=true
    # - and never where the job id lives on these boards, so it is dropped.
    return s.netloc.lower() + _APPLY_TAIL.sub("", _LOCALE.sub("", s.path)).rstrip("/")


def merge_batch(items: list[dict]) -> dict[str, dict]:
    """Return {dedupe_key: merged_item}. Keeps all source links; best fields win."""
    out: dict[str, dict] = {}
    for it in items:
        k = it["dedupe_key"]
        if k not in out:
            it = dict(it)
            it["_sources"] = [(it["source"], it.get("source_url"))]
            out[k] = it
        else:
            cur = out[k]
            cur["_sources"].append((it["source"], it.get("source_url")))
            # prefer a named place (baseline area first) over a remote-only geo
            rank = lambda x: (x["within_radius"], x["geo"].get("on_site", False))
            if rank(it) > rank(cur):
                for f in ("geo", "location_raw", "lat", "lng", "is_remote",
                          "within_radius", "distance_miles"):
                    cur[f] = it[f]
            if not cur.get("apply_url") and it.get("apply_url"):
                cur["apply_url"] = it["apply_url"]
            if not cur.get("sector") and it.get("sector"):
                cur["sector"] = it["sector"]
            if not cur.get("description") and it.get("description"):
                cur["description"] = it["description"]
            # region locations can differ per source: keep the union
            g = cur["geo"] = dict(cur["geo"])
            g["region_locations"] = list(dict.fromkeys(g["region_locations"] + it["geo"]["region_locations"]))
    return _fold_untermed(out)


def _fold_untermed(out: dict[str, dict]) -> dict[str, dict]:
    """Fold a listing whose term we could not read into the same posting where we could.

    The dedupe key ends in the season and year, which is right - a company's "Data Intern" for
    Summer 2027 and for Fall 2026 are two different things to apply to. But when one source reads
    the term off the title and another does not, the same job lands under two keys and the student
    sees it twice, once with a good location and once with whatever the second source knew. 195 of
    the 14,525 listings in the last export were that.

    So a key with no term at all is folded into one that has a term, and only when the apply URLs
    say it is the same posting. Nothing is guessed from the title: if two termed keys both match,
    or the URL does not, the listing is left exactly where it was.
    """
    by_prefix: dict[str, list[tuple[str, str, str]]] = defaultdict(list)
    for k in out:
        prefix, season, year = k.rsplit("|", 2)
        by_prefix[prefix].append((k, season, year))
    for rows in by_prefix.values():
        if len(rows) < 2:
            continue
        termed = [k for k, season, year in rows if season or year]
        for key in [k for k, season, year in rows if not season and not year]:
            match = [t for t in termed if same_job(out[key].get("apply_url"), out[t].get("apply_url"))]
            if len(match) != 1:
                continue
            cur, it = out[match[0]], out.pop(key)
            cur["_sources"].extend(it["_sources"])
            rank = lambda x: (x["within_radius"], x["geo"].get("on_site", False))
            if rank(it) > rank(cur):
                for f in ("geo", "location_raw", "lat", "lng", "is_remote",
                          "within_radius", "distance_miles"):
                    cur[f] = it[f]
            for f in ("apply_url", "sector", "description"):
                if not cur.get(f) and it.get(f):
                    cur[f] = it[f]
            g = cur["geo"] = dict(cur["geo"])
            g["region_locations"] = list(dict.fromkeys(g["region_locations"] + it["geo"]["region_locations"]))
    return out
