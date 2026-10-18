"""Free, bounded official-source discovery, separate from paid Google Jobs ingestion.

The inventory is a worklist, not a claim of listing coverage. Only boards linked by
an official source and returning parsed opportunities through an existing adapter
can be admitted. Registry writes are opt-in in scripts/discover_sources.py.
"""
from __future__ import annotations

import html
import re
import httpx
from datetime import date
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit, urlunsplit

from .discover import ats_of, add_board
from .geo import PROVINCES, STATE_NAMES
from .sources.common import RobotsDisallowed, robots_rules

SECTORS = {
    "government": '(government OR municipal)',
    "education_research": '(university OR laboratory)',
    "health": '(hospital OR healthcare)',
    "nonprofit": '(nonprofit OR museum OR conservation)',
    "industry": '(employer OR company OR manufacturing)',
}

# Official program/career pages researched 2026-10-16. No ATS tokens are guessed.
# Program presence is verified; machine extraction and present vacancies are not.
_STARTERS = [
    ("CA", "MB", "government", "Manitoba STEP", "https://www.gov.mb.ca/csc/step/programpolicies.html",
     "Student matching pool; individual placements may not have public listings."),
    ("CA", "MB", "industry", "Manitoba Hydro", "https://www.hydro.mb.ca/careers/streams/students/",
     "Summer student program; co-op postings may be available only through schools."),
    ("CA", "SK", "government", "Government of Saskatchewan", "https://taskroom.saskatchewan.ca/manager-resources/taleo-guidance/student-requisition-guide",
     "Official recruitment guide confirms Taleo student pools; find public career link before admission."),
    ("CA", "NS", "government", "Province of Nova Scotia", "https://jobs.novascotia.ca/home",
     "Official job site links student opportunities; extraction unverified."),
    ("CA", "NB", "education_research", "University of New Brunswick", "https://www.unb.ca/hr/careers/",
     "Official employer careers hub includes graduate student opportunities."),
    ("CA", "NL", "education_research", "Memorial University", "https://www.mun.ca/main/careers/",
     "Official hub includes student employment; some student systems require login."),
    ("CA", "NT", "government", "Government of Northwest Territories", "https://www.gov.nt.ca/careers/en/explore-gnwt",
     "Summer student and graduate internship programs; verify each role's education eligibility."),
    ("CA", "NU", "government", "Government of Nunavut", "https://www.gov.nu.ca/en/careers/tuglirijavut-student-employment",
     "Student employment program; program page is not itself an individual vacancy."),
    ("CA", "YT", "government", "Government of Yukon", "https://yukon.ca/en/employment/find-government-job",
     "Official careers hub links STEP opportunities."),
    ("CA", "YT", "education_research", "Yukon University", "https://www.yukonu.ca/current-students/get-involved/student-employment",
     "Official student employment board; distinguish third-party employers from university positions."),
    ("US", "ME", "government", "State of Maine", "https://www.maine.gov/bhr/Internships",
     "Official hub links municipal/state and agency internships, including non-ATS programs."),
    ("US", "SD", "government", "State of South Dakota", "https://www.sd.gov/bhra?id=kb_article_view&sysparm_article=KB0044640",
     "Official internship program covering multiple disciplines."),
    ("US", "SD", "health", "Sanford Health", "https://www.sanfordhealth.org/about/residency-and-student-programs",
     "Official student program hub; distinguish internships from residency/volunteer programs."),
    ("US", "TN", "industry", "Tennessee Valley Authority", "https://www.tva.com/careers/internship-opportunities",
     "Official multi-city paid internship program; careers link needs adapter verification."),
    ("US", "TN", "education_research", "Oak Ridge National Laboratory", "https://www.ornl.gov/internships/",
     "Official undergraduate/community-college research and professional internship hub."),
    ("US", "ME", "nonprofit", "Maine Arts internships", "https://mainearts.maine.gov/Pages/Services/Internship-Home",
     "Official arts opportunity directory; directory operator must not become every employer's name."),
]


def starter_targets() -> list[dict]:
    return [dict(country=c, jurisdiction=j, sector=s, name=n, official_url=u,
                 evidence_url=u, researched_on="2026-10-16", program_evidence="official_page",
                 access="unverified", extraction="unverified", notes=notes)
            for c, j, s, n, u, notes in _STARTERS]


def discovery_plan(jurisdictions: set[str] | None = None) -> list[dict]:
    """Search worklist for all 50 states, DC, PR and 13 Canadian provinces/territories.

    These are ordinary research queries, never automatic paid search requests.
    """
    places = [("US", code, name.title()) for name, code in STATE_NAMES.items()]
    places += [("CA", code, name) for code, name in PROVINCES.items()]
    rows = []
    for country, code, name in places:
        if jurisdictions and code not in jurisdictions:
            continue
        for sector, terms in SECTORS.items():
            queries = [f'"{name}" {terms} ("internship" OR "summer student" OR "co-op")',
                       f'"{name}" {terms} careers ("student assistant" OR "student intern" OR "placement")']
            if code == "QC":
                queries.append(f'"Québec" {terms} (stage OR stagiaire OR "emploi étudiant") carrière')
            rows.append(dict(country=country, jurisdiction=code, name=name, sector=sector,
                             status="needs_research", queries=queries))
    return rows


def validate_targets(targets: list[dict]) -> list[dict]:
    if not isinstance(targets, list):
        raise ValueError("targets must be a JSON array")
    codes = {"US": set(STATE_NAMES.values()), "CA": set(PROVINCES)}
    for target in targets:
        if not isinstance(target, dict):
            raise ValueError("each target must be an object")
        if target.get("jurisdiction") not in codes.get(target.get("country"), set()):
            raise ValueError("target requires a valid country/jurisdiction pair")
        if target.get("sector") not in SECTORS or not target.get("name"):
            raise ValueError("target requires a sector and employer/program name")
        if not public_url(target.get("official_url", "")):
            raise ValueError("target requires an HTTPS official_url without credentials")
    return targets


def public_url(url: str) -> bool:
    try:
        p = urlsplit(url)
        # Inputs are explicit official-source URLs, never arbitrary discovered request paths.
        return (p.scheme == "https" and bool(p.hostname) and "." in p.hostname
                and not p.username and not p.password and p.port in (None, 443))
    except (ValueError, TypeError, AttributeError):
        return False


class _Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []
        self.anchors = []
        self.scripts = []

    def handle_starttag(self, tag, attrs):
        attr = dict(attrs)
        key = "href" if tag == "a" else "src" if tag in ("iframe", "script") else None
        if key and attr.get(key):
            self.urls.append(attr[key])
            if tag == "a":
                self.anchors.append(attr[key])
            if tag == "script":
                self.scripts.append(attr[key])


_ATS_DOMAINS = {
    "greenhouse": ("greenhouse.io",), "lever": ("lever.co",), "ashby": ("ashbyhq.com",),
    "workday": ("myworkdayjobs.com", "myworkdaysite.com"),
    "smartrecruiters": ("smartrecruiters.com",), "workable": ("workable.com",),
    "recruitee": ("recruitee.com",), "bamboohr": ("bamboohr.com",),
    "rippling": ("rippling.com",), "oracle": ("oraclecloud.com",),
    "taleo": ("taleo.net",), "adp": ("adp.com",), "jobvite": ("jobvite.com",),
    "eightfold": ("eightfold.ai",), "icims": ("icims.com",), "jazzhr": ("applytojob.com",),
}


def page_links(body: str, page_url: str, *, anchors_only: bool = False) -> list[str]:
    parser = _Links()
    parser.feed(body)
    urls = [urljoin(page_url, html.unescape(u))
            for u in (parser.anchors if anchors_only else parser.urls)]
    return list(dict.fromkeys(urlunsplit(urlsplit(u)._replace(fragment=""))
                              for u in urls if public_url(u)))


def board_candidates(body: str, page_url: str) -> list[dict]:
    """Only actual ATS-host links count; a query parameter containing an ATS URL does not."""
    out, seen = [], set()
    for url in [page_url] + page_links(body, page_url):
        ats, token = ats_of(url)
        host = (urlsplit(url).hostname or "").lower()
        domains = _ATS_DOMAINS.get(ats, ())
        branded_icims = ats == "icims_site" and host == token
        if not token or not (branded_icims or any(host == d or host.endswith("." + d) for d in domains)):
            continue
        key = (ats, token.lower())
        if key not in seen:
            seen.add(key)
            out.append(dict(ats=ats, token=token, board_url=url, discovered_from=page_url,
                            extraction="unverified", access="unverified"))
    # SuccessFactors Career Site Builder uses branded domains, so no ATS hostname
    # appears in the job URL. Its actual first-party platform script is evidence;
    # merely mentioning "SuccessFactors" in a document is insufficient.
    parser = _Links()
    parser.feed(body)
    host = (urlsplit(page_url).hostname or "").lower()
    if any(urlsplit(urljoin(page_url, src)).hostname == host
           and "/platform/js/j2w/" in urlsplit(urljoin(page_url, src)).path
           for src in parser.scripts):
        out.append(dict(ats="successfactors", token=host, board_url=page_url,
                        discovered_from=page_url, extraction="unverified", access="unverified"))
    return out


def _blocked(rules: list[tuple[str, str]], path: str) -> bool:
    matches = []
    for field, value in rules:
        if not value:
            continue
        pattern = re.escape(value).replace(r"\*", ".*")
        if value.endswith("$"):
            pattern = pattern[:-2] + "$"
        if re.match(pattern, path):
            matches.append((len(value.replace("*", "").rstrip("$")), field == "allow"))
    return bool(matches) and not max(matches)[1]


class RequestBudgetExceeded(RuntimeError):
    pass


class DiscoveryClient:
    """Bound all scan/adapter traffic and check robots before each redirected URL."""
    def __init__(self, client, max_requests: int = 200):
        self.client = client
        self.remaining = max_requests
        self.requests = 0
        self.rules = {}

    def _raw(self, method, url, **kwargs):
        if self.remaining <= 0:
            raise RequestBudgetExceeded("discovery request limit reached")
        self.remaining -= 1
        self.requests += 1
        kwargs["follow_redirects"] = False
        return self.client.request(method, url, **kwargs)

    def _allowed(self, url):
        p = urlsplit(url)
        base = f"{p.scheme}://{p.netloc}"
        if base not in self.rules:
            r = self._raw("GET", base + "/robots.txt")
            if r.status_code == 404:
                self.rules[base] = []
            elif r.status_code == 200 and "<html" not in r.text[:400].lower():
                self.rules[base] = robots_rules(r.text)
            else:
                raise RobotsDisallowed(f"robots unavailable ({r.status_code}): {base}")
        path = p.path + ("?" + p.query if p.query else "")
        if _blocked(self.rules[base], path):
            raise RobotsDisallowed(url)

    def request(self, method, url, **kwargs):
        if kwargs.get("params"):
            url = str(httpx.URL(url).copy_merge_params(kwargs.pop("params")))
        for _ in range(6):
            if not public_url(url):
                raise ValueError("discovery only requests public HTTPS URLs")
            self._allowed(url)
            response = self._raw(method, url, **kwargs)
            if response.status_code not in (301, 302, 303, 307, 308) or not response.headers.get("location"):
                return response
            url = urljoin(str(response.url), response.headers["location"])
            kwargs.pop("params", None)
            if response.status_code == 303 or (response.status_code in (301, 302) and method != "GET"):
                method = "GET"
                kwargs.pop("json", None)
                kwargs.pop("data", None)
        raise ValueError("too many source redirects")

    def get(self, url, **kwargs):
        return self.request("GET", url, **kwargs)

    def post(self, url, **kwargs):
        return self.request("POST", url, **kwargs)


_CAREER_PATH = re.compile(r"career|intern|student|employment|opportunit|vacanc|/jobs|stagiaire|/stage", re.I)
_CAREER_HOST = re.compile(r"career|jobs|internship|workday|recruit", re.I)


def _career_links(body: str, page_url: str) -> list[str]:
    links = []
    for url in page_links(body, page_url, anchors_only=True):
        p = urlsplit(url)
        if (p.path.lower().endswith((".pdf", ".doc", ".docx"))
                or re.search(r"login|subscribe|signup|talentcommunity", url, re.I)):
            continue
        if _CAREER_PATH.search(p.path) or _CAREER_HOST.search(p.hostname or ""):
            links.append(url)
    # External career portals often contain the usable ATS link; a source hub's
    # first navigation link often just points back to its general careers page.
    return sorted(links, key=lambda u: urlsplit(u).hostname == urlsplit(page_url).hostname)


def scan_target(c: DiscoveryClient, target: dict, max_pages: int = 3) -> dict:
    """Read the source and at most max_pages-1 linked career pages, one level deep.

    External career portals count only when linked by the official source. This
    records delegation/provenance; it does not establish employer identity.
    """
    result = {**target, "checked_on": date.today().isoformat(), "access": "unverified",
              "extraction": "unverified", "pages": [], "boards": []}
    queue, seen, boards = [target["official_url"]], set(), set()
    while queue and len(seen) < max_pages:
        url = queue.pop(0)
        if url in seen:
            continue
        seen.add(url)
        page = {"url": url}
        try:
            response = c.get(url)
            response.raise_for_status()
            page.update(status="accessible", final_url=str(response.url))
            if len(response.content) > 2_000_000:
                page["status"] = "page_too_large"
                continue
            content_type = response.headers.get("content-type", "")
            if "html" not in content_type.lower():
                page["status"] = "non_html"
                continue
            result["access"] = "public"
            final_url = str(response.url)
            for board in board_candidates(response.text, final_url):
                key = board["ats"], board["token"].lower()
                if key not in boards:
                    boards.add(key)
                    result["boards"].append(board)
            if len(seen) == 1:
                queue += _career_links(response.text, final_url)
        except RobotsDisallowed:
            page["status"] = "robots_blocked_or_unavailable"
        except Exception as exc:
            page.update(status="error", error=type(exc).__name__)
        finally:
            result["pages"].append(page)
    if result["boards"]:
        result["extraction"] = "ats_links_found"
    elif result["access"] == "public":
        result["extraction"] = "needs_adapter_or_manual_review"
    return result


def verify_boards(c: DiscoveryClient, result: dict, fetchers: dict, max_boards: int = 20) -> None:
    """Verify adapter output now; a reachable empty board remains pending, never dead."""
    for board in result["boards"][:max_boards]:
        ats, token = board["ats"], board["token"]
        if ats not in fetchers:
            board["extraction"] = "unsupported_adapter"
            continue
        try:
            items = fetchers[ats](c, {"name": result["name"], "ats_token": token,
                                     "sector": result["sector"], "is_quant_target": False})
            usable = [i for i in items if isinstance(i, dict) and i.get("title")
                      and public_url(i.get("url") or i.get("apply_url") or "")]
            board.update(access="public", extraction="verified" if usable else "no_opportunities_parsed",
                         parsed_opportunities=len(usable), verified_on=date.today().isoformat())
        except RobotsDisallowed:
            board.update(access="robots_blocked_or_unavailable", extraction="unverified")
        except Exception as exc:
            board.update(extraction="verification_failed", error=type(exc).__name__)


def admit_verified(registry: dict, results: list[dict]) -> list[dict]:
    """Mutate only the supplied registry; the CLI alone opts in to saving it.

    Directory pages can link unrelated employers. Require an explicit employer
    identity review and a single board before assigning the source employer name.
    """
    added = []
    for result in results:
        if len(result.get("boards", [])) != 1 or result.get("employer_identity_reviewed") is not True:
            continue
        for board in result.get("boards", []):
            if (board.get("extraction") != "verified" or board.get("access") != "public"
                    or board.get("verified_on") != date.today().isoformat()
                    or not board.get("parsed_opportunities")):
                continue
            if add_board(registry, board["ats"], board["token"], result["name"], sector=result["sector"]):
                added.append(dict(ats=board["ats"], token=board["token"], name=result["name"]))
    return added
