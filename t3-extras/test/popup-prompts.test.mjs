import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Private acceptance cases; run against the final released-and-extended source.
const source = fs.readFileSync(process.env.POPUP_SOURCE || new URL('../public/extras.js', import.meta.url), 'utf8');
const box = { window: { __T3X_TEST__: {} } };
vm.runInNewContext(source, box);
const C = box.window.__T3X_TEST__.core;
const read = value => JSON.parse(JSON.stringify(C.readSettings(JSON.stringify(value))));
const main = { family: 'Kalam', size: 125 };
const off = { family: 'off', size: null };

test('Sent-message preference migrates Main family and size with true or omitted mine', () => {
  for (const fontSchema of [undefined, 2]) {
    for (const fontTargets of [undefined, {}, { mine: true }]) {
      const value = read({ fontSchema, fontTargets, fontMain: main });
      assert.deepEqual(value.fontPrompts, main);
      assert.deepEqual(value.fontMain, main);
      assert.equal(value.fontSchema, 2);
    }
  }
});

test('Legacy mine false migrates prompts to Off while retaining the stored flag', () => {
  for (const fontSchema of [undefined, 2]) {
    const value = read({ fontSchema, fontMain: main, fontTargets: { mine: false } });
    assert.deepEqual(value.fontPrompts, off);
    assert.deepEqual(value.fontMain, main);
    assert.equal(value.fontTargets.mine, false);
  }
});

test('Explicit prompts choices take precedence, including Off and invalid input', () => {
  for (const fontTargets of [{ mine: true }, { mine: false }]) {
    for (const choice of [off, { family: 'Neucha', size: 80 }, { family: 'Caveat', size: 150 }]) {
      const value = read({ fontSchema: 2, fontMain: main, fontTargets, fontPrompts: choice });
      assert.deepEqual(value.fontPrompts, choice);
    }
    assert.deepEqual(read({ fontMain: main, fontTargets, fontPrompts: null }).fontPrompts, off);
    assert.deepEqual(read({ fontMain: main, fontTargets, fontPrompts: { family: '<bad>', size: 900 } }).fontPrompts, off);
  }
});

test('Prompts migrate once and then survive Main and Composer changes independently', () => {
  const initial = read({ fontMain: main, fontBody: { family: 'Caveat', size: 90 } });
  assert.deepEqual(read(initial), initial);
  const later = read({ ...initial, fontMain: { family: 'Neucha', size: 150 }, fontComposer: off, fontTargets: { ...initial.fontTargets, mine: false } });
  assert.deepEqual(later.fontPrompts, main);
  const promptsChanged = read({ ...later, fontPrompts: { family: 'Patrick Hand', size: 100 } });
  assert.deepEqual(promptsChanged.fontMain, later.fontMain);
  assert.deepEqual(promptsChanged.fontComposer, later.fontComposer);
  assert.deepEqual(read({ ...later, fontPrompts: off, fontMain: main }).fontPrompts, off);
});

test('Adding prompts does not remigrate missing schema-2 roles or change existing settings', () => {
  const value = read({ fontSchema: 2, fontMain: main, fontBody: { family: 'Caveat', size: 90 }, fontTargets: { plantext: true, mine: true }, marker: 'outline', printOnly: false, showPartly: true, interfaceFontsOpen: true });
  for (const key of ['fontComposer', 'fontQuotes', 'fontInterface', 'fontPlans', 'fontQuestions', 'fontReasoning', 'fontViz']) assert.deepEqual(value[key], off, key);
  assert.deepEqual(value.fontPrompts, main);
  assert.equal(value.fontSchema, 2);
  assert.equal(value.marker, 'outline');
  assert.equal(value.printOnly, false);
  assert.equal(value.showPartly, true);
  assert.equal(value.interfaceFontsOpen, true);
});

test('All legacy presets preserve the independent role migration contract', () => {
  for (const font of ['3A', '3B', '3C', '3D']) {
    const value = read({ font, fontMain: main });
    assert.deepEqual(value.fontPrompts, main);
    assert.deepEqual(value.fontComposer, value.fontBody);
    assert.deepEqual(value.fontQuotes, value.fontBody);
    assert.deepEqual(read(value), value);
  }
});

test('All filter combinations preserve menu order, wrap, and hidden current choices', () => {
  const catalog = [
    { name: 'Narrow Print', group: 'hand', style: 'print', source: 'google', width: 100 },
    { name: 'Semi Face', group: 'hand', style: 'partly', source: 'google', width: 130 },
    { name: 'Joined Face', group: 'hand', style: 'joined', source: 'google', width: 150 },
    { name: 'Missing Mac', group: 'cond', style: 'print', source: 'mac', width: 170 },
  ];
  const native = name => name !== 'Missing Mac';
  for (const printOnly of [false, true]) for (const showPartly of [false, true]) {
    const settings = { printOnly, showPartly };
    const entries = C.fontOptions(catalog, settings, 'off', native).flatMap(group => group.options).filter(option => native(option.name));
    for (let index = 0; index < entries.length; index++) {
      const current = entries[index].name;
      assert.equal(C.fontNeighbor(catalog, settings, current, 1, native), entries.length > 1 ? entries[(index + 1) % entries.length].name : null);
      assert.equal(C.fontNeighbor(catalog, settings, current, -1, native), entries.length > 1 ? entries[(index + entries.length - 1) % entries.length].name : null);
    }
    const retained = C.fontOptions(catalog, settings, 'Joined Face', native).flatMap(group => group.options).find(option => option.name === 'Joined Face');
    assert.ok(retained);
    assert.equal(retained.hidden, !C.fontVisible(catalog[2], settings));
  }
});
