const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { closeClaude } = require('./mac-helper.cjs');

const label = 'local.tamler.helper';
const agentPath = () => path.join(os.homedir(), 'Library', 'LaunchAgents', label + '.plist');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const xml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);

function buildPlist(root, node) {
  const data = path.join(root, 'data');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(path.join(root, 'runtime', 'mac-helper.cjs'))}</string><string>--autostart</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>ThrottleInterval</key><integer>10</integer>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path.dirname(node))}:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>StandardOutPath</key><string>${xml(path.join(data, 'mac-helper.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(data, 'mac-helper.log'))}</string>
</dict></plist>
`;
}

function nodePath() {
  for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    try { if (fs.realpathSync(candidate) === fs.realpathSync(process.execPath)) return candidate; } catch {}
  }
  return process.execPath;
}

async function control(root, action) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'data', 'mac-connection.json'), 'utf8'));
  const response = await fetch(config.endpoint + '/control', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.token }, body: JSON.stringify({ action }), signal: AbortSignal.timeout(20000) });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || 'Mac helper unavailable');
  return result;
}

async function manageAutostart(root, action) {
  if (process.platform !== 'darwin') throw new Error('Mac autostart requires macOS');
  if (!['enable', 'disable', 'status'].includes(action)) throw new Error('Expected enable, disable or status');
  const plist = agentPath();
  const domain = 'gui/' + process.getuid();
  const target = domain + '/' + label;
  const launchctl = args => execFileSync('/bin/launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const loaded = () => { try { return launchctl(['print', target]); } catch { return ''; } };
  const owned = () => {
    if (fs.existsSync(plist) && fs.readFileSync(plist, 'utf8') !== buildPlist(root, nodePath())) throw new Error('Tamler LaunchAgent belongs to a different installation or has been modified');
  };
  if (action === 'status') {
    const details = loaded();
    let helper;
    try { helper = await control(root, 'status'); } catch {}
    return { ok: true, installed: fs.existsSync(plist), loaded: !!details, pid: Number(details.match(/\bpid = (\d+)/)?.[1]) || null, connected: !!helper?.connected, plist };
  }
  owned();
  if (action === 'disable') {
    if (loaded()) launchctl(['bootout', target]);
    fs.rmSync(plist, { force: true });
    let helper;
    try { helper = await control(root, 'status'); } catch {}
    if (helper) await control(root, 'stop');
    else { await closeClaude(); execFileSync('/usr/bin/open', ['-a', '/Applications/Claude.app']); }
    return { ok: true, installed: false, loaded: false };
  }
  if (!loaded()) {
    let helper;
    try { helper = await control(root, 'status'); } catch {}
    if (helper) {
      await control(root, 'stop');
      for (let n = 0; n < 50; n++) {
        try { process.kill(helper.helperPid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }
        await wait(100);
      }
    }
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(plist, buildPlist(root, nodePath()));
    execFileSync('/usr/bin/plutil', ['-lint', plist]);
    launchctl(['enable', target]);
    launchctl(['bootstrap', domain, plist]);
  }
  for (let n = 0; n < 80; n++) {
    await wait(500);
    try {
      const helper = await control(root, 'status');
      const details = loaded();
      const pid = Number(details.match(/\bpid = (\d+)/)?.[1]);
      if (helper.connected && pid === helper.helperPid) return { ok: true, installed: true, loaded: true, pid, connected: true, plist };
    } catch {}
  }
  throw new Error('LaunchAgent did not connect to Claude; see data/mac-helper.log and data/mac-claude.log');
}

module.exports = { buildPlist, agentPath, manageAutostart };
