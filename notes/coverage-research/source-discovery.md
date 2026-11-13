# Official source discovery — October 16, 2026

Implemented a separate, free discovery workflow in `backend/scripts/discover_sources.py`.
It generates a research worklist for all 50 states, DC, Puerto Rico, and all 13 Canadian
provinces/territories across government, education/research, health, nonprofits, and
industry: 325 jurisdiction/sector combinations. A worklist entry is **not evidence of
listing coverage**. Queries are provided for ordinary research; no search API is called.

The built-in catalog contains 16 researched official career/program pages, especially
Manitoba, Saskatchewan, Atlantic Canada, and the territories. Sources include
[Manitoba STEP](https://www.gov.mb.ca/csc/step/programpolicies.html),
[Manitoba Hydro student programs](https://www.hydro.mb.ca/careers/streams/students/),
[Nova Scotia's careers site](https://jobs.novascotia.ca/home),
[UNB careers](https://www.unb.ca/hr/careers/),
[Memorial's careers hub](https://www.mun.ca/main/careers/),
[NWT programs](https://www.gov.nt.ca/careers/en/explore-gnwt),
[Nunavut student employment](https://www.gov.nu.ca/en/careers/tuglirijavut-student-employment),
[Yukon government careers](https://yukon.ca/en/employment/find-government-job), and
[Yukon University student employment](https://www.yukonu.ca/current-students/get-involved/student-employment).
US examples include [Maine](https://www.maine.gov/bhr/Internships),
[South Dakota](https://www.sd.gov/bhra?id=kb_article_view&sysparm_article=KB0044640),
[Sanford Health](https://www.sanfordhealth.org/about/residency-and-student-programs),
[TVA](https://www.tva.com/careers/internship-opportunities), and
[Oak Ridge](https://www.ornl.gov/internships/).

These pages establish source/program existence. No starter is claimed to have a
verified adapter or currently open vacancies. A student matching pool, program
description, directory, and individual vacancy are different things. Some placements
are advertised through school systems requiring login; this workflow does not access them.

## Run locally

Run these commands from `backend/`:

```powershell
# Offline plan and starter catalog. No network or registry writes.
python scripts/discover_sources.py --output "$env:TEMP/discovery-plan.json"

# Bounded free HTTP scan. Reads official pages and their linked career portals.
python scripts/discover_sources.py --scan --jurisdictions MB,SK,NS,NB,NL,NT,NU,YT --max-targets 10 --max-pages 3 --max-requests 80 --output "$env:TEMP/discovery-scan.json"

# Exercise existing ATS parsers too. Report only; no registry changes.
python scripts/discover_sources.py --scan --verify --max-targets 3 --max-requests 100 --output "$env:TEMP/discovery-verified.json"
```

`--offset N` resumes the next batch. `--targets path.json` accepts a JSON array
with `country` (`US` or `CA`), `jurisdiction`, `sector`, `name`, and `official_url`.
Use the offline report's `targets` array as a starting template. Every target should
represent one actual employer's official career source, with evidence and notes.

The scanner follows at most one level of explicitly linked career pages, including
external career portals. ATS tokens come from actual links, never employer-name
guesses. Branded SuccessFactors sites are recognized from their first-party
`/platform/js/j2w/` script, and require adapter verification afterward. HTTP requests
including robots checks, redirect destinations, and adapter traffic share one ceiling.
Robots restrictions/unavailable robots, network failures, empty output, unsupported
sources, and verified parsed opportunities receive distinct report states.

Registry admission requires **all** of the following: `--scan --verify --apply`,
fresh successful verification in that run, parsed opportunities, exactly one board
for the target, and an explicit `"employer_identity_reviewed": true` target field.
Review that the board belongs to the named employer before setting that field.
Directories must not assign their operator's name to unrelated employers. Existing
registry cooldown/deduplication rules still apply. Nothing is applied automatically.
Verification demonstrates adapter parsing, not successful normalization or additional
unique live listings. Newly admitted boards enter ordinary ingestion on its next run.

## Validation and measured limits

- 21 offline tests passed: complete jurisdiction/sector worklist, actual ATS links,
  branded SuccessFactors evidence, externally linked portals, bounded navigation,
  robots/redirect/request ceilings, empty/error classification, identity/date gates,
  duplicate-safe admission, and offline/read-only CLI defaults.
- An initial live scan made 36 free HTTP requests across all 16 targets, reading at
  most two same-host pages each. Eleven targets had publicly readable HTML;
  four had blocked/unavailable robots and one had a fetch error. It found no ATS
  candidates under that initial narrower traversal. This is source access evidence,
  not a claim that these sites lack internships.
- That result prompted external career-portal following and branded SuccessFactors
  detection. The subsequent scan/verification completed in 100 free HTTP requests:
  Nova Scotia's `jobs.novascotia.ca` SuccessFactors board returned two parsed
  opportunities, and Sanford's `sanford|wd5|SanfordHealth` Workday board returned
  twelve. These are adapter output counts, **not** measured new unique accepted
  listings. Both tokens came from actual official pages, without guessing.
- Employer identity review and registry admission remain unfinished. Fourteen other
  starter targets still need source/adapter review. No registry changes, paid calls,
  ingestion, or deployments occurred.

## Resume

Updated October 18, 2026. Details and numbers: [live verification](live-verification-2026-10-18.md).

1. Done: Nova Scotia (`jobs.novascotia.ca`, 1 parsed student role) and Sanford Health
   (`sanford|wd5|SanfordHealth`, 14) passed identity and content review and were admitted
   with `--scan --verify --apply` and a curated targets file. Both enter ordinary ingestion
   on its next run.
2. Done: the other 14 starters were scanned. None had a supported board with student roles.
   Four are blocked by robots (Nunavut, Yukon government, Maine, TVA answer 403 for
   `/robots.txt`); Saskatchewan's `careers.saskatchewan.ca` redirects its robots file;
   Memorial's student system is login-only; the rest have no supported board.
3. Remaining: re-verify Oak Ridge (`jobs.ornl.gov`, a working classic SuccessFactors site with
   no student roles parsed today) during recruiting season and admit it if student roles
   appear. It needs a curated target at `ornl.gov/careers-at-ornl/`, because the starter's
   internship hub links the board only two levels deep.
4. Remaining: custom-adapter candidates with readable public vacancies and no supported
   board: GNWT eRecruit (`gov.nt.ca/careers/en/search/job`), UNB and Yukon University
   first-party lists, Manitoba Hydro (SAP E-Recruiting). Saskatchewan looks like Oracle
   Recruiting Cloud on a branded host, which the Oracle adapter does not recognise.
5. Remaining: decide whether the discovery client should follow a robots redirect that ends
   in a 404 (RFC 9309 allows this). Keep treating 403 as blocked.
6. Remaining: fill uncovered jurisdiction/sector worklist cells with official employer
   evidence. The 16 starters are a seed, not a complete national employer catalog.
7. Consider scheduled discovery only after validating yield and choosing an explicit
   maintenance owner. No new scheduled job was installed in this workstream.
