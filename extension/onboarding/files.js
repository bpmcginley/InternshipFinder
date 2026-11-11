// ---------- file helpers ----------
function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export async function readFile(file) {
  if (file.size > 15 * 1024 * 1024) throw new Error(`${file.name} is over 15 MB.`);
  const buf = await file.arrayBuffer();
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  const isDocx = /\.docx$/i.test(file.name);
  const out = { name: file.name, type: isPdf ? "application/pdf" : file.type || "application/octet-stream", size: file.size, b64: toB64(buf) };
  if (isDocx) {
    if (!window.mammoth) throw new Error("DOCX reader failed to load. Save the file as PDF instead.");
    out.text = (await window.mammoth.extractRawText({ arrayBuffer: buf })).value;
  } else if (!isPdf) {
    out.text = new TextDecoder().decode(buf);
  }
  return out;
}
export function docBlock(f, title) {
  if (!f) return null;
  if (f.type === "application/pdf" && f.b64) return { type: "document", source: { type: "base64", media_type: "application/pdf", data: f.b64 }, title };
  if (f.text) return { type: "document", source: { type: "text", media_type: "text/plain", data: f.text.slice(0, 60000) }, title };
  return null;
}
