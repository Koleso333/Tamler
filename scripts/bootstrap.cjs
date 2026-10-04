const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'runtime', 'main.cjs');
const source = `(async () => {
  if (process.type !== 'browser') throw new Error('Tamler requires the Electron main process');
  const module = process.getBuiltinModule('module');
  const require = module.createRequire(process.execPath);
  await globalThis.__tamlerMain?.dispose();
  delete require.cache[require.resolve(${JSON.stringify(entry)})];
  require(${JSON.stringify(entry)}).start(require('electron'), ${JSON.stringify(root)});
})().catch(error => {
  process.getBuiltinModule('fs').appendFileSync(${JSON.stringify(path.join(root, 'build', 'native.log'))}, process.pid + ' async-bootstrap-error: ' + error.stack + '\\n');
})`;
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'build', 'bootstrap.js'), source);
