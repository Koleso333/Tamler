// Свои шрифты в Settings → Claude Code → Interface font и Settings → General → Chat font.
// Claude переключает шрифт интерфейса переменной --cds-font-sans на .cds-root, а шрифт чата — --font-user-message
// и --font-claude-response на <html>; плагин подменяет те же переменные.
// Выбранный свой шрифт хранится в плагине: в настройки Claude (и в аккаунт, куда уходит Chat font) ничего чужого не пишется.
const { describeFont } = require('./font-file');
const { createGoogle } = require('./google');

const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'font';
// Запасной список: глифы, которых нет в шрифте, берутся из Anthropic Sans, как у самого Claude.
const FALLBACK = 'var(--font-anthropic-sans, var(--cds-font-system)), var(--cds-font-system)';
// Варианты Chat font в Claude: значение, подпись и CSS-переменная шрифта ответа.
const CHAT_NATIVE = [['serif', 'Anthropic Serif', '--font-serif'], ['sans', 'Anthropic Sans', '--font-ui'], ['system', 'System', '--font-system'], ['atkinson', 'Atkinson Hyperlegible Next', '--font-atkinson-hyperlegible'], ['dyslexia', 'OpenDyslexic', '--font-dyslexia']];
const CHAT_VALUES = new Set(['default', ...CHAT_NATIVE.map(([value]) => value)]);
const NATIVE_PREVIEW = { anthropic: 'var(--font-anthropic-sans, var(--cds-font-system))', system: 'var(--cds-font-system)', dyslexic: 'var(--font-ui-dyslexic, var(--cds-font-system))' };

// Ищется по форме, а не по минифицированным именам:
// fontStore — стор сайдбара Claude (zustand) с полем interfaceFont;
// useChatFont — хук родного списка Chat font: { chatFontSetting, setChatFontSetting }, сеттер сам синхронизирует аккаунт.
async function findClaude(document) {
  const found = { fontStore: null, useChatFont: null };
  for (const link of document.querySelectorAll('link[rel="modulepreload"]')) {
    let module;
    try { module = await import(link.href); } catch { continue; }
    for (const value of Object.values(module)) {
      if (typeof value !== 'function') continue;
      if (!found.fontStore && typeof value.getState === 'function' && typeof value.subscribe === 'function') {
        let state;
        try { state = value.getState(); } catch { continue; }
        if (state && typeof state.setInterfaceFont === 'function' && 'interfaceFont' in state) found.fontStore = value;
        continue;
      }
      if (!found.useChatFont) {
        const source = Function.prototype.toString.call(value);
        if (source.length < 1500 && source.includes('chat_font:') && source.includes('setChatFontSetting:') && source.includes('chatFontSetting:')) found.useChatFont = value;
      }
    }
    if (found.fontStore && found.useChatFont) break;
  }
  return found;
}

module.exports.start = async ({ document, window, signal, storage, files, request, options, mount, render, addStyle, observe, warn, error: logError, cleanup }) => {
  const google = createGoogle({ files, request, storage, document, window });
  cleanup(() => { google.dispose(); });
  options('google', query => google.search(query));

  const { fontStore, useChatFont } = await findClaude(document);
  if (signal.aborted) return;
  if (!fontStore) warn('Claude interface font store not found; built-in fonts can only be chosen in Claude itself');
  if (!useChatFont) warn('Claude chat font hook not found; Chat font keeps its built-in list');

  // Загруженные семейства: id → { id, label, family, faces: FontFace[] }.
  const fonts = new Map();
  const listeners = new Set();
  const changed = () => { for (const listener of listeners) listener(); };
  cleanup(() => { for (const font of fonts.values()) for (const face of font.faces) document.fonts.delete(face); fonts.clear(); });

  const style = addStyle('');
  function apply() {
    const font = fonts.get(storage.get('font'));
    const chat = fonts.get(storage.get('chatFont'));
    // !important перекрывает и data-font=system, и OpenDyslexic, и inline-переменные чата, не трогая выбор в самом Claude.
    style.textContent = [
      font && `:root.cds-root, .cds-root { --cds-font-sans: "${font.family}", ${FALLBACK} !important; --cds-font-sans-display: "${font.family}", ${FALLBACK} !important; }`,
      chat && `:root { --font-user-message: "${chat.family}", ${FALLBACK} !important; --font-claude-response: "${chat.family}", ${FALLBACK} !important; }`
    ].filter(Boolean).join('\n');
  }

  // FontFace из байтов: CSP Claude запрещает шрифты по blob: и data:, а двоичный источник под него не попадает.
  async function register(id, label, items) {
    const family = `tamler-font-${slug(id)}`;
    const faces = [];
    for (const item of items) {
      try {
        const descriptors = { weight: item.weight, style: item.style, display: 'swap' };
        if (item.unicodeRange) descriptors.unicodeRange = item.unicodeRange;
        const face = new window.FontFace(family, item.data, descriptors);
        await face.load();
        if (signal.aborted) return;
        document.fonts.add(face);
        faces.push(face);
      } catch (error) { warn(`Font ${label}: ${error.message}`); }
    }
    if (!faces.length || signal.aborted) return;
    const previous = fonts.get(id);
    if (previous) for (const face of previous.faces) document.fonts.delete(face);
    fonts.set(id, { id, label, family, faces });
  }

  async function loadUploads() {
    const list = storage.get('files') || [];
    const groups = new Map();
    for (const file of list) {
      try {
        const data = await files.read('files', file.name);
        const info = await describeFont(file.name, data);
        if (!groups.has(info.family)) groups.set(info.family, []);
        groups.get(info.family).push({ ...info, data });
      } catch (error) { warn(`Font file ${file.name}: ${error.message}`); }
    }
    return [...groups].map(([family, items]) => [`file:${family}`, family, items]);
  }
  async function loadGoogle() {
    const result = [];
    for (const family of storage.get('google') || []) {
      try { result.push([`google:${family}`, family, await google.faces(family)]); }
      catch (error) { warn(error.message); }
    }
    return result;
  }
  let loadSequence = 0;
  async function reload() {
    const ticket = ++loadSequence;
    const wanted = [...await loadUploads(), ...await loadGoogle()];
    if (ticket !== loadSequence || signal.aborted) return;
    // Выбранный шрифт регистрируем первым, чтобы интерфейс переключился как можно раньше.
    const selected = new Set([storage.get('font'), storage.get('chatFont')]);
    wanted.sort((a, b) => Number(selected.has(b[0])) - Number(selected.has(a[0])));
    const ids = new Set(wanted.map(item => item[0]));
    for (const [id, font] of fonts) if (!ids.has(id)) { for (const face of font.faces) document.fonts.delete(face); fonts.delete(id); }
    for (const [id, label, items] of wanted) {
      await register(id, label, items);
      if (ticket !== loadSequence || signal.aborted) return;
      apply();
      changed();
    }
  }

  let lastLists = JSON.stringify([storage.get('files'), storage.get('google')]);
  storage.subscribe(() => {
    apply();
    changed();
    const lists = JSON.stringify([storage.get('files'), storage.get('google')]);
    if (lists !== lastLists) { lastLists = lists; reload().catch(error => logError(error)); }
  });
  if (fontStore) cleanup(fontStore.subscribe(changed));
  apply();
  reload().catch(error => logError(error));

  const customOptions = () => [
    ...[...fonts.values()].sort((a, b) => a.label.localeCompare(b.label)).map((font, index) => ({ value: font.id, label: font.label, divider: index === 0, style: { fontFamily: `"${font.family}", ${FALLBACK}` } })),
    { key: 'add', value: null, label: 'Add fonts…', divider: true, action: () => window.Tamler?.manager?.open() }
  ];

  // Переключатель Interface font: родные кнопки прячутся, вместо них — список с родными и своими шрифтами.
  mount('[data-settings-row][id$="interface-font"] [data-settings-control]', control => {
    const group = control.querySelector('[role="radiogroup"]');
    if (!group) return;
    const native = [...group.querySelectorAll('input[type="radio"]')].map(input => ({
      value: input.value,
      label: input.previousElementSibling?.textContent.trim() || input.value
    }));
    if (!native.length) return;
    const label = group.getAttribute('aria-label') || 'Interface font';
    group.style.display = 'none';
    const host = document.createElement('div');
    control.append(host);
    const view = ui => {
      const custom = fonts.get(storage.get('font'));
      const current = custom ? custom.id : `native:${fontStore?.getState().interfaceFont ?? native.find(option => group.querySelector(`input[value="${option.value}"]`)?.checked)?.value}`;
      const items = [
        ...native.map(option => ({ value: `native:${option.value}`, label: option.label, style: { fontFamily: NATIVE_PREVIEW[option.value] } })),
        ...customOptions()
      ];
      return ui.React.createElement(ui.Dropdown, {
        value: current,
        options: items,
        label,
        className: 'w-56',
        onChange: value => {
          if (value.startsWith('native:')) {
            storage.delete('font');
            const next = value.slice('native:'.length);
            // Свой store недоступен — нажимаем родную кнопку, она спрятана, но работает.
            if (fontStore) fontStore.getState().setInterfaceFont(next);
            else group.querySelector(`input[value="${next}"]`)?.previousElementSibling?.click();
          } else storage.set('font', value);
        }
      });
    };
    const handle = render(host, view);
    const update = () => handle.update(view);
    listeners.add(update);
    return () => {
      listeners.delete(update);
      handle.unmount();
      host.remove();
      group.style.display = '';
    };
  });

  // Chat font: родной выпадающий список заменяется таким же со своими шрифтами ниже родных.
  // Узнаётся по скрытому значению (serif, sans…) и превью шрифта в кнопке — у других списков настроек такого нет.
  if (!useChatFont) return;
  mount('[data-settings-control]', control => {
    const combobox = control.querySelector('[data-cds="Combobox"]');
    const input = control.querySelector('input[aria-hidden="true"]');
    if (!combobox || !CHAT_VALUES.has(input?.value) || !combobox.querySelector('[style*="font-family: var(--font-"]')) return;
    const label = combobox.querySelector('[role="combobox"]')?.getAttribute('aria-label') || 'Chat font';
    const host = document.createElement('div');
    control.append(host);
    const view = ui => {
      const h = ui.React.createElement;
      function ChatFont() {
        const { chatFontSetting, setChatFontSetting } = useChatFont();
        const [, refresh] = ui.React.useState(0);
        ui.React.useEffect(() => {
          const listener = () => refresh(count => count + 1);
          listeners.add(listener);
          // Родной список прячется только после успешной отрисовки замены: при сбое он остаётся на месте.
          combobox.style.display = 'none';
          return () => { listeners.delete(listener); combobox.style.display = ''; };
        }, []);
        const current = CHAT_VALUES.has(chatFontSetting) && chatFontSetting !== 'default' ? chatFontSetting : 'serif';
        const custom = fonts.get(storage.get('chatFont'));
        const items = [
          ...CHAT_NATIVE.filter(([value]) => value !== 'atkinson' || current === 'atkinson').map(([value, text, variable]) => ({ value: `native:${value}`, label: text, style: { fontFamily: `var(${variable})` } })),
          ...customOptions()
        ];
        return h(ui.Dropdown, {
          value: custom ? custom.id : `native:${current}`,
          options: items,
          label,
          className: 'w-56',
          onChange: value => {
            if (!value.startsWith('native:')) { storage.set('chatFont', value); return; }
            storage.delete('chatFont');
            const next = value.slice('native:'.length);
            // Тот же вызов, что делает родной список: значение уходит и в аккаунт.
            if (next !== current) setChatFontSetting(next);
          }
        });
      }
      return h(ChatFont);
    };
    const handle = render(host, view);
    return () => { handle.unmount(); host.remove(); combobox.style.display = ''; };
  });
};
