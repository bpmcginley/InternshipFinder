// Share public dashboard filters through an emitted landing page or a dashboard URL.
(function () {
  "use strict";

  const landingPath = /^\/internships\/(?:[a-z0-9-]+\/)+$/;
  const remoteKeys = new Set(["remote", "US"]);

  function landingViews(element) {
    if (!element) return {};
    try {
      const views = JSON.parse(element.textContent);
      return views && typeof views === "object" && !Array.isArray(views) ? views : {};
    } catch {
      return {};
    }
  }

  function searchLink(filters, scope, available, views, origin, filterParams) {
    if (filters.eligible || filters.app_state) return null;
    const { allLoaded, first, indexKeys } = available;
    let states = scope.keys;
    if (scope.all) {
      if (!allLoaded) states = first;
      else if (scope.noRemote) states = indexKeys.filter((key) => !remoteKeys.has(key));
      else states = ["all"];
    }
    if (!states.length) return null;

    const field = filters.fields.length <= 1 ? filters.fields[0] || "" : null;
    if (
      states.length === 1 &&
      field !== null &&
      !filters.q.trim() &&
      !filters.company.length &&
      !filters.new_only &&
      !filters.stage &&
      !filters.year &&
      !filters.sector &&
      !filters.where &&
      !filters.paid &&
      !filters.hide_citizen &&
      filters.status === "open"
    ) {
      const path = views[field + "/" + states[0]];
      if (typeof path === "string" && landingPath.test(path)) return new URL(path, origin).href;
    }

    const share = { ...filters, states, sort: filters.sort === "score" ? "new" : filters.sort };
    const params = new URLSearchParams(filterParams(share, { sort: "new" }));
    // Make the shared filters independent of the recipient's profile defaults.
    if (!params.has("paid")) params.set("paid", "any");
    if (!params.has("citizen")) params.set("citizen", "show");
    const url = new URL("/", origin);
    url.search = params.toString();
    return url.href;
  }

  window.ISShare = { landingViews, searchLink };
})();
