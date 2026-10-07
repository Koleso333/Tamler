async function installTamler(window, plugins, managerFactory, state = {}) {
  // Upgrade сначала отключает старое ядро, поэтому признак открытого менеджера переживает его через окно.
  const reopen = !!window.Tamler?.managerOpen || !!window.__tamlerReopen;
  delete window.__tamlerReopen;
  if (window.Tamler) window.Tamler.dispose();
  const document = window.document;
  const active = new Map();
  const errors = [];
  let manager;
  const pending = new Map();
  let sequence = 0;
  let nativeUI;
  let loadingUI;
  function request(action, payload = {}, timeout = 10000) {
    if (typeof window.__tamlerBridge !== 'function') return Promise.reject(new Error('Tamler bridge unavailable'));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = window.setTimeout(() => { pending.delete(id); reject(new Error('Tamler request timed out')); }, timeout);
      pending.set(id, { resolve, reject, timer });
      const { id: pluginId, ...parameters } = payload;
      window.__tamlerBridge(JSON.stringify({ ...parameters, id, action, pluginId }));
    });
  }
  const report = (id, error) => {
    errors.push({ id, message: String(error?.message || error) });
    window.console.error(`[Tamler:${id}]`, error);
    manager?.update();
  };
  // Двоичные данные ходят через мост в base64.
  function toBase64(bytes) {
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
    return window.btoa(binary);
  }
  function fromBase64(text) {
    const binary = window.atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  function toBytes(data) {
    if (typeof data === 'string') return new window.TextEncoder().encode(data);
    if (data instanceof ArrayBuffer || data instanceof window.ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new Error('File data must be a string, ArrayBuffer or typed array');
  }
  // Мост принимает до 256 КБ на сообщение, поэтому файл уходит кусками по 144 КБ.
  const CHUNK = 144 * 1024;
  async function uploadFile(id, key, name, data, onProgress) {
    const bytes = toBytes(data);
    const upload = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    let result;
    for (let offset = 0, index = 0; offset < bytes.length || index === 0; offset += CHUNK, index++) {
      const last = offset + CHUNK >= bytes.length;
      result = await request('file-put', { id, key, name, upload, index, last, data: toBase64(bytes.subarray(offset, offset + CHUNK)) }, 30000);
      onProgress?.(Math.min(1, (offset + CHUNK) / Math.max(bytes.length, 1)));
    }
    if (result.data) api.storageChanged(id, result.data);
    return result.files;
  }
  async function removeFile(id, key, name) {
    const result = await request('file-remove', { id, key, name });
    if (result.data) api.storageChanged(id, result.data);
    return result.files;
  }
  const componentSource = value => (typeof value === 'function' ? value : value?.render)?.toString() || '';
  function loadUI() {
    if (nativeUI) return Promise.resolve(nativeUI);
    return loadingUI ||= (async () => {
      const links = [...document.querySelectorAll('link[rel="modulepreload"]')].map(element => element.href);
      const vendorURL = links.find(url => /\/vendor-frame-[^/]+\.js/.test(url));
      // В хэше чанка бывают '-' и '_' (shared-frame-X-FEPizm.js), поэтому отсекаем только соседний shared-frame-boot.
      const sharedURL = links.find(url => /\/shared-frame-(?!boot-)[^/]+\.js/.test(url));
      if (!vendorURL || !sharedURL) throw new Error('Claude UI modules unavailable');
      const [vendor, shared] = await Promise.all([import(vendorURL), import(sharedURL)]);
      const find = (module, predicate) => Object.values(module).find(value => predicate(componentSource(value), value));
      const React = Object.values(vendor).find(value => value?.createElement && value?.useState);
      const createRoot = find(vendor, source => source.includes('unstable_strictMode') && source.includes('identifierPrefix'));
      // Компоненты дизайн-системы узнаются по data-cds; берём только экспорты с единственным таким именем.
      const components = {};
      for (const value of Object.values(shared)) {
        const names = new Set([...componentSource(value).matchAll(/"data-cds":"([A-Za-z]+)"/g)].map(match => match[1]));
        if (names.size === 1) components[[...names][0]] ??= value;
      }
      components.Card = find(shared, source => source.includes('"data-cds":"Card"'));
      components.Switch = find(shared, source => source.includes('"data-cds":"Switch"'));
      components.Button = find(shared, source => source.includes('iconOnly:') && source.includes('busyLabel:') && source.includes('routerOptions:'));
      components.ConfirmationDialog = find(shared, source => source.includes('confirmLabel:') && source.includes('onConfirm:') && source.includes('closeOnConfirm:'));
      const { Button, Card, Switch, ConfirmationDialog: Confirm } = components;
      if (!React || !createRoot || !Button || !Card || !Switch || !Confirm) throw new Error('Claude UI adapter incompatible');
      nativeUI = { React, createRoot, components, Button, Card, Switch, Confirm, TextInput: components.TextInput, ...createKit(React) };
      return nativeUI;
    })().catch(error => { loadingUI = null; throw error; });
  }
  // Общие компоненты Tamler в стиле Claude: ими пользуются менеджер и плагины (ui().Dropdown и т.д.).
  function createKit(React) {
    const h = React.createElement;
    const motion = () => !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const ease = 'var(--cds-ease-out, cubic-bezier(0.2, 0.8, 0.2, 1))';
    // Анимация входа: элемент монтируется скрытым, раскладка пересчитывается принудительно, затем включается видимое состояние.
    // requestAnimationFrame не подходит: в фоновом окне кадры не приходят и элемент остаётся невидимым.
    function useTransition(open, duration) {
      const node = React.useRef(null);
      const [mounted, setMounted] = React.useState(open);
      const [shown, setShown] = React.useState(open);
      const [settled, setSettled] = React.useState(open);
      if (open && !mounted) setMounted(true);
      React.useLayoutEffect(() => {
        if (!open || !mounted || shown) return;
        node.current?.getBoundingClientRect();
        setShown(true);
      }, [open, mounted, shown]);
      React.useEffect(() => {
        setSettled(false);
        if (!open) setShown(false);
        // Таймер дублирует transitionend: событие не приходит, если анимация отключена или окно скрыто.
        const timer = window.setTimeout(() => { if (open) setSettled(true); else setMounted(false); }, motion() ? duration + 40 : 0);
        return () => window.clearTimeout(timer);
      }, [open]);
      return { node, mounted, shown, settled };
    }
    // Раскрытие по высоте через grid-template-rows: высоту содержимого измерять не нужно.
    function Expand({ open, children }) {
      const { node, mounted, shown, settled } = useTransition(open, 240);
      if (!mounted) return null;
      return h('div', { ref: node, style: { display: 'grid', gridTemplateRows: shown ? '1fr' : '0fr', opacity: shown ? 1 : 0, transition: motion() ? `grid-template-rows 240ms ${ease}, opacity 180ms ${ease}` : 'none' } },
        // Во время анимации содержимое обрезается, после — нет, чтобы выпадающий список не прятался.
        h('div', { style: { minHeight: 0, overflow: settled && open ? 'visible' : 'hidden' }, 'aria-hidden': open ? undefined : true }, children));
    }
    const chevron = h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, className: 'shrink-0 text-secondary' },
      h('path', { d: 'M4.5 6.25 8 9.75l3.5-3.5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }));
    const check = h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, className: 'shrink-0' },
      h('path', { d: 'm3.75 8.25 2.75 2.75 5.75-6', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }));
    const optionClass = 'cds-reset flex w-full items-center gap-2 min-h-control px-md py-1 rounded text-body font-normal text-primary select-none outline-none cursor-pointer data-[highlighted]:bg-fill-ghost-hover';
    const popupClass = 'rounded-card bg-surface-popover border border-[var(--cds-ring-color)] text-primary p-1';
    const LIST_HEIGHT = 320;
    let sequence = 0;
    // Положение списка: вниз, а если снизу не хватает места внутри прокручиваемого предка — вверх.
    function placeUpward(anchor, height) {
      const rect = anchor.getBoundingClientRect();
      let boundary = anchor.parentElement;
      while (boundary && !/(auto|scroll)/.test(window.getComputedStyle(boundary).overflowY)) boundary = boundary.parentElement;
      const limit = boundary ? boundary.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      return limit.bottom - rect.bottom < height + 8 && rect.top - limit.top > limit.bottom - rect.bottom;
    }
    function popupStyle(upward, shown, open) {
      return { position: 'absolute', left: 0, right: 0, [upward ? 'bottom' : 'top']: 'calc(100% + 4px)', zIndex: 50, boxShadow: 'var(--cds-shadow-popover)', maxHeight: LIST_HEIGHT, overflowY: 'auto',
        transformOrigin: upward ? 'bottom center' : 'top center', opacity: shown ? 1 : 0, transform: shown ? 'none' : `translateY(${upward ? 4 : -4}px) scale(0.97)`,
        transition: motion() ? `opacity 140ms ${ease}, transform 160ms ${ease}` : 'none', pointerEvents: open ? 'auto' : 'none' };
    }
    function useOutside(open, wrapper, close) {
      React.useEffect(() => {
        if (!open) return;
        const outside = event => { if (!wrapper.current?.contains(event.target)) close(); };
        document.addEventListener('pointerdown', outside, true);
        return () => document.removeEventListener('pointerdown', outside, true);
      }, [open]);
    }
    // Список докручивается к подсвеченному пункту только по клавиатуре и при открытии.
    // При наведении мышью — нет: иначе пункт у края подкручивал список, под курсор попадал следующий, и список уезжал.
    function useScrollIntoView(list, highlighted, open, request) {
      React.useEffect(() => {
        if (!open || highlighted < 0 || !request.current) return;
        request.current = false;
        // Прокручивается только сам список: scrollIntoView двигал бы и страницу настроек вокруг него.
        const box = list.current;
        const item = box?.querySelector(`[data-index="${highlighted}"]`);
        if (!item) return;
        if (item.offsetTop < box.scrollTop) box.scrollTop = item.offsetTop - 4;
        else if (item.offsetTop + item.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = item.offsetTop + item.offsetHeight - box.clientHeight + 4;
      }, [highlighted, open]);
    }
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    function renderOption(option, index, { selected, highlighted, id, onHover, onPick }) {
      const key = option.key ?? JSON.stringify(option.value) ?? String(index);
      const element = h('div', { key, id, role: 'option', 'aria-selected': selected, 'data-index': index,
        'data-highlighted': highlighted ? '' : undefined,
        className: optionClass,
        onMouseEnter: onHover, onMouseDown: event => event.preventDefault(), onClick: onPick },
        h('span', { className: 'min-w-0 flex-1 truncate', style: option.style }, option.label),
        option.description && h('span', { className: 'shrink-0 text-caption text-secondary' }, option.description),
        selected ? check : h('span', { className: 'w-4 shrink-0' }));
      if (!option.divider || index === 0) return element;
      return [h('div', { key: key + ':divider', role: 'separator', style: { height: 1, margin: '4px 8px', background: 'var(--cds-ring-color)' } }), element];
    }
    // Свой список вместо <select>: системный попап Windows не берёт тему Claude.
    // Вариант: { value, label, style?, description?, divider?, action? } — action вызывается вместо onChange.
    function Dropdown({ value, options, onChange, labelledBy, label, onOpenChange, className = 'w-48' }) {
      const [open, setOpen] = React.useState(false);
      const { node: list, mounted, shown } = useTransition(open, 160);
      const [highlighted, setHighlighted] = React.useState(-1);
      const [upward, setUpward] = React.useState(false);
      const wrapper = React.useRef(null);
      const trigger = React.useRef(null);
      const [listId] = React.useState(() => `tamler-dropdown-${++sequence}`);
      const selectedIndex = options.findIndex(option => !option.action && same(option.value, value));
      const scroll = React.useRef(false);
      const show = next => {
        if (next === open) return;
        setOpen(next);
        onOpenChange?.(next);
        if (next) {
          setUpward(placeUpward(trigger.current, Math.min(options.length * 32 + 10, LIST_HEIGHT)));
          scroll.current = true;
          setHighlighted(Math.max(selectedIndex, 0));
        }
      };
      useOutside(open, wrapper, () => show(false));
      useScrollIntoView(list, highlighted, open && shown, scroll);
      const choose = index => {
        show(false);
        trigger.current?.focus();
        const option = options[index];
        if (!option) return;
        if (option.action) option.action();
        else if (index !== selectedIndex) onChange(option.value);
      };
      const onKeyDown = event => {
        const move = step => { event.preventDefault(); scroll.current = true; if (!open) show(true); else setHighlighted(index => (index + step + options.length) % options.length); };
        if (event.key === 'ArrowDown') move(1);
        else if (event.key === 'ArrowUp') move(-1);
        else if (event.key === 'Home' && open) { event.preventDefault(); scroll.current = true; setHighlighted(0); }
        else if (event.key === 'End' && open) { event.preventDefault(); scroll.current = true; setHighlighted(options.length - 1); }
        else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open ? choose(highlighted) : show(true); }
        // Escape закрывает только список, а не всё окно Settings.
        else if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); show(false); }
        else if (event.key === 'Tab' && open) show(false);
      };
      const optionId = index => `${listId}-${index}`;
      const current = options[selectedIndex];
      return h('div', { ref: wrapper, className: `relative ${className}` },
        h('button', { ref: trigger, type: 'button', role: 'combobox', 'aria-haspopup': 'listbox', 'aria-expanded': open, 'aria-controls': listId, 'aria-labelledby': labelledBy, 'aria-label': label,
          'aria-activedescendant': open && highlighted >= 0 ? optionId(highlighted) : undefined,
          className: 'cds-reset inline-flex w-full items-center gap-1.5 h-control rounded px-sm font-sans text-body font-normal text-primary outline-none focus-visible:shadow-focus bg-fill-field shadow-field-ring cursor-pointer',
          onClick: () => show(!open), onKeyDown },
          h('span', { className: 'min-w-0 flex-1 truncate text-left', style: current?.style }, current?.label ?? ''), chevron),
        mounted && h('div', { ref: list, id: listId, role: 'listbox', 'aria-labelledby': labelledBy, tabIndex: -1, className: popupClass,
          onMouseLeave: () => setHighlighted(-1), style: popupStyle(upward, shown, open) },
          options.map((option, index) => renderOption(option, index, { selected: index === selectedIndex, highlighted: index === highlighted, id: optionId(index),
            onHover: () => setHighlighted(index), onPick: () => choose(index) }))));
    }
    // Поле с подсказками: search(query) возвращает промис со списком вариантов, выбранный передаётся в onSelect.
    function Autocomplete({ search, onSelect, placeholder, labelledBy, label, onOpenChange, className = 'w-full' }) {
      const [query, setQuery] = React.useState('');
      const [open, setOpen] = React.useState(false);
      const [results, setResults] = React.useState([]);
      const [state, setState] = React.useState('idle');
      const [highlighted, setHighlighted] = React.useState(0);
      const [upward, setUpward] = React.useState(false);
      const { node: list, mounted, shown } = useTransition(open, 160);
      const wrapper = React.useRef(null);
      const input = React.useRef(null);
      const [listId] = React.useState(() => `tamler-autocomplete-${++sequence}`);
      const latest = React.useRef(0);
      const scroll = React.useRef(false);
      React.useEffect(() => {
        if (!open) return;
        const ticket = ++latest.current;
        setState('loading');
        // Небольшая задержка, чтобы не искать на каждую букву при быстром вводе.
        const timer = window.setTimeout(() => {
          Promise.resolve().then(() => search(query)).then(found => {
            if (ticket !== latest.current) return;
            setResults(Array.isArray(found) ? found : []);
            setHighlighted(0);
            if (list.current) list.current.scrollTop = 0;
            setState('done');
          }, error => {
            if (ticket !== latest.current) return;
            setResults([]);
            setState(String(error?.message || error));
          });
        }, 150);
        return () => window.clearTimeout(timer);
      }, [query, open]);
      const show = next => {
        if (next === open) return;
        if (next) setUpward(placeUpward(input.current, LIST_HEIGHT));
        setOpen(next);
        onOpenChange?.(next);
      };
      useOutside(open, wrapper, () => show(false));
      useScrollIntoView(list, highlighted, open && shown, scroll);
      const choose = index => {
        const option = results[index];
        if (!option) return;
        onSelect(option);
        setQuery('');
        input.current?.focus();
      };
      const onKeyDown = event => {
        const move = step => { event.preventDefault(); scroll.current = true; if (!open) show(true); else if (results.length) setHighlighted(index => (index + step + results.length) % results.length); };
        if (event.key === 'ArrowDown') move(1);
        else if (event.key === 'ArrowUp') move(-1);
        else if (event.key === 'Enter' && open) { event.preventDefault(); choose(highlighted); }
        else if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); show(false); }
        else if (event.key === 'Tab' && open) show(false);
      };
      const optionId = index => `${listId}-${index}`;
      const message = state === 'loading' && !results.length ? 'Searching…' : state === 'done' && !results.length ? 'Nothing found' : state !== 'idle' && state !== 'loading' && state !== 'done' ? state : null;
      return h('div', { ref: wrapper, className: `relative ${className}` },
        h('input', { ref: input, type: 'text', role: 'combobox', value: query, placeholder, 'aria-expanded': open, 'aria-controls': listId, 'aria-autocomplete': 'list',
          'aria-labelledby': labelledBy, 'aria-label': label, 'aria-activedescendant': open && results.length ? optionId(highlighted) : undefined, autoComplete: 'off', spellCheck: false,
          className: 'cds-reset w-full h-control rounded px-sm font-sans text-body font-normal text-primary placeholder:text-muted outline-none focus-visible:shadow-focus bg-fill-field shadow-field-ring',
          onChange: event => { setQuery(event.target.value); show(true); }, onFocus: () => show(true), onClick: () => show(true), onKeyDown }),
        mounted && h('div', { ref: list, id: listId, role: 'listbox', tabIndex: -1, className: popupClass, style: popupStyle(upward, shown, open) },
          message ? h('div', { className: 'px-md py-2 text-body text-secondary' }, message)
            : results.map((option, index) => renderOption(option, index, { selected: false, highlighted: index === highlighted, id: optionId(index),
              onHover: () => setHighlighted(index), onPick: () => choose(index) }))));
    }
    return { motion, ease, useTransition, Expand, Dropdown, Autocomplete, icons: { chevron, check } };
  }
  function providers(element) {
    let fiber;
    for (let node = element; node && !fiber; node = node.parentElement) {
      const key = Object.keys(node).find(key => key.startsWith('__reactFiber'));
      if (key) fiber = node[key];
    }
    const result = [];
    for (; fiber; fiber = fiber.return) {
      if (fiber.tag === 10 && fiber.memoizedProps && 'value' in fiber.memoizedProps) {
        const context = fiber.type?._context || fiber.type;
        if (context?.Provider) result.push([context.Provider, fiber.memoizedProps.value]);
      }
    }
    return result;
  }
  function wildcard(pattern) {
    return new RegExp(`^${pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  }
  const matches = plugin => !plugin.matches?.length || plugin.matches.some(pattern => wildcard(pattern).test(window.location.href));
  function settingsDefaults(plugin) {
    return Object.fromEntries((plugin.settings || []).filter(setting => 'default' in setting || setting.type === 'list' || setting.type === 'files')
      .map(setting => [setting.key, 'default' in setting ? setting.default : []]));
  }
  function normalize(value) {
    const parts = [];
    for (const part of value.replace(/\\/g, '/').split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') { if (!parts.length) throw new Error(`Path escapes plugin: ${value}`); parts.pop(); }
      else parts.push(part);
    }
    return parts.join('/');
  }
  const dirname = file => file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
  function createAssets(plugin, cleanup) {
    const urls = new Map();
    cleanup.push(() => { for (const url of urls.values()) window.URL.revokeObjectURL(url); urls.clear(); });
    const asset = (name, from = '') => {
      if (typeof name !== 'string' || !name) throw new Error('Asset path must be a non-empty string');
      const file = normalize(name.startsWith('/') ? name : `${from}/${name}`);
      if (urls.has(file)) return urls.get(file);
      const entry = plugin.assets?.[file];
      if (!entry) throw new Error(`Asset not found: ${name}`);
      const binary = window.atob(entry.data);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      const url = window.URL.createObjectURL(new window.Blob([bytes], { type: entry.type }));
      urls.set(file, url);
      return url;
    };
    // Относительные url() в CSS указывают на файлы плагина; внешние и data:-адреса не трогаем.
    const css = (source, from = '') => source.replace(/url\(\s*(['"]?)([^'")]+?)\1\s*\)/g, (match, quote, target) => {
      if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) return match;
      try { return `url("${asset(target, from)}")`; }
      catch (error) { report(plugin.id, error); return match; }
    });
    return { asset, css };
  }
  function createRequire(plugin, api) {
    const files = plugin.modules || {};
    const cache = new Map();
    const join = (...parts) => normalize(parts.filter(Boolean).join('/'));
    function resolveFile(base) {
      const direct = [base, `${base}.js`, `${base}.cjs`, `${base}.json`].find(file => file in files);
      if (direct) return direct;
      const manifest = files[join(base, 'package.json')]?.json;
      if (manifest?.main) {
        const main = resolveFile(join(base, manifest.main));
        if (main) return main;
      }
      return [join(base, 'index.js'), join(base, 'index.cjs'), join(base, 'index.json')].find(file => file in files);
    }
    function resolve(specifier, from) {
      if (typeof specifier !== 'string' || !specifier) throw new Error('Module name must be a non-empty string');
      let file;
      if (specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..') file = resolveFile(join(dirname(from), specifier));
      else if (specifier.startsWith('/')) file = resolveFile(normalize(specifier));
      else {
        for (let directory = dirname(from); ; directory = dirname(directory)) {
          file = resolveFile(join(directory, 'node_modules', specifier));
          if (file || !directory) break;
        }
      }
      if (!file) throw new Error(`Cannot find module '${specifier}' from '${from}'`);
      return file;
    }
    function load(file) {
      if (cache.has(file)) return cache.get(file).exports;
      const entry = files[file];
      if (entry.error) throw new Error(`${file}: ${entry.error}`);
      const module = { id: file, exports: {} };
      cache.set(file, module);
      if ('json' in entry) module.exports = entry.json;
      else {
        try { entry.create(module, module.exports, api, makeRequire(file)); }
        catch (error) { cache.delete(file); throw error; }
      }
      return module.exports;
    }
    function makeRequire(from) {
      const require = specifier => load(resolve(specifier, from));
      require.resolve = specifier => resolve(specifier, from);
      return require;
    }
    return { load, main: plugin.main };
  }
  function enable(plugin) {
    if (active.has(plugin.id) || !matches(plugin)) return;
    const cleanup = [];
    const controller = new window.AbortController();
    const subscribers = new Set();
    const optionProviders = new Map();
    const entry = { plugin, cleanup, controller, subscribers, optionProviders };
    const assets = createAssets(plugin, cleanup);
    const guard = callback => function (...args) {
      try { return callback.apply(this, args); } catch (error) { report(plugin.id, error); }
    };
    const storage = {
      get(key) { const data = plugin.data || {}; return key in data ? data[key] : settingsDefaults(plugin)[key]; },
      all() { return { ...settingsDefaults(plugin), ...plugin.data }; },
      set(key, value) { return setValue(plugin, key, value, false); },
      delete(key) { return setValue(plugin, key, undefined, false); },
      subscribe(callback) {
        const listener = guard(callback);
        subscribers.add(listener);
        const off = () => subscribers.delete(listener);
        cleanup.push(off);
        return off;
      }
    };
    const prefix = `[Tamler:${plugin.id}]`;
    const api = {
      document,
      window,
      plugin: { id: plugin.id, name: plugin.name, version: plugin.version },
      page: { url: window.location.href, origin: window.location.origin, host: window.location.host, protocol: window.location.protocol },
      signal: controller.signal,
      storage,
      log: (...args) => window.console.log(prefix, ...args),
      warn: (...args) => window.console.warn(prefix, ...args),
      error: (...args) => window.console.error(prefix, ...args),
      addStyle(css, from = '') {
        const style = document.createElement('style');
        style.dataset.tamlerPlugin = plugin.id;
        style.textContent = assets.css(String(css), from);
        (document.head || document.documentElement).appendChild(style);
        cleanup.push(() => style.remove());
        return style;
      },
      on(target, event, listener, options) {
        const wrapped = guard(listener);
        target.addEventListener(event, wrapped, options);
        const off = () => target.removeEventListener(event, wrapped, options);
        cleanup.push(off);
        return off;
      },
      observe(target, callback, options = { childList: true, subtree: true }) {
        const observer = new window.MutationObserver(guard(callback));
        observer.observe(target, options);
        cleanup.push(() => observer.disconnect());
        return observer;
      },
      mount(selector, callback, options = {}) {
        const root = options.root || document.documentElement;
        const mounted = new Map();
        let stopped = false;
        const undo = (element, revert) => { if (revert) { try { revert(element); } catch (error) { report(plugin.id, error); } } };
        const run = () => {
          if (stopped) return;
          for (const [element, revert] of mounted) {
            if (element.isConnected && element.matches(selector)) continue;
            mounted.delete(element);
            undo(element, revert);
          }
          for (const element of root.querySelectorAll(selector)) {
            if (mounted.has(element)) continue;
            mounted.set(element, null);
            try {
              const revert = callback(element);
              if (mounted.has(element)) mounted.set(element, typeof revert === 'function' ? revert : null);
            } catch (error) { report(plugin.id, error); }
          }
        };
        const observer = new window.MutationObserver(run);
        observer.observe(root, { childList: true, subtree: true, attributes: options.attributes !== false });
        const stop = () => {
          if (stopped) return;
          stopped = true;
          observer.disconnect();
          for (const [element, revert] of mounted) undo(element, revert);
          mounted.clear();
        };
        cleanup.push(stop);
        run();
        return stop;
      },
      asset: name => assets.asset(name),
      // Файлы плагина на диске (data/plugin-files/<id>/<key>/). Для настроек типа files ключ совпадает с ключом настройки.
      files: {
        list: key => request('file-list', { id: plugin.id, key }).then(result => result.files),
        read: (key, name) => request('file-get', { id: plugin.id, key, name }, 60000).then(result => fromBase64(result.data).buffer),
        write: (key, name, data) => uploadFile(plugin.id, key, name, data),
        remove: (key, name) => removeFile(plugin.id, key, name)
      },
      // Запрос из основного процесса: без CSP и CORS страницы, только к адресам из hosts в plugin.json.
      async request(url, options = {}) {
        const result = await request('net-fetch', { id: plugin.id, url: String(new window.URL(url, window.location.href)) }, 70000);
        const bytes = fromBase64(result.data);
        const text = () => new window.TextDecoder().decode(bytes);
        return { status: result.status, ok: result.status >= 200 && result.status < 300, type: result.type, text, json: () => JSON.parse(text()), arrayBuffer: () => bytes.buffer };
      },
      // Варианты для настроек типа list и select: provider(query) возвращает массив { value, label, description?, style? }.
      options(key, provider) {
        if (typeof provider !== 'function') throw new Error('Options provider must be a function');
        optionProviders.set(key, provider);
        cleanup.push(() => { if (optionProviders.get(key) === provider) optionProviders.delete(key); manager?.update(); });
        manager?.update();
      },
      ui: loadUI,
      render(container, view, options = {}) {
        let root;
        let current = view;
        let stopped = false;
        const draw = ui => {
          let element = typeof current === 'function' ? current(ui) : current;
          // Контейнер вне дерева React берёт контексты (тема, роутер) у любого отрисованного компонента Claude.
          let contexts = providers(options.context || container);
          if (!contexts.length) contexts = providers(document.querySelector('[data-cds]'));
          for (const [Provider, value] of contexts) element = ui.React.createElement(Provider, { value }, element);
          root.render(element);
        };
        const ready = loadUI().then(ui => {
          if (stopped || !active.has(plugin.id)) return;
          root = ui.createRoot(container);
          draw(ui);
        }).catch(error => report(plugin.id, error));
        const handle = {
          ready,
          update(next) { current = next; if (root && !stopped) draw(nativeUI); },
          unmount() { if (stopped) return; stopped = true; root?.unmount(); root = null; }
        };
        cleanup.push(handle.unmount);
        return handle;
      },
      cleanup(callback) { cleanup.push(callback); }
    };
    entry.api = api;
    active.set(plugin.id, entry);
    const fail = error => {
      report(plugin.id, error);
      if (active.get(plugin.id) === entry) disable(plugin.id);
    };
    try {
      if (plugin.css) api.addStyle(plugin.css, dirname(plugin.cssPath || ''));
      if (plugin.main) {
        const exports = createRequire(plugin, api).load(plugin.main);
        if (typeof exports?.stop === 'function') cleanup.push(() => exports.stop(api));
        if (typeof exports?.start === 'function') {
          const stop = exports.start(api);
          if (typeof stop === 'function') cleanup.push(stop);
          else if (stop && typeof stop.then === 'function') {
            stop.then(result => {
              if (typeof result !== 'function') return;
              if (active.get(plugin.id) === entry) cleanup.push(result);
              else try { result(); } catch (error) { report(plugin.id, error); }
            }, error => { if (!controller.signal.aborted) fail(error); });
          }
        }
      }
    } catch (error) { fail(error); }
  }
  function disable(id) {
    const entry = active.get(id);
    if (!entry) return;
    active.delete(id);
    entry.controller.abort();
    for (const callback of entry.cleanup.reverse()) {
      try { callback(); } catch (error) { report(id, error); }
    }
  }
  function notify(plugin, external) {
    const entry = active.get(plugin.id);
    if (!entry) return;
    // Плагин без подписки на storage перезапускается, чтобы применить изменения из настроек.
    if (external && !entry.subscribers.size) { disable(plugin.id); enable(plugin); return; }
    const values = { ...settingsDefaults(plugin), ...plugin.data };
    for (const subscriber of entry.subscribers) subscriber(values);
  }
  function setValue(plugin, key, value, external) {
    if (typeof key !== 'string' || !key) return Promise.reject(new Error('Storage key must be a non-empty string'));
    const data = { ...plugin.data };
    if (value === undefined) delete data[key];
    else data[key] = JSON.parse(JSON.stringify(value));
    plugin.data = data;
    notify(plugin, external);
    return request('storage-set', { id: plugin.id, key, value: data[key] ?? null, remove: value === undefined }).then(() => undefined);
  }
  const api = {
    version: '0.6.0',
    errors,
    loadUI,
    providers,
    list: () => plugins.map(plugin => ({ id: plugin.id, name: plugin.name, description: plugin.description, version: plugin.version, error: plugin.error || errors.find(error => error.id === plugin.id)?.message, enabled: plugin.enabled !== false && !plugin.error, running: active.has(plugin.id), matches: matches(plugin), settings: plugin.settings || [], values: { ...settingsDefaults(plugin), ...plugin.data } })),
    reply(id, result) {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      window.clearTimeout(entry.timer);
      result.ok ? entry.resolve(result) : entry.reject(new Error(result.error));
    },
    // Пока Tamler выключен целиком, плагины не запускаются, но менеджер остаётся, чтобы его включить.
    paused: !!state.paused,
    update(next, nextState = {}) {
      for (const id of [...active.keys()]) disable(id);
      plugins = next;
      api.paused = !!nextState.paused;
      errors.length = 0;
      if (!api.paused) for (const plugin of plugins) if (plugin.enabled !== false) enable(plugin);
      manager?.update();
    },
    uploadFile,
    removeFile,
    hasOptions: (id, key) => !!active.get(id)?.optionProviders.get(key),
    async searchOptions(id, key, query) {
      const plugin = plugins.find(plugin => plugin.id === id);
      const setting = plugin?.settings?.find(setting => setting.key === key);
      const provider = active.get(id)?.optionProviders.get(key);
      if (provider) return provider(String(query || ''));
      if (setting?.options) {
        const text = String(query || '').toLowerCase();
        return setting.options.filter(option => option.label.toLowerCase().includes(text));
      }
      throw new Error('Enable the plugin to search');
    },
    setSetting(id, key, value) {
      const plugin = plugins.find(plugin => plugin.id === id);
      if (!plugin) return Promise.reject(new Error(`Unknown plugin: ${id}`));
      const result = setValue(plugin, key, value, true);
      manager?.update();
      return result;
    },
    storageChanged(id, data) {
      const plugin = plugins.find(plugin => plugin.id === id);
      if (!plugin || JSON.stringify(plugin.data || {}) === JSON.stringify(data || {})) return;
      plugin.data = data || {};
      notify(plugin, true);
      manager?.update();
    },
    enable(id) {
      const plugin = plugins.find(plugin => plugin.id === id);
      if (!plugin) throw new Error(`Unknown plugin: ${id}`);
      enable(plugin);
    },
    disable,
    dispose() {
      if (api.managerOpen) window.__tamlerReopen = true;
      manager?.dispose();
      for (const entry of pending.values()) {
        window.clearTimeout(entry.timer);
        entry.reject(new Error('Tamler disposed'));
      }
      pending.clear();
      for (const id of [...active.keys()]) disable(id);
      delete window.Tamler;
    }
  };
  window.Tamler = api;
  if (!api.paused) for (const plugin of plugins) if (plugin.enabled !== false) enable(plugin);
  if (managerFactory) {
    manager = managerFactory(window, api, request);
    api.manager = manager;
    if (reopen) await manager.open();
  }
  return { version: api.version, paused: api.paused, plugins: api.list().map(({ settings, values, ...plugin }) => plugin), errors };
}

module.exports = { installTamler };
