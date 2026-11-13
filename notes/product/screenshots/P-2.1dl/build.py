"""Build only synthetic private before/after artifacts for the browser capture."""

import json
from pathlib import Path
import shutil
import sys

from golden_build import frozen_runtime

frozen_runtime()
from test_follow_employer_selection import captured
from test_follow_site_publication import fixture
from internscout.site import follow_site_publication, publish

root = Path(sys.argv[1]).resolve()
root.mkdir()  # absent output required
site, inputs = fixture.__wrapped__(captured.__wrapped__(root))
repo = Path(__file__).resolve().parents[4]
shutil.copytree(repo / "docs/fonts", site / "fonts")
shutil.copyfile(repo / "docs/icon128.png", site / "icon128.png")
shutil.copytree(site, root / "before")
publish.main(["publish", str(root / "before")])
plan = follow_site_publication.publish_follow_site(
    site, root / "after", enabled=True, inputs=inputs
)
(root / "receipt.json").write_text(
    json.dumps(
        {
            "app": plan.app_sha256,
            "wrapper": plan.script_url,
            "models": len(plan.models),
            "source": inputs.stage_options["source_sha256"],
            "first": inputs.stage_options["first_sha256"],
        },
        indent=2,
    )
)
