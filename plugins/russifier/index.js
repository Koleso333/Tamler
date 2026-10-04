// Русский каталог у Claude уже есть (/i18n/ru.json), но не выпущен флагом. Локаль приложения не меняется:
// заголовки x-app-locale/accept-language, <html lang>, телеметрия и аккаунт остаются en-US.
// Вместо этого русские строки подмешиваются в словарь messages хранилища языка — провайдер переводов
// ставит его поверх строк текущей локали.
const LOCALE = 'ru';
const CACHE_KEY = 'catalog';

function catalogVersions(document) {
  const meta = document.querySelector('meta[name="i18n-catalogs"]');
  for (const entry of (meta?.dataset.i18nCatalogs || '').split(',')) {
    const match = /^([\w-]+):([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(entry);
    if (match && match[1] === LOCALE) return { base: match[2], dynamic: match[3], overrides: match[4] };
  }
  return null;
}

// Хранилище языка — zustand-хук с getState(); ищется по набору действий, а не по имени экспорта.
async function findLocaleStore(document) {
  for (const link of document.querySelectorAll('link[rel="modulepreload"]')) {
    let module;
    try { module = await import(link.href); } catch { continue; }
    for (const value of Object.values(module)) {
      if (typeof value !== 'function' || typeof value.getState !== 'function' || typeof value.setState !== 'function' || typeof value.subscribe !== 'function') continue;
      let state;
      try { state = value.getState(); } catch { continue; }
      if (state && typeof state.setGatedMessages === 'function' && typeof state.setLocaleOverride === 'function' && 'messages' in state) return value;
    }
  }
  return null;
}

function onlyStrings(value) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [key, text] of Object.entries(value)) if (typeof text === 'string' && !key.startsWith('secret:')) result[key] = text;
  return result;
}

async function download(window, path, signal) {
  // Сначала без cookies: это статический файл, аккаунт к запросу привязывать незачем.
  for (const credentials of ['omit', 'same-origin']) {
    try {
      const response = await window.fetch(path, { credentials, signal });
      if (response.ok) return await response.text();
    } catch (error) { if (signal.aborted) throw error; }
  }
  throw new Error(`Failed to download ${path}`);
}

async function loadCatalog({ window, document, files, signal, log, warn }) {
  const versions = catalogVersions(document);
  if (!versions) return null;
  const name = `${LOCALE}-${versions.base}.${versions.dynamic}.${versions.overrides}.json`;
  const cached = await files.list(CACHE_KEY).catch(() => []);
  if (cached.some(file => file.name === name)) {
    try {
      return JSON.parse(new window.TextDecoder().decode(await files.read(CACHE_KEY, name)));
    } catch (error) { warn('Cached catalog is broken, downloading again', error); }
  }
  const parts = await Promise.all([
    `/i18n/${LOCALE}.json?v=${versions.base}`,
    `/i18n/dynamic/${LOCALE}.json?v=${versions.dynamic}`,
    `/i18n/${LOCALE}.overrides.json?v=${versions.overrides}`
  ].map(path => download(window, path, signal)));
  // Порядок слоёв как у приложения: базовый каталог, динамические строки, точечные правки.
  const catalog = Object.assign({}, ...parts.map(text => onlyStrings(JSON.parse(text))));
  if (signal.aborted) return null;
  await files.write(CACHE_KEY, name, new window.TextEncoder().encode(JSON.stringify(catalog)));
  for (const file of cached) if (file.name !== name) await files.remove(CACHE_KEY, file.name).catch(() => {});
  log(`Catalog ${name} cached, ${Object.keys(catalog).length} strings`);
  return catalog;
}

// Локаль en-US, поэтому ICU выбирает формы по английским правилам (one/other) — «5 файла».
// Подменяем выбор формы только у английских PluralRules для количества; порядковые не трогаем.
function patchPlurals(window) {
  const proto = window.Intl.PluralRules.prototype;
  const original = proto.select;
  const resolved = proto.resolvedOptions;
  const russian = new window.Intl.PluralRules('ru');
  const english = new WeakMap();
  const patched = function select(value) {
    let use = english.get(this);
    if (use === undefined) {
      try {
        const options = resolved.call(this);
        use = options.type === 'cardinal' && /^en(-|$)/i.test(options.locale);
      } catch { use = false; }
      english.set(this, use);
    }
    return use ? original.call(russian, value) : original.call(this, value);
  };
  proto.select = patched;
  return () => { if (proto.select === patched) proto.select = original; };
}

module.exports.start = async api => {
  const { window, document, signal, cleanup, warn, log } = api;
  const store = await findLocaleStore(document);
  if (signal.aborted) return;
  if (!store) { warn('Locale store not found; this Claude version is not supported'); return; }

  let catalog;
  try { catalog = await loadCatalog(api); } catch (error) { if (!signal.aborted) warn('Russian catalog unavailable', error); return; }
  if (signal.aborted) return;
  if (!catalog || !Object.keys(catalog).length) { warn('This Claude build has no Russian catalog'); return; }

  // Словарь приложения без наших строк. Сравнение по значению, а не по сохранённой копии: так откат
  // работает, даже если приложение успело собрать новый словарь поверх нашего.
  const strip = messages => {
    let result = messages;
    for (const key in messages) {
      if (Object.hasOwn(catalog, key) && messages[key] === catalog[key]) {
        if (result === messages) result = { ...messages };
        delete result[key];
      }
    }
    return result;
  };

  const merged = new WeakSet();
  const apply = () => {
    const current = store.getState().messages;
    if (merged.has(current)) return;
    // Строки сервера (gated) остаются, если для них нет перевода. Подмены других плагинов (custom-greeting)
    // идут поверх перевода, иначе плагины перезаписывали бы словарь друг за другом бесконечно.
    const overrides = window[Symbol.for('tamler.messageOverrides')];
    const next = Object.assign({}, strip(current), catalog, ...(overrides ? overrides.values() : []));
    merged.add(next);
    store.setState({ messages: next });
  };

  cleanup(patchPlurals(window));
  apply();
  const unsubscribe = store.subscribe(apply);
  // Одна функция очистки: Tamler вызывает их в обратном порядке, и откат до отписки сразу перекрывался бы снова.
  cleanup(() => {
    unsubscribe();
    const current = store.getState().messages;
    const cleaned = strip(current);
    if (cleaned !== current) store.setState({ messages: cleaned });
  });
  log('Russian strings applied');
};
