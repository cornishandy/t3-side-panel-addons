// The reply footer card's CSS (end of public/extras.css). The full browser test is
// ~/Library/Caches/footer-redesign/draft/test/run.sh; this one guards the scoping and the hooks the rules rely on.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const cssPath = process.env.T3X_CSS || new URL("../public/extras.css", import.meta.url);
const css = fs.readFileSync(cssPath, "utf8");
const start = css.indexOf("/* ---------- reply footer card ----------");
const block = css.slice(start);
const code = block.replace(/\/\*[\s\S]*?\*\//g, "");
const GUARD = '.chat-markdown > hr:last-of-type + .chat-markdown-table-container:has([itemprop~="settle-yes"], [itemprop~="settle-no"]):has(thead th:nth-child(3))';
const TEAM = GUARD + " + div:has(> [data-markdown-details])";

test("footer block is present and last", () => {
  assert.ok(start > 0, "footer block missing");
  assert.ok(!/\/\* -{10} (?!reply footer card)/.test(block.slice(10)), "another section follows the footer block");
});

test("every footer rule is scoped to the three-column card after the last hr that carries the verdict hook", () => {
  const selectors = [...code.matchAll(/(^|[;}])\s*([^{};@&]+?)\s*\{/g)].map((m) => m[2].trim())
    .filter((s) => !/^(from|to|\d+%)$/.test(s));
  assert.ok(selectors.length > 5);
  // split selector lists at top-level commas only (commas inside :is()/:has() belong to one selector)
  const parts = (sel) => { const out = []; let depth = 0, cur = ""; for (const ch of sel) { if (ch === "(") depth++; if (ch === ")") depth--; if (ch === "," && !depth) { out.push(cur); cur = ""; } else cur += ch; } return [...out, cur].map((x) => x.trim()); };
  for (const s of selectors) for (const part of parts(s)) assert.ok(part.includes(GUARD), "unscoped selector: " + part.slice(0, 80));
});

test("the rules' hooks are styled: verdict, running, failed, over, saved, done, action words", () => {
  for (const hook of ['[itemprop~="settle-no"]', '[itemprop~="settle-yes"]', '[itemprop~="running"]', '[itemprop~="failed"]', '[itemprop~="over"]', '[itemprop~="saved"]', "td del", 'td:nth-child(2) > ins'])
    assert.ok(code.includes(hook), hook);
  assert.ok(!/&\s*td ins\s*\{/.test(code), "action underline must not cover every cell");
  const quiet = css.slice(0, start);
  assert.match(quiet, /\.chat-markdown ins \{ text-decoration: none; \}/, "action words stay plain outside the open-item row");
});

test("the team list targets T3's collapsible, and the ✦ switch's modes are wired", () => {
  assert.ok(code.includes(TEAM + " {"), "team list rule");
  assert.ok(!/(^|[\s,>+~(])details\b/.test(code), "T3 renders <details> as its own collapsible, so no rule may target details");
  assert.ok(code.includes(`html[data-t3x-footer-team="always-hide"] ${TEAM} { display: none; }`));
  assert.ok(code.includes(`html[data-t3x-footer-team="always-show"] ${TEAM} [data-markdown-details-summary] { pointer-events: none;`));
});

test("no model pills, no !important, no layout outside the footer", () => {
  assert.ok(!/itemprop~="(opus|fable|haiku|sonnet|sol|astra|grok|gemini|flash)"/.test(code), "model pills are gone");
  assert.ok(!code.includes("!important"));
  assert.ok(!/(^|[;}])\s*(body|:root)\b/.test(code));
  for (const m of code.matchAll(/(^|[;}])\s*html\b([^{]*)\{/g)) assert.match(m[2], /^\[data-t3x-footer-team="[a-z-]+"\] /, "html rule outside the switch");
});
