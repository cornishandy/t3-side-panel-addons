// Sidebar section separation (Option A'): visible 2px rules overriding T3's .invisible,
// lighter blue Working row wash with multi-select ring and compact hover-overlay compositing,
// amber Snoozed header, neutral Settled header with drag-over guard, mt-auto and break-check
// preservation, and WCAG AA contrast across Stock Dark/Light, Ocean, Ember and Iris.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('..', import.meta.url));
function newestHeadlessChrome() {
  const root = path.join(os.homedir(), '.t3/tools/chrome-headless-shell/mac-arm64');
  const versions = fs.existsSync(root) ? fs.readdirSync(root).filter(v => /^\d+(\.\d+)+$/.test(v)) : [];
  versions.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  return path.join(root, versions[0] ?? 'missing', 'chrome-headless-shell');
}

const THEMES = {
  stockDark: {
    dark: true,
    vars: {
      '--sidebar': '#111111',
      '--sidebar-foreground': 'oklch(97% 0 none)',
      '--sidebar-muted-foreground': 'oklch(70.8% 0 none)',
      '--sidebar-border': 'color-mix(in oklab, #ffffff 8%, transparent)',
      '--sidebar-row-hover': 'color-mix(in oklab, #ffffff 4%, transparent)',
      '--sidebar-row-active': 'color-mix(in oklab, #ffffff 4%, transparent)',
      '--sidebar-row-selected': 'color-mix(in oklab, #ffffff 3%, transparent)',
      '--info': 'oklch(62.3% .214 259.815)',
      '--info-foreground': 'oklch(70.7% .165 254.624)',
      '--warning': 'oklch(76.9% .188 70.08)',
      '--warning-foreground': 'oklch(82.8% .189 84.429)',
      '--primary': 'oklch(57.1% .21 264)',
      '--ring': 'oklch(57.1% .21 264)',
    },
  },
  stockLight: {
    dark: false,
    vars: {
      '--sidebar': 'oklch(98.5% 0 none)',
      '--sidebar-foreground': 'oklch(21% .006 285.885)',
      '--sidebar-muted-foreground': 'oklch(55.2% .016 285.938)',
      '--sidebar-border': 'oklch(92% .004 286.32)',
      '--sidebar-row-hover': 'oklch(99.2% 0 0)',
      '--sidebar-row-active': '#ffffff',
      '--sidebar-row-selected': '#ffffff',
      '--info': 'oklch(62.3% .214 259.815)',
      '--info-foreground': 'oklch(48.8% .243 264.376)',
      '--warning': 'oklch(76.9% .188 70.08)',
      '--warning-foreground': 'oklch(55.5% .163 48.998)',
      '--primary': 'oklch(54.6% .245 262.881)',
      '--ring': 'oklch(54.6% .245 262.881)',
    },
  },
  oceanDark: {
    dark: true,
    vars: {
      '--sidebar': 'oklch(0.290387 0.032043 247.274)',
      '--sidebar-foreground': 'oklch(0.990339 0.008411 325.64)',
      '--sidebar-muted-foreground': 'oklch(0.69099 0.01395 266.424)',
      '--sidebar-border': 'oklch(0.55859 0.019001 256.223 / 0.35)',
      '--sidebar-row-hover': 'oklch(0.353381 0.042285 245.043)',
      '--sidebar-row-active': 'oklch(0.393878 0.048778 244.179)',
      '--sidebar-row-selected': 'oklch(0.413744 0.051943 243.848)',
      '--info': 'oklch(62.3% .214 259.815)',
      '--info-foreground': 'oklch(70.7% .165 254.624)',
      '--warning': 'oklch(0.772406 0.172798 65.367)',
      '--warning-foreground': 'oklch(0.829017 0.171221 81.038)',
      '--primary': 'oklch(0.758933 0.105833 241.548)',
      '--ring': 'oklch(0.758933 0.105833 241.548)',
    },
  },
  emberDark: {
    dark: true,
    vars: {
      '--sidebar': 'oklch(0.293349 0.029554 46.882)',
      '--sidebar-foreground': 'oklch(0.990339 0.008411 325.64)',
      '--sidebar-muted-foreground': 'oklch(0.691874 0.012538 24.638)',
      '--sidebar-border': 'oklch(0.560372 0.016998 36.179 / 0.35)',
      '--sidebar-row-hover': 'oklch(0.356163 0.042933 49.385)',
      '--sidebar-row-active': 'oklch(0.396617 0.051353 50.201)',
      '--sidebar-row-selected': 'oklch(0.416477 0.055442 50.489)',
      '--info': 'oklch(62.3% .214 259.815)',
      '--info-foreground': 'oklch(70.7% .165 254.624)',
      '--warning': 'oklch(0.772406 0.172798 65.367)',
      '--warning-foreground': 'oklch(0.829017 0.171221 81.038)',
      '--primary': 'oklch(0.762174 0.124117 52.082)',
      '--ring': 'oklch(0.762174 0.124117 52.082)',
    },
  },
  irisDark: {
    dark: true,
    vars: {
      '--sidebar': 'oklch(0.266743 0.044689 294.138)',
      '--sidebar-foreground': 'oklch(0.990339 0.008411 325.64)',
      '--sidebar-muted-foreground': 'oklch(0.668773 0.021522 302.949)',
      '--sidebar-border': 'oklch(0.545895 0.027522 299.871 / 0.35)',
      '--sidebar-row-hover': 'oklch(0.320808 0.062152 294.23)',
      '--sidebar-row-active': 'oklch(0.355677 0.073167 294.217)',
      '--sidebar-row-selected': 'oklch(0.372806 0.078525 294.203)',
      '--info': 'oklch(62.3% .214 259.815)',
      '--info-foreground': 'oklch(70.7% .165 254.624)',
      '--warning': 'oklch(0.772406 0.172798 65.367)',
      '--warning-foreground': 'oklch(0.829017 0.171221 81.038)',
      '--primary': 'oklch(0.671712 0.169136 293.929)',
      '--ring': 'oklch(0.671712 0.169136 293.929)',
    },
  },
};

function cardRow(id, { parent = '', active = false, selected = false, extraClass = '' } = {}) {
  const cls = [
    active ? 'bg-sidebar-row-active' : selected ? 'bg-sidebar-row-selected' : 'bg-transparent',
    extraClass,
  ].filter(Boolean).join(' ');
  const attrs = [
    'data-testid="sidebar-row-card"',
    parent ? `data-sidebar-parent="${parent}"` : '',
    active ? 'aria-current="page"' : '',
    `id="${id}"`,
    `class="${cls}"`,
  ].filter(Boolean).join(' ');
  return `<li data-thread-item="env:${id}"><div ${attrs} role="button">
    <div class="relative z-10"><div class="flex items-center gap-1.5"><i class="size-4"></i><span class="flex-1">Project</span><span class="group/sidebar-status-slot relative ml-auto flex"><span>Working</span><span id="${id}-hover-actions">Snooze Settle</span></span></div><div class="flex"><span class="min-w-0 flex-1 text-start text-sm truncate">${id}</span></div></div>
  </div></li>`;
}

function slimRow(id, parent) {
  return `<li data-thread-item="env:${id}"><div id="${id}" data-testid="sidebar-row-slim" data-sidebar-parent="${parent}" role="button"><span class="min-w-0 flex-1 text-start text-sm truncate">${id}</span></div></li>`;
}

function shelfHeader(name, label, count, { mtAuto = false } = {}) {
  return `<li data-testid="sidebar-${name}-header" class="h-8${mtAuto ? ' mt-auto' : ''}"><button type="button" data-testid="sidebar-${name}-shelf-toggle" class="flex h-8 w-full items-center gap-2 px-2 rounded-md text-xs text-sidebar-muted-foreground"><span class="truncate">${label}</span><span aria-hidden="true" class="h-px min-w-2 flex-1 invisible"></span><span>${count}</span></button></li>`;
}

const PAGE = `<!doctype html><html class="dark"><head><meta charset="utf-8"><style>
@layer utilities {
  :root { --font-sans: Arial, sans-serif; --background: #111; --foreground: #eee; --muted-foreground: #999; --border: #333; --popover: #222; }
  body { margin: 0; font: 14px var(--font-sans); background: var(--sidebar); color: var(--sidebar-foreground); }
  #side { width: 260px; height: 700px; display: flex; flex-direction: column; background: var(--sidebar); }
  #list { margin: 0; padding: 6px; list-style: none; display: flex; flex-direction: column; gap: 1px; flex: 1; }
  li { list-style: none; }
  .flex { display: flex; } .flex-1 { flex: 1; } .min-w-0 { min-width: 0; } .min-w-2 { min-width: 8px; }
  .w-full { width: 100%; } .h-8 { height: 32px; } .h-px { height: 1px; } .size-4 { width: 16px; height: 16px; }
  .items-center { align-items: center; } .gap-2 { gap: 8px; } .gap-1\\.5 { gap: 6px; } .px-2 { padding-inline: 8px; }
  .ml-auto { margin-left: auto; } .mt-auto { margin-top: auto; } .relative { position: relative; }
  .rounded-md { border-radius: 6px; } .text-xs { font-size: 12px; } .text-sm { font-size: 14px; }
  .truncate { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .invisible { visibility: hidden; }
  .bg-transparent { background-color: transparent; }
  .bg-sidebar-row-active { background-color: var(--sidebar-row-active); }
  .bg-sidebar-row-selected { background-color: var(--sidebar-row-selected); }
  .text-sidebar-muted-foreground { color: var(--sidebar-muted-foreground); }
  .text-primary { color: var(--primary); }
  .shadow-lg { box-shadow: 0 10px 15px rgba(0,0,0,.4); }
  .ring-primary\\/70 { box-shadow: inset 0 0 0 1px var(--primary); }
  .focus-visible\\:ring-2:focus-visible { box-shadow: inset 0 0 0 2px var(--ring); }
  button { border: 0; background: transparent; cursor: pointer; font: inherit; }
}
</style><link rel="stylesheet" href="/extras.css"></head><body>
<div id="side" data-slot="sidebar-content"><ul id="list">
  <li data-testid="sidebar-pinned-header"></li>
  ${cardRow('pin-row')}
  <li data-testid="sidebar-pinned-divider"></li>
  ${cardRow('normal-row')}
  ${shelfHeader('working', 'Working', 3, { mtAuto: true })}
  ${cardRow('work-open', { parent: 'shelf:working', active: true })}
  ${cardRow('work-rest', { parent: 'shelf:working' })}
  ${cardRow('work-sel', { parent: 'shelf:working', selected: true, extraClass: 'focus-visible:ring-2' })}
  ${cardRow('work-drop', { parent: 'shelf:working', selected: true, extraClass: 'ring-primary/70' })}
  ${cardRow('work-drag', { parent: 'shelf:working', selected: true, extraClass: 'shadow-lg' })}
  ${shelfHeader('snoozed', 'Snoozed', 2)}
  ${slimRow('snooze-row', 'shelf:snoozed')}
  ${shelfHeader('settled', 'Settled', 41)}
  ${slimRow('settle-row', 'shelf:settled')}
</ul></div>
<button id="anchor">Panel</button>
<script>localStorage.setItem('t3x:settings:v1', JSON.stringify({ compactThreads: true, oneRowTitles: false, foldOlder: false, workingHeader: true, pinnedLabel: true, marker: 'bar' })); window.__T3X_PICK_TEST__ = {};</script>
<script src="/extras.js"></script></body></html>`;

test('sidebar sections Option A\': visible 2px rules, Working wash, overlays, mt-auto, drag guard and AA contrast', { timeout: 60_000 }, async t => {
  const chromePath = newestHeadlessChrome();
  assert.ok(fs.existsSync(chromePath), `headless Chrome missing: ${chromePath}`);
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://x').pathname;
    const file = { '/extras.css': 'text/css', '/extras.js': 'text/javascript' }[name];
    res.writeHead(200, { 'Content-Type': `${file || 'text/html'}; charset=utf-8` });
    if (name === '/font-catalog') return res.end('{"families":[]}');
    if (name === '/state') return res.end('{"localEnvironmentId":"env"}');
    if (name !== '/' && !file) return res.end('{}');
    res.end(file ? fs.readFileSync(path.join(SRC, 'public', name.slice(1)), 'utf8').replace('const BASE = "http://127.0.0.1:8793/";', 'const BASE = location.origin + "/";') : PAGE);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const tmp = path.join(SRC, 'task-output/tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const profile = fs.mkdtempSync(path.join(tmp, 'sidebar-sections-'));
  const chrome = spawn(chromePath, ['--headless', '--disable-gpu', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' });
  const timer = setTimeout(() => chrome.kill('SIGKILL'), 55_000);
  let ws;
  try {
    let wsUrl;
    for (let i = 0; i < 100 && !wsUrl; i++) {
      await new Promise(r => setTimeout(r, 100));
      try {
        const [port] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n');
        wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => p.type === 'page')?.webSocketDebuggerUrl;
      } catch {}
    }
    assert.ok(wsUrl, 'no debugger page');
    ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    let id = 0;
    const pending = new Map();
    const errors = [];
    ws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails);
    });
    const send = (method, params = {}) => new Promise(resolve => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
    const ev = async expression => {
      const m = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      assert.ok(!m.result?.exceptionDetails, JSON.stringify(m.result?.exceptionDetails));
      return m.result?.result?.value;
    };
    const frames = () => ev('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))');
    const setTheme = async (themeKey) => {
      const th = THEMES[themeKey];
      await ev(`(() => {
        const r = document.documentElement;
        r.classList.toggle('dark', ${Boolean(th.dark)});
        for (const [k, v] of Object.entries(${JSON.stringify(th.vars)})) r.style.setProperty(k, v);
        return 1;
      })()`);
      await frames();
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await send('DOM.enable');
    await send('CSS.enable');
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    assert.equal(await ev(`(async () => { for (let i = 0; i < 100; i++) { if (window.__T3X_PICK_TEST__?.openPanel && document.documentElement.hasAttribute('data-t3x-working')) return 'ready'; await new Promise(r => setTimeout(r, 50)); } return 'missing'; })()`), 'ready');
    const forcePseudo = async (selector, forcedPseudoClasses) => {
      const doc = await send('DOM.getDocument', { depth: -1 });
      const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector });
      assert.ok(q.result?.nodeId, `missing node for ${selector}`);
      await send('CSS.forcePseudoState', { nodeId: q.result.nodeId, forcedPseudoClasses });
      await frames();
    };
    await setTheme('stockDark');

    await t.test('shelf divider lines override .invisible to visible 2px rules and header li keeps mt-auto', async () => {
      const r = await ev(`(() => {
        const names = ['working', 'snoozed', 'settled'];
        const headers = Object.fromEntries(names.map(n => {
          const li = document.querySelector('[data-testid="sidebar-' + n + '-header"]');
          const btn = document.querySelector('[data-testid="sidebar-' + n + '-shelf-toggle"]');
          const line = btn.querySelector(':scope > span[aria-hidden].flex-1');
          const lc = getComputedStyle(line);
          const lic = getComputedStyle(li);
          return [n, {
            vis: lc.visibility,
            h: lc.height,
            lineBg: lc.backgroundColor,
            btnBg: getComputedStyle(btn).backgroundColor,
            padTop: lic.paddingTop,
            top: li.getBoundingClientRect().top,
          }];
        }));
        const normalBottom = document.getElementById('normal-row').getBoundingClientRect().bottom;
        return { headers, normalBottom };
      })()`);
      for (const n of ['working', 'snoozed', 'settled']) {
        assert.equal(r.headers[n].vis, 'visible', `${n} line must be visible`);
        assert.equal(r.headers[n].h, '2px', `${n} line must be 2px tall`);
        assert.notEqual(r.headers[n].lineBg, 'rgba(0, 0, 0, 0)', `${n} line must have color`);
        assert.notEqual(r.headers[n].btnBg, 'rgba(0, 0, 0, 0)', `${n} band must have color`);
      }
      assert.equal(r.headers.working.padTop, '8px');
      assert.equal(r.headers.snoozed.padTop, '6px');
      assert.equal(r.headers.settled.padTop, '6px');
      assert.ok(r.headers.working.top > r.normalBottom + 100, `mt-auto must push shelves down (working top ${r.headers.working.top} vs normal bottom ${r.normalBottom})`);
    });

    await t.test('Working rows get layered blue wash (rest/hover/open), guarded multi-select ring, overlay paint order and compact invariants', async () => {
      // Use oceanDark so --sidebar-row-hover, --sidebar-row-active, --sidebar-row-selected and --sidebar are all distinct colors.
      await setTheme('oceanDark');
      const parseGradients = `
        const gradientColors = (bgImg) => {
          const out = [];
          const re = /linear-gradient\\((.+?),\\s*\\1\\)/g;
          let m;
          while ((m = re.exec(bgImg)) !== null) out.push(m[1].trim());
          return out;
        };
        const resolveColor = (cssColor) => {
          const probe = document.createElement('div');
          probe.style.color = cssColor;
          document.body.appendChild(probe);
          const resolved = getComputedStyle(probe).color;
          probe.remove();
          return resolved;
        };
      `;

      const rest = await ev(`(() => {
        ${parseGradients}
        const get = id => document.getElementById(id);
        const wOpen = getComputedStyle(get('work-open'));
        const wRest = getComputedStyle(get('work-rest'));
        const wSel = getComputedStyle(get('work-sel'));
        const wDrop = getComputedStyle(get('work-drop'));
        const wDrag = getComputedStyle(get('work-drag'));
        const sn = getComputedStyle(get('snooze-row'));
        const st = getComputedStyle(get('settle-row'));
        const norm = getComputedStyle(get('normal-row'));
        const openAfter = getComputedStyle(get('work-open'), '::after');
        const itemPads = [...document.querySelectorAll('li[data-thread-item]')].map(li => {
          const c = getComputedStyle(li);
          return [parseFloat(c.paddingTop), parseFloat(c.paddingBottom)];
        });
        return {
          openWash: gradientColors(wOpen.backgroundImage)[0] ?? null,
          restWash: gradientColors(wRest.backgroundImage)[0] ?? null,
          openBgColor: wOpen.backgroundColor,
          selShadow: wSel.boxShadow,
          dropShadow: wDrop.boxShadow,
          dragShadow: wDrag.boxShadow,
          expectedPrimaryRing: resolveColor('var(--primary)'),
          expectedRing: resolveColor('var(--ring)'),
          expectedHoverBg: resolveColor('var(--sidebar-row-hover)'),
          expectedActiveBg: resolveColor('var(--sidebar-row-active)'),
          expectedSelectedBg: resolveColor('var(--sidebar-row-selected)'),
          expectedSidebarBg: resolveColor('var(--sidebar)'),
          snoozeImg: sn.backgroundImage,
          settleImg: st.backgroundImage,
          normImg: norm.backgroundImage,
          markerWidth: openAfter.width,
          markerContent: openAfter.content,
          itemPads,
        };
      })()`);

      assert.ok(rest.openWash && rest.openWash !== 'rgba(0, 0, 0, 0)', 'open Working row uses non-transparent wash');
      assert.ok(rest.restWash && rest.restWash !== 'rgba(0, 0, 0, 0)', 'resting Working row uses non-transparent wash');
      assert.notEqual(rest.openWash, rest.restWash, 'open Working row wash must be distinct from resting wash');
      assert.equal(rest.openBgColor, rest.expectedActiveBg, 'native active background-color must remain intact');
      assert.notEqual(rest.expectedHoverBg, rest.expectedSelectedBg, 'fixture must use distinct hover and selected colors');
      assert.match(rest.selShadow, /inset/, 'multi-selected Working row gets 1px inset ring');
      assert.match(rest.selShadow, /1px/, 'multi-selected Working row ring is 1px');
      assert.ok(rest.dropShadow.includes(rest.expectedPrimaryRing), `ring-primary/70 drop target must keep primary ring, got ${rest.dropShadow}`);
      assert.doesNotMatch(rest.dragShadow, /inset/, 'dragging row keeps its native shadow-lg');
      assert.equal(rest.snoozeImg, 'none', 'Snoozed row stays untinted');
      assert.equal(rest.settleImg, 'none', 'Settled row stays untinted');
      assert.equal(rest.normImg, 'none', 'Active normal row stays untinted');
      assert.equal(rest.markerContent, '""', 'selected thread marker ::after stays intact');
      assert.equal(rest.markerWidth, '3px', 'selected thread marker keeps 3px width');
      assert.ok(rest.itemPads.every(([t, b]) => t === 2 && b === 2), `break-check compact padding-block: 2px broken: ${JSON.stringify(rest.itemPads)}`);

      // Exercise real :hover one element at a time (CDP DOM.getDocument resets prior forced pseudo states).
      const readRowHover = async (id) => {
        await forcePseudo(`#${id}`, ['hover']);
        const out = await ev(`(() => {
          ${parseGradients}
          const row = getComputedStyle(document.getElementById(${JSON.stringify(id)}));
          const ov = getComputedStyle(document.getElementById(${JSON.stringify(`${id}-hover-actions`)}));
          return {
            wash: gradientColors(row.backgroundImage)[0] ?? null,
            ovLayers: gradientColors(ov.backgroundImage),
            ovBase: ov.backgroundColor,
          };
        })()`);
        await forcePseudo(`#${id}`, []);
        return out;
      };

      const restHover = await readRowHover('work-rest');
      const openHover = await readRowHover('work-open');
      const selHover = await readRowHover('work-sel');

      assert.ok(restHover.wash && restHover.wash !== rest.restWash, `hovered Working row must intensify wash over resting state (${restHover.wash} vs ${rest.restWash})`);
      assert.notEqual(restHover.wash, rest.openWash, 'hover Working wash must remain distinct from open wash');
      assert.equal(openHover.wash, rest.openWash, 'open Working row must keep its active wash while hovered');

      // Exact paint order on compact hover-action overlays: [wash, row-bg] over sidebar base.
      assert.deepEqual(restHover.ovLayers, [restHover.wash, rest.expectedHoverBg], 'resting Working overlay must paint hover wash over hover row-bg');
      assert.equal(restHover.ovBase, rest.expectedSidebarBg, 'resting Working overlay base must be --sidebar');
      assert.deepEqual(openHover.ovLayers, [openHover.wash, rest.expectedActiveBg], 'open Working overlay must paint active wash over active row-bg');
      assert.equal(openHover.ovBase, rest.expectedSidebarBg, 'open Working overlay base must be --sidebar');
      assert.deepEqual(selHover.ovLayers, [selHover.wash, rest.expectedSelectedBg], 'multi-selected Working overlay must paint hover wash over selected row-bg');
      assert.equal(selHover.ovBase, rest.expectedSidebarBg, 'multi-selected Working overlay base must be --sidebar');

      // Real :focus-visible guard on multi-selected Working row: must preserve 2px --ring focus shadow.
      await forcePseudo('#work-sel', ['focus-visible']);
      const focusedShadow = await ev(`getComputedStyle(document.getElementById('work-sel')).boxShadow`);
      await forcePseudo('#work-sel', []);
      assert.ok(focusedShadow.includes(rest.expectedRing) && focusedShadow.includes('2px'), `focus-visible must keep 2px --ring shadow, got ${focusedShadow}`);
      assert.notEqual(focusedShadow, rest.selShadow, 'focus-visible must replace the 1px multi-select ring');

      await setTheme('stockDark');
    });

    await t.test('Settled drag-over (.text-primary) keeps dashed primary outline and band at rest and on :hover', async () => {
      const rest = await ev(`(() => {
        const btn = document.querySelector('[data-testid="sidebar-settled-shelf-toggle"]');
        const probe = document.createElement('div');
        probe.style.color = 'var(--primary)';
        document.body.appendChild(probe);
        const expectedPrimary = getComputedStyle(probe).color;
        probe.remove();
        return {
          restBg: getComputedStyle(btn).backgroundColor,
          restOutline: getComputedStyle(btn).outlineStyle,
          expectedPrimary,
        };
      })()`);
      assert.equal(rest.restOutline, 'none');

      await forcePseudo('[data-testid="sidebar-settled-shelf-toggle"]', ['hover']);
      const neutralHoverBg = await ev(`getComputedStyle(document.querySelector('[data-testid="sidebar-settled-shelf-toggle"]')).backgroundColor`);
      await forcePseudo('[data-testid="sidebar-settled-shelf-toggle"]', []);

      await ev(`document.querySelector('[data-testid="sidebar-settled-shelf-toggle"]').classList.add('text-primary'); 1`);
      await frames();
      const dropRest = await ev(`(() => {
        const c = getComputedStyle(document.querySelector('[data-testid="sidebar-settled-shelf-toggle"]'));
        return { bg: c.backgroundColor, color: c.color, outline: c.outlineStyle, width: c.outlineWidth };
      })()`);
      assert.equal(dropRest.outline, 'dashed');
      assert.equal(dropRest.width, '1px');
      assert.equal(dropRest.color, rest.expectedPrimary);
      assert.notEqual(dropRest.bg, rest.restBg);

      await forcePseudo('[data-testid="sidebar-settled-shelf-toggle"]', ['hover']);
      const dropHover = await ev(`(() => {
        const c = getComputedStyle(document.querySelector('[data-testid="sidebar-settled-shelf-toggle"]'));
        return { bg: c.backgroundColor, color: c.color, outline: c.outlineStyle, width: c.outlineWidth };
      })()`);
      assert.equal(dropHover.outline, 'dashed', 'Settled drag-over must keep dashed outline on :hover');
      assert.equal(dropHover.width, '1px', 'Settled drag-over must keep 1px outline width on :hover');
      assert.equal(dropHover.color, rest.expectedPrimary, 'Settled drag-over must keep --primary color on :hover');
      assert.equal(dropHover.bg, dropRest.bg, 'Settled drag-over must keep primary band on :hover');
      assert.notEqual(dropHover.bg, neutralHoverBg, 'Settled drag-over :hover must not fall back to neutral Settled hover band');

      await forcePseudo('[data-testid="sidebar-settled-shelf-toggle"]', []);
      await ev(`document.querySelector('[data-testid="sidebar-settled-shelf-toggle"]').classList.remove('text-primary'); 1`);
      await frames();
    });

    await t.test('WCAG AA contrast >= 4.5:1 (unrounded) for Working, Snoozed and Settled labels across all 5 themes (rest and :hover)', async () => {
      const readContrast = () => ev(`(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 1; canvas.height = 1;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const toRgba = (color, base = [0, 0, 0]) => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = 'rgb(' + base.join(',') + ')';
          ctx.fillRect(0, 0, 1, 1);
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 1, 1);
          const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
          return [r, g, b];
        };
        const lum = ([r, g, b]) => {
          const lin = c => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
          return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
        };
        const cr = (c1, c2) => { const l1 = lum(c1), l2 = lum(c2); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
        const sideBg = toRgba(getComputedStyle(document.getElementById('side')).backgroundColor);
        return Object.fromEntries(['working', 'snoozed', 'settled'].map(n => {
          const btn = document.querySelector('[data-testid="sidebar-' + n + '-shelf-toggle"]');
          const cs = getComputedStyle(btn);
          const surface = toRgba(cs.backgroundColor, sideBg);
          const fg = toRgba(cs.color, surface);
          return [n, cr(fg, surface)];
        }));
      })()`);

      for (const themeKey of Object.keys(THEMES)) {
        await setTheme(themeKey);
        const restRatios = await readContrast();
        for (const [shelf, ratio] of Object.entries(restRatios)) {
          assert.ok(ratio >= 4.5, `${themeKey} ${shelf} rest contrast ${ratio.toFixed(2)}:1 is below WCAG AA 4.5:1`);
        }
        for (const shelf of ['working', 'snoozed', 'settled']) {
          const sel = `[data-testid="sidebar-${shelf}-shelf-toggle"]`;
          await forcePseudo(sel, ['hover']);
          const hoverRatios = await readContrast();
          assert.ok(hoverRatios[shelf] >= 4.5, `${themeKey} ${shelf} hover contrast ${hoverRatios[shelf].toFixed(2)}:1 is below WCAG AA 4.5:1`);
          await forcePseudo(sel, []);
        }
      }
      await setTheme('stockDark');
    });

    await t.test('panel switch is relabeled "Stronger section headers" and cleanly toggles all section styling off/on', async () => {
      const before = await ev(`(() => {
        window.__T3X_PICK_TEST__.openPanel(document.getElementById('anchor'));
        const input = document.querySelector('[data-focus="sw-workingHeader"]');
        const label = input?.closest('.t3x-set')?.textContent || '';
        const pinWeightOn = getComputedStyle(document.querySelector('[data-testid="sidebar-pinned-header"]'), '::before').fontWeight;
        input.click();
        return { label, pinWeightOn, hasAttr: document.documentElement.hasAttribute('data-t3x-working') };
      })()`);
      await frames();
      assert.match(before.label, /Stronger section headers/);
      assert.match(before.label, /Working in blue with tinted threads/);
      assert.equal(before.pinWeightOn, '600', 'Pinned label gets 600 weight when stronger section headers is on');
      assert.equal(before.hasAttr, false);
      const offState = await ev(`(() => ({
        lineVis: getComputedStyle(document.querySelector('[data-testid="sidebar-working-shelf-toggle"] > span[aria-hidden].flex-1')).visibility,
        workImg: getComputedStyle(document.getElementById('work-rest')).backgroundImage,
        pinWeightOff: getComputedStyle(document.querySelector('[data-testid="sidebar-pinned-header"]'), '::before').fontWeight,
      }))()`);
      assert.equal(offState.lineVis, 'hidden', 'switching off restores T3 default line visibility');
      assert.equal(offState.workImg, 'none', 'switching off removes Working row wash');
      assert.equal(offState.pinWeightOff, '500', 'switching off restores Pinned label default 500 weight');
      await ev(`document.querySelector('[data-focus="sw-workingHeader"]').click(); 1`);
      await frames();
      assert.equal(await ev(`document.documentElement.hasAttribute('data-t3x-working')`), true);
    });

    assert.deepEqual(errors, []);
  } finally {
    clearTimeout(timer);
    try { ws?.close(); } catch {}
    chrome.kill('SIGKILL');
    await new Promise(resolve => {
      if (chrome.exitCode !== null || chrome.signalCode !== null) resolve();
      else { chrome.once('exit', resolve); setTimeout(resolve, 3000); }
    });
    server.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
