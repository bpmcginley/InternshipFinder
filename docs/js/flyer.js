(function (root) {
  "use strict";
  function campusTag(name) {
    return String(name || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16);
  }
  function flyerUrl(name) {
    const tag = campusTag(name);
    return "https://internscout.org/?utm_source=flyer" + (tag ? "-" + tag : "") + "&utm_medium=print";
  }
  root.ISFlyer = { campusTag, flyerUrl };
  if (!root.document) return;
  const doc = root.document, campus = doc.getElementById("campus"), qr = doc.getElementById("qr");
  const print = doc.getElementById("print"), status = doc.getElementById("status"), link = doc.getElementById("qr-link");
  function render() {
    print.disabled = true;
    const name = campus.value.trim().slice(0, 80), url = flyerUrl(name);
    doc.getElementById("campus-line").textContent = name ? "For students at " + name : "For students at your campus";
    try {
      const code = root.qrcode(0, "M");
      code.addData(url, "Byte");
      code.make();
      // Only the locally generated, ASCII URL enters the QR library, never campus HTML.
      qr.innerHTML = code.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
      qr.querySelector("svg").setAttribute("aria-hidden", "true");
      link.href = url;
      link.textContent = url;
      status.textContent = "Your flyer is ready to print.";
      print.disabled = false;
    } catch (_) {
      qr.replaceChildren();
      status.textContent = "The QR code could not load. Reload this page to try again.";
    }
  }
  campus.addEventListener("input", render);
  print.addEventListener("click", function () { if (!print.disabled) root.print(); });
  root.addEventListener("beforeprint", function () {
    if (!print.disabled && root.ISCount) root.ISCount("flyer_print");
  });
  render();
})(typeof window === "undefined" ? globalThis : window);
