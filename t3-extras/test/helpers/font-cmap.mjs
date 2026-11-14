// The characters a font file maps (its cmap), for checking that a record's strip only uses letters the file has.
// Reads WOFF2 (brotli; the cmap table is never transformed) and plain TrueType/OpenType or collections.
import fs from "node:fs";
import zlib from "node:zlib";

function base128(buf, at) {
  let v = 0;
  for (let i = 0; i < 5; i++) { const b = buf[at.i++]; v = v * 128 + (b & 0x7f); if (!(b & 0x80)) return v; }
  throw new Error("bad UIntBase128");
}
const GLYF = 10, LOCA = 11, HMTX = 3;
function woff2Cmap(buf) {
  const n = buf.readUInt16BE(12), compressed = buf.readUInt32BE(20);
  const at = { i: 48 }, tables = [];
  for (let k = 0; k < n; k++) {
    const flags = buf[at.i++], idx = flags & 0x3f, ver = flags >> 6;
    let tag = null;
    if (idx === 63) { tag = buf.toString("latin1", at.i, at.i + 4); at.i += 4; }
    const orig = base128(buf, at);
    const transformed = ((idx === GLYF || idx === LOCA) && ver === 0) || (idx === HMTX && ver === 1);
    const len = transformed ? base128(buf, at) : orig;
    tables.push({ cmap: idx === 0 || tag === "cmap", len });
  }
  const data = zlib.brotliDecompressSync(buf.subarray(at.i, at.i + compressed));
  let off = 0;
  for (const t of tables) { if (t.cmap) return data.subarray(off, off + t.len); off += t.len; }
  throw new Error("no cmap");
}
function sfntCmap(buf, base = 0) {
  const n = buf.readUInt16BE(base + 4);
  for (let k = 0; k < n; k++) {
    const r = base + 12 + 16 * k;
    if (buf.toString("latin1", r, r + 4) === "cmap") return buf.subarray(buf.readUInt32BE(r + 8), buf.readUInt32BE(r + 8) + buf.readUInt32BE(r + 12));
  }
  throw new Error("no cmap");
}
function parseCmap(t) {
  const out = new Set(), subs = [];
  for (let k = 0, n = t.readUInt16BE(2); k < n; k++) subs.push({ p: t.readUInt16BE(4 + 8 * k), e: t.readUInt16BE(6 + 8 * k), o: t.readUInt32BE(8 + 8 * k) });
  for (const s of subs.filter((x) => x.p === 0 || x.p === 3)) {
    const f = t.readUInt16BE(s.o);
    if (f === 12) {
      for (let g = 0, ng = t.readUInt32BE(s.o + 12); g < ng; g++) {
        const r = s.o + 16 + 12 * g, start = t.readUInt32BE(r), end = t.readUInt32BE(r + 4);
        for (let c = start; c <= end && c < 0x30000; c++) out.add(c);
      }
    } else if (f === 4) {
      const seg = t.readUInt16BE(s.o + 6) / 2, ends = s.o + 14, starts = ends + 2 * seg + 2, deltas = starts + 2 * seg, ranges = deltas + 2 * seg;
      for (let i = 0; i < seg; i++) {
        const end = t.readUInt16BE(ends + 2 * i), start = t.readUInt16BE(starts + 2 * i), delta = t.readInt16BE(deltas + 2 * i), ro = t.readUInt16BE(ranges + 2 * i);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let g;
          if (!ro) g = (c + delta) & 0xffff;
          else { const gi = ranges + 2 * i + ro + 2 * (c - start); g = t.readUInt16BE(gi); if (g) g = (g + delta) & 0xffff; }
          if (g) out.add(c);
        }
      }
    }
  }
  return out;
}
/** Code points mapped by the font at `file` (WOFF2, TTF/OTF, or the first font of a TTC). */
export function cmapOf(file) {
  const buf = fs.readFileSync(file), sig = buf.toString("latin1", 0, 4);
  if (sig === "wOF2") return parseCmap(woff2Cmap(buf));
  if (sig === "ttcf") return parseCmap(sfntCmap(buf, buf.readUInt32BE(12)));
  return parseCmap(sfntCmap(buf));
}
