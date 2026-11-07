// Real EventTarget dispatch; actual source instances and actual runtime teardown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

export function probeFooterLifecycle(sourcePath = new URL('../public/extras.js', import.meta.url)) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const start = source.indexOf('  W.t3xTeardown = () => {');
  const terminator = '    delete W.t3xTeardown;\n  };';
  const end = source.indexOf(terminator, start);
  assert.ok(start > 0 && end > start, 'actual runtime teardown found');
  const teardown = source.slice(start, end + terminator.length);
  const earlyReturn = '    W.__T3X_TEST__.core = core;\n    return;';
  assert.ok(source.includes(earlyReturn));
  // __T3X_TEST__ skips DOM startup, including teardown registration. Install the
  // verbatim production teardown INSIDE this source instance's lexical scope.
  // Only unrelated DOM/network/font facilities are stubbed; footer state and
  // listeners are the actual ones created before the test early return.
  const instrumented = source.replace(earlyReturn, `
    W.__T3X_TEST__.core = core;
    (() => {
      let disposed = false, routeToken = 0, inflight = null, rafId = 0;
      const requests = new Set(), t3Pending = new Set(), cleanups = [], timers = new Set();
      const features = {}, OWN = 'data-t3x', ROOT_ATTRS = [], ROLE = {}, roleFaces = {};
      const D = { querySelectorAll: () => [], documentElement: { removeAttribute() {} }, fonts: { delete() {} } };
      const teardownVisualization = () => {}, closePopover = () => {}, endInspector = () => {};
      const closeFontWorkspace = () => {}, closeFontPreviews = () => {};
      ${teardown}
    })();
    return;`);
  const window = { __T3X_TEST__: {} };
  const ctx = vm.createContext({ window });
  const load = () => {
    window.__T3X_TEST__ = {};
    vm.runInContext(instrumented, ctx);
    return window.__T3X_TEST__.core;
  };
  let core = load();
  let open = true, toggles = 0;
  const button = new EventTarget();
  const details = {
    getAttribute: () => String(open),
    querySelector: () => button,
  };
  const root = { querySelectorAll: selector => selector === core.FOOTER_DETAILS ? [details] : [] };
  const pass = mode => core.footerPass(root, mode, new WeakSet());
  pass('always-show');
  // Node has no DOM button default action. Model native activation AFTER real
  // EventTarget dispatch, as a browser does; cancellation suppresses that action.
  // This avoids Node's lack of capture/bubble phases when host handlers predate
  // the replacement instance's capture guards. Trusted React handling is also
  // covered by footer-keyboard.test.mjs in an actual browser.
  const send = (type, key) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperty(event, 'key', { value: key });
    const before = toggles;
    if (button.dispatchEvent(event)) { open = !open; toggles++; }
    return { prevented: event.defaultPrevented, toggles: toggles - before, open };
  };
  button.click = () => send('click');
  const checks = [];
  const activations = [['keydown', 'Enter'], ['keyup', ' '], ['click', undefined]];
  for (let replacement = 1; replacement <= 3; replacement++) {
    pass('always-show');
    for (const [type, key] of activations) {
      assert.deepEqual(send(type, key), { prevented: true, toggles: 0, open: true });
    }
    const teardownFn = window.t3xTeardown;
    assert.equal(typeof teardownFn, 'function');
    teardownFn(); // same ordering as keeper.mjs: old teardown, then new script
    assert.equal(window.t3xTeardown, undefined);
    const afterTeardown = send('keydown', 'Enter');
    core = load();
    pass('start-open');
    for (const [type, key] of activations) {
      const before = open;
      const result = send(type, key);
      assert.deepEqual(result, { prevented: false, toggles: 1, open: !before }, `replacement ${replacement}: start-open ${key || type} toggles SAME button`);
      checks.push({ replacement, type, key, ...result });
    }
    assert.deepEqual(afterTeardown, { prevented: false, toggles: 1, open: false }, 'actual teardown releases the old guard');
    // New instance still enforces always-show, including restoration from closed.
    pass('always-show');
    assert.equal(open, true);
  }
  window.t3xTeardown();
  return { sourcePath: String(sourcePath), replacements: 3, checks, actualTeardown: true, sameButton: true };
}

if (!process.env.T3X_FOOTER_LIFECYCLE_PROBE_ONLY) test('footer team list: actual teardown releases guards before a new start-open instance uses the same button', () => probeFooterLifecycle());
