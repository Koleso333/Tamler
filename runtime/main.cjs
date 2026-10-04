const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const { createStore } = require('./store.cjs');

const MODULE_LIMIT = 2000;
const SOURCE_LIMIT = 16 * 1024 * 1024;
const ASSET_LIMIT = 500;
const ASSET_SIZE_LIMIT = 8 * 1024 * 1024;
const ASSET_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp' };
const SETTING_TYPES = new Set(['boolean', 'number', 'string', 'select', 'list', 'files', 'color']);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const FETCH_LIMIT = 32 * 1024 * 1024;
// Браузерный User-Agent: Google Fonts и подобные сервисы по нему выбирают формат (woff2).
const FETCH_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

function inside(folder, filename) {
  const target = path.resolve(folder, filename);
  const relative = path.relative(folder, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Plugin entry must stay within its directory');
  return relative.split(path.sep).join('/');
}

function collectFiles(folder, withModules) {
  const modules = {};
  const assets = {};
  let count = 0;
  let size = 0;
  let assetCount = 0;
  let assetSize = 0;
  const walk = (directory, dependencies) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { walk(file, dependencies || entry.name === 'node_modules'); continue; }
      if (!entry.isFile()) continue;
      const type = ASSET_TYPES[path.extname(entry.name).toLowerCase()];
      // Картинки из node_modules не нужны плагину напрямую и только раздували бы каждую страницу.
      if (type && !dependencies) {
        if (++assetCount > ASSET_LIMIT) throw new Error(`Plugin has more than ${ASSET_LIMIT} images`);
        const data = fs.readFileSync(file);
        assetSize += data.length;
        if (assetSize > ASSET_SIZE_LIMIT) throw new Error('Plugin images exceed 8 MB');
        assets[path.relative(folder, file).split(path.sep).join('/')] = { type, data: data.toString('base64') };
        continue;
      }
      if (!withModules || !/\.(c?js|json)$/i.test(entry.name)) continue;
      if (++count > MODULE_LIMIT) throw new Error(`Plugin has more than ${MODULE_LIMIT} modules`);
      const source = fs.readFileSync(file, 'utf8');
      size += source.length;
      if (size > SOURCE_LIMIT) throw new Error('Plugin modules are too large');
      const name = path.relative(folder, file).split(path.sep).join('/');
      if (/\.json$/i.test(name)) {
        try { modules[name] = { json: JSON.parse(source) }; } catch (error) { modules[name] = { error: error.message }; }
        continue;
      }
      // Синтаксическая ошибка в неиспользуемом файле не ломает плагин: она всплывёт только при require.
      try {
        new vm.Script(`(function(module, exports, Tamler, require) {\n${source}\n})`, { filename: name });
        modules[name] = { source };
      } catch (error) { modules[name] = { error: error.message }; }
    }
  };
  walk(folder, false);
  return { modules, assets };
}

function validateSettings(settings) {
  if (settings === undefined) return [];
  if (!Array.isArray(settings)) throw new Error('settings must be an array');
  const keys = new Set();
  return settings.map(setting => {
    if (!setting || typeof setting.key !== 'string' || !setting.key || keys.has(setting.key)) throw new Error('Each setting needs a unique key');
    keys.add(setting.key);
    if (!SETTING_TYPES.has(setting.type)) throw new Error(`Setting ${setting.key} has unsupported type`);
    const result = { key: setting.key, type: setting.type, label: String(setting.label || setting.key) };
    if (setting.description) result.description = String(setting.description);
    // Без options варианты select даёт сам плагин через options(key, provider).
    if (setting.type === 'select') {
      if (setting.options !== undefined && !Array.isArray(setting.options)) throw new Error(`Setting ${setting.key} options must be an array`);
      result.options = (setting.options || []).map(option => option && typeof option === 'object' ? { value: option.value, label: String(option.label ?? option.value) } : { value: option, label: String(option) });
      if (setting.placeholder) result.placeholder = String(setting.placeholder);
    }
    if (setting.type === 'list' && setting.options !== undefined) {
      if (!Array.isArray(setting.options)) throw new Error(`Setting ${setting.key} options must be an array`);
      result.options = setting.options.map(option => option && typeof option === 'object' ? { value: option.value, label: String(option.label ?? option.value) } : { value: option, label: String(option) });
    }
    if (setting.type === 'list' && setting.placeholder) result.placeholder = String(setting.placeholder);
    if (setting.type === 'files' && setting.accept) result.accept = String(setting.accept);
    if (setting.type === 'number') for (const name of ['min', 'max', 'step']) if (typeof setting[name] === 'number') result[name] = setting[name];
    // Цвет хранится строкой #rrggbb; options — готовые образцы палитры.
    if (setting.type === 'color') {
      if ('default' in setting && !HEX_COLOR.test(setting.default)) throw new Error(`Setting ${setting.key} default must be #rrggbb`);
      if (setting.options !== undefined) {
        if (!Array.isArray(setting.options)) throw new Error(`Setting ${setting.key} options must be an array`);
        result.options = setting.options.map(option => {
          const value = option && typeof option === 'object' ? option.value : option;
          if (!HEX_COLOR.test(value)) throw new Error(`Setting ${setting.key} options must be #rrggbb`);
          return { value: value.toLowerCase(), label: String(option?.label ?? value) };
        });
      }
      if ('default' in setting) { result.default = setting.default.toLowerCase(); return result; }
    }
    if ('default' in setting) result.default = setting.default;
    return result;
  });
}

// Шаблон адреса сравнивается по частям: звёздочка в хосте не может захватить путь.
function hostAllowed(patterns, url) {
  let target;
  try { target = new URL(url); } catch { return false; }
  if (target.protocol !== 'https:' || target.username || target.password) return false;
  const glob = (pattern, part) => new RegExp(`^${pattern.split('*').map(text => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join(part)}$`);
  return patterns.some(pattern => {
    const match = /^https:\/\/([^/]+)(\/.*)$/.exec(pattern);
    return match && glob(match[1], '[^/]*').test(target.host) && glob(match[2], '.*').test(target.pathname + target.search);
  });
}

function broken(folder, id, error) {
  return { id, name: path.basename(folder), description: '', version: '', folder, enabled: false, css: '', cssPath: '', main: '', modules: {}, assets: {}, settings: [], matches: [], hosts: [], error };
}

function loadPlugin(folder, manifest) {
  const plugin = { id: manifest.id, name: manifest.name || manifest.id, description: manifest.description || '', version: manifest.version || '', folder, enabled: manifest.enabled, css: '', cssPath: '', main: '', modules: {}, assets: {}, settings: [], matches: [], hosts: [] };
  try {
    if (manifest.matches !== undefined) {
      if (!Array.isArray(manifest.matches) || manifest.matches.some(pattern => typeof pattern !== 'string' || !pattern)) throw new Error('matches must be an array of URL patterns');
      plugin.matches = manifest.matches;
    }
    // Адреса, которые плагин может запрашивать через Tamler в обход CSP и CORS страницы.
    if (manifest.hosts !== undefined) {
      if (!Array.isArray(manifest.hosts) || manifest.hosts.some(pattern => typeof pattern !== 'string' || !/^https:\/\/[^/*]*[^/]*\/.*$/.test(pattern))) throw new Error('hosts must be an array of https:// URL patterns');
      plugin.hosts = manifest.hosts;
    }
    plugin.settings = validateSettings(manifest.settings);
    if (manifest.css) {
      plugin.cssPath = inside(folder, manifest.css);
      plugin.css = fs.readFileSync(path.join(folder, plugin.cssPath), 'utf8');
    }
    if (manifest.main) plugin.main = inside(folder, manifest.main);
    Object.assign(plugin, collectFiles(folder, !!plugin.main));
    if (plugin.main) {
      const main = plugin.modules[plugin.main];
      if (!main || !('source' in main)) throw new Error(main?.error || `Main module not found: ${manifest.main}`);
    }
  } catch (error) {
    plugin.error = error.message;
    plugin.enabled = false;
    plugin.modules = {};
    plugin.assets = {};
  }
  return plugin;
}

function loadPlugins(directory) {
  if (!fs.existsSync(directory)) return [];
  const plugins = [];
  const ids = new Set();
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(directory, entry.name);
    const manifestPath = path.join(folder, 'plugin.json');
    if (!fs.existsSync(manifestPath)) continue;
    // Сломанный плагин помечается ошибкой и не мешает загрузке остальных.
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
    catch (error) { plugins.push(broken(folder, `invalid-${entry.name}`, `plugin.json: ${error.message}`)); continue; }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(manifest?.id) || ids.has(manifest.id)) {
      plugins.push(broken(folder, `invalid-${entry.name}`, `Invalid or duplicate plugin id: ${manifest?.id}`));
      continue;
    }
    ids.add(manifest.id);
    plugins.push(loadPlugin(folder, manifest));
  }
  return plugins;
}

// Код плагинов вставляется литералами функций: страница не вызывает eval, CSP приложения не меняется.
function serializePlugins(plugins, data) {
  const modules = entries => Object.entries(entries).map(([name, module]) => `${JSON.stringify(name)}: ${'source' in module ? `{ create: function(module, exports, Tamler, require) {\n${module.source}\n} }` : JSON.stringify(module)}`).join(',');
  return plugins.map(({ modules: entries, folder, ...plugin }) => `({ ...${JSON.stringify({ ...plugin, data: plugin.error ? {} : data(plugin.id) })}, modules: { ${plugin.error ? '' : modules(entries)} } })`).join(',');
}

function start(electron,root = path.resolve(__dirname, '..')) {
  if (globalThis.__tamlerMain) return globalThis.__tamlerMain;
  const { app, webContents, shell } = electron;
  const store = createStore(root, loadPlugins);
  const logfile = path.join(root, 'build', 'runtime.jsonl');
  fs.mkdirSync(path.dirname(logfile), { recursive: true });
  const log = value => fs.appendFileSync(logfile, JSON.stringify({ time: new Date().toISOString(), pid: process.pid, ...value }) + '\n');
  const attached = new Map();
  const bindings = new Map();
  const entries = plugins => serializePlugins(plugins, store.data);
  const state = () => ({ paused: store.paused() });
  const pages = () => [...attached.values()].map(({ contents }) => contents).filter(contents => !contents.isDestroyed() && allowed(contents.getURL()));
  async function syncPlugins() {
    const plugins = store.list();
    await Promise.all(pages().map(contents => contents.executeJavaScript(`window.Tamler?.update([${entries(plugins)}], ${JSON.stringify(state())})`)));
  }
  async function command(request, origin) {
    if (request.action === 'storage-set') {
      const data = store.setData(request.id, request.key, request.remove ? undefined : request.value);
      // Отправитель уже применил значение у себя, остальные страницы получают его здесь.
      await Promise.all(pages().filter(contents => contents !== origin).map(contents => contents.executeJavaScript(`window.Tamler?.storageChanged(${JSON.stringify(request.id)}, ${JSON.stringify(data)})`).catch(() => {})));
      return { ok: true };
    }
    if (request.action === 'file-put' || request.action === 'file-remove') {
      if (request.action === 'file-put') {
        if (typeof request.data !== 'string') throw new Error('Invalid upload');
        store.writeFileChunk(request.id, request.key, request.name, request.upload, request.index, Buffer.from(request.data, 'base64'), !!request.last);
        if (!request.last) return { ok: true };
      } else store.removeFile(request.id, request.key, request.name);
      const files = store.listFiles(request.id, request.key);
      // У настройки типа files значение — список файлов; для внутренних ключей плагина хранилище не трогаем.
      if (!store.isFileSetting(request.id, request.key)) return { ok: true, files };
      const data = store.setData(request.id, request.key, files);
      await Promise.all(pages().filter(contents => contents !== origin).map(contents => contents.executeJavaScript(`window.Tamler?.storageChanged(${JSON.stringify(request.id)}, ${JSON.stringify(data)})`).catch(() => {})));
      return { ok: true, files, data };
    }
    if (request.action === 'file-list') return { ok: true, files: store.listFiles(request.id, request.key) };
    if (request.action === 'file-get') return { ok: true, data: store.readFile(request.id, request.key, request.name).toString('base64') };
    if (request.action === 'net-fetch') {
      if (!hostAllowed(store.hostsOf(request.id), request.url)) throw new Error(`Host is not listed in plugin hosts: ${request.url}`);
      const response = await fetch(request.url, { headers: { 'user-agent': FETCH_AGENT }, redirect: 'follow', signal: AbortSignal.timeout(60000) });
      if (!hostAllowed(store.hostsOf(request.id), response.url)) throw new Error(`Redirect to an unlisted host: ${response.url}`);
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length > FETCH_LIMIT) throw new Error('Response is larger than 32 MB');
      return { ok: true, status: response.status, type: response.headers.get('content-type') || '', data: body.toString('base64') };
    }
    if (request.action === 'toggle') store.toggle(request.id, request.enabled);
    else if (request.action === 'pause') store.setPaused(request.paused);
    else if (request.action === 'remove') store.remove(request.id);
    else if (request.action === 'open-folder') {
      fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });
      const error = await shell.openPath(path.join(root, 'plugins'));
      if (error) throw new Error(error);
    } else if (request.action !== 'refresh') throw new Error('Unknown action');
    if (request.action !== 'open-folder') await syncPlugins();
    return { ok: true };
  }
  async function bind(contents) {
    if (!bindings.has(contents.id)) {
      const own = !contents.debugger.isAttached();
      if (own) contents.debugger.attach('1.3');
      const contexts = new Map();
      const state = { contents, own, contexts, frameId: null };
      const listener = async (_event, method, params) => {
        if (method === 'Runtime.executionContextCreated') {
          contexts.set(params.context.id, params.context.auxData);
          return;
        }
        if (method === 'Runtime.executionContextDestroyed') { contexts.delete(params.executionContextId); return; }
        if (method === 'Runtime.executionContextsCleared') { contexts.clear(); return; }
        const context = contexts.get(params.executionContextId);
        if (method !== 'Runtime.bindingCalled' || params.name !== '__tamlerBridge' || !context?.isDefault || context.frameId !== state.frameId || !allowed(contents.getURL()) || params.payload.length > 262144) return;
        let id;
        let result;
        try {
          const request = JSON.parse(params.payload);
          id = request.id;
          if (!Number.isSafeInteger(id)) throw new Error('Invalid request');
          result = await command({ ...request, id: request.pluginId }, contents);
        } catch (error) { result = { ok: false, error: error.message }; }
        if (Number.isSafeInteger(id) && !contents.isDestroyed()) await contents.debugger.sendCommand('Runtime.evaluate', { expression: `window.Tamler?.reply(${id}, ${JSON.stringify(result)})`, contextId: params.executionContextId }).catch(() => {});
      };
      contents.debugger.on('message', listener);
      state.listener = listener;
      bindings.set(contents.id, state);
    }
    const tree = await contents.debugger.sendCommand('Page.getFrameTree');
    bindings.get(contents.id).frameId = tree.frameTree.frame.id;
    await contents.debugger.sendCommand('Runtime.enable');
    await contents.debugger.sendCommand('Runtime.addBinding', { name: '__tamlerBridge' });
  }
  const allowed = url => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'file:' || (parsed.protocol === 'app:' && parsed.hostname === 'localhost') || (parsed.protocol === 'https:' && parsed.hostname === 'claude.ai');
    } catch { return false; }
  };
  async function inject(contents) {
    if (contents.isDestroyed() || !allowed(contents.getURL())) return;
    try {
      await bind(contents);
      const plugins = store.list();
      delete require.cache[require.resolve('./renderer.cjs')];
      delete require.cache[require.resolve('./manager.cjs')];
      const { installTamler } = require('./renderer.cjs');
      const { installManager } = require('./manager.cjs');
      const source = `(${installTamler.toString()})(window, [${entries(plugins)}], ${installManager.toString()}, ${JSON.stringify(state())})`;
      const result = await contents.executeJavaScript(source);
      log({ event: 'renderer-ready', id: contents.id, result });
      return { id: contents.id, ...result, loadErrors: plugins.filter(plugin => plugin.error).map(plugin => ({ id: plugin.id, message: plugin.error })) };
    } catch (error) {
      log({ event: 'renderer-error', id: contents.id, message: error.message });
      return { id: contents.id, error: error.message };
    }
  }
  function attach(contents) {
    if (attached.has(contents.id) || contents.isDestroyed() || contents.getType() === 'devtools') return;
    const onReady = () => void inject(contents);
    contents.on('dom-ready', onReady);
    attached.set(contents.id, { contents, onReady });
    contents.once('destroyed', () => attached.delete(contents.id));
    if (!contents.isLoadingMainFrame()) onReady();
    // Ядро могло подключиться между dom-ready и концом загрузки: тогда dom-ready уже не повторится.
    else contents.once('did-stop-loading', () => { if (attached.get(contents.id)?.onReady === onReady) onReady(); });
  }
  const created = (_event, contents) => attach(contents);
  app.on('web-contents-created', created);
  const api = {
    command,
    openSettings() {
      const item = electron.Menu.getApplicationMenu()?.items.flatMap(item => item.submenu?.items || []).find(item => item.accelerator === 'CmdOrCtrl+,');
      if (!item) throw new Error('Claude Settings menu unavailable');
      const target = electron.BrowserWindow.getFocusedWindow() || electron.BrowserWindow.getAllWindows().find(window => !window.isDestroyed());
      item.click(item, target, {});
    },
    async upgrade() {
      await api.dispose();
      for (const filename of ['./main.cjs', './store.cjs']) delete require.cache[require.resolve(filename)];
      const next = require('./main.cjs').start(electron, root);
      await next.ready;
      return next.reload();
    },
    reload: async () => (await Promise.all([...attached.values()].map(({ contents }) => inject(contents)))).filter(Boolean),
    async dispose() {
      server.close();
      app.removeListener('web-contents-created', created);
      for (const { contents, onReady } of attached.values()) {
        if (contents.isDestroyed()) continue;
        contents.removeListener('dom-ready', onReady);
        if (allowed(contents.getURL())) await contents.executeJavaScript('window.Tamler?.dispose()').catch(() => {});
      }
      attached.clear();
      for (const { contents, listener, own } of bindings.values()) {
        if (contents.isDestroyed()) continue;
        await contents.debugger.sendCommand('Runtime.removeBinding', { name: '__tamlerBridge' }).catch(() => {});
        contents.debugger.removeListener('message', listener);
        if (own && contents.debugger.isAttached()) contents.debugger.detach();
      }
      bindings.clear();
      delete globalThis.__tamlerMain;
      log({ event: 'disposed' });
    }
  };
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('error', () => {});
    let input = '';
    socket.on('data', async chunk => {
      input += chunk;
      if (input.length > 4096) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      socket.removeAllListeners('data');
      try {
        const request = JSON.parse(input.split('\n')[0]);
        if (request.action === 'reload') socket.end(JSON.stringify({ ok: true, results: await api.reload() }) + '\n');
        else if (request.action === 'upgrade') socket.end(JSON.stringify({ ok: true, results: await api.upgrade() }) + '\n');
        else if (['toggle', 'pause', 'remove', 'refresh'].includes(request.action)) socket.end(JSON.stringify(await command(request)) + '\n');
        else if (request.action === 'status') socket.end(JSON.stringify({ ok: true, pid: process.pid, paused: store.paused(), plugins: store.list().map(({ modules, assets, css, folder, ...plugin }) => plugin) }) + '\n');
        else if (request.action === 'show-manager') {
          const page = [...attached.values()].map(entry => entry.contents).find(contents => !contents.isDestroyed() && contents.getURL().startsWith('https://claude.ai'));
          if (page && !await page.executeJavaScript('!!document.querySelector("[role=dialog][data-open] nav[data-perf-region=settings_nav]")')) {
            api.openSettings();
            for (let attempt = 0; attempt < 40; attempt++) {
              if (await page.executeJavaScript('!!document.querySelector("[role=dialog][data-open] nav[data-perf-region=settings_nav] [data-tamler-navigation]")')) break;
              await new Promise(resolve => setTimeout(resolve, 50));
            }
          }
          const results = await Promise.all([...attached.values()].filter(({ contents }) => !contents.isDestroyed() && allowed(contents.getURL())).map(async ({ contents }) => ({ id: contents.id, result: await contents.executeJavaScript('window.Tamler?.manager?.open().then(() => ({ pane: !!document.querySelector("[data-tamler-manager]"), errors: window.Tamler.errors }))') })));
          socket.end(JSON.stringify({ ok: true, results }) + '\n');
        }
        else if (request.action === 'ui-status') {
          const results = await Promise.all([...attached.values()].filter(({ contents }) => !contents.isDestroyed() && allowed(contents.getURL())).map(async ({ contents }) => ({ id: contents.id, result: await contents.executeJavaScript('(async () => ({ navigation: [...document.querySelectorAll("[data-tamler-navigation]")].map(e => ({text:e.textContent, first:e.parentElement.firstElementChild===e, selected:e.getAttribute("aria-current") === "page" || e.getAttribute("aria-selected") === "true"})), managerOpen: !!window.Tamler?.managerOpen, cards: document.querySelectorAll("[data-tamler-manager] [data-cds=Card]").length, switches: document.querySelectorAll("[data-tamler-manager] [data-cds=Switch]").length, errors: window.Tamler?.errors, components: await window.Tamler?.loadUI().then(ui => Object.keys(ui.components).sort(), error => error.message), checks: document.body.dataset.tamlerChecks }))()') })));
          socket.end(JSON.stringify({ ok: true, results }) + '\n');
        }
        else if (request.action === 'sources') {
          // Только чтение: адреса стартовых модулей и номер сборки для scripts/claude-sources.cjs.
          const contents = [...attached.values()].map(entry => entry.contents).find(contents => !contents.isDestroyed() && contents.getURL().startsWith('https://claude.ai'));
          if (!contents) throw new Error('Claude page unavailable');
          const result = await contents.executeJavaScript('({ build: document.documentElement.dataset.buildId || "unknown", urls: [...new Set([...document.querySelectorAll("link[rel=modulepreload], link[rel=stylesheet], script[src]")].map(e => e.href || e.src).filter(Boolean))] })');
          socket.end(JSON.stringify({ ok: true, ...result }) + '\n');
        }
        else if (request.action === 'capture') {
          const contents = [...attached.values()].map(entry => entry.contents).find(contents => !contents.isDestroyed() && contents.getURL().startsWith('https://claude.ai'));
          if (!contents) throw new Error('Claude page unavailable');
          const image = await contents.capturePage();
          fs.writeFileSync(path.join(root, 'build', 'manager.png'), image.toPNG());
          socket.end(JSON.stringify({ ok: true }) + '\n');
        }
        else if (request.action === 'verify-ui') {
          socket.setTimeout(30000);
          const contents = [...attached.values()].map(entry => entry.contents).find(contents => !contents.isDestroyed() && contents.getURL().startsWith('https://claude.ai'));
          const testPath = path.join(root, 'tests', 'claude-ui.cjs');
          delete require.cache[require.resolve(testPath)];
          const results = await require(testPath).verify(contents, root, api);
          socket.end(JSON.stringify({ ok: true, results }) + '\n');
        }
        else if (request.action === 'dispose') { await api.dispose(); socket.end(JSON.stringify({ ok: true }) + '\n'); }
        else socket.end(JSON.stringify({ ok: false, error: 'Unknown action' }) + '\n');
      } catch (error) { socket.end(JSON.stringify({ ok: false, error: error.message }) + '\n'); }
    });
  });
  let listenRetries = 0;
  server.on('error', error => {
    if (error.code === 'EADDRINUSE' && listenRetries++ < 10) setTimeout(() => server.listen(`\\\\.\\pipe\\tamler-${process.pid}`), 100);
    else log({ event: 'control-error', message: error.message });
  });
  server.listen(`\\\\.\\pipe\\tamler-${process.pid}`);
  server.unref();
  globalThis.__tamlerMain = api;
  api.ready = app.whenReady().then(() => {
    for (const contents of webContents.getAllWebContents()) attach(contents);
    log({ event: 'main-ready', electron: process.versions.electron, pid: process.pid });
  });
  return api;
}

module.exports = { start, loadPlugins, serializePlugins, hostAllowed };

