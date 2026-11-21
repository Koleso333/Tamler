const { HEX, shiftScale, tintScale, shiftColor, hslTriplet, lightness } = require('./color');

// Исходные шкалы Claude Design System (сборка aa6da7d0d3): :where(:root) { --cds-gray-*, --cds-blue-* }.
const STEPS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 150, 200, 250, 300, 350, 400, 450, 500, 550, 600, 650, 700, 750, 800, 810, 820, 830, 840, 850, 860, 870, 880, 890, 900];
const scale = colors => Object.fromEntries(STEPS.map((step, index) => [step, colors[index]]));
const GRAY = scale(['#ffffff', '#fcfcfb', '#f9f9f7', '#f6f6f4', '#f3f3f0', '#f0efec', '#edece8', '#eae9e4', '#e7e6e1', '#e4e3dd', '#e1e0d9', '#d2d1c7', '#c3c2b7', '#b4b3a8', '#a5a49a', '#97958d', '#898781', '#7b7974', '#6d6b67', '#5f5e5a', '#52514e', '#454442', '#383835', '#2c2c2a', '#20201f', '#1e1e1d', '#1c1c1b', '#1a1a19', '#181817', '#151515', '#131313', '#111111', '#0f0f0f', '#0d0d0d', '#0b0b0b']);
const BLUE = scale(['#ffffff', '#fafcff', '#f5f9fe', '#f0f7fe', '#ebf4fc', '#e7f1fb', '#e2eefa', '#ddebfa', '#d7e8fa', '#d2e5fa', '#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b', '#062b57', '#032042', '#031e3d', '#021c39', '#021a36', '#021831', '#03162c', '#051426', '#07121f', '#091018', '#0a0d11', '#0b0b0b']);
const ACCENT = BLUE[450];
const FIZZY = '[data-cds-fizzy-lake~="color"]:not(:where([data-cds-theme], [data-cds-theme] *))';
const FIZZY_COLOR = /\[data-cds-fizzy-lake~=(?:"color"|'color'|color)\]/;
const BUILT_IN = { blue: BLUE, gray: GRAY, palettes: [FIZZY], themeRules: [] };
const CLAY = '#d97757';
const CLAY_EMPHASIZED = '#c6613f';

// Акцент Claude — это шкала --cds-blue-*: от неё считаются --cds-role-accent-*, а через --cds-hsl-blue-* и старые --accent-*.
// Палитра объявлена на :root с низкой специфичностью, поэтому :root:root:root перекрывает её без !important,
// а вложенные .cds-root наследуют уже пересчитанные значения.
// scales — исходные шкалы { blue, gray } той палитры, что сейчас действует; ACCENT (значение настройки по умолчанию) ничего не меняет.
function buildCss({ accent, brand, tint }, scales = BUILT_IN) {
  const vars = [];
  const clay = [];
  const themed = [];
  const customAccent = accent !== ACCENT;
  const tintColor = customAccent ? accent : scales.blue['450'];
  const onAccent = customAccent && lightness(accent) > 0.72 ? scales.gray[900] || GRAY[900] : null;
  if (customAccent) {
    const blue = shiftScale(scales.blue, '450', accent);
    for (const step of Object.keys(blue)) vars.push(`--cds-blue-${step}: ${blue[step]};`, `--cds-hsl-blue-${step}: ${hslTriplet(blue[step])};`);
    if (onAccent) vars.push(`--cds-role-accent-on: ${onAccent};`);
  }
  if (tint > 0) {
    const gray = tintScale(scales.gray, tintColor, tint / 100);
    for (const step of Object.keys(gray)) vars.push(`--cds-gray-${step}: ${gray[step]};`, `--cds-hsl-gray-${step}: ${hslTriplet(gray[step])};`);
  }
  for (const { selector, surfaces, hover, hasOnAccent, media } of scales.themeRules) {
    const declarations = [];
    if (tint > 0) {
      const tinted = tintScale(surfaces, tintColor, tint / 100);
      for (const [name, value] of Object.entries(tinted)) declarations.push(`${name}: ${value};`);
    }
    if (hover && customAccent) declarations.push(`--cds-fill-accent-hover: ${shiftColor(hover, scales.blue['450'], accent)};`);
    if (hasOnAccent && onAccent) declarations.push(`--cds-on-accent: ${onAccent};`);
    if (!declarations.length) continue;
    const css = `:is(${selector}).cds-root.cds-root { ${declarations.join(' ')} }`;
    themed.push(media ? `@media ${media} { ${css} }` : css);
  }
  const rules = [];
  if (brand !== CLAY) {
    const emphasized = shiftColor(CLAY_EMPHASIZED, CLAY, brand);
    vars.push(`--cds-hsl-clay: ${hslTriplet(brand)};`, `--cds-hsl-clay-emphasized: ${hslTriplet(emphasized)};`);
    // --cds-clay объявлен ещё и на каждом .cds-root.
    clay.push(`--cds-clay: ${brand};`, `--cds-clay-emphasized: ${emphasized};`);
    // Места, где оранжевый Claude записан в коде напрямую: логотипы, градиенты, отдельные классы.
    rules.push(
      '[fill="#d97757" i] { fill: var(--cds-clay); }',
      '[stroke="#d97757" i] { stroke: var(--cds-clay); }',
      '[stop-color="#d97757" i] { stop-color: var(--cds-clay); }',
      '.text-\\[\\#D97757\\].text-\\[\\#D97757\\] { color: var(--cds-clay); }',
      '.border-\\[\\#D97757\\].border-\\[\\#D97757\\] { border-color: var(--cds-clay); }',
      '.to-\\[\\#d97757\\].to-\\[\\#d97757\\] { --tw-gradient-to: var(--cds-clay); }',
      '.from-\\[\\#db6843\\].from-\\[\\#db6843\\] { --tw-gradient-from: var(--cds-clay-emphasized); }'
    );
  }
  return [
    vars.length || clay.length ? `:root:root:root { ${vars.join(' ')} ${clay.join(' ')} }` : '',
    ...(vars.length ? scales.palettes.map(selector => `:is(${selector})[data-cds-fizzy-lake] { ${vars.join(' ')} }`) : []),
    ...themed,
    clay.length ? `.cds-root.cds-root.cds-root { ${clay.join(' ')} }` : '',
    ...rules
  ].filter(Boolean).join('\n');
}

const hex = value => {
  value = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(value)) value = '#' + [...value.slice(1)].map(digit => digit + digit).join('');
  return HEX.test(value) ? value : null;
};

// Шкалы fizzy-lake читаются из CSS Claude: значения меняются от сборки к сборке.
function readScales(document) {
  if (!/(^|\s)color(\s|$)/.test(document.documentElement.getAttribute('data-cds-fizzy-lake') || '')) return BUILT_IN;
  const found = { blue: {}, gray: {}, palettes: [], themeRules: [] };
  const walk = (rules, media) => {
    for (const rule of rules) {
      if (rule.cssRules) walk(rule.cssRules, rule.media ? rule.media.mediaText : media);
      const { selectorText: selector, style } = rule;
      if (!style || !FIZZY_COLOR.test(selector || '')) continue;
      const hasPalette = hex(style.getPropertyValue('--cds-blue-450')) && hex(style.getPropertyValue('--cds-gray-450'));
      if (hasPalette) found.palettes.push(selector);
      const surfaces = {};
      const hover = hex(style.getPropertyValue('--cds-fill-accent-hover'));
      const hasOnAccent = Boolean(style.getPropertyValue('--cds-on-accent'));
      for (const name of rule.style) {
        const match = hasPalette && /^--cds-(blue|gray)-(\d+)$/.exec(name);
        const isSurface = /^--cds-surface-[\w-]+$/.test(name);
        if (!match && !isSurface) continue;
        const value = hex(style.getPropertyValue(name));
        if (!value) continue;
        if (match) found[match[1]][match[2]] = value;
        else surfaces[name] = value;
      }
      if (hover || hasOnAccent || Object.keys(surfaces).length) found.themeRules.push({ selector, surfaces, hover, hasOnAccent, media });
    }
  };
  for (const sheet of document.styleSheets) {
    try { walk(sheet.cssRules, ''); } catch {}
  }
  return found.blue['450'] && found.gray['450'] ? found : BUILT_IN;
}

const color = (value, fallback) => typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : fallback;

// Анимированный знак Claude (WorkingMark) — PNG-спрайт с оранжевым внутри картинки.
// Спрайт становится маской, а цвет берётся из color: var(--cds-clay) самого знака.
function maskSprite(element) {
  const image = element.style.backgroundImage;
  if (!image || image === 'none') return null;
  element.style.setProperty('-webkit-mask-image', image);
  element.style.setProperty('-webkit-mask-size', '100% 100%');
  element.style.setProperty('-webkit-mask-repeat', 'no-repeat');
  element.style.setProperty('background-image', 'none', 'important');
  element.style.setProperty('background-color', 'currentColor', 'important');
  return () => {
    for (const name of ['-webkit-mask-image', '-webkit-mask-size', '-webkit-mask-repeat', 'background-color']) element.style.removeProperty(name);
    element.style.setProperty('background-image', image);
  };
}

module.exports.start = ({ document, storage, addStyle, mount, warn }) => {
  const style = addStyle('');
  const scales = readScales(document);
  let applied = null;
  let stopMask = null;
  function apply() {
    const tint = Number(storage.get('tint'));
    const options = { accent: color(storage.get('accent'), ACCENT), brand: color(storage.get('brand'), CLAY), tint: Number.isFinite(tint) ? Math.min(100, Math.max(0, tint)) : 0 };
    const key = JSON.stringify(options);
    if (key === applied) return;
    applied = key;
    try { style.textContent = buildCss(options, scales); }
    catch (error) { style.textContent = ''; warn('palette failed', error); }
    // Атрибуты не отслеживаются: style спрайта меняется каждый кадр анимации, а на совпадение селектора это не влияет.
    if (options.brand !== CLAY && !stopMask) stopMask = mount('[data-cds="WorkingMark"] span[style*="background-image"]', maskSprite, { attributes: false });
    else if (options.brand === CLAY && stopMask) { stopMask(); stopMask = null; }
  }
  apply();
  storage.subscribe(apply);
};

module.exports.buildCss = buildCss;
