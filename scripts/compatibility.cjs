const fs = require('node:fs');
const path = require('node:path');
const { readPe } = require('./pe.cjs');

function compatible(target, loader, version, supportedVersion, callExports = []) {
  if (version !== supportedVersion) return { ok: false, reason: `Unsupported Electron ${version}; tested ${supportedVersion}` };
  if (target.machine !== 34404 || loader.machine !== 34404) return { ok: false, reason: 'Windows x64 required' };
  const required = loader.imports.filter(entry => entry.dll.toLowerCase() === 'node.exe').map(entry => entry.name);
  if (!required.length) return { ok: false, reason: 'Loader has no Node imports' };
  const available = new Set(target.exports);
  if (callExports.length && !callExports.some(name => available.has(name))) return { ok: false, reason: 'No supported V8 Function::Call export' };
  const missing = required.filter(name => !available.has(name));
  if (missing.length) return { ok: false, reason: `Missing ${missing.length} native exports` };
  return { ok: true, electron: version };
}

if (require.main === module) {
  try {
    const executable = process.argv[2];
    const root = path.resolve(__dirname, '..');
    const version = fs.readFileSync(path.join(path.dirname(executable), 'version'), 'utf8').trim();
    const baseline = JSON.parse(fs.readFileSync(path.join(root, 'build', 'target.json'), 'utf8').replace(/^\uFEFF/, ''));
    const result = compatible(readPe(executable), readPe(path.join(root, 'build', 'tamler.dll')), version, baseline.electron, baseline.callExports);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 2;
  } catch (error) { console.log(JSON.stringify({ ok: false, reason: error.message })); process.exitCode = 2; }
}

module.exports = { compatible };
