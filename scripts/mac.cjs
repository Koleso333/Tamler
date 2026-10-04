const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const connection = path.join(root, 'data', 'mac-connection.json');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function control(value) {
  const config = JSON.parse(fs.readFileSync(connection, 'utf8'));
  const response = await fetch(config.endpoint + '/control', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.token }, body: JSON.stringify(value), signal: AbortSignal.timeout(20000) });
  const result = await response.json();
  if (!result.ok) throw new Error(result.error);
  return result;
}
async function main() {
  if (process.platform !== 'darwin') throw new Error('This command requires macOS');
  const [action = 'start', argument = '{}'] = process.argv.slice(2);
  if (['start', 'stop'].includes(action)) {
    const { agentPath, manageAutostart } = require('../runtime/mac-autostart.cjs');
    if (fs.existsSync(agentPath())) {
      console.log(JSON.stringify(await manageAutostart(root, action === 'start' ? 'enable' : 'disable'), null, 2));
      return;
    }
  }
  if (action === 'start') {
    let running = false;
    try { await control({ action: 'status' }); running = true; } catch {}
    if (!running) {
      fs.mkdirSync(path.dirname(connection), { recursive: true });
      const logfile = fs.openSync(path.join(root, 'data', 'mac-helper.log'), 'a');
      const process = spawn(global.process.execPath, [path.join(root, 'runtime', 'mac-helper.cjs')], { detached: true, stdio: ['ignore', logfile, logfile] });
      process.unref();
      fs.closeSync(logfile);
      for (let n = 0; n < 50; n++) { await wait(100); try { await control({ action: 'status' }); running = true; break; } catch {} }
      if (!running) throw new Error('Mac helper failed; see data/mac-helper.log');
    }
    await control({ action: 'restart' });
    for (let n = 0; n < 40; n++) { await wait(500); const result = await control({ action: 'status' }); if (result.connected) { console.log(JSON.stringify(result, null, 2)); return; } }
    throw new Error('Claude has not reported Tamler; see data/mac-claude.log');
  }
  const result = await control({ ...JSON.parse(argument), action });
  if (!result.id) { console.log(JSON.stringify(result, null, 2)); return; }
  for (let n = 0; n < 150; n++) {
    await wait(500);
    const reply = await control({ action: 'result', id: result.id });
    if (reply.result) { console.log(JSON.stringify(reply.result, null, 2)); if (!reply.result.ok) global.process.exitCode = 1; return; }
  }
  throw new Error('Page command timed out');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
