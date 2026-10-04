// Каталог и файлы Google Fonts. Всё скачанное кешируется в файлах плагина: шрифты работают и без сети.
const CATALOG_AGE = 7 * 24 * 60 * 60 * 1000;
// Наборы символов, которые грузим всегда; остальные (греческий, вьетнамский, CJK…) не нужны интерфейсу.
const SUBSETS = new Set(['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext']);

function hash(text) {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 0x01000193) >>> 0;
  return value.toString(16).padStart(8, '0') + text.length.toString(16);
}

const previewFamily = family => `tamler-preview-${family.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

function createGoogle({ files, request, storage, document, window }) {
  // Превью для подсказок: Google отдаёт крошечный шрифт только с буквами названия (параметр text=).
  const previews = new Map();
  function preview(family) {
    if (previews.has(family)) return previews.get(family);
    const task = (async () => {
      const url = `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, '+')}&text=${encodeURIComponent(family)}`;
      const css = new TextDecoder().decode(await cached(`${hash(url)}.css`, async () => {
        const response = await request(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      }));
      const source = /url\(([^)]+)\)/.exec(css)?.[1].replace(/['"]/g, '');
      if (!source) return null;
      const data = await cached(`${hash(source)}.preview`, async () => (await request(source)).arrayBuffer());
      const face = new window.FontFace(previewFamily(family), data);
      await face.load();
      document.fonts.add(face);
      return face;
    })().catch(() => null);
    previews.set(family, task);
    return task;
  }
  async function dispose() {
    for (const task of previews.values()) { const face = await task; if (face) document.fonts.delete(face); }
    previews.clear();
  }
  let catalog = null;
  let loading = null;
  const cached = async (name, download) => {
    try { return await files.read('cache', name); }
    catch {
      const data = await download();
      files.write('cache', name, data).catch(() => {});
      return data;
    }
  };
  async function fetchCatalog() {
    const response = await request('https://fonts.google.com/metadata/fonts');
    if (!response.ok) throw new Error(`Google Fonts catalog: HTTP ${response.status}`);
    const list = JSON.parse(response.text().replace(/^\)\]\}'/, '')).familyMetadataList || [];
    // Из каталога (~2,7 МБ) оставляем только то, что нужно для поиска и запроса CSS.
    return list.map(item => ({ family: item.family, category: item.category, popularity: item.popularity, fonts: Object.keys(item.fonts || {}), axes: (item.axes || []).filter(axis => axis.tag === 'wght').map(axis => [axis.min, axis.max])[0] || null }));
  }
  function loadCatalog() {
    if (catalog) return Promise.resolve(catalog);
    return loading ||= (async () => {
      const fresh = Date.now() - (storage.get('catalogTime') || 0) < CATALOG_AGE;
      if (fresh) {
        try { catalog = JSON.parse(new TextDecoder().decode(await files.read('cache', 'catalog.json'))); return catalog; } catch {}
      }
      try {
        catalog = await fetchCatalog();
        await files.write('cache', 'catalog.json', JSON.stringify(catalog));
        await storage.set('catalogTime', Date.now());
      } catch (error) {
        // Нет сети — берём старый кеш, если он есть.
        try { catalog = JSON.parse(new TextDecoder().decode(await files.read('cache', 'catalog.json'))); } catch { throw error; }
      }
      return catalog;
    })().finally(() => { loading = null; });
  }
  async function search(query) {
    const list = await loadCatalog();
    const text = query.trim().toLowerCase();
    const found = !text ? list.slice() : list.filter(item => item.family.toLowerCase().includes(text));
    found.sort((a, b) => (text && Number(!a.family.toLowerCase().startsWith(text)) - Number(!b.family.toLowerCase().startsWith(text))) || a.popularity - b.popularity);
    const result = found.slice(0, 50);
    // Шрифт подхватится браузером сам, как только превью загрузится.
    for (const item of result) preview(item.family);
    return result.map(item => ({ value: item.family, label: item.family, description: item.category, style: { fontFamily: `"${previewFamily(item.family)}", var(--cds-font-sans)` } }));
  }
  // Строка family=… для css2: переменная насыщенность — диапазоном, иначе перечислением.
  function familyQuery(entry) {
    const family = entry.family.replace(/ /g, '+');
    const italic = entry.fonts.some(font => font.endsWith('i'));
    if (entry.axes) {
      const range = `${entry.axes[0]}..${entry.axes[1]}`;
      return italic ? `${family}:ital,wght@0,${range};1,${range}` : `${family}:wght@${range}`;
    }
    const tuples = entry.fonts.map(font => [font.endsWith('i') ? 1 : 0, parseInt(font, 10) || 400]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (!tuples.length) return family;
    return italic ? `${family}:ital,wght@${tuples.map(tuple => tuple.join(',')).join(';')}` : `${family}:wght@${tuples.map(tuple => tuple[1]).join(';')}`;
  }
  // Возвращает список начертаний { data, weight, style, unicodeRange } для FontFace.
  async function faces(family) {
    const list = await loadCatalog();
    const entry = list.find(item => item.family === family) || { family, fonts: [], axes: null };
    const url = `https://fonts.googleapis.com/css2?family=${familyQuery(entry)}&display=swap`;
    const css = new TextDecoder().decode(await cached(`${hash(url)}.css`, async () => {
      const response = await request(url);
      if (!response.ok) throw new Error(`Google Fonts: ${family}: HTTP ${response.status}`);
      return response.arrayBuffer();
    }));
    const blocks = [...css.matchAll(/\/\*\s*([^*]+?)\s*\*\/\s*@font-face\s*{([^}]*)}/g)].map(([, subset, body]) => ({
      subset,
      style: /font-style:\s*([^;]+);/.exec(body)?.[1].trim() || 'normal',
      weight: /font-weight:\s*([^;]+);/.exec(body)?.[1].trim() || '400',
      url: /url\(([^)]+)\)/.exec(body)?.[1].replace(/['"]/g, ''),
      unicodeRange: /unicode-range:\s*([^;]+);/.exec(body)?.[1].trim()
    })).filter(block => block.url);
    let wanted = blocks.filter(block => SUBSETS.has(block.subset));
    // Шрифты только для других письменностей (например, японские) — берём что есть, но не больше 40 файлов.
    if (!wanted.length) wanted = blocks.slice(0, 40);
    return Promise.all(wanted.map(async block => ({
      ...block,
      data: await cached(`${hash(block.url)}.woff2`, async () => {
        const response = await request(block.url);
        if (!response.ok) throw new Error(`Google Fonts: ${family}: HTTP ${response.status}`);
        return response.arrayBuffer();
      })
    })));
  }
  return { search, faces, preview, dispose };
}

module.exports = { createGoogle };
