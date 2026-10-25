#!/opt/homebrew/bin/node
/**
 * Maintainer tool for fonts.json (not run by install.sh or the service).
 *
 *   node tools/fonts.mjs pin [--commit <google/fonts sha>]
 *       For each Google family: ask the Google Fonts CSS API for its latin woff2 (one weight, 400),
 *       download it, record its URL + sha256, and find its real licence (OFL, Apache 2.0 or UFL) in
 *       github.com/google/fonts at one pinned commit. Downloads go to a fresh folder under
 *       ~/Library/Caches/t3-extras-build-r2/ for `measure`.
 *   node tools/fonts.mjs measure --dl <folder>
 *       Measures every family the way the specimen board does (40 px canvas: sentence width,
 *       x-height, cap height) in T3's headless Chrome, and stores the results, the "narrow" and
 *       "tall" tags and a default size (x-height matched to T3's UI font, 80-150%).
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
  const commit = arg("--commit") ?? execFileSync("git", ["ls-remote", "https://github.com/google/fonts", "HEAD"], { encoding: "utf8" }).split(/\s/)[0];
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`bad commit ${commit}`);
  const dl = fs.mkdtempSync(path.join(SCRATCH, "fonts-dl-"));
  const files = [];
  for (const fam of data.families) {
    if (fam.source !== "google") continue;
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
  console.log(`pinned ${files.length / 2} families; downloads in ${dl}`);
}

/** narrow / tall tags and a default size, from raw 40 px measurements (pure; tested). */
export function deriveTags(families, uiXh) {
  const hand = families.filter((f) => f.group === "hand" && f.m);
  const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const wMed = median(hand.map((f) => f.m.w));
  const tMed = median(hand.map((f) => f.m.tall));
  for (const f of families) {
    if (!f.m) continue;
    f.width = Math.round(f.m.w * 10) / 10; // px at 40 px, the board's sentence
    f.tallness = Math.round(f.m.tall * 100) / 100; // cap height / average advance
    f.narrow = f.m.w < wMed * 0.88;
    f.tall = f.m.tall > tMed * 1.12;
    // x-height matched to T3's UI font, in 5% steps, kept to the stepper's 80-150%.
    f.size = Math.max(80, Math.min(150, Math.round((uiXh / f.m.xh) * 20) * 5));
    delete f.m;
  }
  return families;
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
  deriveTags(data.families, res.ui.xh);
  data.measuredWith = { sample: SAMPLE, px: 40, uiXHeight: Math.round(res.ui.xh * 1000) / 1000, browser: "T3's chrome-headless-shell" };
  fs.writeFileSync(FONTS_JSON, `${JSON.stringify(data, null, 1)}\n`);
  for (const f of data.families) console.log(`${f.name.padEnd(28)} w ${String(f.width).padStart(6)} tall ${f.tallness} ${f.narrow ? "narrow " : ""}${f.tall ? "tall " : ""}size ${f.size}%`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (cmd === "pin") await pin();
  else if (cmd === "measure") measure();
  else console.log("usage: tools/fonts.mjs pin [--commit sha] | measure --dl <folder>");
}
