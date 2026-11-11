const STYLE = "body{font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#111;background:#fff}" +
  "h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:1.6rem}table{border-collapse:collapse}td,th{text-align:left;" +
  "vertical-align:top;padding:.2rem .8rem .2rem 0}.warn{color:#a40000;font-weight:600}.ok{color:#0a5a1f}" +
  "form{margin:1rem 0;padding:1rem;border:1px solid #ccc}textarea{width:100%;font:inherit}button{font:inherit;padding:.4rem 1rem}" +
  "li{margin:.4rem 0}code{word-break:break-all}";
let styleHash;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// A self-contained page: no script at all, the one style block allowed by its hash, forms that post
// back to this Worker only, and nothing kept by the browser or sent on as a referrer (the link is signed).
async function page(title, body, status = 200) {
  styleHash ||= btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(STYLE)))));
  const html = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta name=\"robots\" content=\"noindex\">" +
    `<title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; style-src 'sha256-${styleHash}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}

const message = (title, text, status) => page(title, `<h1>${esc(title)}</h1><p>${esc(text)}</p>`, status);

export { esc, message, page };
