const fs = require('node:fs');
const path = require('node:path');

const DATA_LIMIT = 256 * 1024;
const FILE_LIMIT = 32 * 1024 * 1024;
const FILES_LIMIT = 256 * 1024 * 1024;

function createStore(root, loadPlugins) {
  const directory = path.join(root, 'plugins');
  const settingsPath = path.join(root, 'data', 'settings.json');
  const read = () => fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : { enabled: {} };
  const known = new Set();
  const hosts = new Map();
  const fileSettings = new Map();
  const dataDirectory = path.join(root, 'data', 'plugin-data');
  function write(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
    fs.renameSync(temporary, file);
  }
  const save = settings => write(settingsPath, settings);
  const dataPath = id => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id || '')) throw new Error('Invalid plugin id');
    return path.join(dataDirectory, `${id}.json`);
  };
  function data(id) {
    const file = dataPath(id);
    if (!fs.existsSync(file)) return {};
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  }
  function setData(id, key, value) {
    if (typeof key !== 'string' || !key || key.length > 200) throw new Error('Invalid storage key');
    // Список берётся из последней загрузки: перечитывать все модули на каждую запись слишком дорого.
    if (!known.has(id)) throw new Error('Unknown plugin');
    const next = data(id);
    if (value === undefined) delete next[key];
    else next[key] = value;
    if (JSON.stringify(next).length > DATA_LIMIT) throw new Error('Plugin storage is limited to 256 KB');
    write(dataPath(id), next);
    return next;
  }
  // Файлы плагина: data/plugin-files/<id>/<key>/<name>. Ключ и имя — один сегмент пути без спецсимволов.
  const segment = (value, what) => {
    if (typeof value !== 'string' || !value || value.length > 200 || /[\\/:*?"<>|\x00-\x1f]/.test(value) || value.startsWith('.')) throw new Error(`Invalid file ${what}`);
    return value;
  };
  const filesRoot = id => {
    dataPath(id);
    if (!known.has(id)) throw new Error('Unknown plugin');
    return path.join(root, 'data', 'plugin-files', id);
  };
  const filePath = (id, key, name) => path.join(filesRoot(id), segment(key, 'key'), segment(name, 'name'));
  function listFiles(id, key) {
    const directory = path.join(filesRoot(id), segment(key, 'key'));
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile() && !entry.name.startsWith('.'))
      .map(entry => ({ name: entry.name, size: fs.statSync(path.join(directory, entry.name)).size })).sort((a, b) => a.name.localeCompare(b.name));
  }
  function usage(id) {
    const base = filesRoot(id);
    let total = 0;
    const walk = directory => { if (!fs.existsSync(directory)) return; for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) walk(file); else total += fs.statSync(file).size; } };
    walk(base);
    return total;
  }
  // Загрузка идёт кусками: мост из страницы ограничен 256 КБ на сообщение.
  function writeFileChunk(id, key, name, upload, index, chunk, last) {
    const target = filePath(id, key, name);
    if (!/^[a-z0-9]{8,40}$/.test(upload || '') || !Number.isSafeInteger(index) || index < 0) throw new Error('Invalid upload');
    const temporary = path.join(path.dirname(target), `.upload-${upload}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (index === 0) fs.writeFileSync(temporary, chunk);
    else {
      if (!fs.existsSync(temporary)) throw new Error('Upload expired');
      fs.appendFileSync(temporary, chunk);
    }
    const size = fs.statSync(temporary).size;
    const previous = fs.existsSync(target) ? fs.statSync(target).size : 0;
    if (size > FILE_LIMIT || usage(id) - previous > FILES_LIMIT) {
      fs.rmSync(temporary, { force: true });
      throw new Error(size > FILE_LIMIT ? 'File is larger than 32 MB' : 'Plugin files exceed 256 MB');
    }
    if (last) fs.renameSync(temporary, target);
  }
  const readFile = (id, key, name) => fs.readFileSync(filePath(id, key, name));
  function removeFile(id, key, name) { fs.rmSync(filePath(id, key, name), { force: true }); }
  function list() {
    const settings = read();
    const plugins = loadPlugins(directory).map(plugin => ({ ...plugin, enabled: plugin.error ? false : settings.enabled?.[plugin.id] ?? plugin.enabled ?? true }));
    known.clear();
    hosts.clear();
    fileSettings.clear();
    for (const plugin of plugins) if (!plugin.error) { known.add(plugin.id); hosts.set(plugin.id, plugin.hosts || []); fileSettings.set(plugin.id, new Set((plugin.settings || []).filter(setting => setting.type === 'files').map(setting => setting.key))); }
    return plugins;
  }
  function toggle(id, enabled) {
    if (typeof enabled !== 'boolean' || !list().some(plugin => plugin.id === id)) throw new Error('Invalid plugin toggle');
    const settings = read();
    settings.enabled = { ...settings.enabled, [id]: enabled };
    save(settings);
  }
  // Общий выключатель: останавливает все плагины, не трогая их собственные переключатели.
  const paused = () => read().paused === true;
  function setPaused(value) {
    if (typeof value !== 'boolean') throw new Error('Invalid pause value');
    const settings = read();
    if (value) settings.paused = true;
    else delete settings.paused;
    save(settings);
  }
  function remove(id) {
    const plugin = list().find(entry => entry.id === id);
    if (!plugin) throw new Error('Unknown plugin');
    const base = fs.realpathSync(directory);
    const target = fs.realpathSync(plugin.folder);
    const relative = path.relative(base, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.dirname(target) !== base) throw new Error('Plugin directory is outside plugins');
    const trash = path.join(root, 'data', 'removed-plugins');
    fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(target, path.join(trash, `${Date.now()}-${id}`));
    const settings = read();
    delete settings.enabled?.[id];
    save(settings);
  }
  return { list, toggle, paused, setPaused, remove, data, setData, listFiles, writeFileChunk, readFile, removeFile, hostsOf: id => hosts.get(id) || [], isFileSetting: (id, key) => !!fileSettings.get(id)?.has(key) };
}

module.exports = { createStore };
