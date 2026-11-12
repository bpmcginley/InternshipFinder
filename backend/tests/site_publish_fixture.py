"""Publish fixture pages with the same near-page setting as legacy test builds."""

from internscout.site import publish, runtime


def write_site(site_dir: str) -> tuple[list[dict], runtime.BuildState]:
    state = runtime.BuildState(near_on=False)
    hooks = runtime.BuildHooks()
    pages = runtime.invoke(state, hooks, runtime.build_result, site_dir).pages
    publish._write_site(site_dir, pages, state, hooks)
    return pages, state
