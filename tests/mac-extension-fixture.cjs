const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { buildExtension } = require('../runtime/mac-extension.cjs');
const profile = process.argv.find(value => value.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length) || os.tmpdir();
const root = fs.mkdtempSync(path.join(profile, 'tamler-world-'));
app.setPath('userData', path.join(root, 'profile'));
let server;
app.whenReady().then(async () => {
  server = http.createServer((request, response) => {
    if (request.url === '/store.js') { response.writeHead(200, { 'Content-Type': 'application/javascript' }); response.end('export const store={groupBy:"date"};'); return; }
    if (request.method === 'POST') { request.resume(); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"ok":true,"commands":[]}'); return; }
    response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'nonce-tamler-fixture'; style-src 'unsafe-inline'" });
    response.end('<!doctype html><html><head><link rel="modulepreload" href="/store.js"><script type="module" nonce="tamler-fixture">import{store}from"/store.js";window.nativeStore=store;document.documentElement.__nativeMarker=true;</script></head><body>Tamler context fixture</body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = 'http://127.0.0.1:' + server.address().port;
  const extension = path.join(root, 'extension');
  const plugin = { id: 'grouping', name: 'Grouping', enabled: true, main: 'index.js', modules: { 'index.js': { source: 'module.exports.start=async({window,document})=>{const url=document.querySelector("link[rel=modulepreload]").href;const{store}=await import(url);store.groupBy="project";document.documentElement.dataset.nativeVisible=String(!!document.documentElement.__nativeMarker);};' } }, assets: {}, settings: [] };
  buildExtension(extension, { root, endpoint, token: 'fixture', channel: 'fixture-channel' }, [plugin], () => ({}));
  const manifestPath = path.join(extension, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  for (const script of manifest.content_scripts) script.matches = ['http://127.0.0.1/*'];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  await session.defaultSession.loadExtension(extension);
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL(endpoint);
  await new Promise(resolve => setTimeout(resolve, 1500));
  const result = await window.webContents.executeJavaScript('({groupBy:window.nativeStore?.groupBy,nativeVisible:document.documentElement.dataset.nativeVisible})');
  console.log(JSON.stringify(result));
  assert.equal(result.groupBy, 'project', 'plugin must update the store instance used by the page');
  assert.equal(result.nativeVisible, 'true', 'plugin must see native DOM expandos');
  console.log('Mac extension context fixture: ok');
  server.close();
  session.defaultSession.extensions.removeExtension(session.defaultSession.extensions.getAllExtensions()[0].id);
  window.destroy();
  app.exit(0);
}).catch(error => { console.error(error.stack); server?.close(); app.exit(1); });
// On Windows Chromium still holds profile files open during will-quit; the runner removes the parent dir after exit.
app.on('will-quit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
setTimeout(() => app.exit(2), 20000).unref();
