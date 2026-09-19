// Just enough ZIP to open a .docx, change one file inside it and write it back. The Web Store does
// not allow remotely hosted code, and the service worker has no DOM, so this uses only what MV3
// gives us: DecompressionStream / CompressionStream("deflate-raw").
//
// Every entry we do not touch is copied byte for byte (same compressed data, same CRC, same order),
// so fonts, images, styles and numbering in the student's file come out exactly as they went in.
// Not supported, and reported as an error so the caller falls back: ZIP64, encryption, methods
// other than stored (0) and deflate (8).

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
export const inflate = (bytes) => pipe(bytes, new DecompressionStream("deflate-raw"));
export const deflate = (bytes) => pipe(bytes, new CompressionStream("deflate-raw"));

// bytes -> [{name, method, flags, time, date, crc, csize, usize, data (compressed), extra}]
export function readZip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip file");
  const count = v.getUint16(eocd + 10, true);
  let at = v.getUint32(eocd + 16, true);
  if (count === 0xffff || at === 0xffffffff) throw new Error("zip64 is not supported");
  const dec = new TextDecoder();
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (v.getUint32(at, true) !== 0x02014b50) throw new Error("bad zip directory");
    const flags = v.getUint16(at + 8, true), method = v.getUint16(at + 10, true);
    if (flags & 1) throw new Error("encrypted zip is not supported");
    if (method !== 0 && method !== 8) throw new Error("zip method " + method + " is not supported");
    const csize = v.getUint32(at + 20, true), usize = v.getUint32(at + 24, true);
    const nlen = v.getUint16(at + 28, true), xlen = v.getUint16(at + 30, true), clen = v.getUint16(at + 32, true);
    const local = v.getUint32(at + 42, true);
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nlen));
    if (v.getUint32(local, true) !== 0x04034b50) throw new Error("bad zip entry");
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    if (start + csize > bytes.length) throw new Error("truncated zip");
    entries.push({
      name, method, flags: flags & ~8, time: v.getUint16(at + 12, true), date: v.getUint16(at + 14, true),
      crc: v.getUint32(at + 16, true), csize, usize, data: bytes.subarray(start, start + csize),
      attrs: v.getUint32(at + 38, true), made: v.getUint16(at + 4, true),
    });
    at += 46 + nlen + xlen + clen;
  }
  return entries;
}

export async function entryBytes(e) { return e.method === 8 ? inflate(e.data) : e.data; }

// Replace one entry's content; the rest of the entry (name, dates, attributes) stays.
export async function withContent(e, content) {
  const data = await deflate(content);
  return { ...e, method: 8, crc: crc32(content), csize: data.length, usize: content.length, data };
}

export function writeZip(entries) {
  const enc = new TextEncoder();
  const names = entries.map((e) => enc.encode(e.name));
  const size = entries.reduce((n, e, i) => n + 30 + 46 + names[i].length * 2 + e.data.length, 22);
  const out = new Uint8Array(size), v = new DataView(out.buffer);
  const offsets = [];
  let at = 0;
  entries.forEach((e, i) => {
    offsets.push(at);
    v.setUint32(at, 0x04034b50, true); v.setUint16(at + 4, 20, true); v.setUint16(at + 6, e.flags, true); v.setUint16(at + 8, e.method, true);
    v.setUint16(at + 10, e.time, true); v.setUint16(at + 12, e.date, true); v.setUint32(at + 14, e.crc, true);
    v.setUint32(at + 18, e.csize, true); v.setUint32(at + 22, e.usize, true); v.setUint16(at + 26, names[i].length, true); v.setUint16(at + 28, 0, true);
    out.set(names[i], at + 30); out.set(e.data, at + 30 + names[i].length);
    at += 30 + names[i].length + e.data.length;
  });
  const dir = at;
  entries.forEach((e, i) => {
    v.setUint32(at, 0x02014b50, true); v.setUint16(at + 4, e.made || 20, true); v.setUint16(at + 6, 20, true); v.setUint16(at + 8, e.flags, true);
    v.setUint16(at + 10, e.method, true); v.setUint16(at + 12, e.time, true); v.setUint16(at + 14, e.date, true); v.setUint32(at + 16, e.crc, true);
    v.setUint32(at + 20, e.csize, true); v.setUint32(at + 24, e.usize, true); v.setUint16(at + 28, names[i].length, true);
    v.setUint32(at + 38, e.attrs || 0, true); v.setUint32(at + 42, offsets[i], true);
    out.set(names[i], at + 46);
    at += 46 + names[i].length;
  });
  v.setUint32(at, 0x06054b50, true); v.setUint16(at + 8, entries.length, true); v.setUint16(at + 10, entries.length, true);
  v.setUint32(at + 12, at - dir, true); v.setUint32(at + 16, dir, true);
  return out.subarray(0, at + 22);
}
