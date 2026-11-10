# 500 "<field> internships near <city>" pages (built 2026-10-18)

What was built for the request recorded in CONTEXT.md ("500 pages: prepared, NOT implemented").

## Pages
- `/internships/near/<city>/<field>/`: the ten NCES field groups in `top_degree_fields.json` times the
  50 metro anchor cities in `us_top50_metros.json`. Exactly 500 URLs, built on every Pages deploy by
  `seo_pages.build` (never committed), whatever is open, so no URL ever breaks. City slugs are the anchor
  city (`denver`, `st-louis`, `washington-dc`); field slugs are the JSON slugs. No existing path changed.
- `/internships/near/`: one hub linking all 500, by city, with each page's local count. Linked from
  `/internships/` ("More ways to browse").
- Each page: the local count and opening paragraph computed from its own listings (stages, pay share, start
  terms, top employers, towns), the rows (newest first, the local location named first), a sentence saying
  how the metro and field are counted, a dashboard link (field tags, metro states), a separate labelled
  "Remote <field> roles" section (a count, plus up to 10 rows on pages not indexed), RSS feed when there are
  local roles, and links to the city's other nine fields and the field's other 49 cities.

## Field mapping (`near_metros.FIELD_TAGS`, also in the JSON)
Business: business, finance, accounting, consulting, marketing, sales, hr, operations, supply_chain,
entrepreneurship, pm, real_estate, insurance, retail, hospitality (not quant). Health: health, nursing,
public_health, clinical_research. Social Sciences and History: social_science, economics, government,
museums (no history tag; thin). Biology: biology, biomedical (biomedical is also Engineering). Psychology:
psychology. Engineering: engineering and every discipline tag, environmental and biomedical included.
Computer and Information Sciences: swe, data, ml, security. Visual and Performing Arts: arts, design,
theater, music, film (thin). Education: education only (thin). Communication and Journalism:
communications, journalism, media, publishing.

## Location matching (`backend/internscout/near_metros.py`)
The export has no coordinates outside the Northeast, so a radius is not possible for most metros. Each
metro is a list of towns per state: principal cities plus the cities and towns of the MSA's counties. A
region counts only when its own state code is one of the metro's states and its location names one of
that state's towns (whole token, or the end of one not after a prefix such as "fort", "north", "new").
New York uses region.py's `nyc_metro` kind (50 miles of Midtown) plus the boroughs; Washington counts any
location in the District. Never local: state-only or country-only locations, anything remote or work from
home ("Remote, TX" too), Canada. Laurel, MD is the one town counted for two metros (Washington and
Baltimore). Missing towns undercount; they never overcount.

## Search quality guard
`NEAR_INDEX_MIN = 5` local roles, from at least `MIN_EMPLOYERS_NEW` (3) employers, and not `near_same` as a
list page the site already indexes. Below that a page is `noindex, follow`, out of `sitemap.xml`, listed in
`noindex-pages.txt`, but still built and linked. A page in the live sitemap keeps its place down to 4
(`NEAR_INDEX_SLACK`); a page with Search Console traffic is never made noindex.

## Result on the committed data (export of 2026-10-18)
228 of 500 indexable, 272 noindex (92 with no local roles, 171 with 1 to 4, 9 with 5 or more that repeat an
existing page or have too few employers). Indexable by field: Business 49, Engineering 48, Computer and
Information Sciences 46, Social Sciences and History 37, Communication and Journalism 19, Visual and
Performing Arts 13, Biology 9, Health 4, Education 3, Psychology 0.

Tests: `backend/tests/test_near_pages.py`.
