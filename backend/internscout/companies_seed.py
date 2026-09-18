"""Registry of employers with VERIFIED public ATS boards (Tier 2).

All tokens below returned live jobs when last checked. Spans tech, quant/trading,
biotech/health, consumer, fintech, education and consulting so the tool surfaces
internships across disciplines — not just software.

Add more: confirm at https://boards-api.greenhouse.io/v1/boards/<token>/jobs
"""
from __future__ import annotations

GREENHOUSE = [
    {"name": "Affirm", "ats_token": "affirm", "is_quant_target": False},
    {"name": "Airbnb", "ats_token": "airbnb", "is_quant_target": False},
    {"name": "Airtable", "ats_token": "airtable", "is_quant_target": False},
    {"name": "Akunacapital", "ats_token": "akunacapital", "is_quant_target": True},
    {"name": "Anthropic", "ats_token": "anthropic", "is_quant_target": False},
    {"name": "AppLovin", "ats_token": "applovin", "is_quant_target": False},
    {"name": "Archer", "ats_token": "archer", "is_quant_target": False},
    {"name": "Asana", "ats_token": "asana", "is_quant_target": False},
    {"name": "Boston Consulting Group", "ats_token": "bcg", "is_quant_target": False},
    {"name": "Block", "ats_token": "block", "is_quant_target": False},
    {"name": "Brex", "ats_token": "brex", "is_quant_target": False},
    {"name": "Calm", "ats_token": "calm", "is_quant_target": False},
    {"name": "CarGurus", "ats_token": "cargurus", "is_quant_target": False},
    {"name": "Chime", "ats_token": "chime", "is_quant_target": False},
    {"name": "Cloudflare", "ats_token": "cloudflare", "is_quant_target": False},
    {"name": "Coinbase", "ats_token": "coinbase", "is_quant_target": False},
    {"name": "Coursera", "ats_token": "coursera", "is_quant_target": False},
    {"name": "Databricks", "ats_token": "databricks", "is_quant_target": False},
    {"name": "Datadog", "ats_token": "datadog", "is_quant_target": False},
    {"name": "Discord", "ats_token": "discord", "is_quant_target": False},
    {"name": "Duolingo", "ats_token": "duolingo", "is_quant_target": False},
    {"name": "Elastic", "ats_token": "elastic", "is_quant_target": False},
    {"name": "Fastly", "ats_token": "fastly", "is_quant_target": False},
    {"name": "Figma", "ats_token": "figma", "is_quant_target": False},
    {"name": "Flatiron Health", "ats_token": "flatironhealth", "is_quant_target": False},
    {"name": "Flexport", "ats_token": "flexport", "is_quant_target": False},
    {"name": "Flowtraders", "ats_token": "flowtraders", "is_quant_target": True},
    {"name": "Formlabs", "ats_token": "formlabs", "is_quant_target": False},
    {"name": "Ginkgo Bioworks", "ats_token": "ginkgobioworks", "is_quant_target": False},
    {"name": "GitLab", "ats_token": "gitlab", "is_quant_target": False},
    {"name": "Grafana Labs", "ats_token": "grafanalabs", "is_quant_target": False},
    {"name": "Gusto", "ats_token": "gusto", "is_quant_target": False},
    {"name": "Hometap", "ats_token": "hometap", "is_quant_target": False},
    {"name": "IMC Trading", "ats_token": "imc", "is_quant_target": True},
    {"name": "Instacart", "ats_token": "instacart", "is_quant_target": False},
    {"name": "Jump Trading", "ats_token": "jumptrading", "is_quant_target": True},
    {"name": "Khan Academy", "ats_token": "khanacademy", "is_quant_target": False},
    {"name": "Klaviyo", "ats_token": "klaviyo", "is_quant_target": False},
    {"name": "Lucid Motors", "ats_token": "lucidmotors", "is_quant_target": False},
    {"name": "Lyft", "ats_token": "lyft", "is_quant_target": False},
    {"name": "Marqeta", "ats_token": "marqeta", "is_quant_target": False},
    {"name": "Mercury", "ats_token": "mercury", "is_quant_target": False},
    {"name": "MongoDB", "ats_token": "mongodb", "is_quant_target": False},
    {"name": "New Relic", "ats_token": "newrelic", "is_quant_target": False},
    {"name": "Nuro", "ats_token": "nuro", "is_quant_target": False},
    {"name": "Old Mission Capital", "ats_token": "oldmissioncapital", "is_quant_target": True},
    {"name": "Oura", "ats_token": "oura", "is_quant_target": False},
    {"name": "PDT Partners", "ats_token": "pdtpartners", "is_quant_target": True},
    {"name": "Peloton", "ats_token": "peloton", "is_quant_target": False},
    {"name": "Pinterest", "ats_token": "pinterest", "is_quant_target": False},
    {"name": "Recursion Pharmaceuticals", "ats_token": "recursionpharmaceuticals", "is_quant_target": False},
    {"name": "Reddit", "ats_token": "reddit", "is_quant_target": False},
    {"name": "Robinhood", "ats_token": "robinhood", "is_quant_target": False},
    {"name": "Roblox", "ats_token": "roblox", "is_quant_target": False},
    {"name": "Samsara", "ats_token": "samsara", "is_quant_target": False},
    {"name": "Scale AI", "ats_token": "scaleai", "is_quant_target": False},
    {"name": "SimpliSafe", "ats_token": "simplisafe", "is_quant_target": False},
    {"name": "Stripe", "ats_token": "stripe", "is_quant_target": False},
    {"name": "Sumo Logic", "ats_token": "sumologic", "is_quant_target": False},
    {"name": "The Trade Desk", "ats_token": "thetradedesk", "is_quant_target": False},
    {"name": "Toast", "ats_token": "toast", "is_quant_target": False},
    {"name": "TransMarket Group", "ats_token": "transmarketgroup", "is_quant_target": True},
    {"name": "Twitch", "ats_token": "twitch", "is_quant_target": False},
    {"name": "Vatic Labs", "ats_token": "vaticlabs", "is_quant_target": True},
    {"name": "Verkada", "ats_token": "verkada", "is_quant_target": False},
    {"name": "Virtu", "ats_token": "virtu", "is_quant_target": True},
    {"name": "Walleye Capital", "ats_token": "walleyecapital-external-students", "is_quant_target": True},
    {"name": "Waymo", "ats_token": "waymo", "is_quant_target": False},
    {"name": "Weiss Asset Management", "ats_token": "weissassetmanagement", "is_quant_target": True},
    # Northeast additions (verified live 2026-09)
    {"name": "DRW", "ats_token": "drweng", "is_quant_target": True},
    {"name": "Point72", "ats_token": "point72", "is_quant_target": True},
    {"name": "Jane Street", "ats_token": "janestreet", "is_quant_target": True},
    {"name": "Tower Research Capital", "ats_token": "towerresearchcapital", "is_quant_target": True},
    {"name": "AQR", "ats_token": "aqr", "is_quant_target": True},
    # optiver.com gives its board away nowhere, and no rule built from "Optiver" reaches
    # "optiverus" - the two Optiver boards discovery did find, optiverprivate and
    # tradingacademy2025, are neither of them the one with the internships on it. Confirmed
    # live 2026-09-18: 163 open jobs, among them the Summer 2027 quant research internship.
    {"name": "Optiver", "ats_token": "optiverus", "is_quant_target": True},
    {"name": "Schonfeld", "ats_token": "schonfeld", "is_quant_target": True},
    {"name": "Squarespace", "ats_token": "squarespace", "is_quant_target": False},
    {"name": "Betterment", "ats_token": "betterment", "is_quant_target": False},
    {"name": "Oscar Health", "ats_token": "oscar", "is_quant_target": False},
    {"name": "FanDuel", "ats_token": "fanduel", "is_quant_target": False},
    {"name": "Justworks", "ats_token": "justworks", "is_quant_target": False},
    {"name": "Cockroach Labs", "ats_token": "cockroachlabs", "is_quant_target": False},
    {"name": "Yext", "ats_token": "yext", "is_quant_target": False},
    {"name": "Zocdoc", "ats_token": "zocdoc", "is_quant_target": False},
    {"name": "Harry's", "ats_token": "harrys", "is_quant_target": False},
    {"name": "Glossier", "ats_token": "glossier", "is_quant_target": False},
    {"name": "SeatGeek", "ats_token": "seatgeek", "is_quant_target": False},
    {"name": "Attentive", "ats_token": "attentive", "is_quant_target": False},
    {"name": "CLEAR", "ats_token": "clear", "is_quant_target": False},
    {"name": "C3 AI", "ats_token": "c3iot", "is_quant_target": False},
    {"name": "PathAI", "ats_token": "pathai", "is_quant_target": False},
    {"name": "Markforged", "ats_token": "markforged", "is_quant_target": False},
    {"name": "Harvard Business School", "ats_token": "hbs", "is_quant_target": False},
    {"name": "Tripadvisor", "ats_token": "tripadvisor", "is_quant_target": False},
    {"name": "Cybereason", "ats_token": "cybereason", "is_quant_target": False},
]

LEVER = [
    # Verify at https://api.lever.co/v0/postings/<token>?mode=json before adding.
]

# Tier 4 watchlist: firms on their own portals (no public ATS API).
QUANT_WATCHLIST = [
    {"name": "Citadel / Citadel Securities", "careers_url": "https://www.citadel.com/careers/students/"},
    {"name": "Jane Street", "careers_url": "https://www.janestreet.com/join-jane-street/"},
    {"name": "Hudson River Trading", "careers_url": "https://www.hudsonrivertrading.com/careers/"},
    {"name": "Two Sigma", "careers_url": "https://careers.twosigma.com/careers/Students"},
    {"name": "DE Shaw", "careers_url": "https://www.deshaw.com/careers"},
    {"name": "DRW", "careers_url": "https://drw.com/work-at-drw"},
    {"name": "Optiver", "careers_url": "https://optiver.com/working-at-optiver/career-opportunities/"},
    {"name": "SIG (Susquehanna)", "careers_url": "https://careers.sig.com/"},
    {"name": "XTX Markets", "careers_url": "https://www.xtxmarkets.com/careers/"},
    {"name": "Tower Research", "careers_url": "https://www.tower-research.com/open-positions/"},
    {"name": "Five Rings", "careers_url": "https://www.fiverings.com/careers"},
    {"name": "Arrowstreet Capital", "careers_url": "https://www.arrowstreetcapital.com/careers/"},
]


# Ashby / Workday / SmartRecruiters seeds. Discovery (discover.py) adds hundreds more
# from apply URLs automatically; these just guarantee a few boards from day one.
ASHBY = [
    {"name": "Ramp", "ats_token": "ramp", "is_quant_target": False},
    {"name": "OpenAI", "ats_token": "openai", "is_quant_target": False},
    {"name": "Notion", "ats_token": "notion", "is_quant_target": False},
    {"name": "Linear", "ats_token": "linear", "is_quant_target": False},
    {"name": "Hex", "ats_token": "hex", "is_quant_target": False},
    {"name": "Plaid", "ats_token": "plaid", "is_quant_target": False},
    {"name": "Cursor", "ats_token": "cursor", "is_quant_target": False},
    {"name": "Replit", "ats_token": "replit", "is_quant_target": False},
    {"name": "Vanta", "ats_token": "vanta", "is_quant_target": False},
    {"name": "Modal", "ats_token": "modal", "is_quant_target": False},
    {"name": "Perplexity", "ats_token": "perplexity", "is_quant_target": False},
    {"name": "Cohere", "ats_token": "cohere", "is_quant_target": False},
    {"name": "Sierra", "ats_token": "sierra", "is_quant_target": False},
    {"name": "Harvey", "ats_token": "harvey", "is_quant_target": False},
    {"name": "Runway", "ats_token": "runway", "is_quant_target": False},
    {"name": "ElevenLabs", "ats_token": "elevenlabs", "is_quant_target": False},
    {"name": "Benchling", "ats_token": "benchling", "is_quant_target": False},
    {"name": "Watershed", "ats_token": "watershed", "is_quant_target": False},
]
WORKDAY = [
    {"name": "Moderna", "ats_token": "modernatx|wd1|M_tx", "is_quant_target": False},
]
SMARTRECRUITERS = [
    {"name": "Bosch", "ats_token": "BoschGroup", "is_quant_target": False},
    # Education research and public health, Waltham MA. The one employer of this sweep whose
    # token the name probe could reach on its own; the rest had to be read off a careers page.
    {'name': 'Education Development Center', 'ats_token': 'educationdevelopmentcenter',
     'is_quant_target': False, 'sector': 'education_research'},
]

# Sector employers (health, government, arts, ...): each entry also has "sector".
TALEO: list = []
ADP: list = []
JOBVITE: list = []

# --- sector seeds (generated by merge_sectors.py) ---
ADP += [
    {'name': 'Greater Boston Food Bank', 'ats_token': 'c8a69c17-a9c1-45ff-8324-98137a9b6b4d', 'is_quant_target': False, 'sector': 'nonprofit'},
    {'name': 'Mass Audubon', 'ats_token': '6044bc19-19e6-443a-8a51-62fe8af33798', 'is_quant_target': False, 'sector': 'nonprofit'},
    # Child and family policy research. One student posting the day it was added. ADP had two
    # boards in the registry and its tokens are opaque UUIDs no naming rule can guess, so each
    # one has to be read off the employer's own careers page.
    {'name': 'Child Trends', 'ats_token': '70c1bbee-a65c-4b42-bb04-9dcb8a73868a', 'is_quant_target': False, 'sector': 'education_research'},
]
GREENHOUSE += [
    {'name': "Sotheby's", 'ats_token': 'sothebys', 'is_quant_target': False, 'sector': 'arts_museums'},
    {'name': 'Khan Academy', 'ats_token': 'khanacademy', 'is_quant_target': False, 'sector': 'education_research'},
    {'name': 'Nexamp', 'ats_token': 'nexamp', 'is_quant_target': False, 'sector': 'energy_environment'},
    {'name': 'Peloton', 'ats_token': 'peloton', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    {'name': 'Axios', 'ats_token': 'axios', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'Hearst', 'ats_token': 'hearst', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'NPR', 'ats_token': 'nationalpublicradioinc', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'ProPublica', 'ats_token': 'propublica', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'Sony Music', 'ats_token': 'sonymusicentertainment', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'The New York Times', 'ats_token': 'thenewyorktimes', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'Vox Media', 'ats_token': 'voxmedia', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'Weber Shandwick', 'ats_token': 'webershandwick', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'WPP', 'ats_token': 'wpp', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'ACLU', 'ats_token': 'aclu', 'is_quant_target': False, 'sector': 'nonprofit'},
    {'name': 'Doctors Without Borders USA', 'ats_token': 'msfcareers', 'is_quant_target': False, 'sector': 'nonprofit'},
    {'name': 'Human Rights Watch', 'ats_token': 'humanrightswatch', 'is_quant_target': False, 'sector': 'nonprofit'},
    {'name': 'Robin Hood', 'ats_token': 'robinhood', 'is_quant_target': False, 'sector': 'nonprofit'},
    {'name': 'Southern Poverty Law Center', 'ats_token': 'southernpovertylawcenter', 'is_quant_target': False, 'sector': 'nonprofit'},
    {'name': 'Hasbro', 'ats_token': 'hasbro', 'is_quant_target': False, 'sector': 'retail_consumer'},
    {'name': 'Unilever', 'ats_token': 'unilever', 'is_quant_target': False, 'sector': 'retail_consumer'},
]
JOBVITE += [
    {'name': 'Port Authority of New York and New Jersey', 'ats_token': 'panynj', 'is_quant_target': False, 'sector': 'government_policy'},
    {'name': 'Feeding America', 'ats_token': 'feedingamerica', 'is_quant_target': False, 'sector': 'nonprofit'},
]
LEVER += [
    {'name': 'Planned Parenthood', 'ats_token': 'ppfa', 'is_quant_target': False, 'sector': 'health'},
    {'name': 'Spotify', 'ats_token': 'spotify', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'Sierra Club', 'ats_token': 'sierraclub', 'is_quant_target': False, 'sector': 'nonprofit'},
]
ORACLE: list = []
ORACLE += [
    {'name': 'Pearson', 'ats_token': 'hccz.fa.em3.oraclecloud.com|CX_2', 'is_quant_target': False, 'sector': 'education_research'},
    {'name': 'Arcadis', 'ats_token': 'ebcs.fa.em2.oraclecloud.com|CX_1', 'is_quant_target': False, 'sector': 'energy_environment'},
    {'name': 'Stantec', 'ats_token': 'hdhl.fa.us6.oraclecloud.com|CX_1', 'is_quant_target': False, 'sector': 'energy_environment'},
    {'name': 'Honeywell', 'ats_token': 'ibqbjb.fa.ocs.oraclecloud.com|Honeywell', 'is_quant_target': False, 'sector': 'engineering_manufacturing'},
    {'name': 'Abt Global', 'ats_token': 'egpy.fa.us2.oraclecloud.com|JoinAbt', 'is_quant_target': False, 'sector': 'government_policy'},
    {'name': 'Northwell Health', 'ats_token': 'eppr.fa.us2.oraclecloud.com|CX_2', 'is_quant_target': False, 'sector': 'health'},
    {'name': 'Fanatics', 'ats_token': 'fa-exki-saasfaprod1.fa.ocs.oraclecloud.com|CX_1', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    {'name': 'Hilton', 'ats_token': 'efet.fa.us2.oraclecloud.com|CX_1009', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    {'name': 'Marriott International', 'ats_token': 'ejwl.fa.us2.oraclecloud.com|CX', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    {'name': 'Chubb', 'ats_token': 'fa-ewgu-saasfaprod1.fa.ocs.oraclecloud.com|CX_2001', 'is_quant_target': False, 'sector': 'insurance_finance'},
    {'name': 'Grant Thornton', 'ats_token': 'ehzq.fa.us2.oraclecloud.com|CX_1', 'is_quant_target': False, 'sector': 'insurance_finance'},
    {'name': 'Hearst', 'ats_token': 'eevd.fa.us6.oraclecloud.com|CX_1', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'Staples', 'ats_token': 'fa-exhh-saasfaprod1.fa.ocs.oraclecloud.com|StaplesInc', 'is_quant_target': False, 'sector': 'retail_consumer'},
]
SMARTRECRUITERS += [
    {'name': 'Harvard University', 'ats_token': 'HarvardUniversity', 'is_quant_target': False, 'sector': 'education_research'},
    {'name': 'AECOM', 'ats_token': 'AECOM2', 'is_quant_target': False, 'sector': 'energy_environment'},
    {'name': 'Syngenta', 'ats_token': 'SyngentaGroup', 'is_quant_target': False, 'sector': 'energy_environment'},
    {'name': 'Veolia', 'ats_token': 'VeoliaEnvironnementSA', 'is_quant_target': False, 'sector': 'energy_environment'},
    {'name': 'NBCUniversal', 'ats_token': 'NBCUniversal3', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'Publicis Groupe', 'ats_token': 'publicisgroupe', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'Oxfam America', 'ats_token': 'oxfamamerica2', 'is_quant_target': False, 'sector': 'nonprofit'},
]
TALEO += [
    {'name': 'Commonwealth of Massachusetts', 'ats_token': 'massanf|ex', 'is_quant_target': False, 'sector': 'government_policy'},
    {'name': 'Hyatt', 'ats_token': 'hyatt|10780', 'is_quant_target': False, 'sector': 'hospitality_sports'},
]
WORKABLE: list = []
WORKABLE += [
    {'name': 'Cleveland Clinic', 'ats_token': 'cleveland-clinic', 'is_quant_target': False, 'sector': 'health'},
    {'name': 'CVS Health', 'ats_token': 'cvshealth', 'is_quant_target': False, 'sector': 'health'},
    {'name': 'Northwell Health', 'ats_token': 'northwell-health', 'is_quant_target': False, 'sector': 'health'},
]
WORKDAY += [
    {'name': 'Etsy', 'ats_token': 'etsy|wd5|Etsy_Careers', 'is_quant_target': False, 'sector': 'arts_museums'},
    {'name': 'Argonne National Laboratory', 'ats_token': 'argonne|wd1|Argonne_Careers', 'is_quant_target': False, 'sector': 'education_research'},
    {'name': 'Argonne National Laboratory', 'ats_token': 'argonne|wd1|EDU_PUB', 'is_quant_target': False, 'sector': 'education_research'},
    {'name': 'Draper', 'ats_token': 'draper|wd5|draper_careers', 'is_quant_target': False, 'sector': 'education_research'},
    {'name': 'HMH', 'ats_token': 'hmhw|wd12|hmh_careers', 'is_quant_target': False, 'sector': 'education_research'},
    {'name': 'National Renewable Energy Laboratory', 'ats_token': 'nrel|wd5|nrel', 'is_quant_target': False, 'sector': 'education_research'},
    {'name': 'Northeastern University', 'ats_token': 'northeastern|wd1|careers', 'is_quant_target': False, 'sector': 'education_research'},
    {'name': 'Ameresco', 'ats_token': 'ameresco|wd5|Ameresco', 'is_quant_target': False, 'sector': 'energy_environment'},
    {'name': 'Corteva', 'ats_token': 'corteva|wd5|corteva', 'is_quant_target': False, 'sector': 'energy_environment'},
    {'name': "Land O'Lakes", 'ats_token': 'landolakes|wd1|landolakes', 'is_quant_target': False, 'sector': 'energy_environment'},
    {'name': 'ABB', 'ats_token': 'abb|wd3|external_career_page', 'is_quant_target': False, 'sector': 'engineering_manufacturing'},
    {'name': 'Analog Devices', 'ats_token': 'analogdevices|wd1|External', 'is_quant_target': False, 'sector': 'engineering_manufacturing'},
    {'name': 'Bose', 'ats_token': 'boseallaboutme|wd503|Bose_Careers', 'is_quant_target': False, 'sector': 'engineering_manufacturing'},
    {'name': 'Boston Dynamics', 'ats_token': 'bostondynamics|wd1|Boston_Dynamics', 'is_quant_target': False, 'sector': 'engineering_manufacturing'},
    {'name': 'GE Aerospace', 'ats_token': 'geaerospace|wd5|ge_externalsite', 'is_quant_target': False, 'sector': 'engineering_manufacturing'},
    {'name': 'Johnson & Johnson', 'ats_token': 'jj|wd5|JJ', 'is_quant_target': False, 'sector': 'engineering_manufacturing'},
    {'name': 'Medtronic', 'ats_token': 'medtronic|wd1|medtroniccareers', 'is_quant_target': False, 'sector': 'engineering_manufacturing'},
    {'name': 'Medtronic', 'ats_token': 'medtronic|wd1|redeploymentmedtroniccareers', 'is_quant_target': False, 'sector': 'engineering_manufacturing'},
    {'name': 'Northrop Grumman', 'ats_token': 'ngc|wd1|northrop_grumman_external_site', 'is_quant_target': False, 'sector': 'engineering_manufacturing'},
    {'name': 'Northrop Grumman', 'ats_token': 'ngc|wd1|northrop_grumman_restricted_site', 'is_quant_target': False, 'sector': 'engineering_manufacturing'},
    {'name': 'Otis', 'ats_token': 'otis|wd5|REC_Ext_Gateway', 'is_quant_target': False, 'sector': 'engineering_manufacturing'},
    {'name': 'RTX', 'ats_token': 'globalhr|wd5|Private_Posting_No_TMP', 'is_quant_target': False, 'sector': 'engineering_manufacturing'},
    {'name': 'RTX', 'ats_token': 'globalhr|wd5|rec_rtx_ext_gateway', 'is_quant_target': False, 'sector': 'engineering_manufacturing'},
    {'name': 'Stanley Black & Decker', 'ats_token': 'sbdinc|wd1|Stanley_Black_Decker_Career_Site', 'is_quant_target': False, 'sector': 'engineering_manufacturing'},
    {'name': 'Booz Allen Hamilton', 'ats_token': 'bah|wd1|BAH_Jobs', 'is_quant_target': False, 'sector': 'government_policy'},
    {'name': 'Federal Reserve Bank of Boston', 'ats_token': 'rb|wd5|FRS', 'is_quant_target': False, 'sector': 'government_policy'},
    {'name': 'MITRE', 'ats_token': 'mitre|wd5|MITRE', 'is_quant_target': False, 'sector': 'government_policy'},
    {'name': 'Pew Research Center', 'ats_token': 'pewtrusts|wd5|TrustsExternal', 'is_quant_target': False, 'sector': 'government_policy'},
    {'name': 'RAND Corporation', 'ats_token': 'rand|wd5|External_Career_Site', 'is_quant_target': False, 'sector': 'government_policy'},
    {'name': 'Urban Institute', 'ats_token': 'urban|wd115|Urban-Careers', 'is_quant_target': False, 'sector': 'government_policy'},
    {'name': 'American Red Cross', 'ats_token': 'americanredcross|wd1|american_red_cross_careers', 'is_quant_target': False, 'sector': 'health'},
    {'name': 'Baystate Health', 'ats_token': 'baystatehealth|wd12|External_Careers', 'is_quant_target': False, 'sector': 'health'},
    {'name': 'Beth Israel Lahey Health', 'ats_token': 'bilh|wd1|External', 'is_quant_target': False, 'sector': 'health'},
    {'name': 'Biogen', 'ats_token': 'biibhr|wd3|external', 'is_quant_target': False, 'sector': 'health'},
    {'name': 'Boston Medical Center', 'ats_token': 'bmc|wd1|BMC', 'is_quant_target': False, 'sector': 'health'},
    {'name': 'Brown University Health', 'ats_token': 'brownhealth|wd12|External_Careers', 'is_quant_target': False, 'sector': 'health'},
    {'name': 'Cigna Group', 'ats_token': 'cigna|wd5|cignacareers', 'is_quant_target': False, 'sector': 'health'},
    {'name': 'Cleveland Clinic', 'ats_token': 'ccf|wd1|ClevelandClinicCareers', 'is_quant_target': False, 'sector': 'health'},
    {'name': 'CVS Health', 'ats_token': 'cvshealth|wd1|CVS_Health_Careers', 'is_quant_target': False, 'sector': 'health'},
    {'name': 'CVS Health', 'ats_token': 'cvshealth|wd1|Private_Postings_Intern_Conversion_ONLY', 'is_quant_target': False, 'sector': 'health'},
    {'name': 'Elevance Health', 'ats_token': 'elevancehealth|wd1|ELV-ET', 'is_quant_target': False, 'sector': 'health'},
    {'name': 'Mass General Brigham', 'ats_token': 'massgeneralbrigham|wd1|mgbexternal', 'is_quant_target': False, 'sector': 'health'},
    {'name': 'Memorial Sloan Kettering', 'ats_token': 'msk|wd108|MSKCC_Careers_Primary', 'is_quant_target': False, 'sector': 'health'},
    {'name': 'Moderna', 'ats_token': 'modernatx|wd1|M_tx', 'is_quant_target': False, 'sector': 'health'},
    {'name': 'NewYork-Presbyterian', 'ats_token': 'nyp|wd1|nypcareers', 'is_quant_target': False, 'sector': 'health'},
    {'name': 'Pfizer', 'ats_token': 'pfizer|wd1|PfizerCareers', 'is_quant_target': False, 'sector': 'health'},
    {'name': 'Point32Health', 'ats_token': 'point32health|wd5|THP', 'is_quant_target': False, 'sector': 'health'},
    {'name': 'Takeda', 'ats_token': 'takeda|wd3|external', 'is_quant_target': False, 'sector': 'health'},
    {'name': 'Thermo Fisher Scientific', 'ats_token': 'thermofisher|wd5|ThermoFisherCareers', 'is_quant_target': False, 'sector': 'health'},
    {'name': 'Tufts Medicine', 'ats_token': 'tuftsmedicine|wd1|Jobs', 'is_quant_target': False, 'sector': 'health'},
    {'name': 'UMass Memorial Health', 'ats_token': 'ummh|wd1|Careers', 'is_quant_target': False, 'sector': 'health'},
    {'name': 'Vertex Pharmaceuticals', 'ats_token': 'vrtx|wd501|vertex_careers', 'is_quant_target': False, 'sector': 'health'},
    {'name': 'Vertex Pharmaceuticals', 'ats_token': 'vrtx|wd501|vertex_intern', 'is_quant_target': False, 'sector': 'health'},
    {'name': 'DraftKings', 'ats_token': 'draftkings|wd1|Campus_Career_Portal', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    {'name': 'DraftKings', 'ats_token': 'draftkings|wd1|Employee_Referral_Portal', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    {'name': 'MGM Resorts', 'ats_token': 'mgmresorts|wd5|MGMCareers', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    {'name': 'New Balance', 'ats_token': 'newbalance|wd1|careers', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    {'name': 'Nike', 'ats_token': 'nike|wd1|nke', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    {'name': 'The Walt Disney Company', 'ats_token': 'disney|wd5|disneycareer', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    {'name': 'The Walt Disney Company', 'ats_token': 'disney|wd5|disneycareerdc', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    {'name': 'AIG', 'ats_token': 'aig|wd1|aig', 'is_quant_target': False, 'sector': 'insurance_finance'},
    {'name': 'AIG', 'ats_token': 'aig|wd1|early_careers', 'is_quant_target': False, 'sector': 'insurance_finance'},
    {'name': 'Bank of America', 'ats_token': 'ghr|wd1|us-emplsv', 'is_quant_target': False, 'sector': 'insurance_finance'},
    {'name': 'Fidelity Investments', 'ats_token': 'fmr|wd1|fidelitycareers', 'is_quant_target': False, 'sector': 'insurance_finance'},
    {'name': 'Fidelity Investments', 'ats_token': 'fmr|wd1|targeted', 'is_quant_target': False, 'sector': 'insurance_finance'},
    {'name': 'RSM', 'ats_token': 'rsm|wd1|RSMCareers', 'is_quant_target': False, 'sector': 'insurance_finance'},
    {'name': 'State Street', 'ats_token': 'statestreet|wd1|equest', 'is_quant_target': False, 'sector': 'insurance_finance'},
    {'name': 'State Street', 'ats_token': 'statestreet|wd1|Global', 'is_quant_target': False, 'sector': 'insurance_finance'},
    {'name': 'The Hartford', 'ats_token': 'thehartford|wd5|Careers_External', 'is_quant_target': False, 'sector': 'insurance_finance'},
    {'name': 'Vanguard', 'ats_token': 'vanguard|wd5|contractors_restricted', 'is_quant_target': False, 'sector': 'insurance_finance'},
    {'name': 'Vanguard', 'ats_token': 'vanguard|wd5|vanguard_external', 'is_quant_target': False, 'sector': 'insurance_finance'},
    {'name': 'Webster Bank', 'ats_token': 'websteronline|wd12|WebsterExternalCareerSite', 'is_quant_target': False, 'sector': 'insurance_finance'},
    {'name': 'Wellington Management', 'ats_token': 'wellington|wd5|Campus', 'is_quant_target': False, 'sector': 'insurance_finance'},
    {'name': 'Condé Nast', 'ats_token': 'condenast|wd5|CondeCareers', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'Dow Jones', 'ats_token': 'dowjones|wd1|Dow_Jones_Career', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'Edelman', 'ats_token': 'djeholdings|wd5|edelman-careers-E200', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'GBH', 'ats_token': 'publicmedia|wd1|WGBH_Careers', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'iHeartMedia', 'ats_token': 'iheartmedia|wd5|External_iHM', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'Netflix', 'ats_token': 'netflix|wd1|Netflix', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'Omnicom', 'ats_token': 'interpublic|wd5|omc', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'PBS', 'ats_token': 'vhr-pbs|wd5|PBSCareers', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'Politico', 'ats_token': 'politico|wd108|POLITICO', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'The Atlantic', 'ats_token': 'atlanticmedia|wd1|Careers', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'Thomson Reuters', 'ats_token': 'thomsonreuters|wd5|External_Career_Site', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'Universal Music Group', 'ats_token': 'umusic|wd5|UMGUS', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'Warner Bros. Discovery', 'ats_token': 'warnerbros|wd5|global', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'Warner Music Group', 'ats_token': 'wmg|wd1|WMGUS', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'Environmental Defense Fund', 'ats_token': 'osv-edf|wd5|Confidential', 'is_quant_target': False, 'sector': 'nonprofit'},
    {'name': 'Habitat for Humanity', 'ats_token': 'habitat|wd12|External', 'is_quant_target': False, 'sector': 'nonprofit'},
    {'name': 'International Rescue Committee', 'ats_token': 'theirc|wd1|External_Careers', 'is_quant_target': False, 'sector': 'nonprofit'},
    {'name': 'The Nature Conservancy', 'ats_token': 'nature|wd108|ExternalCareers', 'is_quant_target': False, 'sector': 'nonprofit'},
    {'name': 'Year Up', 'ats_token': 'yearup|wd503|YearUp', 'is_quant_target': False, 'sector': 'nonprofit'},
    {'name': "BJ's Wholesale Club", 'ats_token': 'bjswholesaleclub|wd1|BJsCareers', 'is_quant_target': False, 'sector': 'retail_consumer'},
    {'name': 'Burlington', 'ats_token': 'burlington|wd5|BurlingtonCareers', 'is_quant_target': False, 'sector': 'retail_consumer'},
    {'name': 'General Mills', 'ats_token': 'genmills|wd1|GMI_External_Careers', 'is_quant_target': False, 'sector': 'retail_consumer'},
    {'name': 'Home Depot', 'ats_token': 'homedepot|wd5|careerdepot', 'is_quant_target': False, 'sector': 'retail_consumer'},
    {'name': 'Home Depot', 'ats_token': 'homedepot|wd5|CareerDepotCanada', 'is_quant_target': False, 'sector': 'retail_consumer'},
    {'name': 'Inspire Brands', 'ats_token': 'inspirebrands|wd5|InspireCareers', 'is_quant_target': False, 'sector': 'retail_consumer'},
    {'name': 'Kraft Heinz', 'ats_token': 'heinz|wd1|KraftHeinz_Careers', 'is_quant_target': False, 'sector': 'retail_consumer'},
    {'name': 'Kraft Heinz', 'ats_token': 'heinz|wd1|KraftHeinz_Careers_UR', 'is_quant_target': False, 'sector': 'retail_consumer'},
    {'name': 'L.L.Bean', 'ats_token': 'llbean|wd1|LLBean_Careers', 'is_quant_target': False, 'sector': 'retail_consumer'},
    {'name': "Lowe's", 'ats_token': 'lowes|wd5|LWS_External_CS', 'is_quant_target': False, 'sector': 'retail_consumer'},
    {'name': 'Ocean Spray', 'ats_token': 'oceanspray|wd5|OceanSprayJobs', 'is_quant_target': False, 'sector': 'retail_consumer'},
    {'name': 'PVH', 'ats_token': 'pvh|wd1|PVH_Careers', 'is_quant_target': False, 'sector': 'retail_consumer'},
    {'name': 'Tapestry', 'ats_token': 'tapestry|wd108|Tapestry_Careers', 'is_quant_target': False, 'sector': 'retail_consumer'},
    {'name': 'Target', 'ats_token': 'target|wd5|targetcareers', 'is_quant_target': False, 'sector': 'retail_consumer'},
    {'name': 'The Coca-Cola Company', 'ats_token': 'coke|wd1|coca-cola-careers', 'is_quant_target': False, 'sector': 'retail_consumer'},
    {'name': 'TJX Companies', 'ats_token': 'tjx|wd1|TJX_EXTERNAL', 'is_quant_target': False, 'sector': 'retail_consumer'},
    {'name': 'Unilever', 'ats_token': 'unilever|wd3|Unilever_Experienced_Professionals', 'is_quant_target': False, 'sector': 'retail_consumer'},
    {'name': 'Walmart', 'ats_token': 'walmart|wd504|WalmartExternal', 'is_quant_target': False, 'sector': 'retail_consumer'},
    {'name': 'Walmart', 'ats_token': 'walmart|wd5|WalmartExternal', 'is_quant_target': False, 'sector': 'retail_consumer'},
]
# SuccessFactors tenants, every one checked live on 2026-09-17: the token is the whole host.
# These employers were already reaching students one job at a time through Google Jobs; seeding
# them reads the whole board instead.
SUCCESSFACTORS: list = [
    {'name': 'Qorvo', 'ats_token': 'careers.qorvo.com', 'is_quant_target': False, 'sector': 'engineering_manufacturing'},
    {'name': 'Corning', 'ats_token': 'corningjobs.corning.com', 'is_quant_target': False, 'sector': 'engineering_manufacturing'},
    {'name': 'Edison International', 'ats_token': 'apply.edisoncareers.com', 'is_quant_target': False, 'sector': 'energy_environment'},
    {'name': 'Entergy', 'ats_token': 'jobs.entergy.com', 'is_quant_target': False, 'sector': 'energy_environment'},
    {'name': 'HF Sinclair', 'ats_token': 'careers.hfsinclair.com', 'is_quant_target': False, 'sector': 'energy_environment'},
    {'name': 'Westinghouse Electric Company', 'ats_token': 'careers.westinghousenuclear.com', 'is_quant_target': False, 'sector': 'energy_environment'},
    {'name': 'Advanced Energy', 'ats_token': 'jobs.advanced-energy.com', 'is_quant_target': False, 'sector': 'engineering_manufacturing'},
    {'name': 'Arkema', 'ats_token': 'jobs.arkema.com', 'is_quant_target': False, 'sector': 'engineering_manufacturing'},
    {'name': 'Commercial Metals Company', 'ats_token': 'jobs.cmc.com', 'is_quant_target': False, 'sector': 'engineering_manufacturing'},
    {'name': 'Epiroc', 'ats_token': 'www.careerprofile.epiroc.com', 'is_quant_target': False, 'sector': 'engineering_manufacturing'},
    {'name': 'Gulfstream Aerospace', 'ats_token': 'careers.gulfstream.com', 'is_quant_target': False, 'sector': 'engineering_manufacturing'},
    {'name': 'Huntington Ingalls Industries', 'ats_token': 'careers.huntingtoningalls.com', 'is_quant_target': False, 'sector': 'engineering_manufacturing'},
    {'name': 'Kodak', 'ats_token': 'careers.kodak.com', 'is_quant_target': False, 'sector': 'engineering_manufacturing'},
    {'name': 'L3Harris Technologies', 'ats_token': 'jobs.l3harris.com', 'is_quant_target': False, 'sector': 'engineering_manufacturing'},
    {'name': 'Mitsubishi Heavy Industries America', 'ats_token': 'mhicareers.com', 'is_quant_target': False, 'sector': 'engineering_manufacturing'},
    {'name': 'Nucor', 'ats_token': 'jobs.nucor.com', 'is_quant_target': False, 'sector': 'engineering_manufacturing'},
    {'name': 'Paccar', 'ats_token': 'jobs.paccar.com', 'is_quant_target': False, 'sector': 'engineering_manufacturing'},
    {'name': 'United Launch Alliance', 'ats_token': 'jobs.ulalaunch.com', 'is_quant_target': False, 'sector': 'engineering_manufacturing'},
    {'name': 'Zurich Insurance', 'ats_token': 'www.careers.zurich.com', 'is_quant_target': False, 'sector': 'insurance_finance'},
    {'name': 'Altice USA', 'ats_token': 'www.optimumcareers.com', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'Hershey', 'ats_token': 'careers.thehersheycompany.com', 'is_quant_target': False, 'sector': 'retail_consumer'},
    {'name': 'W.W. Grainger', 'ats_token': 'jobs.grainger.com', 'is_quant_target': False, 'sector': 'retail_consumer'},
]

# Eightfold tenants, all five checked live on 2026-09-17. Four of them were already in our data one
# job at a time through Google Jobs; Micron came from probing, and it is also on Workday, which is
# fine - the same role from two sources collapses on the dedupe key and keeps both links.
# The token is the tenant, and where the employer's website is not <tenant>.com it is pinned after
# a pipe, because the Eightfold API requires it and answers 422 without it.
EIGHTFOLD: list = [
    {'name': 'John Deere', 'ats_token': 'johndeere', 'is_quant_target': False,
     'sector': 'engineering_manufacturing'},
    {'name': 'Eaton', 'ats_token': 'eaton', 'is_quant_target': False,
     'sector': 'engineering_manufacturing'},
    {'name': 'Micron Technology', 'ats_token': 'micron', 'is_quant_target': False,
     'sector': 'engineering_manufacturing'},
    {'name': 'Boston Scientific', 'ats_token': 'bostonscientific', 'is_quant_target': False,
     'sector': 'health'},
    {'name': 'PayPal', 'ats_token': 'paypal', 'is_quant_target': False,
     'sector': 'insurance_finance'},
]


# iCIMS career sites on the employer's own host (sources/icims_site.py). These are every branded
# host our own listings already carried an "?icims=1" apply link for; all 29 answered /api/jobs
# when they were checked on 2026-09-18. Discovery adds more on its own, but only from a paid
# Google Jobs run, and the boards are free to scan, so they are named here rather than waited for.
ICIMS_SITE: list = [
    {'name': 'AMD', 'ats_token': 'careers.amd.com', 'is_quant_target': False,
     'sector': 'engineering_manufacturing'},
    {'name': 'Johns Hopkins Applied Physics Laboratory', 'ats_token': 'careers.jhuapl.edu',
     'is_quant_target': False, 'sector': 'education_research'},
    {'name': 'Medpace', 'ats_token': 'careers.medpace.com', 'is_quant_target': False, 'sector': 'health'},
    {'name': 'State Farm', 'ats_token': 'jobs.statefarm.com', 'is_quant_target': False,
     'sector': 'insurance_finance'},
    {'name': 'Clyde Companies', 'ats_token': 'careers.clydeinc.com', 'is_quant_target': False,
     'sector': 'engineering_manufacturing'},
    {'name': 'Constellation Energy', 'ats_token': 'jobs.constellationenergy.com', 'is_quant_target': False,
     'sector': 'energy_environment'},
    {'name': 'Kinder Morgan', 'ats_token': 'careers.kindermorgan.com', 'is_quant_target': False,
     'sector': 'energy_environment'},
    {'name': 'Principal Financial Group', 'ats_token': 'careers.principal.com', 'is_quant_target': False,
     'sector': 'insurance_finance'},
    {'name': 'Post Holdings', 'ats_token': 'jobs.postholdings.com', 'is_quant_target': False,
     'sector': 'retail_consumer'},
    {'name': 'Garmin', 'ats_token': 'careers.garmin.com', 'is_quant_target': False,
     'sector': 'engineering_manufacturing'},
    {'name': 'Keysight Technologies', 'ats_token': 'jobs.keysight.com', 'is_quant_target': False,
     'sector': 'engineering_manufacturing'},
    {'name': 'Stryten', 'ats_token': 'jobs.stryten.com', 'is_quant_target': False,
     'sector': 'energy_environment'},
    {'name': 'Ulta Beauty', 'ats_token': 'careers.ulta.com', 'is_quant_target': False,
     'sector': 'retail_consumer'},
    {'name': 'Spirit AeroSystems', 'ats_token': 'careers.spiritaero.com', 'is_quant_target': False,
     'sector': 'engineering_manufacturing'},
    {'name': 'MSA Safety', 'ats_token': 'careers.msasafety.com', 'is_quant_target': False,
     'sector': 'engineering_manufacturing'},
    {'name': 'M.C. Dean', 'ats_token': 'careers.mcdean.com', 'is_quant_target': False,
     'sector': 'engineering_manufacturing'},
    {'name': 'Exelon', 'ats_token': 'careers.comed.com', 'is_quant_target': False,
     'sector': 'energy_environment'},
    {'name': 'AARP', 'ats_token': 'careers.aarp.org', 'is_quant_target': False, 'sector': 'nonprofit'},
    {'name': 'Publicis Groupe', 'ats_token': 'careers.publicisgroupe.com', 'is_quant_target': False,
     'sector': 'media'},
    {'name': 'Arthur J. Gallagher & Co.', 'ats_token': 'jobs.ajg.com', 'is_quant_target': False,
     'sector': 'insurance_finance'},
    {'name': 'V2X', 'ats_token': 'careers.gov2x.com', 'is_quant_target': False,
     'sector': 'government_policy'},
    {'name': 'Sabre Systems', 'ats_token': 'careers.sabresystems.com', 'is_quant_target': False,
     'sector': 'government_policy'},
    {'name': 'BJC HealthCare', 'ats_token': 'jobs.bjc.org', 'is_quant_target': False, 'sector': 'health'},
    {'name': 'CDM Smith', 'ats_token': 'careers.cdmsmith.com', 'is_quant_target': False,
     'sector': 'engineering_manufacturing'},
    {'name': 'Universal Health Services', 'ats_token': 'jobs.uhsinc.com', 'is_quant_target': False,
     'sector': 'health'},
    {'name': 'Planview', 'ats_token': 'careers.planview.com', 'is_quant_target': False,
     'sector': 'engineering_manufacturing'},
    {'name': 'FAST Enterprises', 'ats_token': 'careers.fastenterprises.com', 'is_quant_target': False,
     'sector': 'government_policy'},
    {'name': 'Cvent', 'ats_token': 'careers.cvent.com', 'is_quant_target': False,
     'sector': 'hospitality_sports'},
    {'name': 'Foundation Finance', 'ats_token': 'careers.foundationfinance.com', 'is_quant_target': False,
     'sector': 'insurance_finance'},
]


# JazzHR boards, the small-employer end of the market: one page holds the whole board, so a
# tenant costs a single request however many jobs it has. These are the tenants our own data
# already pointed at, resolved to the employer names JazzHR serves on the board - the subdomain
# is often not the company (neboagency is Nebo, aramcoservices is Aramco Americas).
JAZZHR: list = [
    {'name': 'Nebo', 'ats_token': 'neboagency', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'Aramco Americas', 'ats_token': 'aramcoservices', 'is_quant_target': False,
     'sector': 'energy_environment'},
    {'name': 'Ragle Inc', 'ats_token': 'ragleinc', 'is_quant_target': False,
     'sector': 'engineering_manufacturing'},
    {'name': 'Bee Sweet Citrus', 'ats_token': 'beesweetcitrus', 'is_quant_target': False,
     'sector': 'energy_environment'},
    {'name': 'ROUSH', 'ats_token': 'roush', 'is_quant_target': False, 'sector': 'engineering_manufacturing'},
    {'name': 'Aerotech', 'ats_token': 'aerotech', 'is_quant_target': False,
     'sector': 'engineering_manufacturing'},
    {'name': 'Nova-Tech Engineering', 'ats_token': 'novatechengineering', 'is_quant_target': False,
     'sector': 'engineering_manufacturing'},
    {'name': 'Engenious Design', 'ats_token': 'engeniousdesign', 'is_quant_target': False,
     'sector': 'engineering_manufacturing'},
    {'name': 'Rantec Power Systems', 'ats_token': 'rantecpowersystemsinc', 'is_quant_target': False,
     'sector': 'engineering_manufacturing'},
    {'name': 'Foxconn Industrial Internet', 'ats_token': 'foxconnggroup', 'is_quant_target': False,
     'sector': 'engineering_manufacturing'},
    {'name': 'DEKA Research & Development', 'ats_token': 'deka', 'is_quant_target': False,
     'sector': 'engineering_manufacturing'},
    {'name': 'Advanced Robotics for Manufacturing', 'ats_token': 'arminstitute', 'is_quant_target': False,
     'sector': 'engineering_manufacturing'},
    {'name': 'National Reconnaissance Office', 'ats_token': 'nro', 'is_quant_target': False,
     'sector': 'government_policy'},
    {'name': 'Innovation Works', 'ats_token': 'innovationworks', 'is_quant_target': False,
     'sector': 'nonprofit'},
    {'name': 'Specialisterne', 'ats_token': 'specialisterne', 'is_quant_target': False,
     'sector': 'nonprofit'},
    {'name': 'Spherix Global Insights', 'ats_token': 'spherixglobalinsights', 'is_quant_target': False,
     'sector': 'health'},
    {'name': 'Open Road Integrated Media', 'ats_token': 'openroadmedia', 'is_quant_target': False,
     'sector': 'media'},
    {'name': 'ZGF Architects', 'ats_token': 'zgfarchitects', 'is_quant_target': False},
    {'name': 'Emerging Tech', 'ats_token': 'emergingtech', 'is_quant_target': False},
    {'name': 'Stellar Science', 'ats_token': 'stellarscience', 'is_quant_target': False},
    {'name': 'SimIS', 'ats_token': 'simisinc', 'is_quant_target': False},
    {'name': 'Black Cape', 'ats_token': 'blackcape', 'is_quant_target': False},
    {'name': 'CloudFit Software', 'ats_token': 'cloudfitsoftware', 'is_quant_target': False},
    {'name': 'Geo Owl', 'ats_token': 'geoowl', 'is_quant_target': False},
    {'name': 'IntelliGenesis', 'ats_token': 'intelligenesis', 'is_quant_target': False},
    {'name': 'Innovative Systems', 'ats_token': 'innovativesystems', 'is_quant_target': False},
    {'name': 'Naver U.Hub', 'ats_token': 'naveruhubinc', 'is_quant_target': False},
    {'name': 'Prospect Equities', 'ats_token': 'prospectequities', 'is_quant_target': False},
    {'name': 'Gulf Management', 'ats_token': 'gulfmanagement', 'is_quant_target': False},
]

# --- thin-cluster seeds (probed and fetched live 2026-09-18) ---
GREENHOUSE += [
    {'name': 'ITHAKA', 'ats_token': 'ithaka', 'is_quant_target': False, 'sector': 'education_research'},          # 0 today
    {'name': 'BrainPOP', 'ats_token': 'brainpop', 'is_quant_target': False, 'sector': 'education_research'},       # 0
    {'name': 'IXL Learning', 'ats_token': 'ixllearning', 'is_quant_target': False, 'sector': 'education_research'},# 0
    {'name': 'Teaching Lab', 'ats_token': 'teachinglab', 'is_quant_target': False, 'sector': 'education_research'},# 0
    {'name': 'Achievement First', 'ats_token': 'achievementfirst', 'is_quant_target': False,
     'sector': 'education_research'},                                                                             # 0
    {'name': 'Genius Sports', 'ats_token': 'geniussports', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    {'name': 'OpenTable', 'ats_token': 'opentable', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    # 6 economics-tagged roles on the day it was added: the only board in the data that has them.
    {'name': 'Charles River Associates', 'ats_token': 'charlesriverassociates', 'is_quant_target': False},
    # 12 "Clinical Apprentice - BCBA Fieldwork Program" posts, which is the whole psychology cluster.
    {'name': 'Centria Autism', 'ats_token': 'centriaautism', 'is_quant_target': False,
     'sector': 'behavioral_health'},
    # Three clinical internships in Lexington MA, titled by degree level: the sector is what
    # tags them, and they are the only psychology postings in the baseline states.
    {'name': 'Eliot Community Human Services', 'ats_token': 'eliotcommunityhumanservices',
     'is_quant_target': False, 'sector': 'behavioral_health'},
    {'name': 'Leading Educators', 'ats_token': 'leadingeducators', 'is_quant_target': False,
     'sector': 'education_research'},
]
SMARTRECRUITERS += [
    {'name': 'Uncommon Schools', 'ats_token': 'uncommonschools', 'is_quant_target': False,
     'sector': 'education_research'},
    {'name': 'Hyatt Hotels', 'ats_token': 'hyatthotels', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    {'name': 'Norwegian Cruise Line', 'ats_token': 'norwegiancruiseline', 'is_quant_target': False,
     'sector': 'hospitality_sports'},
    {'name': 'Sodexo', 'ats_token': 'sodexo', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    # 12 personal-trainer internships, the largest single source of sports placements found so far.
    {'name': 'Equinox', 'ats_token': 'equinox', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    {'name': 'Sportradar', 'ats_token': 'sportradar', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    # A Worcester ABA provider: nothing open today, everything it opens is psychology.
    {'name': 'Behavioral Concepts', 'ats_token': 'behavioralconcepts', 'is_quant_target': False,
     'sector': 'behavioral_health'},
]
ASHBY += [
    {'name': 'Instructure', 'ats_token': 'instructure', 'is_quant_target': False, 'sector': 'education_research'},
    # A polling firm first: social_research rather than the media it was first seeded as.
    {'name': 'Morning Consult', 'ats_token': 'morningconsult', 'is_quant_target': False, 'sector': 'social_research'},
    {'name': 'Berlitz', 'ats_token': 'berlitz', 'is_quant_target': False, 'sector': 'education_research'},
]

# --- social-science boards read off employers' own careers pages (2026-09-18) ---
ICIMS = [
    {'name': 'Brookings Institution', 'ats_token': 'careers-brookings', 'is_quant_target': False,
     'sector': 'government_policy'},
    # Analysis Group runs two boards and the internships are split across them.
    {'name': 'Analysis Group', 'ats_token': 'professionalcareers-analysisgroup', 'is_quant_target': False,
     'sector': 'economic_consulting'},
    {'name': 'Analysis Group', 'ats_token': 'datasciencecareers-analysisgroup', 'is_quant_target': False,
     'sector': 'economic_consulting'},
    {'name': 'Advocates', 'ats_token': 'careers-advocatesinc', 'is_quant_target': False, 'sector': 'nonprofit'},
    # Human services across central MA: disability, brain injury and behavioral health. Five
    # postings on the board the day it was added and no student role among them, which is
    # September; the board is registered so the spring practicum postings are there when they
    # appear. behavioral_health is the only sector that reaches the psychology tag, and three
    # boards carried it before these.
    {'name': 'Seven Hills Foundation', 'ats_token': 'careers-sevenhills', 'is_quant_target': False,
     'sector': 'behavioral_health'},
]
RECRUITEE = [
    {'name': 'TransPerfect', 'ats_token': 'transperfect', 'is_quant_target': False},
]
WORKDAY += [
    # The Pew Research Center hires through the Pew Charitable Trusts' tenant.
    # Survey research, so social_research; the Trusts' own board (TrustsExternal) stays policy.
    {'name': 'Pew Research Center', 'ats_token': 'pewtrusts|wd5|CenterExternal', 'is_quant_target': False,
     'sector': 'social_research'},
    # Likewise Compass Lexecon through FTI Consulting's. 10 economics internships on the day it was
    # added, all in Europe; the US ones post later in the season.
    {'name': 'Compass Lexecon', 'ats_token': 'fticonsulting|wd108|CompassLexeconCareers', 'is_quant_target': False,
     'sector': 'economic_consulting'},
    # Two boards on one tenant, both live: the staff board had 18 postings the day it was added
    # and the pre-service board, which is the corps pipeline students actually enter through,
    # had none. An empty board is registered rather than skipped - it answers 200 with a total
    # of 0, which is a season, not a dead board, and only a failing fetch counts against it.
    {'name': 'Teach For America', 'ats_token': 'teachforamerica|wd1|TFA_Careers', 'is_quant_target': False,
     'sector': 'education_research'},
    {'name': 'Teach For America', 'ats_token': 'teachforamerica|wd1|TFA_Pre-Service_Careers',
     'is_quant_target': False, 'sector': 'education_research'},
]

JAZZHR += [
    {'name': "Let's Get Ready", 'ats_token': 'letsgetready', 'is_quant_target': False,
     'sector': 'education_research'},
    # Crisis counselling, which is where a psychology undergraduate actually starts. Eight
    # openings the day it was added, none of them student roles yet.
    {'name': 'Crisis Text Line', 'ats_token': 'CrisisTextLineInc', 'is_quant_target': False,
     'sector': 'behavioral_health'},
]


# --- boards found behind a Greenhouse embed URL (checked live 2026-09-18) ---
# 22 listings in the last export apply through "boards.greenhouse.io/embed/job_app?token=N", which
# names the job and not the board, so discovery reads nothing from it and the employer's other
# postings never arrive. One request each says who they are: the URL answers 301 to
# "job-boards.greenhouse.io/embed/job_app?for=<board>&token=N", and the board is sitting in for=.
#
# Doing that on every run would be 76 requests for 4 boards, so it is not worth a fetcher; doing it
# once is worth these three. (The fourth, "earlytalentcerebras", answers 404 on the board API - it
# exists only as an embed.) The same trick on 54 Workable /j/<id>/apply URLs found 24 boards and
# every one of them was already registered, so that form is left alone.
GREENHOUSE += [
    {'name': 'Dropbox', 'ats_token': 'dropbox', 'is_quant_target': False, 'sector': None},
    {'name': 'Squarepoint Capital', 'ats_token': 'squarepointcapital', 'is_quant_target': True, 'sector': 'quant_finance'},
    {'name': 'StepStone Group', 'ats_token': 'stepstone', 'is_quant_target': False, 'sector': 'insurance_finance'},
]

# --- college boards (each searched live for "intern" on 2026-09-18; the count is what came back) ---
# A student job on a campus is the one internship a first-year can actually get, and Workday is
# where the Northeast schools keep them. 18 of the 74 schools checked have a tenant; these eight
# are the ones with postings today. Every one of them writes its locations the way the campus says
# them - "Amherst Campus", "RIT Main Location", "L - 2 West 13th Street" - so each carries the one
# place it is, which board_item adds when a posting names no state. Without that, 25 of these 34
# postings are dropped for having no US location at all.
#
# Fourteen more tenants answer but had nothing today, and are left out rather than fetched forever
# for nothing: smithcollege|wd5|smithcollege, wesleyan|wd5|careers, risd|wd5|RISD,
# colby|wd5|ColbyCareers, suffolk|wd1|External, vassar|wd1|Vassar-External, endicott|wd1|Endicott,
# pace|wd1|Orion, montclair|wd1|JobOpportunities, amherst|wd5|FSL_Employment_Opportunities (the
# Five Colleges), and four the new Workday probe turned up on 2026-09-18:
# trinity|wd1|Trinity_University, holycross|wd12|Careers, colby|wd5|ColbySummerJobs and
# unioncollege|wd5|UnionCollegeCareers. The last two are second sites on tenants already named
# here, which is the shape to expect: a school splits student jobs, summer jobs and staff jobs
# across sites, and only one of them is ever the student one.
#
# The probe finds these because its bar is a posting matching "intern", and the fetcher's bar is
# classification. All four cleared the first and none cleared the second, so they are boards, but
# not boards worth a request every six hours. Re-check them rather than re-probing them.
#
# williams|wd5|External is Williams Companies of Tulsa, not Williams College. It is already in the
# registry as an energy employer, which is what it is; do not re-seed it as a school.
WORKDAY += [
    {'name': 'Amherst College', 'ats_token': 'amherst|wd5|Amherst_Jobs', 'is_quant_target': False, 'sector': 'education_research', 'location': 'Amherst, MA'},
    {'name': 'Babson College', 'ats_token': 'babson|wd1|Student_Staffing', 'is_quant_target': False, 'sector': 'education_research', 'location': 'Wellesley, MA'},
    {'name': 'Berklee College of Music', 'ats_token': 'berklee|wd1|BerkleeStudentEmployment', 'is_quant_target': False, 'sector': 'education_research', 'location': 'Boston, MA'},
    {'name': 'Emerson College', 'ats_token': 'emerson|wd5|Emerson_College_Staff', 'is_quant_target': False, 'sector': 'education_research', 'location': 'Boston, MA'},
    {'name': 'Rochester Institute of Technology', 'ats_token': 'rit|wd12|careers', 'is_quant_target': False, 'sector': 'education_research', 'location': 'Rochester, NY'},
    {'name': 'Union College', 'ats_token': 'unioncollege|wd5|UnionCollegeStudentCareers', 'is_quant_target': False, 'sector': 'education_research', 'location': 'Schenectady, NY'},
    {'name': 'The New School', 'ats_token': 'newschool|wd1|External', 'is_quant_target': False, 'sector': 'education_research', 'location': 'New York, NY'},
    # Cornell Cooperative Extension is every county in New York and no one campus, so it is seeded
    # without a place: its postings name the county themselves, and a fallback would have to lie.
    {'name': 'Cornell Cooperative Extension', 'ats_token': 'cornell|wd1|CCECareerPage', 'is_quant_target': False, 'sector': 'education_research'},
]

# --- employers whose board was found but cannot be fetched (checked in a browser 2026-09-18) ---
# Their careers pages render in JavaScript, so a plain GET sees nothing; loading them in a real
# browser and reading where the apply links go gives the board for each. None is seedable:
#
#   Vinfen                       careers-vinfen.icims.com        iCIMS, but the tenant answers
#                                                                'Log in to Vinfen Corporation'
#                                                                to an anonymous job search.
#   The Home for Little Wanderers  recruiting.ultipro.com/HOM1009HOMLW   UKG/UltiPro - no fetcher
#   Riverside Community Care     jobs.silkroad.com/RiversideCC   SilkRoad - no fetcher
#   Westat                       sjobs.brassring.com             Kenexa BrassRing - no fetcher
#   NORC                         careers.norc.org                own host, no ATS marker in the page
#   Bay Cove Human Services      -                               every careers URL 404s
#
# UKG looked like the one worth building - it is in the plan's fetcher table, and it is what
# these nonprofits keep turning out to be on - but recruiting.ultipro.com/robots.txt closes it:
#
#     Disallow: /
#     Allow: */JobBoard/
#     Disallow: */JobBoardView
#
# The board pages are opened on purpose and the JSON behind them is shut on purpose, and
# LoadSearchResults lives under JobBoardView. The endpoint answers - 102 postings with clean
# addresses and posted dates for the tenant above - which is exactly why the rule has to be the
# thing that decides. UKG joins REU on the list of sources we are not allowed to read.
#
# Of the other two systems seen here, SilkRoad allows its job pages (Crawl-Delay: 10, so a board
# is a minute of waiting) and BrassRing serves no robots.txt at all. Neither appears anywhere in
# the apply_url hosts we already index, so a fetcher for either would be built for one employer.

# --- human services and social research, checked live 2026-09-18 ---
# Looking for the employers behind the one cluster the coverage report calls thin. Reachable and
# seeded above: Seven Hills (iCIMS), Teach For America (Workday), Child Trends (ADP), Crisis Text
# Line (JazzHR), Education Development Center (SmartRecruiters). Not reachable:
#
#   Center for Human Development    recruiting.ultipro.com          UKG, closed by robots.txt
#   Gandara Center                  recruiting.ultipro.com          UKG, closed by robots.txt
#   Behavioral Health Network       bhnteam.rec.pro.ukg.net         UKG, closed by robots.txt
#   Baker Center for Children       secure7.saashr.com              UKG Ready
#   MDRC                            secure6.saashr.com              UKG Ready
#   Clinical & Support Options      csoemployment.e3applicants.com  E3, one employer
#   ServiceNet, JRI, Wayside, May Institute, Elwyn, Devereux, City Year, Boys & Girls Clubs of
#   Boston, RAND, Trevor Project    no ATS reachable from the careers page
#
# UKG Ready (saashr.com) is a different host from the UKG board already ruled out and may well
# allow what its parent forbids, but it turned up for two employers here and appears in no
# apply_url we index, so a fetcher for it would be built for those two - the same reason SilkRoad
# and BrassRing were left alone above. The Pioneer Valley agencies nearest UMass are the loss
# that matters: CHD, Gandara and BHN are all on UKG, and they are exactly who a psychology
# undergraduate in Amherst would apply to.

# --- social research and economic consulting (probed and fetched live 2026-09-18) ---
# Social sciences was the one thin cluster: 10 open listings in the baseline states. Most of the
# employers that hire for it were already registered but carried no sector, or one that counted
# them elsewhere, so their "Research Assistant" and "Summer Analyst" postings reached no social-
# science tag. These label them social_research or economic_consulting and add the boards found by
# the name probe or on the employer's own careers page. Several had no student posting on the day
# (SSRC, IDinsight, CFR, Vera, Kantar, Hanover, Material, Catalist); they hire interns by season.
#
# Not reachable: Brattle, Cornerstone Research, Keystone, Heritage, Cato, CAP, Atlantic Council,
# Bipartisan Policy Center, CBPP, EPI, Niskanen, IPA, Westat and the Chicago Council answer a plain
# GET of their careers page with 403, and are left alone. NERA posts through Marsh McLennan's own
# site; Mathematica through its own host. EDF's Workday site answers 422 to the jobs API under
# both tenant names, and the "Confidential" site discovery registered for it is closed by its
# robots.txt, so it will age out.
#
# A sector counts every posting on the board towards its cluster, so it is given only where the
# internships are the discipline. Gallup is a pollster, but its eleven open internships were
# software, data and ML; BRG's economics internships are in Europe and its US ones are corporate
# finance. Both stay unlabelled - labelled, they would have filled Social sciences with jobs a
# sociology or economics major would not apply for.
GREENHOUSE += [
    {'name': 'Social Science Research Council', 'ats_token': 'socialscienceresearchcouncil',
     'is_quant_target': False, 'sector': 'social_research'},
    {'name': 'American Institutes for Research', 'ats_token': 'americaninstitutesforresearch',
     'is_quant_target': False, 'sector': 'social_research'},
    {'name': 'Vera Institute of Justice', 'ats_token': 'verainstituteofjustice', 'is_quant_target': False,
     'sector': 'social_research'},
    {'name': 'Charles River Associates', 'ats_token': 'charlesriverassociates', 'is_quant_target': False,
     'sector': 'economic_consulting'},
    # The careers page embeds this board; one fellowship open on the day.
    {'name': 'Manhattan Institute', 'ats_token': 'manhattaninstituteforpolicyresearchinc',
     'is_quant_target': False, 'sector': 'government_policy'},
]
ICIMS += [
    # The third Analysis Group board, found by discovery.
    {'name': 'Analysis Group', 'ats_token': 'analystcareers-analysisgroup', 'is_quant_target': False,
     'sector': 'economic_consulting'},
    {'name': 'Council on Foreign Relations', 'ats_token': 'careers-cfr', 'is_quant_target': False,
     'sector': 'government_policy'},
]
JAZZHR += [
    # One paid communications internship open on the day.
    {'name': 'New America', 'ats_token': 'newamerica', 'is_quant_target': False, 'sector': 'government_policy'},
    {'name': 'Brennan Center for Justice', 'ats_token': 'brennancenter', 'is_quant_target': False,
     'sector': 'government_policy'},
]
LEVER += [
    {'name': 'Catalist', 'ats_token': 'catalist', 'is_quant_target': False, 'sector': 'social_research'},
]
WORKDAY += [
    {'name': 'Kantar', 'ats_token': 'kantar|wd3|KANTAR', 'is_quant_target': False, 'sector': 'social_research'},
    {'name': 'Hanover Research', 'ats_token': 'hanoverresearch|wd5|HanoverResearch', 'is_quant_target': False,
     'sector': 'social_research'},
    {'name': 'Material', 'ats_token': 'material|wd1|Material_External_Career_Site', 'is_quant_target': False,
     'sector': 'social_research'},
]
BAMBOOHR: list = [
    {'name': 'IDinsight', 'ats_token': 'idinsight', 'is_quant_target': False, 'sector': 'social_research'},
]

# --- hospitality, sports and events (probed and fetched live 2026-09-18) ---
# Hospitality & sports had 25 open listings in the baseline states. The plan's named employers
# were checked one by one; most are out of reach and are listed here so nobody re-checks them:
#   - 403 to our user agent: Aramark, Delaware North, the Celtics, Kraft Group/Patriots, Foxwoods,
#     Wasserman. No board found by probe: Compass Group, Levy, Wynn, Planet Fitness, ESPN (posts
#     through Disney, already seeded), the NBA/NFL/NHL league offices.
#   - UKG (IHG) and SmartRecruiters (Accor, Westgate) are on the skipped list.
#   - Six Flags/Cedar Fair's iCIMS tenants redirect to a Radancy site we have no fetcher for.
#   - TeamWork Online, where most teams post: robots.txt allows it but its terms forbid robots
#     and "systematic extraction of data", so it is skipped like Handshake.
# Entries marked 'rename' were already in the registry under a wrong name (see
# discover.rename_board). A rename changes those listings' ids (normalize.listing_id hashes the
# employer name), so it is kept to names that were actually wrong. Boards with no student posting today are kept because they hire
# interns seasonally; the fetch is one request each.
GREENHOUSE += [
    {'name': 'Four Seasons', 'ats_token': 'fourseasons', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    {'name': 'Octagon', 'ats_token': 'octagon', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    {'name': 'Excel Sports Management', 'ats_token': 'excelsportsmanagement', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    {'name': 'World Surf League', 'ats_token': 'worldsurfleague', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    {'name': 'Baltimore Orioles', 'ats_token': 'baltimoreorioles', 'is_quant_target': False, 'sector': 'hospitality_sports',
     'rename': True},
    {'name': 'Philadelphia Phillies', 'ats_token': 'philliesbaseballoperations', 'is_quant_target': False,
     'sector': 'hospitality_sports', 'rename': True},
]
LEVER += [
    {'name': 'Boston Red Sox', 'ats_token': 'redsox', 'is_quant_target': False, 'sector': 'hospitality_sports', 'rename': True},
    {'name': 'San Francisco Giants', 'ats_token': 'sfgiants', 'is_quant_target': False, 'sector': 'hospitality_sports'},
]
ICIMS += [
    {'name': 'United States Tennis Association', 'ats_token': 'careers-usopen', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    # 54 hotel internships across the US (finance, sales, operations) on the "hourly" board.
    {'name': 'Highgate', 'ats_token': 'externalhourly-highgate', 'is_quant_target': False, 'sector': 'hospitality_sports'},
]
WORKDAY += [
    # Personal-training internships at clubs nationwide: the kinesiology listings.
    {'name': 'Life Time', 'ats_token': 'lifetime|wd1|lifetime', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    {'name': 'Loews Hotels', 'ats_token': 'loewshotels|wd5|loewshotels', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    # Mohegan Sun, Uncasville CT: a baseline-state resort.
    {'name': 'Mohegan', 'ats_token': 'mohegan|wd1|Mohegan', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    {'name': 'Seminole Hard Rock', 'ats_token': 'seminolehardrock|wd503|seminolehardrockcareers',
     'is_quant_target': False, 'sector': 'hospitality_sports'},
    # Legends and ASM Global merged; legendsglobal.com/careers links to this board.
    # Not renamed to "Legends": the id of every listing is built from the employer name, so a
    # rename resets students' saved marks on it, and "ASM Global" is not wrong.
    {'name': 'ASM Global', 'ats_token': 'asmglobal|wd1|careers', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    {'name': 'IMG', 'ats_token': 'wwecorp|wd5|IMG', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    {'name': 'PGA TOUR', 'ats_token': 'pgatour|wd5|PGATOURExternal', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    {'name': 'Live Nation Entertainment', 'ats_token': 'livenation|wd503|LNExternalSite', 'is_quant_target': False,
     'sector': 'hospitality_sports'},
    {'name': 'Maple Leaf Sports & Entertainment Partnership (MLSE)', 'ats_token': 'mlse|wd3|MLSE',
     'is_quant_target': False, 'sector': 'hospitality_sports'},
    {'name': 'Texas Rangers', 'ats_token': 'rangersmlb|wd5|Rangers', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    {'name': 'TKO Group Holdings, Inc', 'ats_token': 'wwecorp|wd5|tko', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    {'name': 'WWE', 'ats_token': 'wwecorp|wd5|wwecorp', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    {'name': 'Choice Hotels', 'ats_token': 'choicehotels|wd5|External', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    {'name': 'Marriott Vacations Worldwide', 'ats_token': 'mymvw|wd5|mvw', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    {'name': 'Acushnet Holdings', 'ats_token': 'acushnetgolf|wd12|ACU', 'is_quant_target': False, 'sector': 'hospitality_sports'},
]
SUCCESSFACTORS += [
    # The Rookie Program, UA's yearly intern class; the 2027 postings were not up yet.
    {'name': 'Under Armour', 'ats_token': 'careers.underarmour.com', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    {'name': 'Wyndham Hotels & Resorts', 'ats_token': 'careers.wyndhamhotels.com', 'is_quant_target': False, 'sector': 'hospitality_sports'},
    {'name': 'Royal Caribbean Group', 'ats_token': 'jobs.royalcaribbeangroup.com', 'is_quant_target': False, 'sector': 'hospitality_sports'},
]

# --- nonprofits, foundations, publishers and arts (probed and fetched live 2026-09-18) ---
# Nonprofit & social work had 35 open listings in the baseline states. sector_gaps.json had
# marked Boys & Girls Clubs, NRDC, the Council on Foreign Relations, HarperCollins, NYU Langone
# and Dartmouth Health "unsupported iCIMS"; the iCIMS fetcher has since been built, so they are
# seeded here. Checked and left out: World Wildlife Fund (its iCIMS board 404s), Yale New Haven
# (robots.txt closes its iCIMS host), Partners In Health (403), a "goodwill" JazzHR board that
# could not be tied to any particular Goodwill, and greenhouse "fox", which is a veterinary group,
# not Fox Corporation. Most of these had no student posting on the day; they hire interns
# seasonally and each fetch is one request.
GREENHOUSE += [
    {'name': 'GiveDirectly', 'ats_token': 'givedirectly', 'is_quant_target': False, 'sector': 'nonprofit'},
    {'name': 'Code for America', 'ats_token': 'codeforamerica', 'is_quant_target': False, 'sector': 'nonprofit'},
    {'name': 'DonorsChoose', 'ats_token': 'donorschoose', 'is_quant_target': False, 'sector': 'nonprofit'},
    {'name': 'Mozilla Foundation', 'ats_token': 'mozillafoundation', 'is_quant_target': False, 'sector': 'nonprofit'},
    {'name': 'Acumen', 'ats_token': 'acumen', 'is_quant_target': False, 'sector': 'nonprofit'},
    {'name': 'One Acre Fund', 'ats_token': 'oneacrefund', 'is_quant_target': False, 'sector': 'nonprofit'},
    {'name': 'A24', 'ats_token': 'a24', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'Ogilvy', 'ats_token': 'ogilvy', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'R/GA', 'ats_token': 'rga', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'IDEO', 'ats_token': 'ideo', 'is_quant_target': False, 'sector': 'arts_museums'},
]
LEVER += [
    {'name': 'Ashoka', 'ats_token': 'ashoka', 'is_quant_target': False, 'sector': 'nonprofit'},
    {'name': 'charity: water', 'ats_token': 'charitywater', 'is_quant_target': False, 'sector': 'nonprofit'},
]
JAZZHR += [
    {'name': 'IREX', 'ats_token': 'irex', 'is_quant_target': False, 'sector': 'nonprofit'},
    {'name': 'CalMatters', 'ats_token': 'calmatters', 'is_quant_target': False, 'sector': 'media'},
]
ASHBY += [
    {'name': 'Artsy', 'ats_token': 'artsy', 'is_quant_target': False, 'sector': 'arts_museums'},
]
ICIMS += [
    {'name': 'Boys & Girls Clubs of America', 'ats_token': 'careers-bgca', 'is_quant_target': False, 'sector': 'nonprofit'},
    {'name': 'NRDC', 'ats_token': 'careers-nrdc', 'is_quant_target': False, 'sector': 'nonprofit'},
    {'name': 'Council on Foreign Relations', 'ats_token': 'careers-cfr', 'is_quant_target': False, 'sector': 'government_policy'},
    {'name': 'HarperCollins', 'ats_token': 'careers-harpercollins', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'NYU Langone Health', 'ats_token': 'careers-nyu', 'is_quant_target': False, 'sector': 'health'},
    {'name': 'Dartmouth Health', 'ats_token': 'careers-dartmouth-hitchcock', 'is_quant_target': False, 'sector': 'health'},
]
WORKDAY += [
    {'name': 'World Vision', 'ats_token': 'worldvision|wd1|WorldVisionInternational', 'is_quant_target': False, 'sector': 'nonprofit'},
    {'name': 'Teach For America', 'ats_token': 'teachforamerica|wd1|TFA_Careers', 'is_quant_target': False, 'sector': 'nonprofit'},
    {'name': 'City Year', 'ats_token': 'cityyear|wd5|CityYear', 'is_quant_target': False, 'sector': 'nonprofit'},
    {'name': 'ALSAC St. Jude', 'ats_token': 'alsacstjude|wd1|careersalsacstjude', 'is_quant_target': False, 'sector': 'nonprofit'},
    {'name': 'Gates Foundation', 'ats_token': 'gatesfoundation|wd1|Gates', 'is_quant_target': False, 'sector': 'nonprofit'},
    {'name': 'Ford Foundation', 'ats_token': 'fordfoundation|wd1|FordFoundationCareerPage', 'is_quant_target': False, 'sector': 'nonprofit'},
    {'name': 'PATH', 'ats_token': 'path|wd1|External', 'is_quant_target': False, 'sector': 'nonprofit'},
    {'name': 'Scholastic', 'ats_token': 'scholastic|wd5|External', 'is_quant_target': False, 'sector': 'media'},
    {'name': 'Wiley', 'ats_token': 'wiley|wd1|wiley_careers', 'is_quant_target': False, 'sector': 'media'},
    {'name': "Christie's", 'ats_token': 'christies|wd3|Christies_Careers', 'is_quant_target': False, 'sector': 'arts_museums'},
]

# --- end sector seeds ---
