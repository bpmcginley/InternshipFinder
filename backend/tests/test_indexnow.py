"""growth/indexnow.py: which URLs a deploy tells the search engines about."""
import importlib.util
import os

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
_spec = importlib.util.spec_from_file_location("indexnow", os.path.join(ROOT, "growth", "indexnow.py"))
indexnow = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(indexnow)


def _sitemap(tmp_path, name, urls):
    body = "".join(f"<url><loc>{u}</loc><lastmod>{d}</lastmod></url>" for u, d in urls.items())
    p = tmp_path / name
    p.write_text('<?xml version="1.0" encoding="UTF-8"?>'
                 f'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{body}</urlset>', encoding="utf-8")
    return str(p)


def test_new_removed_and_updated_pages_are_sent(tmp_path):
    s = "https://internscout.org/internships/"
    old = _sitemap(tmp_path, "old.xml", {s + "a/": "2026-09-20", s + "b/": "2026-09-20", s + "c/": "2026-09-20"})
    new = _sitemap(tmp_path, "new.xml", {s + "a/": "2026-09-20", s + "b/": "2026-09-23", s + "d/": "2026-09-23"})
    assert indexnow.changed(indexnow.entries(old), indexnow.entries(new)) == [s + "b/", s + "c/", s + "d/"]


def test_first_deploy_sends_everything_and_other_hosts_never(tmp_path):
    new = _sitemap(tmp_path, "new.xml", {"https://internscout.org/": "2026-09-23",
                                         "https://example.com/x": "2026-09-23"})
    assert indexnow.entries(str(tmp_path / "missing.xml")) == {}
    assert indexnow.changed({}, indexnow.entries(new)) == ["https://internscout.org/"]


def test_the_key_file_is_published_with_the_key():
    with open(os.path.join(ROOT, "docs", f"{indexnow.KEY}.txt"), encoding="utf-8") as f:
        assert f.read().strip() == indexnow.KEY
