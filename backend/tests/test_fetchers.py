"""Fetcher parsers against small saved payload shapes (no network)."""
from internscout.sources.greenhouse import parse_greenhouse
from internscout.sources.lever import parse_lever
from internscout.sources.ashby import parse_ashby
from internscout.sources.workday import parse_workday_list, parse_workday_detail, host_of
from internscout.sources.smartrecruiters import parse_smartrecruiters
from internscout.sources.workable import parse_workable
from internscout.sources.recruitee import parse_recruitee
from internscout.sources.bamboohr import parse_bamboohr
from internscout.sources.rippling import parse_rippling
from internscout.sources.oracle import parse_oracle
from internscout.sources.taleo import parse_taleo
from internscout.sources.adp import parse_adp
from internscout.sources.jobvite import parse_jobvite, parse_jobvite_detail
from internscout.sources.icims import parse_icims
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


def test_rippling():
    items = parse_rippling([
        {"uuid": "u1", "name": "IT Intern", "url": "https://ats.rippling.com/acme/jobs/u1",
         "workLocation": {"label": "Boston, MA"}},
        {"uuid": "u1", "name": "IT Intern", "url": "https://ats.rippling.com/acme/jobs/u1",
         "workLocation": {"label": "Remote - US"}},
        {"uuid": "u2", "name": "Account Manager", "url": "x", "workLocation": {"label": "Boston, MA"}},
    ], CO)
    assert len(items) == 1 and items[0]["locations"] == ["Boston, MA", "Remote - US"]


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
    def card(jid, title, loc):
        return f"""<li class="col-xs-12 iCIMS_JobCardItem"><div class="row">
        <div class="col-xs-6 header left"><span class="sr-only field-label">Job Locations</span>
        <span > {loc}</span></div>
        <div class="col-xs-12 title">
        <a href="https://acme.icims.com/jobs/{jid}/slug/job?in_iframe=1" class="iCIMS_Anchor" title="{jid} - {title}">
        <h3 > {title}</h3></a></div>
        <div class="col-xs-12 description">&nbsp; Care for patients...</div>
        </div></li>"""
    page = (card(7600, "RN Internship", "US-TX-Midland")
            + card(7601, "Executive Chef", "US-TX-Midland")
            + card(7602, "Summer Intern", "CA-ON-Toronto")
            + card(7603, "Dietetic Intern", "US-MA-Boston | US-Remote"))
    items = parse_icims(page, CO)
    # the chef is not an internship; Toronto is not US, so it drops with no US location left
    assert [i["title"] for i in items] == ["RN Internship", "Dietetic Intern"]
    assert items[0]["locations"] == ["Midland, TX"]
    assert items[1]["locations"] == ["Boston, MA", "Remote - US"]
    # in_iframe is a fetch detail, not part of the link we hand a student
    assert items[0]["url"] == "https://acme.icims.com/jobs/7600/slug/job"


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
