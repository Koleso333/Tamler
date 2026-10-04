// Выкачивает JS и CSS веб-интерфейса Claude, форматирует и складывает в .cache/claude-src/<build>/ для поиска по коду.
// Запуск: node scripts/claude-sources.cjs PID
// Из окна Claude берётся только список стартовых модулей (команда sources, без кликов); остальное качается напрямую.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const beautify = require('js-beautify');

const pid = process.argv[2];
if (!/^\d+$/.test(pid || '')) {
  console.error('Usage: node scripts/claude-sources.cjs PID');
  process.exit(1);
}

function control(action) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(`\\\\.\\pipe\\tamler-${pid}`);
    let output = '';
    socket.setEncoding('utf8');
    socket.setTimeout(10000, () => socket.destroy(new Error('Control request timed out')));
    socket.on('connect', () => socket.write(JSON.stringify({ action }) + '\n'));
    socket.on('data', chunk => { output += chunk; });
    socket.on('end', () => {
      try {
        const result = JSON.parse(output);
        result.ok ? resolve(result) : reject(new Error(result.error));
      } catch (error) { reject(error); }
    });
    socket.on('error', reject);
  });
}

const allowed = url => /^https:\/\/assets-proxy\.anthropic\.com\//.test(url) && /\.(js|css)$/.test(new URL(url).pathname);
const references = /["'`]((?:\.{1,2}\/|\/|https:\/\/)[^"'`\s()]+?\.(?:js|css))["'`]/g;

async function main() {
  const { build, urls } = await control('sources');
  const target = path.join(__dirname, '..', '.cache', 'claude-src', build);
  fs.mkdirSync(target, { recursive: true });
  const queue = urls.filter(allowed);
  const seen = new Set(queue);
  let done = 0;
  let failed = 0;

  async function take(url) {
    const name = path.basename(new URL(url).pathname);
    const file = path.join(target, name);
    let text;
    if (fs.existsSync(file + '.raw')) text = fs.readFileSync(file + '.raw', 'utf8');
    else {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      text = await response.text();
      fs.writeFileSync(file + '.raw', text);
    }
    for (const match of text.matchAll(references)) {
      let next;
      try { next = new URL(match[1], url).href; } catch { continue; }
      if (allowed(next) && !seen.has(next)) { seen.add(next); queue.push(next); }
    }
    if (!fs.existsSync(file)) {
      const pretty = name.endsWith('.css') ? beautify.css(text, { indent_size: 2 }) : beautify.js(text, { indent_size: 2, max_preserve_newlines: 1 });
      fs.writeFileSync(file, pretty);
    }
  }

  const workers = Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const url = queue.shift();
      try { await take(url); done++; } catch (error) { failed++; console.error(error.message); }
      if ((done + failed) % 100 === 0) console.log(`${done + failed} / ${seen.size}`);
    }
  });
  await Promise.all(workers);
  // Сырые копии нужны только для повторного запуска без скачивания.
  for (const name of fs.readdirSync(target)) if (name.endsWith('.raw')) fs.rmSync(path.join(target, name));
  fs.writeFileSync(path.join(target, 'urls.txt'), [...seen].sort().join('\n') + '\n');
  console.log(`Build ${build}: ${done} files saved, ${failed} failed -> ${target}`);
}

main().catch(error => { console.error(error.message); process.exit(1); });
