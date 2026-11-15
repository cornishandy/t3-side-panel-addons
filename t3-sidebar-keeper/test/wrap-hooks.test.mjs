// Pure planner fixtures: never import/run the keeper, open an archive, or read installed state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as acorn from '../vendor/acorn/acorn.mjs';

const source = fs.readFileSync(new URL('../keeper.mjs', import.meta.url), 'utf8');
const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const decl = name => ast.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === name);
const hooks = ast.body.find(n => n.type === 'VariableDeclaration' && n.declarations.some(d => d.id.name === 'WRAP_HOOKS'));
const planner = decl('plan');
assert.ok(hooks && planner, 'keeper planner and hook inventory exist');

// Copied from 4736's actual title class string. This fixture deliberately has no
// aria-hidden/title test ID. Retaining containers alone must not count as healthy.
const TITLE = 'min-w-0 flex-1 text-start text-sm transition-opacity motion-reduce:transition-none';
const containers = 'sidebar-row-card sidebar-row-slim sidebar-draft-row sidebar-thread-search-results h-[4.875rem]';
function inspectFixture(titleClass) {
  const input = `const containers = ${JSON.stringify(containers)}; jsx("span", {className: ${JSON.stringify(titleClass)}, dir:"ltr", children:thread.title});`;
  const context = vm.createContext({
    UNITS: ['wrap', 'fit'].map(name => ({name, file:name === 'wrap' ? 'index' : 'binCli', run:text => ({state:'already', text})})),
    ASSETS: "assets", listDir: () => ["main.js"],
    DESKTOP_MAIN: 'desktop', entryAt: () => false,
    loadDisabled: () => new Set(), readLoaderKey: () => null,
    readEntry: (_fd, _layout, rel) => Buffer.from(rel === 'main' || rel === 'assets/main.js' ? input : rel === 'runtime' ? 'function threadTitle(){}' : '<html>already wrapped</html>'),
  });
  vm.runInContext(source.slice(hooks.start, hooks.end) + '\n' + source.slice(planner.start, planner.end) + '\n' + source.slice(decl('scanWrapHooks').start, decl('scanWrapHooks').end), context);
  return vm.runInContext('plan(null, {header:{}}, {index:"index", mainJs:"main", binCli:"runtime"})', context);
}

test('4736 title span passes the keeper health check without the removed attributes', () => {
  const out = inspectFixture(TITLE);
  assert.equal(out.results.wrap.state, 'already');
  assert.deepEqual(Array.from(out.missingHooks), []);
  assert.deepEqual(Object.keys(out.files), [], 'health check does not plan writes');
});

test('a future title-span change is reported even with all containers and an already-wrapped page', () => {
  const out = inspectFixture('flex-1 truncate text-sm');
  assert.equal(out.results.wrap.state, 'already');
  assert.deepEqual(Array.from(out.missingHooks), ['min-w-0 flex-1 text-start text-sm']);
  assert.deepEqual(Object.keys(out.files), [], 'reporting a missing hook does not rewrite the page');
});

function scan(chunks) {
  const c = vm.createContext({ ASSETS:'assets', listDir:() => Object.keys(chunks), readEntry:(_f,_l,p) => Buffer.from(chunks[p.split('/').pop()]) });
  vm.runInContext(source.slice(hooks.start,hooks.end) + '\n' + source.slice(decl('scanWrapHooks').start,decl('scanWrapHooks').end),c);
  return Array.from(vm.runInContext('scanWrapHooks(null,{header:{}})',c));
}
test('all JS chunks count; unrelated thread-title occurrences satisfy nothing and index.html is ignored', () => {
  assert.equal(scan({'main.js':'thread-title-instructions data-thread-title-chevron', 'index.html':containers+' '+TITLE}).length,6);
  assert.deepEqual(scan({'main.js':'thread-title-instructions', 'other.js':containers+' '+TITLE}),[]);
});
