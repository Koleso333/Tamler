// Проверяет патчи всех плагинов из plugins/ на сырых (минифицированных) чанках текущей сборки Claude.
// Запуск: node scripts/check-patches.cjs [build]   (без build берётся самая свежая папка .cache/claude-src)
// Список адресов — urls.txt, который пишет npm run sources -- PID. Сырые чанки кэшируются в .cache/claude-raw/<build>/.
// За прокси: NODE_USE_ENV_PROXY=1 node scripts/check-patches.cjs (fetch в Node сам HTTPS_PROXY не читает).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { applyPatches } = require('../runtime/main.cjs');

const cache = path.join(__dirname, '..', '.cache', 'claude-src');
const build = process.argv[2] || fs.readdirSync(cache)
  .map(name => ({ name, time: fs.statSync(path.join(cache, name)).mtimeMs }))
  .sort((a, b) => b.time - a.time)[0]?.name;
if (!build) { console.error('No sources in .cache/claude-src; run npm run sources -- PID first'); process.exit(1); }
const urls = fs.readFileSync(path.join(cache, build, 'urls.txt'), 'utf8').split('\n').filter(Boolean);
const raw = path.join(__dirname, '..', '.cache', 'claude-raw', build);
fs.mkdirSync(raw, { recursive: true });
// Как в ядре: * в адресе патча совпадает с чем угодно, включая /.
const glob = pattern => new RegExp('^' + pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');

async function main() {
  let failed = 0;
  const plugins = path.join(__dirname, '..', 'plugins');
  for (const id of fs.readdirSync(plugins)) {
    const manifest = path.join(plugins, id, 'plugin.json');
    if (!fs.existsSync(manifest)) continue;
    const { patches = [] } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    for (const [index, patch] of patches.entries()) {
      const url = urls.find(entry => glob(patch.url).test(entry));
      if (!url) { failed++; console.log(`${id} #${index}: no chunk matches ${patch.url}`); continue; }
      const file = path.join(raw, path.basename(url));
      if (!fs.existsSync(file)) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${response.status} ${url}`);
        fs.writeFileSync(file, await response.text());
      }
      const source = fs.readFileSync(file, 'utf8');
      const flags = patch.flags || '';
      const matches = (source.match(new RegExp(patch.find, flags.includes('g') ? flags : flags + 'g')) || []).length;
      const { source: patched } = applyPatches(source, [patch]);
      // Чанки — ES-модули: .mjs, чтобы node --check разбирал import/export.
      const check = path.join(raw, `${path.basename(url, '.js')}.${id}-${index}.mjs`);
      fs.writeFileSync(check, patched);
      let syntax = 'ok';
      try { execFileSync(process.execPath, ['--check', check], { stdio: 'pipe' }); } catch (error) { syntax = `syntax error: ${String(error.stderr).split('\n').slice(0, 4).join(' ')}`; }
      fs.rmSync(check);
      // Патч должен находить ровно одно место: 0 — не сработает, больше 1 — заденет лишнее.
      const ok = matches === 1 && syntax === 'ok';
      if (!ok) failed++;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${id} #${index}: ${path.basename(url)}, matches ${matches}, ${syntax}`);
    }
  }
  console.log(`Build ${build}: ${failed ? `${failed} patch(es) need attention` : 'all patches apply'}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
