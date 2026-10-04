const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readPe } = require('./pe.cjs');

function findClaude() {
  const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-AppxPackage -Name Claude | Select-Object -ExpandProperty InstallLocation"], { encoding: 'utf8' }).trim();
  if (!output) throw new Error('Claude MSIX installation not found; pass the executable path');
  return path.join(output.split(/\r?\n/)[0], 'app', 'Claude.exe');
}

const argument = process.argv.slice(2).find(value => !value.startsWith('--'));
const executable = argument ? path.resolve(argument) : findClaude();
const pe = readPe(executable);
const functions = pe.exports.filter(name => /^\?Call@Function@v8@@/.test(name));
const report = {
  executable,
  electron: fs.readFileSync(path.join(path.dirname(executable), 'version'), 'utf8').trim(),
  architecture: pe.machine === 0x8664 ? 'x64' : pe.machine,
  fuses: pe.fuses,
  callExports: functions,
  canBuildProbe: pe.machine === 0x8664 && functions.length >= 1
};
if (process.argv.includes('--def')) {
  fs.mkdirSync(path.join(__dirname, '..', 'build'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'node.def'), `LIBRARY node.exe\nEXPORTS\n${pe.exports.map(name => `  ${name}`).join('\n')}\n`);
}
console.log(JSON.stringify(report, null, 2));
