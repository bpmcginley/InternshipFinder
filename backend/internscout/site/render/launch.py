"""Plain listing pages for the fixed P-4.1 pilot, using existing layout helpers."""

from html import escape as esc

from ..launch import Page


def render(
    model: Page,
    context,
    *,
    field_title,
    field_slug,
    state_slug,
    metro_state,
    place_names,
    dash_link,
    listing_rows,
    autoapply_card,
    per_page,
    existing_paths,
):
    if model.field:
        name = field_title(model.field)
        h1 = f"Summer 2027 {name.lower()} internships"
        parent = (f"/internships/{field_slug(model.field)}/", name)
        explanation = "These roles are tagged Summer 2027 in the current export. Check each posting for its dates and requirements."
        dashboard = dash_link(fields=[model.field])
        dashboard_label = f"Browse {name.lower()} roles"
        dashboard_note = "The dashboard includes other terms."
    else:
        standing = "senior" if model.year == "senior" else "sophomore"
        h1 = f"Internships for {standing}s in {model.city}"
        parent = (f"/internships/{state_slug(model.city)}/", model.city)
        explanation = f"These postings mention {standing} standing in the title or extracted requirements. Roles that only say undergraduate are not included. Check each posting for its full requirements."
        dashboard = dash_link(state=model.city, year=model.year)
        dashboard_label = f"Browse roles across {place_names[metro_state[model.city]]}"
        dashboard_note = "The dashboard covers the wider state and also includes roles without stated class-year requirements."
    count = len(model.items)
    shown = min(count, per_page)
    if parent[0] not in existing_paths:
        parent = context.root
    body = (
        f'<p class="lede">{count:,} open student roles in this list.</p>'
        f'<p class="more">{esc(explanation)}</p>'
        f'<a class="cta" href="{dashboard}">{esc(dashboard_label)}</a>'
        f'<p class="more">{esc(dashboard_note)}</p>'
        + autoapply_card(model.items, "seo-hub", model.city)
        + f'<ul class="jobs">{listing_rows(model.items, context.now, model.city, src="seo-hub")}</ul>'
        + (f'<p class="more">Showing {shown} of {count:,} roles.</p>' if shown < count else "")
        + '<p class="follow"><a href="feed.xml">RSS feed</a></p>'
        + f'<p class="more"><a href="{esc(parent[0])}">More roles: {esc(parent[1])}</a></p>'
    )
    return dict(
        path=model.path,
        title=h1,
        desc=f"{count:,} open student roles. {explanation}",
        h1=h1,
        crumbs=[context.root] + ([parent] if parent != context.root else []) + [(model.path, h1)],
        body=body,
        items=model.items,
        state=model.city,
        thin=not model.indexed,
    )
