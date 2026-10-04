const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createStore } = require('./store.cjs');
const { loadPlugins, hostAllowed } = require('./main.cjs');
const { buildExtension } = require('./mac-extension.cjs');

function createBackend(root) {
  const store = createStore(root, loadPlugins);
  let plugins = store.list();
  const state = () => plugins.map(plugin => ({ id: plugin.id, enabled: plugin.enabled, data: store.data(plugin.id) }));
  async function command(request) {
    const id = request.pluginId;
    if (request.action === 'storage-set') return { ok: true, data: store.setData(id, request.key, request.remove ? undefined : request.value) };
    if (request.action === 'file-put' || request.action === 'file-remove') {
      if (request.action === 'file-put') {
        if (typeof request.data !== 'string' || request.data.length > 262144) throw new Error('Invalid upload');
        store.writeFileChunk(id, request.key, request.name, request.upload, request.index, Buffer.from(request.data, 'base64'), !!request.last);
        if (!request.last) return { ok: true };
      } else store.removeFile(id, request.key, request.name);
      const files = store.listFiles(id, request.key);
      return { ok: true, files, ...(store.isFileSetting(id, request.key) ? { data: store.setData(id, request.key, files) } : {}) };
    }
    if (request.action === 'file-list') return { ok: true, files: store.listFiles(id, request.key) };
    if (request.action === 'file-get') return { ok: true, data: store.readFile(id, request.key, request.name).toString('base64') };
    if (request.action === 'net-fetch') {
      if (!hostAllowed(store.hostsOf(id), request.url)) throw new Error('Host is not listed in plugin hosts');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      try {
        let url = request.url;
        for (let redirects = 0; redirects <= 10; redirects++) {
          if (!hostAllowed(store.hostsOf(id), url)) throw new Error('Redirect to an unlisted host');
          const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 AppleWebKit/537.36 Chrome/142.0.0.0 Safari/537.36' }, redirect: 'manual', signal: controller.signal });
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel();
            url = new URL(response.headers.get('location'), url).href;
            continue;
          }
          const chunks = [];
          let size = 0;
          for await (const chunk of response.body || []) {
            size += chunk.length;
            if (size > 32 * 1024 * 1024) { controller.abort(); throw new Error('Response is larger than 32 MB'); }
            chunks.push(chunk);
          }
          return { ok: true, status: response.status, type: response.headers.get('content-type') || '', data: Buffer.concat(chunks).toString('base64') };
        }
        throw new Error('Too many redirects');
      } finally { clearTimeout(timer); }
    }
    if (request.action === 'toggle') store.toggle(id || request.id, request.enabled);
    else if (request.action === 'pause') store.setPaused(request.paused);
    else if (request.action === 'remove') store.remove(id || request.id);
    else if (request.action === 'open-folder') { execFileSync('open', [path.join(root, 'plugins')]); return { ok: true }; }
    else throw new Error('Unknown action');
    plugins = store.list();
    return { ok: true, state: state(), paused: store.paused() };
  }
  return { command, store, state, list: () => plugins, refresh: () => { plugins = store.list(); } };
}

function claudePids() {
  try { return execFileSync('pgrep', ['-x', 'Claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n'); } catch { return []; }
}

async function closeClaude() {
  for (const pid of claudePids()) process.kill(Number(pid), 'SIGTERM');
  for (let n = 0; n < 100 && claudePids().length; n++) await new Promise(resolve => setTimeout(resolve, 100));
  if (claudePids().length) throw new Error('Claude did not exit gracefully');
}

async function startHelper(root) {
  if (process.platform !== 'darwin') throw new Error('Mac helper requires macOS');
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  const configPath = path.join(data, 'mac-connection.json');
  const previous = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  if (previous.pid) {
    try { process.kill(previous.pid, 0); throw new Error('Mac helper is already running'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  const backend = createBackend(root);
  const extension = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'extensions', 'fmkadmapgofadopljbjfkapdkoienihi');
  if (fs.existsSync(extension)) {
    const marker = path.join(extension, '.tamler.json');
    if (!fs.existsSync(marker) || JSON.parse(fs.readFileSync(marker, 'utf8')).root !== root) throw new Error('React DevTools cache already exists; refusing to overwrite it');
  }
  const config = { root, pid: process.pid, key: previous.key || crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'der' }, privateKeyEncoding: { type: 'pkcs8', format: 'der' } }).publicKey.toString('base64'), token: crypto.randomBytes(32).toString('hex'), channel: previous.channel || crypto.randomBytes(24).toString('hex') };
  const queued = [];
  const completed = new Map();
  let status = { connected: false };
  let restarting;
  let stopping = false;
  function rebuild() { backend.refresh(); buildExtension(extension, config, backend.list(), backend.store.data, backend.store.paused()); }
  function restart() {
    return restarting ||= (async () => {
      await closeClaude();
      rebuild();
      status = { connected: false };
      execFileSync('open', ['-a', '/Applications/Claude.app', '--env', 'REACT_PROFILE=1', '--stdout', path.join(data, 'mac-claude.log'), '--stderr', path.join(data, 'mac-claude.log')]);
    })().finally(() => { restarting = undefined; });
  }
  const server = http.createServer(async (request, response) => {
    const answer = (code, value) => { response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
    if (request.method !== 'POST' || request.headers.authorization !== 'Bearer ' + config.token || request.headers['content-type'] !== 'application/json') { answer(403, { ok: false, error: 'Forbidden' }); return; }
    let input = '';
    try {
      for await (const chunk of request) { input += chunk; if (input.length > 4 * 1024 * 1024) throw new Error('Request is too large'); }
      const value = JSON.parse(input);
      if (request.url === '/bridge') {
        if (value.action === 'refresh') { answer(200, { ok: true }); setTimeout(() => restart().catch(error => { status.restartError = error.message; }), 700); return; }
        answer(200, await backend.command(value));
      } else if (request.url === '/report') {
        status = { ...value, connected: true, time: new Date().toISOString() };
        fs.writeFileSync(path.join(data, 'mac-status.json'), JSON.stringify(status, null, 2));
        answer(200, { ok: true });
      } else if (request.url === '/commands') answer(200, { ok: true, commands: queued.splice(0) });
      else if (request.url === '/command-result') { completed.set(value.id, value.result); answer(200, { ok: true }); }
      else if (request.url === '/control') {
        if (value.action === 'status') answer(200, { ok: true, helperPid: process.pid, ...status });
        else if (value.action === 'restart' || value.action === 'refresh') { await restart(); answer(200, { ok: true }); }
        else if (value.action === 'result') { const result = completed.get(value.id); if (result) completed.delete(value.id); answer(200, { ok: true, result }); }
        else if (['diagnostics', 'verify', 'set-setting', 'toggle', 'remove', 'show-manager'].includes(value.action)) {
          if (queued.length > 32) throw new Error('Too many pending commands');
          const id = crypto.randomUUID(); queued.push({ ...value, id }); answer(200, { ok: true, id });
        }
        else if (value.action === 'stop') {
          stopping = true;
          await closeClaude();
          execFileSync('open', ['-a', '/Applications/Claude.app']);
          answer(200, { ok: true });
          setTimeout(() => process.exit(0), 200);
        }
        else answer(200, await backend.command(value));
      } else answer(404, { ok: false, error: 'Unknown route' });
    } catch (error) { answer(200, { ok: false, error: error.message }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.endpoint = 'http://127.0.0.1:' + server.address().port;
  rebuild();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  console.log('Tamler Mac helper ready');
  setInterval(() => {
    if (restarting || stopping) return;
    const pids = claudePids();
    if (!pids.length) return;
    try {
      const environment = execFileSync('ps', ['eww', '-p', pids[0]], { encoding: 'utf8' });
      if (!environment.includes('REACT_PROFILE=1')) restart().catch(error => { status.restartError = error.message; });
    } catch (error) { status.restartError = error.message; }
  }, 5000).unref();
  return { server, backend, restart };
}

if (require.main === module) startHelper(path.resolve(__dirname, '..')).then(async helper => {
  if (process.argv.includes('--autostart')) await helper.restart();
}).catch(error => { console.error(error.stack); process.exit(1); });
module.exports = { createBackend, startHelper, closeClaude };
