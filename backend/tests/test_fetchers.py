"""Fetcher parsers against small saved payload shapes (no network)."""
from internscout.sources.greenhouse import parse_greenhouse
from internscout.sources.lever import parse_lever
from internscout.sources.ashby import parse_ashby
from internscout.sources.workday import parse_workday_list, parse_workday_detail, host_of
from internscout.sources.smartrecruiters import parse_smartrecruiters, parse_smartrecruiters_detail
from internscout.sources.workable import parse_workable
from internscout.sources.recruitee import parse_recruitee
from internscout.sources.bamboohr import parse_bamboohr
from internscout.sources.rippling import parse_rippling, parse_rippling_detail
from internscout.sources.oracle import parse_oracle, parse_oracle_detail
from internscout.sources.taleo import parse_taleo, parse_taleo_detail
from internscout.sources.adp import parse_adp
from internscout.sources.jobvite import parse_jobvite, parse_jobvite_detail
from internscout.sources.icims import parse_icims, parse_icims_detail
from internscout.sources.successfactors import parse_successfactors, parse_successfactors_detail
from internscout.sources.eightfold import parse_eightfold, host_of as ef_host
from internscout.sources.jazzhr import parse_jazzhr
from internscout.sources.usajobs import parse_usajobs
from internscout.sources.nyc_jobs import parse_nyc_jobs
from internscout.sources.github_lists import _parse

CO = {"name": "Acme", "ats_token": "acme", "is_quant_target": False}


def test_greenhouse():
    items = parse_greenhouse({"jobs": [
        {"id": 1, "title": "Software Engineer Intern", "location": {"name": "Boston, MA"},
         "absolute_url": "https://boards.greenhouse.io/acme/jobs/1", "updated_at": "2026-09-01T00:00:00Z"},
        {"id": 2, "title": "Senior Engineer", "location": {"name": "Boston, MA"}, "absolute_url": "x"},
    ]}, CO)
    assert len(items) == 1 and items[0]["locations"] == ["Boston, MA"] and items[0]["source"] == "greenhouse"


def test_lever():
    items = parse_lever([{"text": "Data Science Intern", "hostedUrl": "https://jobs.lever.co/acme/1",
                          "applyUrl": "https://jobs.lever.co/acme/1/apply", "createdAt": 1767225600000,
                          "categories": {"location": "New York, NY", "allLocations": ["New York, NY", "Boston, MA"],
                                         "commitment": "Internship"},
                          "descriptionPlain": "Build models."}], CO)
    assert items[0]["locations"] == ["New York, NY", "Boston, MA"]
    assert items[0]["apply_url"].endswith("/apply") and items[0]["posted_at"] == 1767225600


def test_ashby():
    items = parse_ashby({"jobs": [
        {"title": "Quant Research Intern", "employmentType": "Intern", "location": "NYC",
         "secondaryLocations": [{"location": "Boston", "address": {"postalAddress": {
             "addressLocality": "Boston", "addressRegion": "Massachusetts"}}}],
         "isRemote": False, "isListed": True, "jobUrl": "https://jobs.ashbyhq.com/acme/1",
         "applyUrl": "https://jobs.ashbyhq.com/acme/1/application", "publishedAt": "2026-09-01T00:00:00Z",
         "descriptionPlain": "Research."},
        {"title": "Intern (hidden)", "isListed": False},
    ]}, CO)
    assert len(items) == 1 and "Boston, Massachusetts" in items[0]["locations"]


def test_workday():
    assert host_of("modernatx|wd1|M_tx") == ("https://modernatx.wd1.myworkdayjobs.com", "modernatx", "M_tx")
    posts = parse_workday_list({"total": 2, "jobPostings": [
        {"title": "Summer 2027 Engineering Intern", "externalPath": "/job/Cambridge/X_R1", "locationsText": "2 Locations"},
        {"title": "Internal Audit Manager", "externalPath": "/job/y", "locationsText": "Boston, MA"},
    ]})
    assert [p["title"] for p in posts] == ["Summer 2027 Engineering Intern"]
    locs, desc = parse_workday_detail({"jobPostingInfo": {
        "location": "Cambridge, MA", "additionalLocations": ["Norwood, MA"], "jobDescription": "<p>Hi &amp; bye</p>"}})
    assert locs == ["Cambridge, MA", "Norwood, MA"] and desc == "Hi & bye"


def test_smartrecruiters():
    items = parse_smartrecruiters({"totalFound": 2, "content": [
        {"id": "7", "name": "Marketing Intern", "releasedDate": "2026-09-01T00:00:00Z",
         "location": {"city": "Providence", "region": "RI", "country": "us", "remote": False}},
        {"id": "8", "name": "Marketing Intern", "location": {"city": "Paris", "country": "fr"}},
    ]}, CO, "Acme")
    assert len(items) == 1 and items[0]["url"] == "https://jobs.smartrecruiters.com/Acme/7"
    # The id has to survive the parse, or the detail call has nothing to ask for.
    assert items[0]["_sr_id"] == "7"


def test_smartrecruiters_detail():
    # The advert's own sections, in posting order. companyDescription is the same boilerplate on
    # every job a company has, so it is left out rather than spent from the 4,000-char budget.
    text = parse_smartrecruiters_detail({"jobAd": {"sections": {
        "companyDescription": {"text": "<p>Acme has been making anvils since 1923.</p>"},
        "qualifications": {"text": "<p>Rising junior &amp; up</p>"},
        "jobDescription": {"text": "<p>Design anvils</p>"},
        "additionalInformation": {"text": "<p>Paid</p>"},
    }}})
    assert text == "Design anvils\nRising junior & up\nPaid"

    # A posting with no advert at all must come back empty, not raise: an empty description is
    # what every SmartRecruiters listing had before this, so it has to stay survivable.
    assert parse_smartrecruiters_detail({}) == ""
    assert parse_smartrecruiters_detail({"jobAd": {"sections": {"jobDescription": None}}}) == ""


def test_workable():
    items = parse_workable({"jobs": [
        {"title": "Software Engineering Intern", "employment_type": "Intern", "shortcode": "ABC",
         "url": "https://apply.workable.com/acme/j/ABC/", "application_url": "https://apply.workable.com/acme/j/ABC/apply/",
         "published_on": "2026-09-01", "country": "United States", "city": "Boston", "state": "Massachusetts",
         "locations": [{"country": "United States", "countryCode": "US", "city": "Boston", "region": "Massachusetts"}],
         "telecommuting": False, "description": "<p>Build things.</p>"},
        {"title": "Software Engineer", "employment_type": "Full-time", "locations": [{"countryCode": "US"}]},
        {"title": "Marketing Intern", "employment_type": "Intern", "locations": [{"countryCode": "FR"}]},
    ]}, CO)
    assert len(items) == 1 and items[0]["locations"] == ["Boston, Massachusetts"] and items[0]["source"] == "workable"


def test_recruitee():
    items = parse_recruitee({"offers": [
        {"title": "Data Intern", "employment_type_code": "internship", "city": "New York", "state_code": "NY",
         "country_code": "US", "careers_url": "https://acme.recruitee.com/o/data-intern",
         "careers_apply_url": "https://acme.recruitee.com/o/data-intern/c/new",
         "published_at": "2026-09-01 00:00:00 UTC", "remote": False,
         "locations": [{"city": "New York", "state_code": "NY", "country_code": "US"}],
         "description": "<p>Analyze data.</p>", "requirements": "<p>SQL.</p>"},
        {"title": "Sales Intern", "employment_type_code": "internship", "country_code": "DE"},
    ]}, CO)
    assert len(items) == 1 and items[0]["locations"] == ["New York, NY"] and items[0]["source"] == "recruitee"


def test_bamboohr():
    items = parse_bamboohr({"result": [
        {"id": 1, "jobOpeningName": "Finance Intern", "employmentStatusLabel": "Intern",
         "atsLocation": {"city": "Providence", "state": "RI", "country": "US"}, "isRemote": False},
        {"id": 2, "jobOpeningName": "Finance Intern", "employmentStatusLabel": "Intern",
         "atsLocation": {"city": "Paris", "country": "FR"}},
    ]}, CO, "acme")
    assert len(items) == 1 and items[0]["locations"] == ["Providence, RI"] and items[0]["_bh_id"] == 1


def test_bamboohr_plain_location():
    # The other shape: no atsLocation values at all, and no country field anywhere. An empty
    # atsLocation is still a dict, so reading it in preference to this one lost the job entirely.
    items = parse_bamboohr({"result": [
        {"id": 3, "jobOpeningName": "Robotics Co-op", "employmentStatusLabel": "Intern",
         "atsLocation": {"country": None, "state": None, "province": None, "city": None},
         "location": {"city": "Bedford", "state": "Massachusetts"}},
        {"id": 4, "jobOpeningName": "Sales Intern", "employmentStatusLabel": "Intern",
         "atsLocation": {"country": None, "state": None, "province": None, "city": None},
         "location": {"city": "Haarlem", "state": "Netherlands"}},   # 'state' holds the country
        {"id": 5, "jobOpeningName": "Design Intern", "employmentStatusLabel": "Intern",
         "location": {"city": None, "state": None}, "isRemote": True},
    ]}, CO, "acme")
    assert [i["locations"] for i in items] == [["Bedford, Massachusetts"], ["Remote - US"]]
    assert [i["_bh_id"] for i in items] == [3, 5]


def test_rippling():
    items = parse_rippling([
        {"uuid": "u1", "name": "IT Intern", "url": "https://ats.rippling.com/acme/jobs/u1",
         "workLocation": {"label": "Boston, MA"}},
        {"uuid": "u1", "name": "IT Intern", "url": "https://ats.rippling.com/acme/jobs/u1",
         "workLocation": {"label": "Remote - US"}},
        {"uuid": "u2", "name": "Account Manager", "url": "x", "workLocation": {"label": "Boston, MA"}},
    ], CO)
    assert len(items) == 1 and items[0]["locations"] == ["Boston, MA", "Remote - US"]
    assert items[0]["_rp_uuid"] == "u1", "the job call needs the uuid, which only the list carries"


def test_rippling_detail():
    desc, posted = parse_rippling_detail({
        "createdOn": "2026-09-14T08:54:48.317000-07:00",
        "description": {"company": "<p>Acme is a great place to work.</p>",
                        "role": "<p>Build real things.</p><p>Rising juniors &amp; up.</p>"}})
    # 'company' is the same boilerplate on every job, so it stays out of the 4,000-character budget.
    assert desc == "Build real things.\n Rising juniors & up."
    # createdOn is the only posting date Rippling gives; the board list has none.
    assert posted == "2026-09-14"

    # A tenant may leave either half out, and a job that has gone answers with nothing.
    assert parse_rippling_detail({"description": {"company": "<p>Acme.</p>"}}) == ("", None)
    assert parse_rippling_detail({}) == ("", None)


def test_oracle():
    items, total = parse_oracle({"items": [{"TotalJobsCount": 1, "requisitionList": [
        {"Id": "REQ1", "Title": "Summer Intern - Engineering", "PostedDate": "2026-09-01",
         "PrimaryLocation": "New York, United States", "PrimaryLocationCountry": "US",
         "ShortDescriptionStr": "Join our team.",
         "secondaryLocations": [{"Name": "Boston, United States", "CountryCode": "US"},
                                 {"Name": "London, United Kingdom", "CountryCode": "GB"}]},
    ]}]}, CO, "acme.fa.oraclecloud.com", "CX_1")
    assert total == 1 and items[0]["locations"] == ["New York", "Boston"]
    assert items[0]["url"] == "https://acme.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/REQ1"
    # The requisition id has to survive the parse, or the detail call has nothing to ask for.
    assert items[0]["_req_id"] == "REQ1"


def test_oracle_detail():
    # Advert order, and CorporateDescriptionStr left out: it is the same employer boilerplate on
    # every requisition, so keeping it would spend the 4,000-char budget on marketing copy.
    text = parse_oracle_detail({"items": [{
        "CorporateDescriptionStr": "<p>Acme has been making anvils since 1923.</p>",
        "ExternalQualificationsStr": "<p>Rising junior &amp; up</p>",
        "ExternalDescriptionStr": "<p>Design anvils</p>",
        "ExternalResponsibilitiesStr": "<p>Draw them</p>",
    }]})
    assert text == "Design anvils\nDraw them\nRising junior & up"

    # Most tenants leave most of these fields present and empty, and a requisition can be gone by
    # the time we ask for it, so both have to come back empty rather than raise.
    assert parse_oracle_detail({"items": [{"ExternalDescriptionStr": None}]}) == ""
    assert parse_oracle_detail({}) == ""


def test_simplify_terms():
    items = _parse([{"company_name": "A", "title": "SWE Intern", "terms": ["Fall 2026", "Summer 2027"],
                     "locations": ["Boston, MA"], "url": "u", "active": True, "source": "Simplify"}],
                   "simplify", {"Summer": 2027})
    assert (items[0]["season"], items[0]["year"], items[0]["source"]) == ("Summer", 2027, "simplify")


def test_taleo():
    items, total = parse_taleo({"pagingData": {"totalCount": 3}, "requisitionList": [
        {"contestNo": "342925", "linkedColumn": 0, "locationsColumns": [1],
         "column": ["2027 Intern - Autonomy Engineer", '["US-Maryland-Hunt Valley","CA-Ontario-Toronto"]', "09/01/2026"]},
        {"contestNo": "1", "linkedColumn": 0, "locationsColumns": [1],
         "column": ["Engineering Intern", '["CA-Ontario-Toronto"]', "09/01/2026"]},
        {"contestNo": "2", "linkedColumn": 0, "locationsColumns": [1],
         "column": ["Machinist", '["US-Texas-Fort Worth"]', "09/01/2026"]},
    ]}, CO, "acme", "ext")
    assert total == 3 and len(items) == 1
    assert items[0]["locations"] == ["Hunt Valley, Maryland"] and items[0]["posted_at"] == "2026-09-01"
    assert items[0]["url"] == "https://acme.taleo.net/careersection/ext/jobdetail.ftl?job=342925"


def test_taleo_detail():
    # The career section serializes the whole page into this one field: the advert's blocks,
    # each twice, among labels and flags, percent-encoded, with ":" escaped.
    body = "!|!".join([
        "ftlx0", "descRequisition", "true", "342925",
        "!*!%3Cp%3EBuild real things at Acme%5C: rovers.%3C/p%3E",
        "!*!%3Cp%3EBuild real things at Acme%5C: rovers.%3C/p%3E",
        "!*!%3Cul%3E%3Cli%3ERising juniors %26amp; up.%3C/li%3E%3C/ul%3E",
        "!*!%3Cul%3E%3Cli%3ERising juniors %26amp; up.%3C/li%3E%3C/ul%3E",
        "Acme pays $20 per hour.",            # a plain-text field: no markup, so not the advert
        "Acme is an equal opportunity employer.",
        "US-Maryland-Hunt Valley", "Internship / Co-Op", "csrftoken", "isListEmpty", "false",
    ])
    page = '<input type="hidden" name="initialHistory" id="initialHistory" value="%s" />' % body
    desc = parse_taleo_detail(page)
    assert desc == "Build real things at Acme: rovers.\nRising juniors & up."
    # The boilerplate the employer typed as plain text stays out, and so do the labels.
    assert "equal opportunity" not in desc and "csrftoken" not in desc

    # A page without the field is not an error - an expired job is served as an empty shell.
    assert parse_taleo_detail("<html><body>Job no longer available</body></html>") == ""
    assert parse_taleo_detail("") == ""


def test_adp():
    def req(i, title, locs, level="Intern"):
        return {"itemID": i, "requisitionTitle": title, "postDate": "2026-09-01T00:00:00-04:00",
                "workLevelCode": {"shortName": level},
                "customFieldGroup": {"stringFields": [{"nameCode": {"codeValue": "ExternalJobID"}, "stringValue": "6026"}]},
                "requisitionLocations": locs}
    ma = {"address": {"cityName": "Boston", "countrySubdivisionLevel1": {"codeValue": "MA"}},
          "nameCode": {"shortName": "HQ, Boston, MA, US"}}
    fr = {"address": {"cityName": "Paris", "countrySubdivisionLevel1": {"codeValue": "IDF"}, "countryCode": "FR"},
          "nameCode": {"shortName": "Store, Paris, IDF, FR"}}
    items, total = parse_adp({"meta": {"totalNumber": 3}, "jobRequisitions": [
        req("a_1", "Marketing Intern", [ma, fr]), req("b_1", "Design Intern", [fr]),
        req("c_1", "Sales Supervisor", [ma], level="Full Time"),
    ]}, CO, "cid-1")
    assert total == 3 and len(items) == 1
    assert items[0]["locations"] == ["Boston, MA"] and items[0]["_adp_id"] == "a_1"
    assert "cid=cid-1" in items[0]["url"] and "jobId=6026" in items[0]["url"]


def test_jobvite():
    page = """<tr><td class="jv-job-list-name">
        <a href="/acme/job/oA1">Summer Intern - Planning</a>
    </td>
    <td class="jv-job-list-location">
        Brooklyn,
        NY
    </td></tr>
    <tr><td class="jv-job-list-name"><a href="/acme/job/oB2">Agency Attorney</a></td>
    <td class="jv-job-list-location">New York, NY</td></tr>"""
    items = parse_jobvite(page, CO)
    assert len(items) == 1 and items[0]["locations"] == ["Brooklyn, NY"]
    assert items[0]["url"] == "https://jobs.jobvite.com/acme/job/oA1" and items[0]["apply_url"].endswith("/oA1/apply")
    desc = parse_jobvite_detail('<div class="jv-job-detail-description" ng-non-bindable><h3>Description</h3>'
                                '<div><p>Plan routes.</p></div></div><div class="jv-job-detail-bottom-actions">')
    assert "Plan routes." in desc


def test_icims():
    def card(jid, title, loc, header_layout=False):
        # two real layouts: "Job Locations" in a plain span, and "Location" inside the header-field
        # block with the value past a </dt><dd> boundary
        where = (f"""<dl class="iCIMS_JobHeaderGroup"><div class="iCIMS_JobHeaderTag">
        <dt class="iCIMS_JobHeaderField"><span class="glyphicons" aria-hidden="true"></span>
        <span class="sr-only field-label">Location</span> </dt>
        <dd class="iCIMS_JobHeaderData"><span > {loc}</span> </dd></div></dl>""" if header_layout else
        f"""<span class="sr-only field-label">Job Locations</span><span > {loc}</span>""")
        return f"""<li class="col-xs-12 iCIMS_JobCardItem"><div class="row">
        <div class="col-xs-6 header left">{where}</div>
        <div class="col-xs-12 title">
        <a href="https://acme.icims.com/jobs/{jid}/slug/job?in_iframe=1" class="iCIMS_Anchor" title="{jid} - {title}">
        <h3 > {title}</h3></a></div>
        <div class="col-xs-12 description">&nbsp; Care for patients...</div>
        </div></li>"""
    page = (card(7600, "RN Internship", "US-TX-Midland")
            + card(7601, "Executive Chef", "US-TX-Midland")
            + card(7602, "Summer Intern", "CA-ON-Toronto")
            + card(7603, "Dietetic Intern", "US-MA-Boston | US-Remote", header_layout=True))
    items = parse_icims(page, CO)
    # the chef is not an internship; Toronto is not US, so it drops with no US location left
    assert [i["title"] for i in items] == ["RN Internship", "Dietetic Intern"]
    assert items[0]["locations"] == ["Midland, TX"]
    # the header-field layout resolves too, or a whole tenant silently yields nothing
    assert items[1]["locations"] == ["Boston, MA", "Remote - US"]
    # in_iframe is a fetch detail, not part of the link we hand a student
    assert items[0]["url"] == "https://acme.icims.com/jobs/7600/slug/job"
    # "International" is not an internship, but iCIMS keyword search matches it on substring
    assert parse_icims(card(7604, "International Scholar Advisor", "US-NY-New York"), CO) == []


def test_icims_detail():
    ld = ('{"@context":"http://schema.org","@type":"JobPosting","title":"Data Science Intern",'
          '"datePosted":"2026-09-09T04:00:00.000Z","validThrough":"2027-09-01T04:00:00.000Z",'
          '"description":"<h2>Overview</h2>\\n<p>Build real things.</p>"}')
    page = ('<script type="application/ld+json">{"@type":"WebSite","name":"Acme Careers"}</script>'
            '<script type="application/ld+json">%s</script>') % ld
    desc, posted = parse_icims_detail(page)
    # The WebSite block comes first on every tenant, so the JobPosting has to be looked for.
    assert desc == "Overview\n Build real things."
    # datePosted is a timestamp; the search card carries no date at all, so this is the only one.
    assert posted == "2026-09-09"

    # A closed job is served as a 410 with no block, and a tenant may omit the date.
    assert parse_icims_detail('<script type="application/ld+json">{"@type":"WebSite"}</script>') == ("", None)
    assert parse_icims_detail('<script type="application/ld+json">{"@type":"JobPosting",'
                              '"description":"<p>Hi</p>"}</script>') == ("Hi", None)
    assert parse_icims_detail("<html><body>Job no longer available</body></html>") == ("", None)
    # A tenant serving something that is not JSON must not take the whole board down with it.
    assert parse_icims_detail('<script type="application/ld+json">not json</script>') == ("", None)


def test_eightfold():
    EF = {"name": "Acme", "ats_token": "acme", "is_quant_target": False}

    def pos(i, name, std, dept="", path=None):
        return {"id": i, "name": name, "standardizedLocations": std, "department": dept,
                "postedTs": 1788276561, "positionUrl": path if path is not None else f"/careers/job/{i}"}

    payload = {"data": {"count": 7, "positions": [
        pos(1, "2027 Intern - Product Engineering", ["IL,US"]),
        pos(2, "Supply Management Intern", ["Moline, IL, US", "Des Moines, IA, US"]),
        pos(3, "Manufacturing Intern", ["Winston-Salem, NC, US"]),
        pos(4, "Graduate Engineer Internship", ["Slough, England, GB"]),
        pos(5, "Manager, Internal Controls", ["Austin, TX, US"]),
        pos(6, "Process Development Intern", ["Arden Hills, MN, US"], path=""),
        pos(7, "Summer Intern", ["Somewhere, ZZ, US"]),
    ]}}
    out = parse_eightfold(payload, EF)
    by_title = {i["title"]: i for i in out}

    # a two-part standardized location is a state with no city, which the geo labeler can still place
    assert by_title["2027 Intern - Product Engineering"]["locations"] == ["IL"]
    # a job open in two places keeps both
    assert by_title["Supply Management Intern"]["locations"] == ["Moline, IL", "Des Moines, IA"]
    # a hyphenated city survives: only the last two parts are the state and country
    assert by_title["Manufacturing Intern"]["locations"] == ["Winston-Salem, NC"]
    # the search is a relevance search, so it returns near misses; they are not internships
    assert "Manager, Internal Controls" not in by_title
    # non-US rows are dropped rather than translated, and so is a two-letter code that is not a state
    assert "Graduate Engineer Internship" not in by_title
    assert "Summer Intern" not in by_title
    # positionUrl is site-relative; with none, the link is rebuilt from the job id
    assert by_title["Supply Management Intern"]["url"] == "https://acme.eightfold.ai/careers/job/2"
    assert by_title["Process Development Intern"]["url"] == "https://acme.eightfold.ai/careers/job/6"
    assert by_title["Manufacturing Intern"]["posted_at"] == 1788276561

    # the employer's own website is a required API parameter and is assumed from the tenant,
    # unless a seed pins it
    assert ef_host("johndeere") == ("johndeere", "johndeere.com")
    assert ef_host("wf|wellsfargo.com") == ("wf", "wellsfargo.com")


def test_successfactors():
    SF = {"name": "Acme", "ats_token": "careers.acme.com", "is_quant_target": False}

    def row(jid, title, slug, loc):
        # the table template: the link once for desktop and again inside the phone block, with the
        # location printed in the phone block and again in its own column
        where = f'<span class="jobLocation"> {loc} </span>'
        return f"""<tr class="data-row"><td class="colTitle" headers="hdrTitle">
        <span class="jobTitle hidden-phone"><a href="/job/{slug}/{jid}/" class="jobTitle-link">{title}</a></span>
        <div class="jobdetail-phone visible-phone">
        <span class="jobTitle visible-phone"><a class="jobTitle-link" href="/job/{slug}/{jid}/">{title}</a></span>
        <span class="jobLocation visible-phone">{where}</span></div></td>
        <td class="colLocation hidden-phone" headers="hdrLocation">{where}</td></tr>"""

    def tile(jid, title, slug):
        # the tile template: the same link three times over (desktop, tablet, phone) and no
        # location markup anywhere on the page
        one = (f'<a class="jobTitle-link fontcolora880bb1b" data-focus-tile=".job-id-{jid}" '
               f'href="/job/{slug}/{jid}/"> {title} </a>')
        return f'<li class="job-tile job-id-{jid}" data-url="/job/{slug}/{jid}/">{one}{one}{one}</li>'

    page = ('<a id="hdrLocationButton" class="jobLocation sort" href="/search/?sortColumn=sort_location">Location </a>'
            + row(1422901500, "Physical Verification Intern", "Greensboro-Physical-Verification-Intern-NC-27409",
                  "Greensboro, NC, US, 27409")
            + row(1422800501, "Director of Sourcing", "Greensboro-Director-of-Sourcing-NC-27409",
                  "Greensboro, NC, US, 27409")
            + row(1422800502, "Summer Intern", "Shanghai-Summer-Intern-SH-201807", "Shanghai, SH, CN, 201807")
            + tile(1424643100, "2027 Summer Internship - Business Administration (Whittier)",
                   "Santa-Fe-Springs-2027-Summer-Internship-Business-Administration-%28Whittier%29-CA-91770-3714"))
    items = parse_successfactors(page, SF)
    # the director is not an internship; Shanghai is not US, so it drops with no US location left
    assert [i["title"] for i in items] == ["Physical Verification Intern",
                                           "2027 Summer Internship - Business Administration (Whittier)"]
    # a job's link appears two or three times over; it is one listing, not two or three
    assert len(items) == 2
    # the country code and the postcode after it are not part of a location a student reads
    assert items[0]["locations"] == ["Greensboro, NC"]
    # the tile template prints no location, so the place comes out of the slug. Taking the city as
    # the slug's first segment would make this Santa; the title is what says where the city ends.
    assert items[1]["locations"] == ["Santa Fe Springs, CA"]
    # the token is the host, and hrefs on the page are relative to it
    assert items[0]["url"] == "https://careers.acme.com/job/Greensboro-Physical-Verification-Intern-NC-27409/1422901500/"
    assert items[0]["source"] == "successfactors"
    # the column header is a link, not a job's location, and must not be read as one
    assert parse_successfactors('<a class="jobLocation sort">Location</a>', SF) == []

    # Westinghouse ends a slug with a bare two-letter code that is not the state: its Cranberry
    # Township jobs, which are in Pennsylvania, end in -NC. Only a code followed by a real postcode
    # is a state, so this job keeps the city the page gave it and claims no state at all.
    where = parse_successfactors(row(9001, "Summer Intern - Project Controls",
                                     "Cranberry-Township-Summer-Intern-Project-Controls-NC",
                                     "Cranberry Township, US"), SF)
    assert where[0]["locations"] == ["Cranberry Township"]
    # An Italian postcode is five digits too, so the state has to be a real one or Monfalcone lands
    # in Iowa. Here the page says CZ, which is not the US, and that alone settles it.
    assert parse_successfactors(row(9002, "Document Controller Intern",
                                    "Prague-Document-Controller-Intern-CZ-11000", "Prague, CZ"), SF) == []
    # ... and with no location on the page at all, the slug's 'IT' is not a state either
    assert parse_successfactors(tile(9003, "Document Controller Intern",
                                     "Monfalcone-Document-Controller-Intern-IT-34074"), SF) == []
    # 'OTHER' is one tenant's placeholder for "somewhere in this state", not a city
    other = parse_successfactors(row(9004, "Business System Intern", "OTHER-Business-System-Intern-MA-0",
                                     "OTHER, MA, US, 0"), SF)
    assert other[0]["locations"] == ["MA"]
    # a city with no state on the page, but a real postcode in the slug, gets its state back
    back = parse_successfactors(row(9005, "Summer Intern", "Chattanooga-Summer-Intern-TN-37401",
                                    "Chattanooga, US"), SF)
    assert back[0]["locations"] == ["Chattanooga, TN"]


def test_successfactors_detail():
    page = ('<div class="jobDisplayShell" itemscope itemtype="http://schema.org/JobPosting">'
            '<meta itemprop="datePosted" content="Tue Sep 15 07:00:00 UTC 2026">'
            '<span itemprop="description" class="rtltextaligneligible"><span class="jobdescription">'
            '<p>Build <span style="font-weight:bold">real</span> things.</p>'
            '<p>Rising juniors &amp; up.</p></span></span>'
            '<div class="footer">Apply now</div>')
    desc, posted = parse_successfactors_detail(page)
    # The nested spans are the point: stopping at the first </span> would cut this after "Build".
    assert desc == "Build real things.\n Rising juniors & up."
    # The search page has no date at all, so the job page is where one comes from.
    assert posted == "2026-09-15"

    # A tenant may serve either half, and an expired job serves neither, so both are optional.
    assert parse_successfactors_detail('<meta itemprop="datePosted" content="Tue Sep 15 07:00:00 UTC 2026">') \
        == ("", "2026-09-15")
    assert parse_successfactors_detail("<div>Job no longer available</div>") == ("", None)
    assert parse_successfactors_detail("") == ("", None)


def test_jazzhr():
    def item(slug, title, loc=None, dept="Engineering"):
        # the real shape: the location and department are nested <li>s inside the job's own <li>,
        # which is why the parser splits on the opening tag instead of matching a balanced one
        where = f"<li><i class='fa fa-map-marker'></i>{loc}</li>" if loc else ""
        return f"""<li class="list-group-item">
        <h3 class='list-group-item-heading'>
            <a href="https://acme.applytojob.com/apply/{slug}/{title.replace(' ', '-')}">
                {title}                                    </a>
        </h3>
        <ul class='list-inline list-group-item-text'>
            {where}
            <li><i class='fa fa-sitemap'></i>{dept}</li>
        </ul></li>"""

    page = ("<div class='list-group'>"
            + item("aB1", "Back-End Engineering Intern", "Atlanta, GA")
            + item("aB2", "Account Director", "Atlanta, GA")
            + item("aB3", "Finance Department - 2027 Summer Student Program", "Houston, TX")
            + item("aB4", "AlphaLab &amp; Portfolio  Operations Intern")
            + "</div>")
    items = parse_jazzhr(page, CO)
    # the director is not a student role; the summer student programme is, though it never says
    # "intern" - seventeen of Aramco Americas' postings are worded exactly that way
    assert [i["title"] for i in items] == ["Back-End Engineering Intern",
                                           "Finance Department - 2027 Summer Student Program",
                                           "AlphaLab & Portfolio Operations Intern"]
    assert items[0]["locations"] == ["Atlanta, GA"]
    assert items[0]["source"] == "jazzhr"
    assert items[0]["url"] == "https://acme.applytojob.com/apply/aB1/Back-End-Engineering-Intern"
    # a board may omit the location entirely, and that is not a reason to drop the job
    assert items[2]["locations"] == []
    # JazzHR serves no description on the board page, so we report none rather than inventing one
    assert items[0]["description"] == ""
    # an employer with nothing open serves the page with no items at all
    assert parse_jazzhr("<div class='list-group'></div>", CO) == []


def test_usajobs():
    def hit(title, loc, country="United States"):
        return {"MatchedObjectDescriptor": {
            "PositionTitle": title, "PositionURI": "https://www.usajobs.gov/GetJob/ViewDetails/1",
            "ApplyURI": ["https://www.usajobs.gov/GetJob/ViewDetails/1?PostingChannelID=RESTAPI"],
            "OrganizationName": "National Park Service", "PublicationStartDate": "2026-09-01T00:00:00Z",
            "ApplicationCloseDate": "2026-10-01T00:00:00Z",
            "PositionLocation": [{"LocationName": loc, "CountryCode": country}],
            "PositionSchedule": [{"Name": "Part-time"}],
            "PositionRemuneration": [{"MinimumRange": "17.50", "MaximumRange": "22.00", "Description": "Per Hour"}],
            "UserArea": {"Details": {"JobSummary": "<p>Help visitors.</p>", "MajorDuties": ["Lead tours"],
                                     "WhoMayApply": {"Name": "United States Citizens"}}}}}
    items, total = parse_usajobs({"SearchResult": {"SearchResultCountAll": 3, "SearchResultItems": [
        hit("Park Ranger (Student Trainee)", "Lowell National Historical Park, Lowell, Massachusetts"),
        hit("Biological Science Technician", "Acadia, Bar Harbor, Maine"),
        hit("Student Trainee (Admin)", "Naples, Italy", country="Italy"),
    ]}})
    assert total == 3 and len(items) == 2
    a = items[0]
    assert a["company_name"] == "National Park Service" and a["locations"] == ["Lowell, Massachusetts"]
    assert a["apply_url"].endswith("RESTAPI") and "Salary: $17.50 - $22.00 Per Hour" in a["description"]
    assert "United States Citizens" in a["description"] and "Lead tours" in a["description"]


def test_nyc_jobs():
    from datetime import date
    row = lambda **kw: {"job_id": "1", "agency": "DEPT OF PARKS & RECREATION", "posting_type": "Internal",
                        "business_title": "Communications Intern", "career_level": "Student",
                        "full_time_part_time_indicator": "P", "salary_range_from": "19.14",
                        "salary_range_to": "24.08", "salary_frequency": "Hourly",
                        "posting_date": "2026-09-04T00:00:00.000", "post_until": "03-NOV-2026",
                        "job_description": "Write posts.", **kw}
    items = parse_nyc_jobs([
        row(), row(posting_type="External", job_description="External copy."),
        row(job_id="2", business_title="Assistant General Counsel", career_level="Experienced (non-manager)"),
        row(job_id="3", business_title="Legal Intern", post_until="01-AUG-2026"),
    ], today=date(2026, 9, 14))
    assert len(items) == 1
    it = items[0]
    assert it["url"] == "https://cityjobs.nyc.gov/job/1" and it["description"].count("External copy.") == 1
    assert it["company_name"] == "Dept Of Parks & Recreation" and it["posted_at"] == "2026-09-04"
    assert it["employment_type"] == "Intern Part-time" and "Apply by: 2026-11-03" in it["description"]


def test_public_feeds_are_government():
    from datetime import date
    from internscout.normalize import normalize
    items = parse_nyc_jobs([{"job_id": "9", "agency": "POLICE DEPARTMENT", "business_title": "College Aide",
                             "career_level": "Student", "posting_type": "External"},
                            {"job_id": "8", "agency": "DOHMH", "business_title": "College Intern, Public Health Clinics",
                             "career_level": "Student", "posting_type": "External"}], today=date(2026, 9, 14))
    tags = [normalize(i)["field_tags"] for i in items]
    assert tags[0] == ["government"] and "government" in tags[1] and "public_health" in tags[1]
