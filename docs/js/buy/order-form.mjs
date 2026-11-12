// The native order form shares rules and transport with the classic entry.
export function mountOrder(root, { rules, contact: CONTACT, call, dataJson, request }) {
  var doc = root.document;
  var setTimeout = root.setTimeout.bind(root), clearTimeout = root.clearTimeout.bind(root);
  var URLSearchParams = root.URLSearchParams;
  var { configOk, money, priceCents, startRange, fmtDate, prepareIndex, companyPrefill,
    searchEmployers, norm, rolesFor, canPick, locText, roleFields, fieldLabel, httpUrl,
    UNPAID_NOTE, priceLine, packageFor, pickMessage, buttonText, validIso, runText,
    inRange, readAvailability, availText, EMAIL, orderBody, serverMessage, errorTarget } = rules;

  // 2026-10-23: count only fixed anonymous intent names; ISCount retains opt-out and bot suppression.
  // No form value, query, employer key or order ID is sent. Revert: remove these calls and countStep.
  function countStep(event) {
    try {
      if (typeof root.ISCount === "function") root.ISCount(event);
      else (root.ISCountQ = root.ISCountQ || []).push(event);
    } catch (e) {} // Counting is optional and can never prevent an order or company choice.
  }
  var $ = function (id) { return doc.getElementById(id); };
  // An element with text children only: data is only ever set as text, never parsed as markup.
  function el(tag, props) {
    var n = doc.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k.indexOf("aria-") === 0 || k.indexOf("data-") === 0 || k === "role") n.setAttribute(k, props[k]);
      else n[k] = props[k];
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      n.appendChild(typeof c === "string" ? doc.createTextNode(c) : c);
    }
    return n;
  }
  function show(id, on) { var n = $(id); if (n) n.hidden = !on; }

  // ----- the order form -----
  var S = { cfg: null, index: null, emp: null, roles: [], picked: [], pub: false, avail: null, rseq: 0, aseq: 0, timer: 0, shards: {}, prefill: "", matches: [], active: -1 };
  var form = $("order"), q = $("co-q"), list = $("co-list"), coMsg = $("co-msg"), roleList = $("role-list"), pickMsg = $("pick-msg");
  var pub = $("pub"), startIn = $("start"), availBox = $("avail"), send = $("send"), status = $("status");

  request.then(function (res) {
    if (!res.ok) return unavailable();
    if (!configOk(res.out)) return closed();
    S.cfg = res.out;
    open();
  }).catch(unavailable);

  function closed() { show("boot", false); show("closed", true); }
  function unavailable() { show("boot", false); show("load-error", true); }

  function open() {
    var cfg = S.cfg;
    show("boot", false);
    form.hidden = false;
    countStep("employer_buy_open");
    if (Number.isInteger(cfg.field_cap) && cfg.field_cap > 0) $("cap").textContent = String(cfg.field_cap);
    Array.prototype.forEach.call(doc.querySelectorAll(".days"), function (n) { n.textContent = String(cfg.days); });
    $("pub-hint").textContent = "Then: " + money(priceCents(cfg, "one", true)) + " for one role, " + money(priceCents(cfg, "three", true)) + " for three.";
    var range = startRange(cfg);
    startIn.min = range.min; startIn.max = range.max; startIn.value = range.min;
    $("start-hint").textContent = "From today up to " + fmtDate(range.max) + ".";
    updatePrices();
    updateRun();
    dataJson("/data/roles/index.json").then(function (d) {
      S.index = prepareIndex(d);
      q.disabled = false;
      var prefill = companyPrefill(S.index, root.location.search);
      // Prefill shows existing roles only. It never picks a role, sends an order or opens checkout.
      if (prefill) choose(prefill, true);
      else if (q.value.trim()) search();
    }).catch(function () {
      coMsg.textContent = "";
      coMsg.appendChild(el("span", {}, "We couldn't load the list of employers. Reload the page to try again, or email "));
      coMsg.appendChild(el("a", { href: "mailto:" + CONTACT }, CONTACT));
      coMsg.appendChild(doc.createTextNode("."));
    });
  }

  // Company search: an ARIA combobox with a list box (arrow keys, Enter, Escape).
  function search() {
    if (!S.index) return;
    S.matches = searchEmployers(S.index, q.value, 8);
    S.active = -1;
    drawList();
    coMsg.textContent = "";
    if (S.matches.length) coMsg.textContent = S.matches.length === 1 ? "1 match. Use the arrow keys or tap it to choose." : S.matches.length + " matches. Use the arrow keys or tap one to choose.";
    else if (norm(q.value).length >= 2) {
      coMsg.appendChild(el("span", {}, "No employer by that name has open roles on InternScout right now. We can only sell a paid listing for a role we already list. To ask us to add your job board, which is free, use the form on "));
      coMsg.appendChild(el("a", { href: "/employers/#interest" }, "the employers page"));
      coMsg.appendChild(doc.createTextNode("."));
    }
  }
  function drawList() {
    list.textContent = "";
    S.matches.forEach(function (e, i) {
      var li = el("li", { id: "co-opt-" + i, role: "option", "aria-selected": String(i === S.active), className: i === S.active ? "on" : "" },
        el("span", { className: "co-n" }, e.n), e.c ? el("span", { className: "co-c" }, e.c === 1 ? "1 open role" : e.c + " open roles") : null);
      li.addEventListener("mousedown", function (ev) { ev.preventDefault(); });
      li.addEventListener("click", function () { choose(e); });
      list.appendChild(li);
    });
    var openList = S.matches.length > 0;
    list.hidden = !openList;
    q.setAttribute("aria-expanded", String(openList));
    if (S.active >= 0) q.setAttribute("aria-activedescendant", "co-opt-" + S.active); else q.removeAttribute("aria-activedescendant");
  }
  function closeList() { S.matches = []; S.active = -1; drawList(); }
  q.addEventListener("input", function () { mark("co-q", ""); search(); });
  q.addEventListener("keydown", function (ev) {
    var n = S.matches.length;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (!n) { search(); n = S.matches.length; if (!n) return; }
      S.active = ev.key === "ArrowDown" ? (S.active + 1) % n : (S.active <= 0 ? n - 1 : S.active - 1);
      drawList();
      var on = $("co-opt-" + S.active);
      if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest" });
    } else if (ev.key === "Enter") {
      ev.preventDefault();   // Enter here chooses a company; it never sends the form
      if (S.active >= 0 && S.matches[S.active]) choose(S.matches[S.active]);
      else if (n === 1) choose(S.matches[0]);
    } else if (ev.key === "Escape") {
      if (n) { ev.preventDefault(); closeList(); }
    }
  });
  q.addEventListener("blur", function () { closeList(); });

  function choose(e, prefilled) {
    countStep(prefilled ? "employer_company_prefill" : "employer_company_pick");
    q.value = e.n;
    closeList();
    coMsg.textContent = "";
    S.emp = e; S.roles = []; S.picked = []; S.avail = null;
    var company = form.elements.company;
    if (!company.value.trim() || company.value === S.prefill) { company.value = e.n; S.prefill = e.n; }
    $("roles-legend").textContent = "Open roles at " + e.n;
    show("roles-box", true);
    roleList.textContent = "";
    pickMsg.textContent = "Loading the open roles at " + e.n + ".";
    var seq = ++S.rseq;
    var got = S.shards[e.s] ? Promise.resolve(S.shards[e.s]) : dataJson("/data/roles/" + e.s + ".json");
    got.then(function (d) {
      S.shards[e.s] = d;
      if (seq !== S.rseq || S.emp !== e) return;
      S.roles = rolesFor(d, e.k);
      renderRoles();
      show("step2", true); show("step3", true);
      updatePick();
    }).catch(function () {
      if (S.emp !== e) return;
      pickMsg.textContent = "We couldn't load the roles. Choose the company again to retry.";
    });
  }

  function isPicked(r) { return S.picked.some(function (x) { return String(x.id) === String(r.id); }); }
  function renderRoles() {
    roleList.textContent = "";
    if (!S.roles.length) {
      roleList.appendChild(el("li", { className: "role" }, el("p", { className: "hint" }, "We don't list any open roles at " + S.emp.n + " right now, so there's nothing to buy for it today.")));
      return;
    }
    S.roles.forEach(function (r, i) {
      var id = "role-" + i, ok = canPick(r, S.pub), meta = [];
      var loc = locText(r);
      if (loc) meta.push(loc);
      meta.push(roleFields(r).map(fieldLabel).join(", "));
      var box = el("input", { type: "checkbox", id: id, value: String(r.id), checked: isPicked(r), disabled: !ok.ok });
      if (!ok.ok) box.setAttribute("aria-describedby", id + "-why");
      box.addEventListener("change", function () {
        if (box.checked) { if (!isPicked(r)) S.picked.push(r); }
        else S.picked = S.picked.filter(function (x) { return String(x.id) !== String(r.id); });
        mark("roles", "");
        updatePick();
      });
      var href = httpUrl(r.u);
      roleList.appendChild(el("li", { className: "role" + (ok.ok ? "" : " off") },
        box,
        el("div", { className: "role-b" },
          el("label", { htmlFor: id, className: "role-t" }, r.t),
          el("p", { className: "role-m" }, meta.join(" · ")),
          r.unpaid === true ? el("p", { className: "role-why", id: id + "-why" }, ok.ok ? "The posting doesn't say this role is paid. You can pick it as a nonprofit or public body." : UNPAID_NOTE) : null,
          href ? el("a", { href: href, target: "_blank", rel: "noopener", className: "role-a" }, "See the posting", el("span", { className: "vh" }, " for " + r.t), " ", el("span", { className: "i i-external", "aria-hidden": "true" })) : null)));
    });
  }

  pub.addEventListener("change", function () {
    S.pub = pub.checked;
    // Unpaid roles can't stay picked once the box is unticked.
    var before = S.picked.length;
    if (!S.pub) S.picked = S.picked.filter(function (r) { return r.unpaid !== true; });
    if (S.emp) renderRoles();
    updatePrices();
    updatePick();
    if (S.picked.length < before) pickMsg.textContent = "We unticked the roles whose postings don't say they are paid. " + pickMsg.textContent;
  });

  function updatePrices() {
    $("prices").textContent = priceLine(S.cfg, S.pub);
  }
  function updatePick() {
    if (!S.emp) return;
    if (packageFor(S.picked.length)) countStep("employer_roles_pick");
    pickMsg.textContent = S.roles.length ? pickMessage(S.picked.length, S.cfg, S.pub) : "";
    updateButton();
    checkAvail();
  }
  function updateButton() {
    send.textContent = buttonText(S.cfg, packageFor(S.picked.length), S.pub, form.elements.pilot.value.trim());
  }
  form.elements.pilot.addEventListener("input", updateButton);

  function updateRun() {
    var v = startIn.value;
    $("run").textContent = validIso(v) ? runText(v, S.cfg.days) : "";
  }
  startIn.addEventListener("change", function () { mark("start", ""); updateRun(); checkAvail(); });
  startIn.addEventListener("input", function () { updateRun(); });

  // Room for the picked roles on the chosen start day (FIELD_CAP per field).
  function checkAvail() {
    clearTimeout(S.timer);
    S.aseq++;   // an answer still on its way is for the old roles or day
    S.avail = null;
    availBox.textContent = "";
    var roles = S.picked.slice(), startDay = startIn.value;
    if (!S.emp || !roles.length || roles.length > 3 || !inRange(startDay, startRange(S.cfg))) return;
    S.timer = setTimeout(function () {
      var seq = ++S.aseq;
      var ids = roles.map(function (r) { return r.id; });
      var qs = new URLSearchParams({ shard: S.emp.s, ids: ids.join(","), start: startDay }).toString();
      availBox.textContent = "Checking room on " + fmtDate(startDay) + ".";
      call("GET", "/employer/availability?" + qs).then(function (res) {
        if (seq !== S.aseq) return;
        availBox.textContent = "";
        if (!res.ok) { availBox.appendChild(el("p", {}, "We couldn't check room for this day just now. We check again when you order.")); return; }
        S.avail = readAvailability(res.out, ids);
        var ul = el("ul", { className: "avail" });
        S.avail.forEach(function (a, i) {
          if (!a.known) return;
          var li = el("li", { className: a.fits ? "fits" : "full" },
            el("span", { className: "i " + (a.fits ? "i-check" : "i-alert"), "aria-hidden": "true" }), " ",
            el("strong", {}, roles[i].t), ": " + availText(a));
          if (!a.fits && a.next_start && inRange(a.next_start, startRange(S.cfg))) {
            var day = a.next_start;
            var b = el("button", { type: "button", className: "cta alt small" }, "Start on " + fmtDate(day));
            b.addEventListener("click", function () { startIn.value = day; updateRun(); checkAvail(); startIn.focus(); });
            li.appendChild(doc.createTextNode(" "));
            li.appendChild(b);
          }
          ul.appendChild(li);
        });
        if (ul.children.length) availBox.appendChild(ul);
      }).catch(function () {
        if (seq !== S.aseq) return;
        availBox.textContent = "We couldn't check room for this day just now. We check again when you order.";
      });
    }, 250);
  }

  // ----- field messages, like the interest form on /employers/ -----
  function mark(id, msg) {
    var input = id === "roles" ? null : $(id), err = $(id + "-err");
    if (!err) return;
    if (input) {
      var hint = $(id + "-hint");
      var by = ((hint ? hint.id + " " : "") + (msg ? err.id : "")).trim();
      if (by) input.setAttribute("aria-describedby", by); else input.removeAttribute("aria-describedby");
      if (msg) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
    }
    err.textContent = msg || "";
    err.hidden = !msg;
  }
  function focusFor(id) {
    if (id === "roles") {
      var first = roleList.querySelector("input:not([disabled])");
      (first || q).focus();
    } else if ($(id)) $(id).focus();
  }
  ["name", "email", "company", "pilot"].forEach(function (id) {
    $(id).addEventListener("input", function () { if ($(id).getAttribute("aria-invalid") === "true") mark(id, ""); });
  });
  $("terms").addEventListener("change", function () { if ($("terms").checked) mark("terms", ""); });

  function check() {
    var bad = [], val = function (id) { return $(id).value.trim(); };
    var put = function (id, msg) { mark(id, msg); if (msg) bad.push(id); };
    put("co-q", S.emp ? "" : "Type your company's name and choose it from the list.");
    var n = S.picked.length;
    put("roles", !S.emp ? "" : !S.roles.length ? "There are no open roles to pick." : packageFor(n) ? "" : pickMessage(n, S.cfg, S.pub));
    if (!bad.length && !S.pub && S.picked.some(function (r) { return r.unpaid === true; })) put("roles", UNPAID_NOTE);
    var range = startRange(S.cfg);
    var full = (S.avail || []).filter(function (a) { return a.known && !a.fits; });
    put("start", !inRange(startIn.value, range) ? "Pick a start day from " + fmtDate(range.min) + " to " + fmtDate(range.max) + "."
      : full.length ? "Not every role you picked has room on this day. Pick a later start day." : "");
    put("name", val("name") ? "" : "Enter your name.");
    put("email", !val("email") ? "Enter your work email." : EMAIL.test(val("email")) ? "" : "That email address doesn't look right.");
    put("company", val("company") ? "" : "Enter your company.");
    put("pilot", "");
    put("terms", $("terms").checked ? "" : "Tick this box to order.");
    return bad;
  }

  // 2026-10-23: a lost POST response may still have created an order; never resend automatically (SITE-1).
  // was: network failures invited an immediate duplicate order. Revert: remove uncertain and this send guard.
  function uncertain() {
    S.uncertain = true;
    status.textContent = "We couldn't confirm whether your order was received. It may already have gone through. Check your email, including spam, for the confirmation link. Please don't submit another order until you check, or email " + CONTACT + " for help.";
  }
  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (send.disabled || S.uncertain) return;
    status.textContent = "";
    var bad = check();
    if (bad.length) { focusFor(bad[0]); return; }
    var v = function (id) { return $(id).value.trim(); };
    var body = orderBody({ name: v("name"), email: v("email"), company: v("company"), publicBody: S.pub, shard: S.emp.s, roles: S.picked,
      start: startIn.value, cfg: S.cfg, pilot: v("pilot"), website: form.elements.website.value });
    var label = send.textContent;
    // Intent only: a rejected request, failed email or pilot is not a paid purchase.
    countStep("employer_order_submit");
    send.disabled = true;
    send.textContent = "Sending";
    call("POST", "/employer/order", body).then(function (res) {
      if (res.ok) {
        // 2026-10-23: only the documented acknowledgement proves acceptance; was: any 2xx (SITE-1).
        // Revert: remove this acknowledgement check with the uncertain-outcome rule.
        if (res.out.ok !== true) { uncertain(); return; }
        $("sent-text").textContent = "We sent a link to " + body.email + ". It works for 48 hours.";
        form.hidden = true;
        var done = $("sent");
        done.hidden = false;
        done.focus();
        return;
      }
      var msg = serverMessage(res.out), target = res.status === 400 ? errorTarget(res.out.field) : null;
      if (res.status === 400 && res.out.field === "terms_version") $("terms").checked = false;
      if (target) { mark(target, msg || "Check this."); focusFor(target); }
      else if (res.status === 404) { form.hidden = true; show("closed", true); }
      else if (msg && (res.status === 400 || res.status === 409 || res.status === 429)) status.textContent = msg;
      else if (res.status >= 500) uncertain();
      else status.textContent = "That didn't go through. Please try again, or email " + CONTACT + ".";
    }).catch(uncertain).then(function () {
      send.disabled = !!S.uncertain;
      send.textContent = S.uncertain ? "Check your email" : label === "Sending" ? "Order" : label;
    });
  });
}
