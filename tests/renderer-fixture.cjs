// Запуск: .cache/electron/runtime/electron.exe tests/renderer-fixture.cjs
// Проверяет API плагинов в настоящем Chromium под CSP script-src 'none', без внедрения DLL.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadPlugins, serializePlugins } = require('../runtime/main.cjs');
const { installTamler } = require('../runtime/renderer.cjs');

function write(root, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content));
  }
}

const plugins = {
  'modules/plugin.json': { id: 'modules', main: 'src/index.js' },
  'modules/src/index.js': `
    const helper = require('./helper');
    const config = require('../config.json');
    const pkg = require('tiny');
    module.exports.start = ({ document }) => { document.body.dataset.modules = [helper(), config.value, pkg.name, require.resolve('tiny')].join('|'); };`,
  'modules/src/helper.js': 'module.exports = () => "helper";',
  'modules/config.json': { value: 'json' },
  'modules/node_modules/tiny/package.json': { main: 'lib/main.js' },
  'modules/node_modules/tiny/lib/main.js': 'exports.name = "tiny";',
  'modules/unused.js': 'export default 1;',

  'mount/plugin.json': { id: 'mount', main: 'index.js' },
  'mount/index.js': `
    module.exports.start = ({ mount }) => {
      mount('.target', element => {
        element.dataset.mounted = 'yes';
        return () => { element.dataset.mounted = 'no'; window.__unmounted = (window.__unmounted || 0) + 1; };
      });
    };`,

  'async/plugin.json': { id: 'async', main: 'index.js' },
  'async/index.js': `
    module.exports.start = async ({ signal, plugin, page }) => {
      await new Promise(resolve => setTimeout(resolve, 20));
      window.__asyncInfo = { id: plugin.id, protocol: page.protocol, aborted: signal.aborted };
      return () => { window.__asyncStopped = true; };
    };`,

  'storage/plugin.json': { id: 'storage', main: 'index.js', settings: [{ key: 'size', type: 'number', default: 14 }] },
  'storage/index.js': `
    window.__storageStarts = (window.__storageStarts || 0) + 1;
    module.exports.start = ({ storage }) => { window.__storageSize = storage.get('size'); };`,

  'subscriber/plugin.json': { id: 'subscriber', main: 'index.js', settings: [{ key: 'mode', type: 'select', options: ['a', 'b'], default: 'a' }] },
  'subscriber/index.js': `
    module.exports.start = ({ storage }) => {
      window.__subscriberStarts = (window.__subscriberStarts || 0) + 1;
      storage.subscribe(values => { window.__subscriberMode = values.mode; });
    };`,

  'elsewhere/plugin.json': { id: 'elsewhere', main: 'index.js', matches: ['https://claude.ai/*'] },
  'elsewhere/index.js': 'module.exports.start = () => { window.__elsewhere = true; };',

  'pictures/plugin.json': { id: 'pictures', main: 'index.js', css: 'css/theme.css' },
  'pictures/css/theme.css': 'body { --tamler-picture: url("../img/dot.png"); --tamler-external: url(data:image/png;base64,AA==); }',
  'pictures/img/dot.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'),
  'pictures/index.js': `
    module.exports.start = ({ asset, addStyle, document }) => {
      const image = document.createElement('img');
      image.id = 'picture';
      image.src = asset('img/dot.png');
      document.body.append(image);
      addStyle('body { --tamler-js-picture: url(./img/dot.png); }');
      return () => image.remove();
    };`,

  'listener/plugin.json': { id: 'listener', main: 'index.js' },
  'listener/index.js': `
    module.exports.start = ({ on, document }) => {
      on(document.body, 'tamler-test', () => { throw new Error('listener failed'); });
    };`
};

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tamler-renderer-'));
  let code = 0;
  try {
    write(root, plugins);
    const loaded = loadPlugins(root);
    for (const plugin of loaded) assert.equal(plugin.error, undefined, `${plugin.id}: ${plugin.error}`);
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await window.loadFile(path.join(__dirname, 'fixture.html'));
    const page = source => window.webContents.executeJavaScript(source);
    await page(`window.__requests = []; window.__tamlerBridge = payload => { const request = JSON.parse(payload); window.__requests.push(request); setTimeout(() => window.Tamler.reply(request.id, { ok: true })); }; true`);
    await page(`(${installTamler.toString()})(window, [${serializePlugins(loaded, id => id === 'storage' ? { size: 18 } : {})}], null).then(() => true)`);
    await wait(50);

    assert.equal(await page('document.body.dataset.modules'), 'helper|json|tiny|node_modules/tiny/lib/main.js');

    await page(`const target = document.createElement('div'); target.className = 'target'; document.body.append(target); true`);
    await wait(10);
    assert.equal(await page(`document.querySelector('.target').dataset.mounted`), 'yes');
    await page(`document.querySelector('.target').classList.remove('target'); true`);
    await wait(10);
    assert.equal(await page('window.__unmounted'), 1);
    await page(`document.body.querySelector('div').classList.add('target'); true`);
    await wait(10);
    await page(`window.Tamler.disable('mount'); true`);
    assert.equal(await page('window.__unmounted'), 2);

    assert.deepEqual(await page('window.__asyncInfo'), { id: 'async', protocol: 'file:', aborted: false });
    await page(`window.Tamler.disable('async'); true`);
    assert.equal(await page('window.__asyncStopped'), true);

    assert.equal(await page('window.__storageSize'), 18);
    await page(`window.Tamler.setSetting('storage', 'size', 20)`);
    assert.equal(await page('window.__storageSize'), 20);
    assert.equal(await page('window.__storageStarts'), 2);
    assert.deepEqual(await page('window.__requests.at(-1)'), { id: 1, action: 'storage-set', pluginId: 'storage', key: 'size', value: 20, remove: false });
    await page(`window.Tamler.setSetting('storage', 'size', undefined)`);
    assert.equal(await page('window.__storageSize'), 14);

    await page(`window.Tamler.storageChanged('subscriber', { mode: 'b' }); true`);
    assert.equal(await page('window.__subscriberMode'), 'b');
    assert.equal(await page('window.__subscriberStarts'), 1);

    assert.equal(await page('window.__elsewhere'), undefined);
    const listed = await page(`window.Tamler.list().find(plugin => plugin.id === 'elsewhere')`);
    assert.equal(listed.enabled, true);
    assert.equal(listed.running, false);
    assert.equal(listed.matches, false);

    await page(`new Promise(resolve => { const image = document.getElementById('picture'); image.complete ? resolve() : image.onload = image.onerror = resolve; })`);
    assert.equal(await page(`document.getElementById('picture').naturalWidth`), 1);
    const styles = await page(`[...document.querySelectorAll('style[data-tamler-plugin="pictures"]')].map(style => style.textContent).join(' ')`);
    assert.match(styles, /--tamler-picture: url\("blob:/);
    assert.match(styles, /--tamler-js-picture: url\("blob:/);
    assert.match(styles, /--tamler-external: url\(data:image\/png;base64,AA==\)/);
    const pictureURL = await page(`document.getElementById('picture').src`);
    await page(`window.Tamler.disable('pictures'); true`);
    assert.equal(await page(`fetch(${JSON.stringify(pictureURL)}).then(() => 'loaded', () => 'revoked')`), 'revoked');

    await page(`document.body.dispatchEvent(new Event('tamler-test')); true`);
    assert.ok((await page('window.Tamler.errors')).some(error => error.id === 'listener' && /listener failed/.test(error.message)));

    const fresh = `[${serializePlugins(loaded, () => ({}))}]`;
    await page(`window.Tamler.update(${fresh}, { paused: true }); true`);
    assert.equal(await page('window.Tamler.paused'), true);
    assert.deepEqual(await page('window.Tamler.list().filter(plugin => plugin.running).map(plugin => plugin.id)'), []);
    assert.equal(await page(`window.Tamler.list().find(plugin => plugin.id === 'subscriber').enabled`), true);
    await page(`window.Tamler.update(${fresh}, {}); true`);
    await wait(10);
    assert.equal(await page('window.Tamler.paused'), false);
    assert.equal(await page(`window.Tamler.list().find(plugin => plugin.id === 'subscriber').running`), true);

    await page('window.Tamler.dispose(); true');
    assert.equal(await page('!!window.Tamler'), false);
    console.log('renderer fixture: ok');
  } catch (error) {
    console.error(error);
    code = 1;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    app.exit(code);
  }
});
