const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadPlugins } = require('../runtime/main.cjs');
const { createStore } = require('../runtime/store.cjs');
const { compatible } = require('../scripts/compatibility.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tamler-store-'));
  const plugins = path.join(root, 'plugins');
  fs.mkdirSync(path.join(plugins, 'example'), { recursive: true });
  fs.writeFileSync(path.join(plugins, 'example', 'plugin.json'), JSON.stringify({ id: 'example', name: 'Example', enabled: true }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, store: createStore(root, loadPlugins) };
}

test('plugin toggles survive store recreation without editing manifests', t => {
  const { root, store } = fixture(t);
  store.toggle('example', false);
  assert.equal(createStore(root, loadPlugins).list()[0].enabled, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'plugins', 'example', 'plugin.json'))).enabled, true);
  assert.throws(() => store.toggle('missing', true), /Invalid/);
});

test('global pause survives store recreation and keeps plugin toggles', t => {
  const { root, store } = fixture(t);
  assert.equal(store.paused(), false);
  store.toggle('example', false);
  store.setPaused(true);
  const next = createStore(root, loadPlugins);
  assert.equal(next.paused(), true);
  assert.equal(next.list()[0].enabled, false);
  next.setPaused(false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data', 'settings.json'))).paused, undefined);
  assert.throws(() => store.setPaused('yes'), /Invalid/);
});

test('removal preserves plugin files in recovery directory', t => {
  const { root, store } = fixture(t);
  store.toggle('example', false);
  store.remove('example');
  assert.deepEqual(store.list(), []);
  const trash = path.join(root, 'data', 'removed-plugins');
  const folder = fs.readdirSync(trash)[0];
  assert.equal(JSON.parse(fs.readFileSync(path.join(trash, folder, 'plugin.json'))).id, 'example');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'data', 'settings.json'))).enabled, {});
});

test('unknown Electron and missing native symbols prevent attachment', () => {
  const loader = { machine: 34404, imports: [{ dll: 'node.exe', name: 'required' }] };
  const target = { machine: 34404, exports: ['required'] };
  assert.equal(compatible(target, loader, '44.4.3', '44.4.3').ok, true);
  assert.equal(compatible(target, loader, '45.0.0', '44.4.3').ok, false);
  assert.equal(compatible({ ...target, exports: [] }, loader, '44.4.3', '44.4.3').ok, false);
  assert.equal(compatible({ ...target, machine: 332 }, loader, '44.4.3', '44.4.3').ok, false);
  assert.equal(compatible(target, loader, '44.4.3', '44.4.3', ['Call']).ok, false);
});

test('plugin storage is kept per plugin, survives recreation and rejects unknown plugins', t => {
  const { root, store } = fixture(t);
  store.list();
  assert.deepEqual(store.setData('example', 'size', 16), { size: 16 });
  assert.deepEqual(createStore(root, loadPlugins).data('example'), { size: 16 });
  assert.deepEqual(store.setData('example', 'size', undefined), {});
  assert.throws(() => store.setData('missing', 'size', 1), /Unknown plugin/);
  assert.throws(() => store.setData('example', 'big', 'x'.repeat(300 * 1024)), /256 KB/);
  assert.throws(() => store.data('../escape'), /Invalid plugin id/);
});

test('plugin files are written in chunks, listed and limited to safe names', t => {
  const { root, store } = fixture(t);
  fs.writeFileSync(path.join(root, 'plugins', 'example', 'plugin.json'), JSON.stringify({ id: 'example', settings: [{ key: 'fonts', type: 'files' }] }));
  store.list();
  store.writeFileChunk('example', 'fonts', 'a.ttf', 'upload0001', 0, Buffer.from('ab'), false);
  assert.deepEqual(store.listFiles('example', 'fonts'), []);
  store.writeFileChunk('example', 'fonts', 'a.ttf', 'upload0001', 1, Buffer.from('cd'), true);
  assert.deepEqual(store.listFiles('example', 'fonts'), [{ name: 'a.ttf', size: 4 }]);
  assert.equal(store.readFile('example', 'fonts', 'a.ttf').toString(), 'abcd');
  assert.equal(store.isFileSetting('example', 'fonts'), true);
  assert.equal(store.isFileSetting('example', 'cache'), false);
  for (const name of ['../x', 'a/b', '.hidden', 'a:b', '']) assert.throws(() => store.writeFileChunk('example', 'fonts', name, 'upload0001', 0, Buffer.from('x'), true), /Invalid file/);
  assert.throws(() => store.writeFileChunk('example', 'fonts', 'b.ttf', 'upload0002', 3, Buffer.from('x'), true), /expired/);
  assert.throws(() => store.listFiles('missing', 'fonts'), /Unknown plugin/);
  store.removeFile('example', 'fonts', 'a.ttf');
  assert.deepEqual(store.listFiles('example', 'fonts'), []);
});
