// Runs inside the fable-browser test page, between the production pieces cut from extras.js.
// C, lab, view, svgBar, NOW, MIN, HOUR, DAY come from the page.
const { visibleLabs, compactLabel, spokenUsage, bTooltip, shortBarText, lineLayout, fitParts, sidebarCands, compactParts, lowScoped, composerSummary, lowRefills, fmtPct, fmtClock } = C;
let compactMode = true;
const barsCompact = () => compactMode;
const sig = (node, key) => { if (node.__sig === key) return false; node.__sig = key; return true; };
const bSvg = svgBar;
function h(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  const add = (k) => { if (Array.isArray(k)) k.forEach(add); else if (k != null && k !== false) node.append(k); };
  kids.forEach(add);
  return node;
}
/*MEASURE*/
/*KEY*/
const settings = { usageComposer: true, handoverButton: false };
const lastState = null;
const toolGates = () => ({ handover: false });
const handoverBlocker = () => null;
const bars = { /*BARS*/ };
const chip = { /*CHIP*/ };

const WEEK_AT = NOW + 3 * DAY + 17 * HOUR + 59 * MIN; // a single-digit hour, like the board's "Sun 3:59 PM"
const mk = (opts) => {
  const l = lab(opts);
  for (const w of l.windows) if (w.kind === "weekly") w.resetsAt = WEEK_AT;
  return C.labView(l, NOW, {});
};
const cases = {
  healthy: { week: 20, five: 38, fable: 30, stop: 90 },
  low: { week: 45, five: 38, fable: 92, stop: 90 },
  lowNoStop: { week: 45, five: 38, fable: 86 },
  both: { week: 45, five: 96, fable: 92, stop: 90 },
  fiveOnly: { week: 45, five: 80, fable: 30 },
  fiveOnlyToday: { week: 45, five: 80 },
  weekOnly: { week: 90, five: 38, fable: 30 },
  weekOnlyToday: { week: 90, five: 38 },
  weekAndFable: { week: 97, five: 38, fable: 92, stop: 90 },
  allThree: { week: 97, five: 96, fable: 92, stop: 90 },
  week12: { week: 88, five: 38, fable: 95, stop: 90 },
  weekFableOut: { week: 97, five: 38, fable: 100 },
  blockedOut: { week: 100, five: 10, fable: 100 },
  tieLow: { week: 45, five: 92, fable: 92, stop: 90 },
  tieHealthy: { week: 20, five: 38, fable: 38 },
  fableLowest: { week: 40, five: 0, fable: 62 },
  weekLower: { week: 70, five: 0, fable: 62 },
  fiveTighter: { week: 40, five: 52, fable: 30 },
};
const rows = [];
const home = document.getElementById("dark");
for (const mode of ["line", "side"]) {
  compactMode = mode === "line";
  for (const px of [226, 160]) {
    for (const [name, opts] of Object.entries(cases)) {
      const node = h("button", { "data-t3x": "bars", class: "t3x-bars", "data-prod": `${mode}-${name}-${px}` });
      node.style.width = `${px}px`;
      home.append(node);
      const v = mk(opts);
      bars.update(node, [v], NOW);
      const el = node.querySelector(".t3x-bar-val");
      const box = el.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0);
      const lines = [...el.querySelectorAll(".t3x-ph")];
      rows.push({
        mode, name, px, today: !opts.fable || name === "fiveOnly" || name === "weekOnly",
        text: el.textContent, shown: el.innerText.replace(/\s+/g, " ").trim(), width: el.clientWidth, scroll: el.scrollWidth, overflow: getComputedStyle(el).overflow,
        warn: Boolean(el.querySelector(".t3x-low")),
        lines: lines.map((x) => x.textContent), lineTops: [...new Set(lines.map((x) => Math.round(x.getBoundingClientRect().top)))],
        textLeft: Math.min(...rects.map((r) => r.left)) - box.left, textRight: Math.max(...rects.map((r) => r.right)) - box.left,
      });
    }
  }
}
// F6: the same node, a second per-model reading changes.
compactMode = false;
const changing = h("button", { "data-t3x": "bars", class: "t3x-bars" });
changing.style.width = "226px";
home.append(changing);
const first = lab({ week: 20, fable: 92, stop: 90 });
first.windows.push({ ...first.windows.at(-1), id: "seven_day_opus", usedPct: 30 });
bars.update(changing, [C.labView(first, NOW, {})], NOW);
const before = changing.querySelector(".t3x-bar").title;
const second = JSON.parse(JSON.stringify(first));
second.windows.at(-1).usedPct = 40;
bars.update(changing, [C.labView(second, NOW, {})], NOW);
const afterWhole = changing.querySelector(".t3x-bar").title;
// A change of 0.02 points that moves the shown whole number (71% to 70%) refreshes it too.
const third = JSON.parse(JSON.stringify(first));
third.windows.at(-1).usedPct = 29.49;
bars.update(changing, [C.labView(third, NOW, {})], NOW);
const frac71 = changing.querySelector(".t3x-bar").title;
third.windows.at(-1).usedPct = 29.51;
bars.update(changing, [C.labView(third, NOW, {})], NOW);
const frac70 = changing.querySelector(".t3x-bar").title;
// F5: the chip, with and without a Fable reading.
const chipOf = (opts) => {
  const host = h("div", {}, h("button", { class: "t3x-handover" }), h("button", { class: "t3x-meters" }));
  home.append(host);
  chip.update(host, [view(opts)], NOW);
  const meters = host.querySelector(".t3x-meters");
  return { text: meters.textContent, title: meters.title, spoken: meters.getAttribute("aria-label") };
};
const withFable = chipOf({ week: 20, five: 20, fable: 30 });
window.__PROD__ = {
  font: `${getComputedStyle(changing).fontWeight} ${getComputedStyle(changing).fontSize} ${getComputedStyle(changing).fontFamily}`,
  rows,
  clocks: { week: fmtClock(WEEK_AT, NOW), five: fmtClock(NOW + 2.5 * HOUR, NOW) },
  tip: { before, after: afterWhole, frac71, frac70, spoken: changing.getAttribute("aria-label") },
  chip: { ...withFable, plainTitle: chipOf({ week: 20, five: 20 }).title },
  chipTie: chipOf({ week: 20, five: 38, fable: 38 }).text,
  chipTieWeek: chipOf({ week: 38, five: 20, fable: 38.3 }).text,
};
