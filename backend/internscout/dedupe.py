"""Collapse the same role seen across sources by dedupe_key (in a single batch)."""
from __future__ import annotations
import re
from collections import defaultdict
from urllib.parse import parse_qsl, urlsplit

# A Greenhouse job carries its number in the query and the rest of the URL varies by how it was
# found: the board says "coinbase.com/careers/positions/8168315?gh_jid=8168315" and the embed link
# Google Jobs hands back says "boards.greenhouse.io/embed/job_app?token=8168315".
_GH_ID = re.compile(r"(?:gh_jid|token)=(\d+)")
# Workday serves the same job with or without a locale segment, and Ashby appends /application to
# the apply link. Neither changes which job it is.
_LOCALE = re.compile(r"/[a-z]{2}-[A-Z]{2}(?=/)")
_APPLY_TAIL = re.compile(r"/appl(?:y|ication)/?$")
# Query parameters that say which job a link opens, on the boards that put the id there.
_ID_PARAMS = frozenset({"job", "pid", "jobid", "job_id", "reqid", "req_id", "requisitionid", "jk"})


def requisition_identity(url: str | None, *, icims_hosts=frozenset()) -> str | None:
    """Only recognized individual ATS destinations, never a shared careers/board URL."""
    # 2026-10-23: was generic canonical URL equality, which cannot prove one requisition.
    # Revert: remove this helper and its batch/carryover callers together.
    if not url:
        return None
    s = urlsplit(url)
    host, path = s.netloc.lower(), _LOCALE.sub("", s.path).rstrip("/")
    if not host:
        return None
    query = dict(parse_qsl(s.query))
    gh = query.get("gh_jid")
    gh_board = _greenhouse_board(url)
    if gh_board and gh and gh != gh_board[1]:
        return None  # conflicting URL identities are not proof of one posting
    if not gh and (host == "greenhouse.io" or host.endswith(".greenhouse.io")) and "/embed/job_app" in path:
        gh = query.get("token")
    if gh and gh.isdigit():
        return "gh:" + gh
    # 2026-10-24: branded iCIMS hosts are established by adapter provenance/explicit marker,
    # never guessed from an arbitrary numeric careers URL. Revert: remove this context branch.
    if host in icims_hosts or ("icims", "1") in parse_qsl(s.query):
        match = re.match(r"^/jobs/(\d+)(?:/|$)", path)
        if match:
            return host + ":" + match.group(1)
    uuid = r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
    for domain, job in (("lever.co", uuid), ("ashbyhq.com", uuid), ("smartrecruiters.com", r"\d{8,}[^/]*")):
        if host == domain or host.endswith("." + domain):
            match = re.fullmatch(r"/([^/]+)/(" + job + r")(?:/application|/apply)?", path, re.I)
            if match:
                job_id = re.match(r"\d+", match.group(2)).group(0) if domain == "smartrecruiters.com" else match.group(2).lower()
                return host + "/" + match.group(1) + ":" + job_id
            return None
    patterns = [
        ("oraclecloud.com", r"/job/(\d+)(?:/|$)"),
        ("icims.com", r"/jobs/(\d+)(?:/|$)"),
        ("greenhouse.io", r"/jobs/(\d+)(?:/|$)"),
    ]
    for domain, pattern in patterns:
        if host == domain or host.endswith("." + domain):
            match = re.search(pattern, path, re.I)
            if match:
                if domain == "greenhouse.io":
                    # 2026-10-23: Greenhouse job numbers are shared across its host aliases,
                    # custom gh_jid links and embeds. Company scope belongs at the row boundary.
                    return "gh:" + match.group(1)
                return host + ":" + match.group(1).lower()
    if host.endswith((".myworkdayjobs.com", ".myworkdaysite.com")) and "/job/" in path:
        match = re.search(r"_([A-Za-z]{0,8}[-_]?\d[\w-]*)(?:/apply)?$", path)
        if match:
            return host + path.split("/job/", 1)[0] + ":" + match.group(1).lower()
    return None


def _greenhouse_board(url):
    parsed = urlsplit(url or "")
    host = parsed.netloc.lower()
    if host == "greenhouse.io" or host.endswith(".greenhouse.io"):
        match = re.match(r"^/([^/]+)/jobs/(\d+)(?:/|$)", parsed.path)
        if match:
            return match.group(1), match.group(2)
    return None


def recognized_greenhouse_tenants(items):
    """Map an exact company/id to an observed board only when the evidence is unambiguous."""
    tenants = defaultdict(set)
    for item in items:
        board = _greenhouse_board(item.get("apply_url"))
        identity = requisition_identity(item.get("apply_url"))
        if board and identity == "gh:" + board[1]:
            tenants[(identity, (item.get("company_name") or "").casefold())].add(board[0])
    return tenants


def recognized_icims_hosts(items) -> frozenset[str]:
    """Exact custom hosts proven by our iCIMS adapter or its explicit apply URL marker."""
    hosts = set()
    for item in items:
        url = item.get("apply_url") or ""
        parsed = urlsplit(url)
        if parsed.scheme not in ("http", "https") or not re.match(r"^/jobs/\d+(?:/|$)", parsed.path):
            continue
        sources = {item.get("source"), item.get("ats"), *(item.get("scan_sources") or [])}
        sources.update(source for source, _ in item.get("_sources", []))
        if "icims_site" in sources or ("icims", "1") in parse_qsl(parsed.query):
            hosts.add(parsed.netloc.lower())
    return frozenset(hosts)


def posting_key(item: dict, *, icims_hosts=frozenset(), gh_tenants=None):
    """Use an ATS's scoped destination rather than the employer label's spelling."""
    identity = requisition_identity(item.get("apply_url"), icims_hosts=icims_hosts)
    if not identity:
        return None
    # 2026-10-24: was literal company scope for every identity, leaving verified aliases doubled.
    # Most identities contain exact tenant host/site. GH uses a proven board path when present;
    # custom/embed ids use an exact-company mapping only if one observed board establishes it.
    # Ambiguous GH ids retain company protection and cannot bridge distinct board tenants.
    # Revert: restore the company label in every key; keep numeric-ID/tenant safeguards intact.
    if identity.startswith("gh:"):
        company = (item.get("company_name") or "").casefold()
        direct = _greenhouse_board(item.get("apply_url"))
        choices = (gh_tenants or {}).get((identity, company), set())
        board = direct[0] if direct else next(iter(choices)) if len(choices) == 1 else None
        return (identity, "board:" + board if board else "company:" + company)
    return (identity, "")


def _legacy_suffix(identity):
    """Separate matching scope from the existing public ID disambiguation spelling."""
    value = identity[0]
    host = value.split("/", 1)[0].split(":", 1)[0]
    if any(host == domain or host.endswith("." + domain)
           for domain in ("lever.co", "ashbyhq.com", "smartrecruiters.com")):
        return host + ":" + value.rsplit(":", 1)[1]
    return value


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
    # (2026-09 audit: "never" was wrong for two boards. Taleo writes every job as
    # .../jobdetail.ftl?job=123456 and Microsoft as .../careers?pid=123, so with the whole query gone
    # all 119 Textron postings came out as one URL, and two of them with the same title - one with a
    # term, one without - would have been folded into a single listing. The params that name the job
    # are kept; everything else is still dropped, as before.)
    ids = sorted((k.lower(), v) for k, v in parse_qsl(s.query) if k.lower() in _ID_PARAMS and v)
    tail = "?" + "&".join("%s=%s" % kv for kv in ids) if ids else ""
    return s.netloc.lower() + _APPLY_TAIL.sub("", _LOCALE.sub("", s.path)).rstrip("/") + tail


def merge_batch(items: list[dict]) -> dict[str, dict]:
    """Return {dedupe_key: merged_item}. Keeps all source links; best fields win."""
    from .sources import BOARD_FETCHERS
    # 2026-10-23: was input order. Employer facts must win even when keys already coincide.
    # Revert: iterate items in their original order again.
    items = sorted(items, key=lambda it: (it.get("source") not in BOARD_FETCHERS,
        (it.get("company_name") or "").casefold(), it.get("dedupe_key") or "", it.get("source") or ""))
    icims_hosts = recognized_icims_hosts(items)
    gh_tenants = recognized_greenhouse_tenants(items)
    out: dict[str, dict] = {}
    identities = defaultdict(set)
    for it in items:
        identity = posting_key(it, icims_hosts=icims_hosts, gh_tenants=gh_tenants)
        if identity:
            identities[it["dedupe_key"]].add(identity)
    # 2026-10-24: matching gained tenant context, but unrelated saved listing IDs must stay stable.
    # was: raw identity suffix. Revert: restore suffix text only alongside the old matching rule.
    suffixes = {}
    for base, keys in identities.items():
        collisions = defaultdict(list)
        for identity in keys:
            collisions[_legacy_suffix(identity)].append(identity)
        suffixes[base] = {identity: (legacy if len(values) == 1 else
            identity[0] + (":" + identity[1] if identity[1] else ""))
            for legacy, values in collisions.items() for identity in values}
    for it in items:
        k = it["dedupe_key"]
        identity = posting_key(it, icims_hosts=icims_hosts, gh_tenants=gh_tenants)
        if identity and len(identities[k]) > 1:
            # 2026-10-23: equal titles/terms with different requisitions were collapsed first.
            # Revert: remove this disambiguation; URL reconciliation remains independent.
            prefix, season, year = k.rsplit("|", 2)
            k = f"{prefix} [req:{suffixes[k][identity]}]|{season}|{year}"
            it = {**it, "dedupe_key": k}
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
    # Reconcile source authority before a missing term can donate a board's provenance to a list.
    return _fold_untermed(_fold_same_url(out, icims_hosts=icims_hosts, gh_tenants=gh_tenants),
                         icims_hosts=icims_hosts, gh_tenants=gh_tenants)


def _fold_untermed(out: dict[str, dict], *, icims_hosts=frozenset(), gh_tenants=None) -> dict[str, dict]:
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
            identity = posting_key(out[key], icims_hosts=icims_hosts, gh_tenants=gh_tenants)
            match = [t for t in termed if identity and identity == posting_key(out[t], icims_hosts=icims_hosts, gh_tenants=gh_tenants)]
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


def _fold_same_url(out: dict[str, dict], *, icims_hosts=frozenset(), gh_tenants=None) -> dict[str, dict]:
    """Fold a curated list's copy of a posting into the employer's own row for it.

    The dedupe key is built from the title, and the GitHub lists write their own: Waymo's board says
    "2027 Summer Intern, BS/MS, Software Engineer" and the list says "Software Engineer Intern -
    BS/MS", both pointing at the one Workday URL. Two keys, so the student saw the job twice - 540
    apply URLs carried two or three open rows in the 2026-09-19 export, 4% of the board.

    2026-10-23: recognized individual ATS identities establish one application independently
    of title spelling, locale and guessed community term. Employer source rows win; generic
    shared boards remain separate. Only compatible missing term information is borrowed.
    """
    from .sources import BOARD_FETCHERS   # here, not at the top: sources imports half the package

    def from_board(it):
        return any(src in BOARD_FETCHERS for src, _ in it["_sources"])

    by_url: dict[tuple[str, str], list[str]] = defaultdict(list)
    for k, it in out.items():
        canon = posting_key(it, icims_hosts=icims_hosts, gh_tenants=gh_tenants)
        if canon:
            by_url[canon].append(k)
    for keys in by_url.values():
        boards = [k for k in keys if from_board(out[k])]
        if len(keys) < 2:
            continue
        # 2026-10-23: was exactly one board row with no conflicting term. A verified single
        # requisition cannot become two applications because a community title guesses a term.
        # Employer facts win, then source posting date and deterministic title for locale copies.
        # Revert: restore the one-board/no-term-conflict gate in this loop.
        winner = max(boards or keys, key=lambda k: (str(out[k].get("posted_at") or ""),
            len(out[k].get("description") or ""), out[k].get("title") or "",
            (out[k].get("company_name") or "").casefold(), k))
        cur = out[winner]
        for key in [k for k in keys if k != winner]:
            it = out[key]
            conflict = any(cur.get(f) and it.get(f) and cur[f] != it[f] for f in ("season", "year"))
            out.pop(key)
            cur["_sources"].extend(it["_sources"])
            for f in ("season", "year"):           # "Summer" from the board, "Summer 2027" from the list
                if not conflict and not cur.get(f) and it.get(f):
                    cur[f] = it[f]
            season, year = cur.get("season"), cur.get("year")   # the same wording normalize() gives a term
            cur["term"] = (f"{season} {year}" if year else str(season)).strip() if season else None
            for f in ("sector",):
                if not cur.get(f) and it.get(f):
                    cur[f] = it[f]
            g = cur["geo"] = dict(cur["geo"])
            g["region_locations"] = list(dict.fromkeys(g["region_locations"] + it["geo"]["region_locations"]))
    return out
