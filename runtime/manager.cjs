function installManager(window, api, request) {
  const document = window.document;
  let disposed = false;
  let opened = false;
  let root;
  let host;
  let pane;
  let currentNavigation;
  let renderView;
  let settingsNavigation;
  let generation = 0;
  let closing = false;
  let leaving = null;
  const closePath = new Set();
  const buttons = new Set();
  const selected = new Map();
  const isolation = document.createElement('style');
  isolation.dataset.tamlerManagerIsolation = '';
  isolation.textContent = '[data-tamler-settings-open] { position: relative; } [data-tamler-settings-open] > :not([data-tamler-manager]):not([data-tamler-close-path]), [data-tamler-settings-open] [data-tamler-close-path] > :not([data-tamler-close-path]):not([data-tamler-close]) { display: none !important; } [data-tamler-settings-open] [data-tamler-close-path] { display: contents !important; } [data-tamler-settings-open] [data-tamler-close] { position: absolute; top: 12px; right: 12px; z-index: 2; }';
  document.head.appendChild(isolation);
  function restorePane() {
    for (const element of closePath) { element.removeAttribute('data-tamler-close-path'); element.removeAttribute('data-tamler-close'); }
    closePath.clear();
    pane?.removeAttribute('data-tamler-settings-open');
    if (host) host.style.display = 'none';
  }
  function restoreNavigation() {
    for (const [element, attributes] of selected) {
      for (const [name, value] of attributes) value === null ? element.removeAttribute(name) : element.setAttribute(name, value);
    }
    selected.clear();
    for (const button of buttons) {
      button.removeAttribute('data-active');
      button.setAttribute('aria-selected', 'false');
      button.removeAttribute('aria-current');
      if (button.getAttribute('role') !== 'tab') button.className = 'flex h-control w-full items-center gap-sm rounded px-sm text-left text-body cursor-pointer text-secondary hover:bg-fill-ghost-hover hover:text-primary';
    }
  }
  function restore() {
    generation++;
    if (leaving) { window.clearTimeout(leaving); leaving = null; }
    restorePane();
    restoreNavigation();
  }
  function teardown() {
    restore();
    root?.unmount();
    root = null;
    host?.remove();
    host = null;
    renderView = null;
  }
  function activate() {
    if (!pane || !opened || !host) return;
    const close = [...pane.querySelectorAll('button[aria-label="Close"]')].find(button => !host.contains(button));
    if (close) {
      close.dataset.tamlerClose = '';
      closePath.add(close);
      for (let parent = close.parentElement; parent && parent !== pane; parent = parent.parentElement) {
        parent.dataset.tamlerClosePath = '';
        closePath.add(parent);
      }
    }
    if (!pane.hasAttribute('data-tamler-settings-open')) pane.setAttribute('data-tamler-settings-open', '');
    host.style.display = 'flex';
    if (!selected.has(pane)) selected.set(pane, [['aria-labelledby', pane.getAttribute('aria-labelledby')]]);
    const activeButton = [...buttons].find(button => button.isConnected);
    pane.setAttribute('aria-labelledby', activeButton?.querySelector('[data-tamler-label]')?.id || '');
    for (const button of buttons) {
      if (!button.isConnected) continue;
      for (const original of settingsNavigation.querySelectorAll('button[aria-current="page"]')) {
        if (original === button) continue;
        if (!selected.has(original)) selected.set(original, ['aria-current', 'aria-selected', 'data-active', 'class'].map(name => [name, original.getAttribute(name)]));
        if (original.hasAttribute('aria-current')) original.removeAttribute('aria-current');
        if (original.hasAttribute('data-active')) original.removeAttribute('data-active');
        if (original.getAttribute('aria-selected') !== 'false') original.setAttribute('aria-selected', 'false');
        if (original.getAttribute('role') !== 'tab') original.className = 'flex h-control w-full items-center gap-sm rounded px-sm text-left text-body cursor-pointer text-secondary hover:bg-fill-ghost-hover hover:text-primary';
      }
      if (button.getAttribute('role') === 'tab') {
        if (!button.hasAttribute('data-active')) button.setAttribute('data-active', '');
        if (button.getAttribute('aria-selected') !== 'true') button.setAttribute('aria-selected', 'true');
      } else {
        if (button.getAttribute('aria-current') !== 'page') button.setAttribute('aria-current', 'page');
        button.className = 'flex h-control w-full items-center gap-sm rounded px-sm text-left text-body cursor-pointer bg-fill-ghost-selected font-medium text-primary';
      }
    }
  }
  async function open() {
    if (!pane) return;
    const opening = ++generation;
    opened = true;
    api.managerOpen = true;
    try {
      const ui = await api.loadUI();
      if (disposed || !opened || !pane || opening !== generation) return;
      if (!host || !host.isConnected) {
        root?.unmount();
        host = document.createElement('div');
        host.dataset.tamlerManager = '';
        host.className = 'flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-surface-2';
        const chrome = document.createElement('div');
        chrome.className = 'flex shrink-0 items-center justify-end px-md pt-md pb-sm';
        chrome.style.minHeight = '48px';
        const body = document.createElement('div');
        body.className = 'flex min-h-0 flex-1 flex-col overflow-y-auto';
        host.append(chrome, body);
        pane.appendChild(host);
        root = ui.createRoot(body);
      }
      const contexts = api.providers(currentNavigation);
      const h = ui.React.createElement;
      const fieldClass = 'h-control w-48 rounded border border-border-300 bg-transparent px-sm text-body text-primary';
      const { Expand, Dropdown, Autocomplete } = ui;
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const formatSize = bytes => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
      const removeIcon = h('svg', { width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'm3 3 6 6M9 3 3 9', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }));
      // Список значений с поиском: варианты даёт плагин через options(key, provider) или manifest.
      function ListField({ plugin, setting, id, save, onOpenChange }) {
        const values = Array.isArray(plugin.values[setting.key]) ? plugin.values[setting.key] : [];
        const known = ui.React.useRef(new Map());
        const [, refresh] = ui.React.useState(0);
        for (const option of setting.options || []) if (!known.current.has(JSON.stringify(option.value))) known.current.set(JSON.stringify(option.value), option);
        const remember = options => { for (const option of options) known.current.set(JSON.stringify(option.value), option); };
        const labelOf = value => known.current.get(JSON.stringify(value))?.label ?? String(value);
        // Подписи и стиль уже добавленных значений берутся у поставщика вариантов (например, превью шрифта).
        ui.React.useEffect(() => {
          const missing = values.filter(value => !known.current.has(JSON.stringify(value)));
          if (!missing.length || !api.hasOptions(plugin.id, setting.key)) return;
          let stopped = false;
          Promise.all(missing.map(value => api.searchOptions(plugin.id, setting.key, String(value)).then(options => options.filter(option => same(option.value, value)), () => [])))
            .then(found => { if (!stopped) { remember(found.flat()); refresh(count => count + 1); } });
          return () => { stopped = true; };
        }, [JSON.stringify(values)]);
        const search = query => api.searchOptions(plugin.id, setting.key, query).then(options => {
          remember(options);
          return options.filter(option => !values.some(value => same(value, option.value)));
        });
        return h('div', { className: 'flex flex-col gap-2' },
          h(Autocomplete, { search, labelledBy: id, placeholder: setting.placeholder || 'Search…', onOpenChange, onSelect: option => save([...values, option.value]) }),
          values.length > 0 && h('div', { className: 'flex flex-wrap gap-1.5' }, values.map(value => h('span', { key: JSON.stringify(value), className: 'inline-flex h-7 items-center gap-1 rounded-full bg-fill-ghost-hover pl-2.5 pr-1 text-body text-primary' },
            h('span', { style: known.current.get(JSON.stringify(value))?.style }, labelOf(value)),
            h('button', { type: 'button', 'aria-label': `Remove ${labelOf(value)}`, className: 'cds-reset inline-flex size-5 items-center justify-center rounded-full text-secondary hover:text-primary hover:bg-fill-ghost-hover cursor-pointer',
              onClick: () => save(values.filter(item => !same(item, value))) }, removeIcon)))));
      }
      // Выпадающий список: варианты из manifest или от плагина через options(key, provider), например загруженные файлы.
      // Поставщик спрашивается заново при любом изменении настроек плагина.
      function SelectField({ plugin, setting, id, value, save, onOpenChange }) {
        const dynamic = api.hasOptions(plugin.id, setting.key);
        const [options, setOptions] = ui.React.useState(setting.options || []);
        ui.React.useEffect(() => {
          if (!dynamic) { setOptions(setting.options || []); return; }
          let stopped = false;
          Promise.resolve(api.searchOptions(plugin.id, setting.key, '')).then(next => { if (!stopped) setOptions(Array.isArray(next) ? next : []); }, () => {});
          return () => { stopped = true; };
        }, [dynamic, JSON.stringify(plugin.values)]);
        if (!options.length) return h('p', { className: 'text-body text-secondary' }, setting.placeholder || 'Nothing to choose');
        return h(Dropdown, { value, options, labelledBy: id, onChange: save, onOpenChange });
      }
      // Файлы хранятся на диске через основной процесс; значение настройки — список { name, size }.
      function FilesField({ plugin, setting, id, onError }) {
        const files = Array.isArray(plugin.values[setting.key]) ? plugin.values[setting.key] : [];
        const input = ui.React.useRef(null);
        const [progress, setProgress] = ui.React.useState(null);
        async function add(list) {
          try {
            for (const file of list) {
              setProgress({ name: file.name, value: 0 });
              await api.uploadFile(plugin.id, setting.key, file.name, await file.arrayBuffer(), value => setProgress({ name: file.name, value }));
            }
          } catch (error) { onError(error.message); }
          finally { setProgress(null); if (input.current) input.current.value = ''; }
        }
        return h('div', { className: 'flex flex-col gap-1' },
          files.map(file => h('div', { key: file.name, className: 'flex items-center gap-2 rounded px-sm py-1 hover:bg-fill-ghost-hover' },
            h('span', { className: 'min-w-0 flex-1 truncate text-body text-primary' }, file.name),
            h('span', { className: 'shrink-0 text-caption text-secondary' }, formatSize(file.size || 0)),
            h(ui.Button, { variant: 'ghost', icon: 'Trash', iconOnly: true, tooltip: false, size: 'xs', 'aria-label': `Remove ${file.name}`, disabled: !!progress,
              onClick: () => api.removeFile(plugin.id, setting.key, file.name).catch(error => onError(error.message)) }))),
          progress && h('p', { className: 'px-sm text-caption text-secondary' }, `Uploading ${progress.name}… ${Math.round(progress.value * 100)}%`),
          h('input', { ref: input, type: 'file', multiple: true, accept: setting.accept, hidden: true, onChange: event => add([...event.target.files]) }),
          h('div', { className: 'mt-1' }, h(ui.Button, { variant: 'secondary', disabled: !!progress, 'aria-describedby': id, onClick: () => input.current?.click() }, 'Add files')));
      }
      // Цвет: образцы из options, своё значение через системную палитру или hex-поле.
      function ColorField({ setting, id, value, save }) {
        const hex = /^#[0-9a-f]{6}$/i;
        const current = hex.test(value) ? value.toLowerCase() : (setting.default || '#000000');
        const [draft, setDraft] = ui.React.useState(current);
        ui.React.useEffect(() => setDraft(current), [current]);
        const picker = ui.React.useRef(null);
        const commit = text => {
          let next = String(text).trim().toLowerCase();
          if (/^#?[0-9a-f]{3}$/.test(next)) next = '#' + next.replace('#', '').split('').map(char => char + char).join('');
          if (/^[0-9a-f]{6}$/.test(next)) next = '#' + next;
          if (!hex.test(next)) { setDraft(current); return; }
          setDraft(next);
          if (next !== current) save(next);
        };
        // Системная палитра шлёт input при каждом движении, сохраняем только итоговое change.
        ui.React.useEffect(() => {
          const input = picker.current;
          if (!input) return;
          const preview = () => setDraft(input.value);
          const done = () => commit(input.value);
          input.addEventListener('input', preview);
          input.addEventListener('change', done);
          return () => { input.removeEventListener('input', preview); input.removeEventListener('change', done); };
        });
        const swatch = { width: 24, height: 24, borderRadius: 9999, flexShrink: 0, boxShadow: 'inset 0 0 0 1px rgba(127, 127, 127, 0.35)' };
        const selected = { outline: '2px solid currentColor', outlineOffset: 2 };
        const presets = setting.options || [];
        const custom = !presets.some(option => option.value === current);
        const textProps = { 'aria-labelledby': id, type: 'text', value: draft, spellCheck: false, maxLength: 7,
          onChange: event => setDraft(typeof event === 'string' ? event : event.target.value), onBlur: () => commit(draft), onKeyDown: event => { if (event.key === 'Enter') commit(draft); } };
        return h('div', { className: 'flex flex-col gap-2' },
          h('div', { role: 'group', 'aria-labelledby': id, className: 'flex flex-wrap items-center gap-2 px-0.5 py-0.5' },
            presets.map(option => h('button', { key: option.value, type: 'button', title: option.label, 'aria-label': option.label, 'aria-pressed': option.value === current,
              className: 'text-primary cursor-pointer', style: { ...swatch, background: option.value, ...(option.value === current ? selected : null) }, onClick: () => commit(option.value) })),
            h('span', { title: 'Custom color', className: 'text-primary relative cursor-pointer',
              style: { ...swatch, background: 'conic-gradient(#f43f5e, #f59e0b, #84cc16, #10b981, #06b6d4, #6366f1, #d946ef, #f43f5e)', ...(custom ? selected : null) } },
              h('input', { ref: picker, type: 'color', value: hex.test(draft) ? draft : current, 'aria-label': 'Custom color', className: 'cursor-pointer',
                style: { position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, border: 0, padding: 0 }, onChange: () => {} }))),
          h('div', { className: 'flex items-center gap-2' },
            h('span', { 'aria-hidden': true, style: { ...swatch, background: hex.test(draft) ? draft : current } }),
            ui.TextInput ? h('div', { className: 'w-28' }, h(ui.TextInput, textProps)) : h('input', { ...textProps, className: fieldClass.replace('w-48', 'w-28') }),
            setting.default && current !== setting.default && h(ui.Button, { variant: 'ghost', onClick: () => commit(setting.default) }, 'Reset')));
      }
      function SettingField({ plugin, setting, onError, onOpenChange }) {
        const value = plugin.values[setting.key];
        const [draft, setDraft] = ui.React.useState(value ?? '');
        ui.React.useEffect(() => setDraft(value ?? ''), [value]);
        const save = next => api.setSetting(plugin.id, setting.key, next).catch(error => onError(error.message));
        // Текст и числа сохраняются по завершении ввода, чтобы не перезапускать плагин на каждый символ.
        const commit = () => {
          if (setting.type === 'number') {
            if (draft === '' || Number.isNaN(Number(draft))) { setDraft(value ?? ''); return; }
            if (Number(draft) !== value) save(Number(draft));
          } else if (draft !== (value ?? '')) save(draft);
        };
        const id = `tamler-setting-${plugin.id}-${setting.key}`;
        let control;
        const label = h('div', { className: 'min-w-0' }, h('p', { id, className: 'text-sm text-primary' }, setting.label), setting.description && h('p', { className: 'text-xs text-secondary mt-0.5' }, setting.description));
        // Списки и файлы шире обычного поля: располагаются под подписью на всю ширину.
        if (setting.type === 'list' || setting.type === 'files' || setting.type === 'color') return h('div', { className: 'flex flex-col gap-2 py-1.5' }, label,
          setting.type === 'list' ? h(ListField, { plugin, setting, id, save, onOpenChange })
            : setting.type === 'color' ? h(ColorField, { setting, id, value, save }) : h(FilesField, { plugin, setting, id, onError }));
        if (setting.type === 'boolean') control = h(ui.Switch, { checked: !!value, 'aria-labelledby': id, onCheckedChange: save });
        else if (setting.type === 'select') control = h(SelectField, { plugin, setting, id, value, save, onOpenChange });
        else {
          const props = { 'aria-labelledby': id, type: setting.type === 'number' ? 'number' : 'text', value: String(draft), min: setting.min, max: setting.max, step: setting.step,
            onChange: event => setDraft(typeof event === 'string' ? event : event.target.value), onBlur: commit, onKeyDown: event => { if (event.key === 'Enter') commit(); } };
          control = ui.TextInput ? h('div', { className: 'w-48' }, h(ui.TextInput, props)) : h('input', { ...props, className: fieldClass });
        }
        return h('div', { className: 'flex items-center justify-between gap-4 py-1.5' }, label, h('div', { className: 'shrink-0' }, control));
      }
      function Manager() {
        const [items, setItems] = ui.React.useState(api.list());
        const [paused, setPaused] = ui.React.useState(api.paused);
        const [pending, setPending] = ui.React.useState(null);
        const [confirming, setConfirming] = ui.React.useState(false);
        const [busy, setBusy] = ui.React.useState(false);
        const [error, setError] = ui.React.useState('');
        const [expanded, setExpanded] = ui.React.useState(null);
        const [raised, setRaised] = ui.React.useState(null);
        renderView = () => { setItems(api.list()); setPaused(api.paused); };
        async function action(name, payload) {
          setBusy(true);
          setError('');
          try {
            const result = await request(name, payload);
            if (result.plugins) api.update(result.plugins);
            setItems(api.list());
            setPaused(api.paused);
            return true;
          } catch (error) { setError(error.message); return false; }
          finally { setBusy(false); }
        }
        return h(ui.React.Fragment, null,
          h('div', { className: 'mx-auto w-full max-w-5xl px-4 md:px-8 py-6' },
            h('div', { className: 'flex items-center justify-between gap-4 mb-6' },
              h('div', null, h('h1', { className: 'text-xl font-medium text-primary' }, 'Tamler'), h('p', { className: 'text-body text-secondary mt-1' }, 'Plugins')),
              h('div', { className: 'flex items-center gap-2' },
                h('label', { className: 'flex items-center gap-2 text-sm text-secondary mr-2' }, paused ? 'Disabled' : 'Enabled',
                  h(ui.Switch, { checked: !paused, disabled: busy, 'aria-label': 'Enable Tamler', onCheckedChange: checked => action('pause', { paused: !checked }) })),
                h(ui.Button, { variant: 'ghost', disabled: busy, onClick: () => action('refresh') }, 'Reload'),
                h(ui.Button, { variant: 'secondary', onClick: () => action('open-folder') }, 'Open plugins folder'))),
            error && h('p', { role: 'alert', className: 'text-danger mb-4' }, error),
            paused && h('p', { className: 'text-body text-secondary mb-4' }, 'Tamler is turned off: no plugins are running. Plugin switches are kept for when you turn it back on.'),
            h('div', { className: 'flex flex-col gap-2', style: paused ? { opacity: 0.6 } : undefined }, items.map(plugin =>
              // Открытый список должен перекрывать следующие карточки: каждая Card — отдельный stacking context.
              h(ui.Card, { key: plugin.id, size: 'sm', style: raised === plugin.id ? { zIndex: 1 } : undefined },
                h('div', { className: 'flex items-center justify-between gap-4' },
                  h('div', { className: 'min-w-0' }, h('h2', { className: 'font-medium text-primary' }, plugin.name),
                    h('p', { className: 'text-sm text-secondary mt-0.5' }, plugin.description || plugin.id),
                    h('p', { className: 'text-xs text-muted mt-0.5' }, plugin.version || '0.0.0'),
                    plugin.error && h('p', { className: 'text-sm text-danger mt-1' }, plugin.error),
                    !paused && !plugin.error && plugin.enabled && !plugin.matches && h('p', { className: 'text-xs text-secondary mt-0.5' }, 'Not active on this page')),
                  h('div', { className: 'flex shrink-0 items-center gap-3' },
                    plugin.settings.length > 0 && !plugin.error && h(ui.Button, { variant: 'ghost', 'aria-expanded': expanded === plugin.id, onClick: () => setExpanded(expanded === plugin.id ? null : plugin.id) }, 'Settings'),
                    h('label', { className: 'flex items-center gap-2 text-sm text-secondary' }, 'Enabled',
                      h(ui.Switch, { checked: plugin.enabled, disabled: busy || !!plugin.error, 'aria-label': `Enable ${plugin.name}`, onCheckedChange: checked => action('toggle', { id: plugin.id, enabled: checked }) })),
                    h(ui.Button, { variant: 'ghost', icon: 'Trash', iconOnly: true, tooltip: false, 'aria-label': `Delete ${plugin.name}`, disabled: busy, onClick: () => { setPending(plugin); setConfirming(true); } }))),
                plugin.settings.length > 0 && !plugin.error && h(Expand, { open: expanded === plugin.id },
                  h('div', { className: 'mt-2 border-t border-border-300 pt-2' },
                    plugin.settings.map(setting => h(SettingField, { key: setting.key, plugin, setting, onError: setError, onOpenChange: open => setRaised(current => open ? plugin.id : current === plugin.id ? null : current) })))))),
              !items.length && h('p', { className: 'text-body text-secondary py-8' }, 'No plugins installed. Open the plugins folder to add one.'))),
          h(ui.Confirm, { open: confirming, onOpenChange: setConfirming, title: `Delete ${pending?.name || 'plugin'}?`, description: 'The plugin will be disabled and removed from Tamler.', confirmLabel: 'Delete', cancelLabel: 'Cancel', confirmVariant: 'danger', initialFocus: 'cancel', onConfirm: async () => { if (await action('remove', { id: pending.id })) setConfirming(false); } }));
      }
      let view = h(Manager);
      for (const [Provider, value] of contexts) view = h(Provider, { value }, view);
      root.render(view);
      activate();
    } catch (error) {
      opened = false;
      api.managerOpen = false;
      restore();
      root?.unmount();
      root = null;
      host?.remove();
      host = null;
      renderView = null;
      window.console.error('[Tamler UI]', error);
      api.errors.push({ id: 'manager', message: error.message });
    }
  }
  function scan() {
    if (disposed) return;
    settingsNavigation = document.querySelector('[role="dialog"][data-open] nav[data-perf-region="settings_nav"]');
    const nextPane = settingsNavigation?.closest('[role="dialog"]')?.querySelector('[data-perf-region="settings_panel"]');
    if (!nextPane && pane?.isConnected && !pane.closest('[role="dialog"]')?.hasAttribute('data-open')) {
      // Окно Settings закрывается с анимацией: оставляем менеджер на месте, пока панель не исчезнет.
      closing = true;
      opened = false;
      api.managerOpen = false;
      return;
    }
    if (nextPane !== pane || closing) {
      closing = false;
      restore();
      root?.unmount();
      root = null;
      host?.remove();
      host = null;
      pane = nextPane;
      if (!pane) { opened = false; api.managerOpen = false; }
    }
    if (!pane) return;
    const skills = [...settingsNavigation.querySelectorAll('li[data-testid="customize-skills-settings"] > button')];
    for (const skill of skills) {
      const parent = skill.closest('ul');
      if (parent.querySelector('[data-tamler-navigation]')) continue;
      const connector = parent.querySelector('li[data-testid="customize-connectors-settings"] > button');
      if (!connector) continue;
      currentNavigation = connector;
      const button = connector.cloneNode(true);
      for (const element of [button, ...button.querySelectorAll('[id]')]) element.removeAttribute('id');
      button.removeAttribute('data-testid');
      button.removeAttribute('data-active');
      button.removeAttribute('data-composite-item-active');
      button.removeAttribute('aria-current');
      button.dataset.tamlerNavigation = '';
      button.setAttribute('aria-selected', 'false');
      const icon = button.querySelector('[data-cds="Icon"]') || document.createElement('span');
      icon.dataset.cds = 'Icon';
      icon.className = 'shrink-0 text-secondary';
      icon.style.fontSize = 'calc(1.25rem * var(--cds-rem-scale, 1))';
      icon.style.fontWeight = '433.3';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = '\uE055';
      button.replaceChildren();
      button.appendChild(icon);
      if (button.getAttribute('role') !== 'tab') button.className = 'flex h-control w-full items-center gap-sm rounded px-sm text-left text-body cursor-pointer text-secondary hover:bg-fill-ghost-hover hover:text-primary';
      const label = document.createElement('span');
      label.className = 'min-w-0 flex-1 truncate';
      label.dataset.tamlerLabel = '';
      label.id = `tamler-customize-label-${buttons.size}`;
      label.textContent = 'Tamler';
      button.appendChild(label);
      button.addEventListener('click', () => void open());
      button.addEventListener('keydown', event => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); skill.focus(); }
      });
      buttons.add(button);
      const item = document.createElement('li');
      item.dataset.tamlerNavigationItem = '';
      item.dataset.testid = 'tamler-settings';
      item.appendChild(button);
      parent.insertBefore(item, skill.parentElement);
    }
    if (opened) {
      if (!host?.isConnected) void open();
      else activate();
    }
  }
  const observer = new window.MutationObserver(records => {
    if (disposed) return;
    if (leaving && pane && records.some(record => record.type === 'childList' && pane.contains(record.target) && !host?.contains(record.target))) teardown();
    if (records.some(record => record.type === 'childList' || record.attributeName === 'data-open' || record.target.closest?.('nav[data-perf-region="settings_nav"]'))) scan();
  });
  const onClick = event => {
    if (event.target.closest?.('[data-tamler-navigation], [data-tamler-manager], [role="alertdialog"]')) return;
    const dialog = event.target.closest?.('[role="dialog"]');
    if (dialog && !dialog.querySelector('nav[data-perf-region="settings_nav"]')) return;
    const button = event.target.closest?.('button, a');
    if (button && button.closest('nav[data-perf-region="settings_nav"]') && host) {
      opened = false;
      api.managerOpen = false;
      // Под менеджером уже была эта вкладка: React ничего не перерисует, снимаем сразу.
      const unchanged = selected.get(button)?.some(([name, value]) => name === 'aria-current' && value === 'page');
      generation++;
      restoreNavigation();
      selected.clear();
      if (unchanged) { teardown(); return; }
      // Иначе держим менеджер, пока React не отрисует новую вкладку, чтобы не мелькала старая.
      if (leaving) window.clearTimeout(leaving);
      leaving = window.setTimeout(teardown, 500);
    }
  };
  document.addEventListener('click', onClick, true);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-selected', 'aria-current', 'data-active', 'data-open'] });
  scan();
  return {
    open,
    update: () => renderView?.(),
    dispose() {
      disposed = true;
      observer.disconnect();
      document.removeEventListener('click', onClick, true);
      restore();
      root?.unmount();
      host?.remove();
      isolation.remove();
      for (const button of buttons) button.closest('[data-tamler-navigation-item]')?.remove();
    }
  };
}

module.exports = { installManager };
