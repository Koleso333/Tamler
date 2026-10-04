const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const electron = path.resolve(__dirname, '..', '.cache', 'electron', 'runtime', 'electron.exe');
if (!fs.existsSync(electron)) {
  console.error('Extract stock Electron 44.4.3 x64 into .cache/electron/runtime first');
  process.exit(1);
}
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tamler-electron-'));
const result = spawnSync(electron, [path.resolve(process.argv[2]), `--user-data-dir=${profile}`], { stdio: 'inherit' });
fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
process.exit(result.status ?? 1);
