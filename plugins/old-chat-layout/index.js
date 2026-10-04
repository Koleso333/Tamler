// Группировка сессий Code меняется теми же функциями, что вызывает меню Filter в сайдбаре.
// Имена экспортов минифицированы и меняются между сборками, поэтому функции ищутся по исходному коду.
const patterns = {
  setGroup: source => /\.setGroupBy\(e,t\)/.test(source) && /setSectionView\([\w$]+,\{groupBy:/.test(source),
  setSort: source => /\.setSortBy\(e,t\)/.test(source) && /setSectionView\([\w$]+,\{sortBy:t\}/.test(source),
  getGroup: source => /getState\(\)/.test(source) && /\.groupByByMode\[e\]/.test(source) && !/setGroupBy/.test(source)
};

async function findSidebar(document) {
  const found = {};
  for (const link of document.querySelectorAll('link[rel="modulepreload"]')) {
    let module;
    try { module = await import(link.href); } catch { continue; }
    for (const value of Object.values(module)) {
      if (typeof value !== 'function') continue;
      const source = Function.prototype.toString.call(value);
      if (source.length > 2000) continue;
      for (const [key, test] of Object.entries(patterns)) if (!found[key] && test(source)) found[key] = value;
    }
    if (Object.keys(found).length === Object.keys(patterns).length) return found;
  }
  return null;
}

const choices = [
  { value: 'project', label: 'Project' },
  { value: 'date', label: 'Date' },
  { value: 'none', label: 'None' }
];

module.exports.start = async ({ window, document, signal, storage, mount, observe, addStyle, cleanup, warn }) => {
  const sidebar = await findSidebar(document);
  if (signal.aborted) return;
  if (!sidebar) { warn('Sidebar grouping functions not found; this Claude version is not supported'); return; }

  const current = () => sidebar.getGroup('code');
  const apply = value => {
    if (current() !== value) sidebar.setGroup('code', value);
    // Старый вид — свежие сессии сверху.
    if (value !== 'project') sidebar.setSort('code', 'recency');
  };
  apply(storage.get('groupBy'));

  addStyle(`
    [data-old-chat-layout] { display: flex; align-items: center; gap: 2px; }
    [data-old-chat-layout] > span { flex: 1; min-width: 0; }
    [data-old-chat-layout] button { padding: 1px 7px; border-radius: var(--df-radius-pill, 999px); color: inherit; transition: background-color .15s, color .15s; }
    [data-old-chat-layout] button:hover { color: var(--cds-text-secondary, inherit); }
    [data-old-chat-layout] button[aria-pressed="true"] { color: var(--cds-text-primary, inherit); background: var(--cds-fill-ghost-hover, rgba(127, 127, 127, .15)); }
    [data-old-chat-layout][hidden] { display: none; }
  `);

  const switches = new Set();
  const refresh = () => {
    const value = current();
    // Выбор через родное меню Filter тоже запоминается, иначе при следующем запуске плагин вернул бы старый.
    if (choices.some(choice => choice.value === value) && storage.get('groupBy') !== value) storage.set('groupBy', value);
    for (const row of switches) {
      row.hidden = !storage.get('showSwitch');
      for (const button of row.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.value === value));
    }
  };

  // После смены группировки список перестраивается, а scrollTop остаётся прежним — сайдбар прыгал в случайное место.
  // Подкручиваем прокрутку так, чтобы переключатель остался под курсором, пока React дорисовывает список.
  const keepInPlace = row => {
    let scroller = row.parentElement;
    while (scroller && !/(auto|scroll)/.test(window.getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    if (!scroller) return;
    const top = row.getBoundingClientRect().top;
    const fix = () => {
      const current = row.isConnected ? row : document.querySelector('[data-old-chat-layout]');
      if (current) scroller.scrollTop += current.getBoundingClientRect().top - top;
    };
    const observer = new window.MutationObserver(fix);
    observer.observe(scroller, { childList: true, subtree: true });
    const timers = [0, 50, 150, 300].map(delay => window.setTimeout(fix, delay));
    const done = window.setTimeout(() => observer.disconnect(), 400);
    cleanup(() => { observer.disconnect(); timers.concat(done).forEach(window.clearTimeout); });
  };

  mount('[data-kind="code"] [data-testid="sidebar-recents"]', recents => {
    // Классы взяты у заголовков групп сайдбара, чтобы строка выглядела как родная.
    const row = document.createElement('div');
    row.dataset.oldChatLayout = '';
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Group sessions');
    row.className = 'df-label-inset w-full pt-[var(--df-group-pt)] pr-[calc((var(--df-row-h)-24px)/2)] pb-1 text-[length:var(--df-group-font)] leading-4 text-muted';
    const title = document.createElement('span');
    title.className = 'truncate';
    title.textContent = 'Group by';
    row.append(title);
    for (const choice of choices) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.value = choice.value;
      button.textContent = choice.label;
      button.className = 'hide-focus-ring focus-visible:shadow-focus';
      button.addEventListener('click', () => {
        if (choice.value === current()) return;
        keepInPlace(row);
        storage.set('groupBy', choice.value);
      });
      row.append(button);
    }
    recents.before(row);
    switches.add(row);
    refresh();
    const observer = observe(recents, refresh, { childList: true, subtree: true });
    return () => { observer.disconnect(); switches.delete(row); row.remove(); };
  }, { attributes: false });

  storage.subscribe(values => {
    apply(values.groupBy);
    refresh();
  });
};
