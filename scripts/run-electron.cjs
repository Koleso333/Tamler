const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const target = path.join(root, 'build', 'target.json');
const cache = path.join(root, '.cache', 'electron');
const version = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, '')).electron : null;
const electron = [
  version && path.join(cache, version, 'runtime', 'electron.exe'),
  path.join(cache, 'runtime', 'electron.exe')
].find(candidate => candidate && fs.existsSync(candidate));
if (!electron) {
  console.error('Extract stock Electron x64 into .cache/electron/runtime first');
  process.exit(1);
}
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tamler-electron-'));
const result = spawnSync(electron, [path.resolve(process.argv[2]), `--user-data-dir=${profile}`], { stdio: 'inherit' });
fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
process.exit(result.status ?? 1);
