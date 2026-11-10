(function () {
  "use strict";
  var field = document.getElementById("field"), limit = document.getElementById("limit");
  var snippet = document.getElementById("snippet"), preview = document.getElementById("preview");
  var status = document.getElementById("field-status"), copied = document.getElementById("copy-status");
  var names = { swe: "Software", ml: "ML / AI", pm: "Product / program management", hr: "Human resources" };
  var validFields = [];
  function update() {
    var tag = validFields.indexOf(field.value) >= 0 ? field.value : "";
    var rows = ["4", "8", "12"].indexOf(limit.value) >= 0 ? limit.value : "8";
    var query = (tag ? "field=" + encodeURIComponent(tag) + "&" : "") + "limit=" + rows;
    snippet.value = '<iframe src="https://internscout.org/widget/?' + query.replace(/&/g, "&amp;") +
      '" width="100%" height="560" style="border:0" loading="lazy" title="Open internships from InternScout"></iframe>';
    preview.src = "./?" + query;
    copied.textContent = "";
  }
  field.addEventListener("change", update);
  limit.addEventListener("change", update);
  document.getElementById("copy").addEventListener("click", async function () {
    try {
      await navigator.clipboard.writeText(snippet.value);
      copied.textContent = "Code copied.";
    } catch (_) {
      snippet.focus(); snippet.select();
      copied.textContent = "Code selected. Use your device's copy command.";
    }
  });
  var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, 10000);
  fetch("../data/majors.json", { signal: controller.signal }).then(function (r) {
    if (!r.ok) throw new Error("fields unavailable");
    return r.json();
  }).then(function (data) {
    if (!data || !Array.isArray(data.fields) || !data.fields.length || data.fields.length > 128 ||
        data.fields.some(function (t) { return typeof t !== "string" || !/^[a-z][a-z0-9_]{0,39}$/.test(t); })) throw new Error("invalid fields");
    validFields = Array.from(new Set(data.fields));
    validFields.map(function (tag) { return { tag: tag, label: names[tag] || (tag[0].toUpperCase() + tag.slice(1)).replace(/_/g, " ") }; })
      .sort(function (a, b) { return a.label.localeCompare(b.label); }).forEach(function (item) {
        var option = document.createElement("option"); option.value = item.tag; option.textContent = item.label; field.appendChild(option);
      });
    var wanted = new URLSearchParams(location.search).get("field") || "";
    field.value = validFields.indexOf(wanted) >= 0 ? wanted : "";
    field.disabled = false;
    status.textContent = wanted && !field.value ? "That field is unavailable. Choose a field." : "Choose one field or show all fields.";
    update();
  }).catch(function () {
    status.textContent = "Could not load field choices. The code shows all fields; reload to try again.";
  }).finally(function () { clearTimeout(timer); });
})();
