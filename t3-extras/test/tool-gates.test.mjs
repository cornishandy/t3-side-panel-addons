// Missing /state.tools means both optional tools are on. An explicit false hides that tool.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../public/extras.js", import.meta.url), "utf8");
const box = { window: { __T3X_TEST__: {} } };
vm.runInNewContext(source, box);
const C = box.window.__T3X_TEST__.core;

const labs = [{ id: "claude", windows: [] }];

test("a state with no tools object keeps lab-usage and handover on", () => {
  for (const state of [undefined, null, {}, { usage: { labs } }]) {
    const gates = C.toolGates(state);
    assert.equal(gates.labUsage, true);
    assert.equal(gates.handover, true);
  }
  assert.deepEqual(C.labsForMerge({ usage: { labs } }), labs);
  assert.equal(C.handoverGate({}), null);
});

test("tools.labUsage false drops the lab-usage merge and its failure, including a stale failedAt", () => {
  const state = { tools: { labUsage: false, handover: true }, usage: { labs, failedAt: 5, fetchedAt: 1 }, transportFailedAt: 9 };
  assert.equal(C.toolGates(state).labUsage, false);
  assert.equal(C.labsForMerge(state), null);
  assert.equal(C.labFailure(state, state.transportFailedAt), null);
});

test("tools present still reports a lab-usage or transport failure", () => {
  const state = { tools: { labUsage: true }, usage: { failedAt: 20, fetchedAt: 10 } };
  assert.equal(C.labFailure(state, null), 20);
  assert.equal(C.labFailure(state, 15), 15);
  assert.deepEqual(C.labsForMerge({ tools: { labUsage: true }, usage: { labs } }), labs);
});

test("tools.handover false is the only reason the gate names the missing tool", () => {
  assert.equal(C.handoverGate({ tools: { handover: false } }), "needs the handover tool");
  assert.equal(C.handoverGate({ tools: { handover: true } }), null);
  assert.equal(C.handoverGate({ tools: {} }), null);
});
