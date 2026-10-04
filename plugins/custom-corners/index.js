// Формы из Superellipse Playground. Там угол — кубическая Безье с контрольной точкой на доле c пути к вершине
// (или кривая Ламе с показателем n, или срез). В CSS это corner-shape: superellipse(K), где показатель кривой n = 2^K:
// K = 1 — дуга окружности, K = 2 — squircle, K = 0 — срез. c переводится в n по совпадению середины угла:
// у Безье она в (4 + 3c) / 8, у суперэллипса — в 2^(-1/n).
// def — насколько скругляет вариант при открытии в Playground; относительно Arc он задаёт множитель радиуса.
const VARIANTS = {
  arc: { mode: 'round', c: 0.5523, def: 0.55 },
  softbox: { mode: 'round', c: 0.62, def: 0.60 },
  squircle: { mode: 'round', c: 0.72, def: 0.62 },
  continuum: { mode: 'round', c: 0.80, def: 0.66 },
  marshmallow: { mode: 'round', c: 0.90, def: 0.72 },
  cloud: { mode: 'round', c: 0.99, def: 0.82 },
  pebble: { mode: 'round', c: 0.84, def: 0.88 },
  capsule: { mode: 'round', c: 0.66, def: 1.00 },
  featheredge: { mode: 'round', c: 0.70, def: 0.48 },
  lame: { mode: 'super', nMin: 2.4, nMax: 9, def: 0.60 },
  hyper: { mode: 'super', nMin: 2.0, nMax: 5, def: 0.70 },
  bevel: { mode: 'chamfer', def: 0.50 },
  facet: { mode: 'chamfer', def: 0.78 }
};

function exponent(variant) {
  if (variant.mode === 'chamfer') return 0;
  const n = variant.mode === 'super'
    ? variant.nMax + (variant.nMin - variant.nMax) * variant.def
    : Math.LN2 / Math.log(8 / (4 + 3 * variant.c));
  return Math.round(Math.log2(n) * 1000) / 1000;
}

function corner(shape, scale) {
  const variant = VARIANTS[shape] || VARIANTS.arc;
  return { k: exponent(variant), factor: scale * variant.def / VARIANTS.arc.def };
}

const LENGTH = /(^|[^\w.-])(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(px|rem|em)\b/gi;
const RADIUS = /^border(-(top|bottom|start|end)-(left|right|start|end))?-radius$/;
const KEYFRAME_RULE = 8;

// Круги (50%) и «пилюли» (9999px, calc(infinity * 1px)) не масштабируются и не меняют форму.
function isPill(value) {
  if (value.includes('%') || /infinity/i.test(value)) return true;
  for (const [, , number, unit] of value.matchAll(LENGTH)) {
    if (Number(number) * (unit.toLowerCase() === 'px' ? 1 : 16) >= 999) return true;
  }
  return false;
}

// Масштабируются только числа с единицами. Ссылки на переменные остаются как есть:
// сами переменные радиусов масштабируются там, где объявлены, — иначе радиус умножился бы дважды.
const scaleLengths = (value, factor) => value.replace(LENGTH, (match, before, number, unit) => `${before}${+(Number(number) * factor).toFixed(4)}${unit}`);

module.exports.start = ({ document, window, storage, warn }) => {
  const shapeSupported = !!window.CSS?.supports?.('corner-shape', 'superellipse(2)');
  if (!shapeSupported) warn('corner-shape is not supported, only the radius is scaled');
  const original = new Map();   // CSSStyleDeclaration → [[property, value, priority]]
  const done = new WeakSet();
  let options = null;

  function remember(style, property) {
    let list = original.get(style);
    if (!list) original.set(style, list = []);
    if (!list.some(([name]) => name === property)) list.push([property, style.getPropertyValue(property), style.getPropertyPriority(property)]);
  }

  function rewrite(style, keyframe) {
    if (!/radius/i.test(style.cssText)) return;
    const properties = [];
    for (let i = 0; i < style.length; i++) properties.push(style[i]);
    let shaped = false;
    for (const property of properties) {
      const custom = property.startsWith('--');
      if (custom ? !/radius/i.test(property) : !RADIUS.test(property)) continue;
      const value = style.getPropertyValue(property);
      // Если шорткат border-radius задан через var(), его longhand-свойства читаются пустой строкой.
      if (!value.trim()) {
        if (!custom && !isPill(style.getPropertyValue('border-radius'))) shaped = true;
        continue;
      }
      if (isPill(value)) continue;
      if (options.factor !== 1) {
        const scaled = scaleLengths(value, options.factor);
        if (scaled !== value) { remember(style, property); style.setProperty(property, scaled, style.getPropertyPriority(property)); }
      }
      if (!custom) shaped = true;
    }
    if (shaped && !keyframe && shapeSupported && options.k !== 1) {
      remember(style, 'corner-shape');
      style.setProperty('corner-shape', `superellipse(${options.k})`);
    }
  }

  function walk(rules) {
    for (const rule of rules) {
      if (rule.style) rewrite(rule.style, rule.type === KEYFRAME_RULE);
      if (rule.cssRules) walk(rule.cssRules);
    }
  }

  function scan() {
    for (const sheet of [...document.styleSheets, ...(document.adoptedStyleSheets || [])]) {
      if (done.has(sheet)) continue;
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }   // чужой домен без CORS
      done.add(sheet);
      walk(rules);
    }
  }

  function restore() {
    for (const [style, list] of original) {
      for (const [property, value, priority] of list) {
        if (value) style.setProperty(property, value, priority);
        else style.removeProperty(property);
      }
    }
    original.clear();
  }

  function apply() {
    const scale = Number(storage.get('scale'));
    const next = corner(storage.get('shape'), Number.isFinite(scale) ? Math.min(3, Math.max(0, scale)) : 1.2);
    if (options && next.k === options.k && next.factor === options.factor) return;
    restore();
    options = next;
    for (const sheet of [...document.styleSheets, ...(document.adoptedStyleSheets || [])]) done.delete(sheet);
    scan();
  }

  apply();
  storage.subscribe(apply);

  // Новые <style> и <link rel=stylesheet> при переходах по приложению. У <link> правила появляются только после load.
  const pending = new Set();
  const observer = new window.MutationObserver(records => {
    let found = false;
    for (const record of records) {
      for (const node of record.addedNodes) {
        const element = node.nodeType === 1 ? node : node.parentElement;
        if (!element || (element.tagName !== 'STYLE' && element.tagName !== 'LINK')) continue;
        found = true;
        if (element.tagName === 'LINK' && !element.sheet && !pending.has(element)) {
          pending.add(element);
          element.addEventListener('load', () => { pending.delete(element); scan(); }, { once: true });
        }
      }
    }
    if (found) scan();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  return () => {
    observer.disconnect();
    restore();
  };
};

module.exports.corner = corner;
module.exports.scaleLengths = scaleLengths;
module.exports.isPill = isPill;
