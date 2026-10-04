// Приветствие на стартовой странице Code — обычные сообщения react-intl (сборка aa6da7d0d3, компонент шапки):
// с именем аккаунта и без него, «What's up next» для пустого списка и «Welcome back», когда сессии есть.
const MESSAGES = {
  greeting: { named: 'flLEnDzvfG', plain: 'W8pMCdh9hq' },
  welcome: { named: 'UOxi8mioge', plain: 'UKxoV8UIxo' }
};
const PLACEHOLDER = 'NAME';
// Общий реестр подмен строк: другие плагины, собирающие словарь заново (russifier), кладут эти строки поверх своих.
const OVERRIDES = Symbol.for('tamler.messageOverrides');

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

// Текст пользователя — литерал ICU: фигурные и угловые скобки экранируются, апостроф удваивается.
const literal = text => text.replace(/'/g, "''").replace(/[{}<>]/g, char => `'${char}'`);

// NAME → {name}, если имя берётся из аккаунта; без имени NAME выбрасывается вместе с запятой перед ним.
function build(template, name) {
  const text = typeof template === 'string' ? template.trim() : '';
  if (!text) return {};
  if (name) {
    const value = literal(text.split(PLACEHOLDER).join(name));
    return { named: value, plain: value };
  }
  const plain = text.replace(/[\s,]*NAME/g, '').replace(/^[\s,]+/, '');
  return { named: text.split(PLACEHOLDER).map(literal).join('{name}'), plain: literal(plain || text) };
}

function overrides(storage) {
  const name = String(storage.get('name') || '').trim();
  const result = {};
  for (const [key, ids] of Object.entries(MESSAGES)) {
    const values = build(storage.get(key), name);
    if (values.named) result[ids.named] = values.named;
    if (values.plain) result[ids.plain] = values.plain;
  }
  return result;
}

module.exports.start = async ({ window, document, storage, signal, cleanup, warn }) => {
  const store = await findLocaleStore(document);
  if (signal.aborted) return;
  if (!store) { warn('Locale store not found; this Claude version is not supported'); return; }

  const registry = window[OVERRIDES] || (window[OVERRIDES] = new Map());
  const ids = Object.values(MESSAGES).flatMap(entry => [entry.named, entry.plain]);
  // Свои строки при откате просто удаляются: по умолчанию стоит defaultMessage, а russifier,
  // получив новый словарь, сам вернёт перевод.
  const ours = new Set();
  let wanted = {};

  const apply = () => {
    const current = store.getState().messages || {};
    let next = null;
    for (const id of ids) {
      const value = wanted[id];
      if (value !== undefined) {
        if (current[id] === value) continue;
        next ??= { ...current };
        next[id] = value;
        ours.add(value);
      } else if (Object.hasOwn(current, id) && ours.has(current[id])) {
        next ??= { ...current };
        delete next[id];
      }
    }
    if (next) store.setState({ messages: next });
  };

  const update = () => {
    wanted = overrides(storage);
    registry.set('custom-greeting', wanted);
    apply();
  };

  update();
  const unsubscribe = store.subscribe(apply);
  storage.subscribe(update);
  cleanup(() => {
    unsubscribe();
    registry.delete('custom-greeting');
    wanted = {};
    apply();
  });
};
