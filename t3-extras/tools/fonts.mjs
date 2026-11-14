#!/opt/homebrew/bin/node
/**
 * Maintainer tool for fonts.json (not run by install.sh or the service).
 *
 *   node tools/fonts.mjs pin [--commit <google/fonts sha>] [--only "Name,Name"]
 *       For each Google family: ask the Google Fonts CSS API for its latin woff2 (one weight, 400),
 *       download it, record its URL + sha256, and find its real licence (OFL, Apache 2.0 or UFL) in
 *       github.com/google/fonts at one pinned commit. Downloads go to a fresh folder under
 *       ~/Library/Caches/t3-extras-build-r2/ for `measure`. With --only, just those families are
 *       (re)pinned, at the commit fonts.json already pins unless --commit says otherwise; every
 *       other family keeps its file, URL and hash.
 *   node tools/fonts.mjs measure --dl <folder>
 *       Measures every family the way the specimen board does (40 px canvas: sentence width,
 *       x-height, cap height) in T3's headless Chrome, and stores the results, the "narrow" and
 *       "tall" tags, a default size (x-height matched to T3's UI font, 80-200%; sizeClamped when
 *       the match needed more or less than that), xRatio (lower case as a whole % of capital
 *       height), widthVsSystem (the sentence at the default size against T3's built-in system font
 *       at 100%, signed whole %) and the catalog's xRatioMedian. The folder must hold every
 *       Google family's file.
 *
 *   node tools/fonts.mjs about --from <writer's font-about.json>
 *       Writes font-about.json, the "About this font" records the service sends: the public fields
 *       only (never the writer's `sources`), for families in fonts.json, at fonts.json's listVersion.
 *       `apartWarn` marks the traits that warn how the font draws in T3 (Yomogi's dash, which
 *       fonts.json's dashesTouch records, and Barlow Condensed's double hyphen).
 *       Run it only on a file whose claims have been checked against their sources.
 *
 * The style verdicts (print / partly joined / joined, star, hard) are authored data in fonts.json.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SRC = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FONTS_JSON = path.join(SRC, "fonts.json");
const SCRATCH = path.join(os.homedir(), "Library/Caches/t3-extras-build-r2");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
export const SAMPLE = "The quick handover kept 42 notes in narrow rows.";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
export const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** The @font-face block that covers basic Latin "A" (the latin subset), from a css2 response. */
export function latinWoff2(css) {
  const blocks = [...css.matchAll(/(\/\*\s*([^*]*?)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g)].map((m) => ({
    label: m[2] ?? "",
    url: /url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/.exec(m[3])?.[1] ?? null,
    range: /unicode-range:\s*([^;]+);/.exec(m[3])?.[1] ?? "U+0-10FFFF",
  })).filter((b) => b.url);
  const covers = (range, cp) => range.split(",").some((part) => {
    const [a, b] = part.trim().replace(/^U\+/i, "").split("-");
    const lo = parseInt(a.replace(/\?/g, "0"), 16);
    const hi = b ? parseInt(b, 16) : parseInt(a.replace(/\?/g, "F"), 16);
    return cp >= lo && cp <= hi;
  });
  return blocks.find((b) => b.label === "latin") ?? blocks.find((b) => covers(b.range, 0x41)) ?? null;
}

async function get(url, binary = false) {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return binary ? Buffer.from(await r.arrayBuffer()) : r.text();
}

async function pin() {
  const data = JSON.parse(fs.readFileSync(FONTS_JSON, "utf8"));
  const only = arg("--only") ? new Set(arg("--only").split(",").map((n) => n.trim()).filter(Boolean)) : null;
  if (only) for (const n of only) if (!data.families.some((f) => f.name === n && f.source === "google")) throw new Error(`--only: no Google family ${n} in fonts.json`);
  const commit = arg("--commit") ?? (only ? data.googleFontsCommit : execFileSync("git", ["ls-remote", "https://github.com/google/fonts", "HEAD"], { encoding: "utf8" }).split(/\s/)[0]);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`bad commit ${commit}`);
  if (only && commit !== data.googleFontsCommit) throw new Error("--only keeps one pinned commit for every licence: drop --commit, or re-pin them all");
  fs.mkdirSync(SCRATCH, { recursive: true });
  const dl = fs.mkdtempSync(path.join(SCRATCH, "fonts-dl-"));
  const kept = new Map((data.files ?? []).map((x) => [x.file, x]));
  const files = [];
  for (const fam of data.families) {
    if (fam.source !== "google") continue;
    if (only && !only.has(fam.name)) {
      files.push(kept.get(fam.file), kept.get(fam.licence));
      continue;
    }
    const css = await get(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(fam.name).replace(/%20/g, "+")}&display=swap`);
    const block = latinWoff2(css);
    if (!block) throw new Error(`no latin woff2 for ${fam.name}`);
    const font = await get(block.url, true);
    const file = `${slug(fam.name)}-latin-400.woff2`;
    fs.writeFileSync(path.join(dl, file), font);
    // google/fonts keeps each family in <licence>/<name without spaces or punctuation>/.
    const dir = fam.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    let lic = null;
    for (const [kind, name, type] of [["ofl", "OFL.txt", "OFL-1.1"], ["apache", "LICENSE.txt", "Apache-2.0"], ["ufl", "UFL.txt", "UFL-1.0"]]) {
      const url = `https://raw.githubusercontent.com/google/fonts/${commit}/${kind}/${dir}/${name}`;
      try {
        lic = { url, type, body: await get(url, true) };
        break;
      } catch {}
    }
    if (!lic) throw new Error(`no licence found for ${fam.name} (${dir})`);
    const licFile = `LICENSE-${slug(fam.name)}.txt`;
    fs.writeFileSync(path.join(dl, licFile), lic.body);
    fam.file = file;
    fam.licence = licFile;
    fam.licenceType = lic.type;
    files.push({ file, url: block.url, sha256: sha256(font) }, { file: licFile, url: lic.url, sha256: sha256(lic.body) });
    console.log(`${fam.name}: ${lic.type}, ${font.length} bytes`);
  }
  data.googleFontsCommit = commit;
  data.files = files;
  fs.writeFileSync(FONTS_JSON, `${JSON.stringify(data, null, 1)}\n`);
  console.log(`pinned ${only ? only.size : files.length / 2} families; downloads in ${dl}`);
}

const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** narrow / tall tags, a default size and the font-details numbers, from raw 40 px measurements
 *  (pure; tested). `ui` is T3's built-in system font measured the same way: its x-height (a number,
 *  as before) or { xh, w }; the width comparison needs w. */
export function deriveTags(families, ui) {
  const uiXh = typeof ui === "number" ? ui : ui.xh, uiW = typeof ui === "number" ? null : ui.w;
  // narrow and tall compare with the Handwritten medians of the list as it was before families
  // carried newIn, so adding fonts never re-tags the ones already there (13 Nov 2026: adding four
  // Handwritten fonts would otherwise have made Nanum Pen Script and Patrick Hand "narrow").
  const hand = families.filter((f) => f.group === "hand" && f.m && f.newIn == null);
  const wMed = median(hand.map((f) => f.m.w));
  const tMed = median(hand.map((f) => f.m.tall));
  for (const f of families) {
    if (!f.m) continue;
    f.width = Math.round(f.m.w * 10) / 10; // px at 40 px, the board's sentence
    f.tallness = Math.round(f.m.tall * 100) / 100; // cap height / average advance
    f.narrow = f.m.w < wMed * 0.88;
    f.tall = f.m.tall > tMed * 1.12;
    // x-height matched to T3's UI font, in 5% steps, kept to 80-200% (the size buttons' range; 80-150% until
    // 13 Nov 2026, when Andy confirmed the 200% cap: only Hi Melody moved, 150% to 155%).
    const match = Math.round((uiXh / f.m.xh) * 20) * 5;
    f.size = Math.max(80, Math.min(200, match));
    f.sizeClamped = f.size !== match; // the match needed more (or less) than the limits allow
    // Lower case as a whole % of capital height (small capitals, for the SC families).
    if (f.m.cap > 0) f.xRatio = Math.round((100 * f.m.xh) / f.m.cap);
    // The board's sentence at the default size against T3's built-in system font at 100%, signed whole %.
    if (uiW > 0) f.widthVsSystem = Math.round((100 * f.m.w * f.size) / 100 / uiW - 100) || 0;
    delete f.m;
  }
  return families;
}
/** The catalog's typical lower case: the median xRatio, whole %. */
export function xRatioMedian(families) {
  const xs = families.map((f) => f.xRatio).filter(Number.isFinite);
  return xs.length ? Math.round(median(xs)) : null;
}

function measure() {
  const dl = arg("--dl");
  if (!dl || !fs.existsSync(dl)) throw new Error("--dl <folder from pin> needed");
  const data = JSON.parse(fs.readFileSync(FONTS_JSON, "utf8"));
  const faces = data.families.map((f, i) => f.source === "google"
    ? `@font-face{font-family:"M${i}";src:url(data:font/woff2;base64,${fs.readFileSync(path.join(dl, f.file)).toString("base64")}) format("woff2")}`
    : `@font-face{font-family:"M${i}";src:${f.local.map((n) => `local("${n}")`).join(",")}}`).join("\n");
  const page = `<!doctype html><meta charset="utf-8"><style>${faces}</style><pre id="out">pending</pre><script>
const S=${JSON.stringify(SAMPLE)}, N=${data.families.length};
(async()=>{await Promise.all(Array.from({length:N},(_, i)=>document.fonts.load('40px "M'+i+'"').catch(()=>0)));
const cv=document.createElement("canvas").getContext("2d");
// x-height: the median top of eight flat-topped lowercase letters (one quirky "x" can mislead).
const med=(a)=>a.slice().sort((p,q)=>p-q)[a.length>>1];
const m=(fam)=>{cv.font='40px '+fam;const w=cv.measureText(S).width,x=med([..."xzvwunmr"].map((c)=>cv.measureText(c).actualBoundingBoxAscent)),H=cv.measureText("H").actualBoundingBoxAscent;return {w,xh:x/40,cap:H/40,tall:H/(w/S.length)}};
cv.font="40px monospace";const mono=cv.measureText(S).width;
const rows=Array.from({length:N},(_, i)=>{const r=m('"M'+i+'", monospace');r.fallback=Math.abs(r.w-mono)<0.5;return r});
document.getElementById("out").textContent=JSON.stringify({ui:m("-apple-system, BlinkMacSystemFont, system-ui, sans-serif"),rows});})();
</script>`;
  const tmp = fs.mkdtempSync(path.join(SCRATCH, "measure-"));
  fs.writeFileSync(path.join(tmp, "measure.html"), page);
  const chromeDir = path.join(os.homedir(), ".t3/tools/chrome-headless-shell/mac-arm64");
  const chrome = path.join(chromeDir, fs.readdirSync(chromeDir).sort().at(-1), "chrome-headless-shell");
  const dom = execFileSync(chrome, ["--headless", "--disable-gpu", "--virtual-time-budget=8000", "--dump-dom", `file://${tmp}/measure.html`], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] });
  const json = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom)?.[1];
  const res = JSON.parse(json.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
  const missing = data.families.filter((f, i) => res.rows[i].fallback).map((f) => f.name);
  if (missing.length) throw new Error(`not loaded: ${missing.join(", ")}`);
  data.families.forEach((f, i) => (f.m = res.rows[i]));
  deriveTags(data.families, { xh: res.ui.xh, w: res.ui.w });
  data.xRatioMedian = xRatioMedian(data.families);
  data.measuredWith = { sample: SAMPLE, px: 40, uiXHeight: Math.round(res.ui.xh * 1000) / 1000, uiWidth: Math.round(res.ui.w * 10) / 10, browser: `T3's chrome-headless-shell ${path.basename(path.dirname(chrome))}` };
  fs.writeFileSync(FONTS_JSON, `${JSON.stringify(data, null, 1)}\n`);
  for (const f of data.families) console.log(`${f.name.padEnd(28)} w ${String(f.width).padStart(6)} tall ${f.tallness} ${f.narrow ? "narrow " : ""}${f.tall ? "tall " : ""}size ${f.size}%${f.sizeClamped ? " (clamped)" : ""} x ${f.xRatio}% vs system ${f.widthVsSystem}%`);
}

/** The shipped records from the writer's file (pure; tested). */
export function aboutRecords(writer, fonts) {
  const by = new Map(fonts.families.map((f) => [f.name, f]));
  const keep = ["strip", "desc", "apart", "apartWarn", "madeShort", "background", "weight", "letters", "copyLatinOnly", "familyScripts", "weightLoaded"];
  const records = {};
  const src = writer?.records ?? writer ?? {};
  for (const [name, r] of Object.entries(src)) {
    const f = by.get(name);
    if (!f || f.source === "t3" || !r || typeof r !== "object") continue;
    const out = {};
    for (const k of keep) if (r[k] !== undefined) out[k] = r[k];
    records[name] = out;
  }
  return { note: "The \"About this font\" records (tools/fonts.mjs about, from the writer's checked file; sources stay build-side). Shown as plain text.", listVersion: fonts.listVersion ?? null, records };
}
function about() {
  const from = arg("--from");
  if (!from || !fs.existsSync(from)) throw new Error("--from <writer's font-about.json> needed");
  const fonts = JSON.parse(fs.readFileSync(FONTS_JSON, "utf8"));
  const out = aboutRecords(JSON.parse(fs.readFileSync(from, "utf8")), fonts);
  const missing = fonts.families.filter((f) => !out.records[f.name]).map((f) => f.name);
  fs.writeFileSync(path.join(SRC, "font-about.json"), `${JSON.stringify(out, null, 1)}\n`);
  console.log(`${Object.keys(out.records).length} records written${missing.length ? `; missing: ${missing.join(", ")}` : ""}`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (cmd === "pin") await pin();
  else if (cmd === "measure") measure();
  else if (cmd === "about") about();
  else console.log("usage: tools/fonts.mjs pin [--commit sha] [--only names] | measure --dl <folder> | about --from <file>");
}
