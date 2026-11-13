"""Write synthetic before/opt-in pages locally; never refresh goldens or contact a provider."""

from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parents[4]
sys.path[:0] = [str(ROOT / 'backend'), str(ROOT / 'backend/tests')]
from test_employer_posting_links import fixture_rows, stage, run
from tests.seo_fixture_data import _site
from internscout.site import runtime
from internscout.site.employer_posting_links import PostingLinks

out = Path(sys.argv[1]).resolve()
if out.exists():
    raise SystemExit('Choose an absent output directory')
rows = fixture_rows()
links = PostingLinks.from_stage(stage(rows))
for phase, optional in [('before', None), ('after', links)]:
    site = out / phase
    shutil.copytree(ROOT / 'docs', site, ignore=shutil.ignore_patterns('data'))
    _site(site, {'MA': rows}, majors=[{'name': 'Engineering', 'tags': ['mechanical']}])
    pages = run(optional, runtime.build, str(site), frozenset(), frozenset(), frozenset())
    for page in pages:
        if page['path'] in ['/internships/mechanical-engineering/', '/internships/highest-paying/']:
            target = site / page['path'].lstrip('/') / 'index.html'
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(page['html'], encoding='utf-8')
print('Prepared synthetic before and optional annotation pages')
