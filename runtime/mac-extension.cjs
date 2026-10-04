const fs = require('node:fs');
const path = require('node:path');
const { installTamler } = require('./renderer.cjs');
const { installManager } = require('./manager.cjs');
const { serializePlugins } = require('./main.cjs');

function rendererAdapter(window, plugins, install, manager, channel, paused) {
  const direct = new Map();
  let sequence = 10000000;
  const post = message => window.postMessage({ channel, ...message }, '*');
  const call = request => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { direct.delete(id); reject(new Error('Mac helper timed out')); }, 70000);
    direct.set(id, { resolve, reject, timer });
    post({ kind: 'request', request: { ...request, id } });
  });
  function state(next, nextPaused) {
    if (!next || !window.Tamler) return;
    const ids = new Set(next.map(plugin => plugin.id));
    plugins = plugins.filter(plugin => ids.has(plugin.id));
    for (const plugin of plugins) Object.assign(plugin, next.find(item => item.id === plugin.id));
    window.Tamler.update(plugins, { paused: nextPaused ?? window.Tamler.paused });
  }
  const report = () => post({ kind: 'report', report: { origin: location.origin, version: window.Tamler?.version, plugins: window.Tamler?.list(), errors: window.Tamler?.errors || [], indicator: !!document.querySelector('[data-tamler-indicator]'), managerOpen: !!document.querySelector('[data-tamler-manager]') } });
  async function command(message) {
    try {
      let result;
      if (message.action === 'diagnostics') {
        const ui = await window.Tamler.loadUI();
        result = { components: Object.keys(ui.components).sort(), plugins: window.Tamler.list(), errors: window.Tamler.errors };
      } else if (message.action === 'set-setting') {
        await window.Tamler.setSetting(message.pluginId, message.key, message.value);
        result = { plugins: window.Tamler.list() };
      } else if (message.action === 'toggle' || message.action === 'remove') {
        result = await call({ action: message.action, pluginId: message.pluginId, enabled: message.enabled });
        state(result.state, result.paused);
        result = { plugins: window.Tamler.list() };
      } else if (message.action === 'show-manager') {
        await window.Tamler.manager.open();
        result = { managerOpen: !!document.querySelector('[data-tamler-manager]'), cards: document.querySelectorAll('[data-tamler-manager] [data-cds="Card"]').length, errors: window.Tamler.errors };
      } else if (message.action === 'verify') {
        const id = 'custom-fonts';
        const key = 'tamler-verification';
        const name = 'roundtrip.txt';
        const value = btoa('Tamler Mac file roundtrip');
        try {
          await call({ action: 'file-put', pluginId: id, key, name, upload: 'macverification01', index: 0, last: true, data: value });
          const file = await call({ action: 'file-get', pluginId: id, key, name });
          const files = await call({ action: 'file-list', pluginId: id, key });
          if (file.data !== value || !files.files.some(file => file.name === name)) throw new Error('File roundtrip failed');
          result = { files: true };
        } finally { await call({ action: 'file-remove', pluginId: id, key, name }); }
        const groupBy = window.Tamler.list().find(plugin => plugin.id === 'old-chat-layout').values.groupBy;
        const probe = groupBy === 'none' ? 'date' : 'none';
        await window.Tamler.setSetting('old-chat-layout', 'groupBy', probe);
        result.settings = window.Tamler.list().find(plugin => plugin.id === 'old-chat-layout').values.groupBy === probe;
        await window.Tamler.setSetting('old-chat-layout', 'groupBy', groupBy);
        const fetched = await call({ action: 'net-fetch', pluginId: id, url: 'https://fonts.googleapis.com/css2?family=Roboto&text=Tamler' });
        result.network = fetched.status === 200 && fetched.data.length > 0;
        if (!result.settings || !result.network) throw new Error('Settings or network verification failed');
        result.errors = window.Tamler.errors;
      } else throw new Error('Unknown page command');
      post({ kind: 'command-result', commandId: message.id, result: { ok: true, ...result } });
    } catch (error) { post({ kind: 'command-result', commandId: message.id, result: { ok: false, error: error.message } }); }
    report();
  }
  window.addEventListener('message', event => {
    if (event.source !== window || event.data?.channel !== channel) return;
    const message = event.data;
    if (message.kind === 'reply') {
      const pending = direct.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        direct.delete(message.id);
        message.result.ok ? pending.resolve(message.result) : pending.reject(new Error(message.result.error));
      } else {
        if (message.result.state) state(message.result.state, message.result.paused);
        window.Tamler?.reply(message.id, message.result);
      }
    } else if (message.kind === 'state') state(message.state, message.paused);
    else if (message.kind === 'command') void command(message.command);
  });
  window.__tamlerBridge = raw => post({ kind: 'request', request: JSON.parse(raw) });
  install(window, plugins, manager, { paused }).then(() => {
    post({ kind: 'ready' });
    setTimeout(report, 3000);
    setInterval(report, 10000);
  }, error => post({ kind: 'report', report: { origin: location.origin, errors: [{ message: error.stack }] } }));
}

function isolatedAdapter(channel) {
  window.addEventListener('message', event => {
    if (event.source !== window || event.data?.channel !== channel) return;
    const message = event.data;
    if (!['request', 'ready', 'report', 'command-result'].includes(message.kind)) return;
    chrome.runtime.sendMessage(message).then(result => {
      if (message.kind === 'request') window.postMessage({ channel, kind: 'reply', id: message.request.id, result }, '*');
    }).catch(error => {
      if (message.kind === 'request') window.postMessage({ channel, kind: 'reply', id: message.request.id, result: { ok: false, error: String(error) } }, '*');
    });
  });
  chrome.runtime.onMessage.addListener(message => {
    if (['state', 'command'].includes(message.kind)) window.postMessage({ channel, ...message }, '*');
  });
}

function backgroundAdapter(endpoint, token) {
  const tabs = new Set();
  const allowed = value => {
    try { const url = new URL(value); return url.protocol === 'https:' && ['claude.ai', 'claude.com'].includes(url.hostname); }
    catch { return false; }
  };
  const send = async (route, value) => {
    const response = await fetch(endpoint + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify(value) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Helper unavailable');
    return result;
  };
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (!sender.tab || !allowed(sender.url)) { reply({ ok: false, error: 'Invalid page' }); return; }
    tabs.add(sender.tab.id);
    (async () => {
      if (message.kind === 'request') {
        const result = await send('/bridge', message.request);
        if (result.state) for (const id of tabs) if (id !== sender.tab.id) chrome.tabs.sendMessage(id, { kind: 'state', state: result.state, paused: result.paused }).catch(() => tabs.delete(id));
        return result;
      }
      if (message.kind === 'report') return send('/report', message.report);
      if (message.kind === 'command-result') return send('/command-result', { id: message.commandId, result: message.result });
      return { ok: true };
    })().then(reply, error => reply({ ok: false, error: String(error) }));
    return true;
  });
  setInterval(async () => {
    if (!tabs.size) return;
    try {
      const result = await send('/commands', {});
      for (const command of result.commands) chrome.tabs.sendMessage([...tabs][0], { kind: 'command', command }).catch(() => tabs.delete([...tabs][0]));
    } catch {}
  }, 1000);
}

function buildExtension(directory, config, plugins, data, paused = false) {
  fs.mkdirSync(directory, { recursive: true });
  const matches = ['https://claude.ai/*', 'https://claude.com/*'];
  const manifest = { manifest_version: 2, name: 'Tamler', version: '0.5.0', key: config.key, permissions: ['http://127.0.0.1/*'], background: { scripts: ['background.js'], persistent: true }, content_scripts: [{ matches, js: ['isolated.js'], run_at: 'document_start' }, { matches, js: ['main.js'], run_at: 'document_idle' }] };
  const main = `(()=>{const install=${installTamler.toString()};const manager=${installManager.toString()};(${rendererAdapter.toString()})(window,[${serializePlugins(plugins, data)}],install,manager,${JSON.stringify(config.channel)},${JSON.stringify(!!paused)});})();`;
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const bootstrap = `(()=>{try{const nonce=[...document.scripts].find(script=>script.nonce)?.nonce;if(!nonce)throw new Error('Claude CSP nonce unavailable');const script=document.createElement('script');script.nonce=nonce;script.textContent=${JSON.stringify(main)};document.head.append(script);script.remove();}catch(error){window.postMessage({channel:${JSON.stringify(config.channel)},kind:'report',report:{origin:location.origin,errors:[{message:error.message}]}},'*');}})();`;
  fs.writeFileSync(path.join(directory, 'main.js'), bootstrap);
  fs.writeFileSync(path.join(directory, 'isolated.js'), `(${isolatedAdapter.toString()})(${JSON.stringify(config.channel)});`);
  fs.writeFileSync(path.join(directory, 'background.js'), `(${backgroundAdapter.toString()})(${JSON.stringify(config.endpoint)},${JSON.stringify(config.token)});`);
  fs.writeFileSync(path.join(directory, '.tamler.json'), JSON.stringify({ root: config.root }));
}

module.exports = { buildExtension };
