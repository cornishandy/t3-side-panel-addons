import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/extras.js', import.meta.url), 'utf8');
const box = { window: { __T3X_TEST__: {} } };
vm.runInNewContext(source, box);
const core = box.window.__T3X_TEST__.core;
const start = source.indexOf('  function usageDetail() {');
const end = source.indexOf('  usageDetail.label', start);

function detail(state, labs, readAt = null) {
  const now = Date.now();
  const views = labs.map(source => core.labView({
    id: 'claude', name: 'Claude', source, hasMeter: true, live: true, fetchedAt: now - 60000,
    windows: [{ role: 'long', kind: 'weekly', usedPct: 20, fetchedAt: now - 60000, resetsAt: now + 86400000, lengthSec: 604800 }],
  }, now, {}));
  const context = {
    ...core, Date, known: Number.isFinite, lastState: { tools: { labUsage: true }, usage: { fetchedAt: now - 120000 } },
    t3: { state, readAt }, currentViews: () => views, history: { bySeries: {} },
    bSvg: () => '', dSvg: () => '',
    h: (_tag, attrs, ...children) => [attrs?.text ?? '', ...children].flat(Infinity).filter(Boolean).join(' '),
  };
  vm.runInNewContext(source.slice(start, end) + '\nthis.result = usageDetail();', context);
  return context.result.join(' ');
}

test('quota source notes claim lab-usage readings only when displayed', () => {
  for (const state of ['absent', 'missing', 'schema', 'noenv', 'error']) {
    assert.match(detail(state, ['lab-usage']), /Showing lab-usage readings\./);
    assert.doesNotMatch(detail(state, []), /Showing lab-usage|showing lab-usage only/);
    assert.doesNotMatch(detail(state, ['t3']), /Showing lab-usage/);
  }
});

test('usage header labels cache-read and lab-usage times; cards retain their source', () => {
  assert.match(detail('absent', ['lab-usage']), /lab-usage updated 2 min ago/);
  const mixed = detail('ok', ['t3', 'lab-usage'], Date.now() - 180000);
  assert.match(mixed, /T3 cache read 3 min ago/);
  assert.match(mixed, /T3's reading 1 min ago/);
  assert.match(mixed, /lab-usage's reading 1 min ago/);
});
