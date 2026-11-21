const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadPlugins } = require('../runtime/main.cjs');

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tamler-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function plugin(root, folder, manifest, source = 'module.exports.start = () => {};') {
  const target = path.join(root, folder);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'plugin.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  fs.writeFileSync(path.join(target, 'index.js'), source);
  return target;
}

test('a malformed JavaScript plugin is disabled while a valid plugin remains available', t => {
  const root = directory(t);
  plugin(root, 'bad', { id: 'bad', main: 'index.js' }, 'module.exports.start = (');
  plugin(root, 'good', { id: 'good', main: 'index.js' });
  const entries = loadPlugins(root);
  assert.equal(entries.find(entry => entry.id === 'bad').enabled, false);
  assert.ok(entries.find(entry => entry.id === 'bad').error);
  assert.equal(entries.find(entry => entry.id === 'good').error, undefined);
});

test('plugin entries cannot read outside the plugin directory', t => {
  const root = directory(t);
  plugin(root, 'escape', { id: 'escape', main: '../../outside.js' });
  plugin(root, 'style', { id: 'style', css: '../outside.css' });
  for (const entry of loadPlugins(root)) assert.match(entry.error, /within its directory/);
});

test('duplicate ids and broken manifests only disable the affected plugin', t => {
  const root = directory(t);
  plugin(root, 'a', { id: 'same', main: 'index.js' });
  plugin(root, 'b', { id: 'same', main: 'index.js' });
  plugin(root, 'c', '{ broken');
  const entries = loadPlugins(root);
  assert.equal(entries.filter(entry => !entry.error).length, 1);
  assert.match(entries.find(entry => entry.folder.endsWith('b')).error, /duplicate/);
  assert.match(entries.find(entry => entry.folder.endsWith('c')).error, /plugin\.json/);
});

test('plugin modules are bundled with relative paths and unused broken files stay lazy', t => {
  const root = directory(t);
  const folder = plugin(root, 'multi', { id: 'multi', main: 'index.js' }, "module.exports = require('./lib/value');");
  fs.mkdirSync(path.join(folder, 'lib'));
  fs.writeFileSync(path.join(folder, 'lib', 'value.js'), 'module.exports = 1;');
  fs.writeFileSync(path.join(folder, 'lib', 'config.json'), '{"a":1}');
  fs.writeFileSync(path.join(folder, 'lib', 'broken.js'), 'export default 1;');
  const [entry] = loadPlugins(root);
  assert.equal(entry.error, undefined);
  assert.equal(entry.main, 'index.js');
  assert.ok('source' in entry.modules['lib/value.js']);
  assert.deepEqual(entry.modules['lib/config.json'], { json: { a: 1 } });
  assert.ok(entry.modules['lib/broken.js'].error);
});

test('settings and URL patterns are validated from the manifest', t => {
  const root = directory(t);
  plugin(root, 'ok', { id: 'ok', main: 'index.js', matches: ['https://claude.ai/*'], settings: [
    { key: 'size', type: 'number', default: 14, min: 10 },
    { key: 'mode', type: 'select', options: ['a', { value: 'b', label: 'B' }] },
    { key: 'picked', type: 'select', placeholder: 'Upload first', section: 'Advanced' }
  ] });
  plugin(root, 'bad-type', { id: 'bad-type', settings: [{ key: 'x', type: 'date' }] });
  plugin(root, 'bad-matches', { id: 'bad-matches', matches: 'claude.ai' });
  const entries = loadPlugins(root);
  const ok = entries.find(entry => entry.id === 'ok');
  assert.deepEqual(ok.matches, ['https://claude.ai/*']);
  assert.deepEqual(ok.settings[1].options, [{ value: 'a', label: 'a' }, { value: 'b', label: 'B' }]);
  assert.equal(ok.settings[0].min, 10);
  assert.deepEqual(ok.settings[2].options, []);
  assert.equal(ok.settings[2].placeholder, 'Upload first');
  assert.equal(ok.settings[2].section, 'Advanced');
  assert.equal('section' in ok.settings[0], false);
  assert.match(entries.find(entry => entry.id === 'bad-type').error, /unsupported type/);
  assert.match(entries.find(entry => entry.id === 'bad-matches').error, /matches/);
});

test('images are bundled from the plugin folder but not from node_modules', t => {
  const root = directory(t);
  const folder = plugin(root, 'pictures', { id: 'pictures', css: 'styles/theme.css' });
  fs.mkdirSync(path.join(folder, 'styles'));
  fs.writeFileSync(path.join(folder, 'styles', 'theme.css'), 'body { background: url(../img/bg.png); }');
  fs.mkdirSync(path.join(folder, 'img'));
  fs.writeFileSync(path.join(folder, 'img', 'bg.png'), Buffer.from([1, 2, 3]));
  fs.mkdirSync(path.join(folder, 'node_modules', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'node_modules', 'lib', 'icon.svg'), '<svg/>');
  const [entry] = loadPlugins(root);
  assert.equal(entry.error, undefined);
  assert.equal(entry.cssPath, 'styles/theme.css');
  assert.deepEqual(entry.assets, { 'img/bg.png': { type: 'image/png', data: 'AQID' } });
});

test('oversized image folders disable only that plugin', t => {
  const root = directory(t);
  const folder = plugin(root, 'huge', { id: 'huge' });
  fs.writeFileSync(path.join(folder, 'big.png'), Buffer.alloc(9 * 1024 * 1024));
  assert.match(loadPlugins(root)[0].error, /8 MB/);
});

test('list, files settings and hosts are validated from the manifest', t => {
  const root = directory(t);
  plugin(root, 'ok', { id: 'ok', hosts: ['https://fonts.gstatic.com/*'], settings: [
    { key: 'fonts', type: 'files', accept: '.ttf' },
    { key: 'families', type: 'list', placeholder: 'Search' }
  ] });
  plugin(root, 'bad-hosts', { id: 'bad-hosts', hosts: ['http://example.com/*'] });
  const entries = loadPlugins(root);
  const ok = entries.find(entry => entry.id === 'ok');
  assert.equal(ok.error, undefined);
  assert.deepEqual(ok.hosts, ['https://fonts.gstatic.com/*']);
  assert.equal(ok.settings[0].accept, '.ttf');
  assert.equal(ok.settings[1].placeholder, 'Search');
  assert.match(entries.find(entry => entry.id === 'bad-hosts').error, /hosts/);
});

test('color settings accept only #rrggbb defaults and swatches', t => {
  const root = directory(t);
  plugin(root, 'ok', { id: 'ok', settings: [
    { key: 'accent', type: 'color', default: '#2A78D6', options: ['#FF0000', { value: '#00ff00', label: 'Green' }] }
  ] });
  plugin(root, 'bad-default', { id: 'bad-default', settings: [{ key: 'accent', type: 'color', default: 'blue' }] });
  plugin(root, 'bad-option', { id: 'bad-option', settings: [{ key: 'accent', type: 'color', options: ['#fff'] }] });
  const entries = loadPlugins(root);
  const ok = entries.find(entry => entry.id === 'ok');
  assert.equal(ok.error, undefined);
  assert.equal(ok.settings[0].default, '#2a78d6');
  assert.deepEqual(ok.settings[0].options, [{ value: '#ff0000', label: '#FF0000' }, { value: '#00ff00', label: 'Green' }]);
  assert.match(entries.find(entry => entry.id === 'bad-default').error, /#rrggbb/);
  assert.match(entries.find(entry => entry.id === 'bad-option').error, /#rrggbb/);
});

test('custom accent color plugin builds a palette only for changed colors', () => {
  const { buildCss } = require('../plugins/custom-accent-color/index.js');
  assert.equal(buildCss({ accent: '#2a78d6', brand: '#d97757', tint: 0 }), '');
  const accent = buildCss({ accent: '#8b5cf6', brand: '#d97757', tint: 0 });
  assert.match(accent, /--cds-blue-450: #8b5cf6;/);
  assert.match(accent, /--cds-hsl-blue-500: [\d.]+ [\d.]+% [\d.]+%;/);
  assert.doesNotMatch(accent, /--cds-clay|--cds-gray-/);
  const brand = buildCss({ accent: '#2a78d6', brand: '#16a34a', tint: 10 });
  assert.match(brand, /\.cds-root\.cds-root\.cds-root \{ --cds-clay: #16a34a;/);
  assert.match(brand, /--cds-gray-500: #[0-9a-f]{6};/);
  assert.match(buildCss({ accent: '#d4a017', brand: '#d97757', tint: 0 }), /--cds-role-accent-on: #0b0b0b;/);
});

test('context return keeps the native breakdown collapsed above the Code usage limits', () => {
  const { start } = require('../plugins/context-return/index.js');
  const inline = props => props.presentation === 'inline' && props.contextOnly;
  const component = { type: inline };
  const sessionRef = { id: 'session-1', type: 'local' };
  const contextFiber = { type: inline, elementType: component, memoizedProps: { sessionRef, modelId: 'current' } };
  const planFiber = { memoizedProps: { presence: { kind: 'meters' }, rows: [], errorAction: null }, return: contextFiber };
  const events = [];
  const readout = { dataset: { railContextPct: '18' }, textContent: '36k / 200k (18%)' };
  const createElement = tag => ({
    tag, dataset: {}, style: {}, children: [], open: false,
    append(...children) { this.children.push(...children); },
    setAttribute() {},
    querySelector: selector => selector === '[data-rail-context-summary]' ? readout : null,
    remove() { events.push('remove'); }
  });
  let host;
  const section = { before(node) { host = node; events.push('insert'); } };
  const group = { parentElement: section, '__reactFiber$fixture': planFiber };
  let mountGroup;
  let syncSummary;

  start({
    document: { createElement },
    window: { MutationObserver: class {
      constructor(callback) { syncSummary = callback; }
      observe() {}
      disconnect() { events.push('disconnect'); }
    } },
    addStyle: css => assert.match(css, /data-tamler-context-return/),
    mount: (selector, callback) => { assert.match(selector, /epitaxy-root/); mountGroup = callback; },
    render: (node, view, options) => {
      assert.equal(node, host.children[1]);
      assert.equal(options.context, group);
      const { type, props } = view({ React: { createElement: (type, props) => ({ type, props }) } });
      assert.equal(type, component);
      assert.equal(type.type(props), true);
      assert.equal(props.sessionRef, sessionRef);
      assert.equal(props.modelId, 'current');
      events.push('render');
      return { unmount() { events.push('unmount'); } };
    }
  });

  assert.equal(mountGroup({ ...group, '__reactFiber$fixture': contextFiber }), undefined);
  assert.equal(mountGroup({ ...group, '__reactFiber$fixture': {
    memoizedProps: { children: [{ key: 'tamler-context' }] }, return: planFiber
  } }), undefined);
  assert.deepEqual(events, []);
  const cleanup = mountGroup(group);
  assert.deepEqual(events, ['insert', 'render']);
  assert.equal(host.tag, 'details');
  assert.equal(host.open, false);
  const [summary] = host.children;
  assert.equal(summary.tag, 'summary');
  syncSummary();
  assert.equal(summary.children[1].textContent, '36k / 200k (18%)');
  assert.equal(summary.children[2].children[0].style.width, '18%');
  cleanup();
  assert.deepEqual(events, ['insert', 'render', 'disconnect', 'unmount', 'remove']);
});

test('plugin hosts match host and path separately', () => {
  const { hostAllowed } = require('../runtime/main.cjs');
  const patterns = ['https://fonts.google.com/metadata/*', 'https://*.gstatic.com/*'];
  assert.equal(hostAllowed(patterns, 'https://fonts.google.com/metadata/fonts'), true);
  assert.equal(hostAllowed(patterns, 'https://fonts.gstatic.com/s/inter/a.woff2'), true);
  assert.equal(hostAllowed(patterns, 'https://evil.com/x.gstatic.com/a'), false);
  assert.equal(hostAllowed(patterns, 'https://fonts.google.com/other'), false);
  assert.equal(hostAllowed(patterns, 'http://fonts.gstatic.com/a'), false);
});

test('source patches are validated and applied in order', t => {
  const { applyPatches } = require('../runtime/main.cjs');
  const root = directory(t);
  const url = 'https://assets.example.com/*/chunk-*.js';
  plugin(root, 'good', { id: 'good', patches: [{ url, find: 'return (\\w+)\\?"a":"b"', replace: 'return"b"' }, { url, find: 'b"', replace: 'c"', flags: 'g' }] });
  plugin(root, 'regex', { id: 'regex', patches: [{ url, find: '(', replace: '' }] });
  plugin(root, 'flags', { id: 'flags', patches: [{ url, find: 'x', replace: '', flags: 'y' }] });
  plugin(root, 'http', { id: 'http', patches: [{ url: 'http://assets.example.com/*', find: 'x', replace: '' }] });
  const entries = loadPlugins(root);
  const good = entries.find(entry => entry.id === 'good');
  assert.equal(good.error, undefined);
  for (const id of ['regex', 'flags', 'http']) assert.ok(entries.find(entry => entry.id === id).error, id);
  const { source, results } = applyPatches('function f(e){return e?"a":"b"}', good.patches);
  assert.equal(source, 'function f(e){return"c"}');
  assert.deepEqual(results.map(result => result.applied), [true, true]);
  assert.deepEqual(applyPatches('nothing', good.patches).results.map(result => result.applied), [false, false]);
});

test('runtime downloads through the page session so the system proxy applies', async t => {
  const { sessionFetch } = require('../runtime/main.cjs');
  const calls = [];
  const contents = { isDestroyed: () => false, session: { fetch: async (url, init) => { calls.push([url, init]); return 'session'; } } };
  const init = { headers: { 'user-agent': 'x' } };
  assert.equal(await sessionFetch(contents, 'https://assets.example.com/a.js', init), 'session');
  assert.deepEqual(calls, [['https://assets.example.com/a.js', init]]);
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => 'node';
  assert.equal(await sessionFetch({ isDestroyed: () => true, session: contents.session }, 'https://assets.example.com/a.js'), 'node');
  assert.equal(await sessionFetch(undefined, 'https://assets.example.com/a.js'), 'node');
  assert.equal(calls.length, 1);
});

test('custom fonts plugin reads family, weight and style from font files', async () => {
  const { describeFont, fromFileName } = require('../plugins/custom-fonts/font-file.js');
  assert.deepEqual(fromFileName('Inter-BoldItalic.woff2'), { family: 'Inter', weight: '700', style: 'italic' });
  assert.deepEqual(fromFileName('JetBrains Mono SemiBold.woff2'), { family: 'JetBrains Mono', weight: '600', style: 'normal' });
  assert.deepEqual(fromFileName('Inter-VariableFont_opsz,wght.ttf'), { family: 'Inter', weight: '100 900', style: 'normal' });
  const fonts = path.join(process.env.WINDIR || 'C:\Windows', 'Fonts');
  if (!fs.existsSync(path.join(fonts, 'arialbi.ttf'))) return;
  const read = name => fs.readFileSync(path.join(fonts, name));
  assert.deepEqual(await describeFont('arial.ttf', read('arial.ttf')), { family: 'Arial', weight: '400', style: 'normal' });
  assert.deepEqual(await describeFont('arialbi.ttf', read('arialbi.ttf')), { family: 'Arial', weight: '700', style: 'italic' });
});
