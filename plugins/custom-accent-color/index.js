const { HEX, shiftScale, tintScale, shiftColor, hslTriplet, lightness } = require('./color');

const STEPS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 150, 200, 250, 300, 350, 400, 450, 500, 550, 600, 650, 700, 750, 800, 810, 820, 830, 840, 850, 860, 870, 880, 890, 900];
const scale = colors => Object.fromEntries(STEPS.map((step, index) => [step, colors[index]]));
const GRAY = scale(['#ffffff', '#fcfcfb', '#f9f9f7', '#f6f6f4', '#f3f3f0', '#f0efec', '#edece8', '#eae9e4', '#e7e6e1', '#e4e3dd', '#e1e0d9', '#d2d1c7', '#c3c2b7', '#b4b3a8', '#a5a49a', '#97958d', '#898781', '#7b7974', '#6d6b67', '#5f5e5a', '#52514e', '#454442', '#383835', '#2c2c2a', '#20201f', '#1e1e1d', '#1c1c1b', '#1a1a19', '#181817', '#151515', '#131313', '#111111', '#0f0f0f', '#0d0d0d', '#0b0b0b']);
const BLUE = scale(['#ffffff', '#fafcff', '#f5f9fe', '#f0f7fe', '#ebf4fc', '#e7f1fb', '#e2eefa', '#ddebfa', '#d7e8fa', '#d2e5fa', '#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b', '#062b57', '#032042', '#031e3d', '#021c39', '#021a36', '#021831', '#03162c', '#051426', '#07121f', '#091018', '#0a0d11', '#0b0b0b']);
const ACCENT = BLUE[450];
const FIZZY_COLOR = /\[data-cds-fizzy-lake~=(?:"color"|'color'|color)\]/;
const PALETTE_COLOR = /^--cds-(blue|gray)-(\d+)$/;
const SURFACE_COLOR = /^--cds-surface-[\w-]+$/;
const CDS_SCOPE = /\.cds-(?:root|dark-scope)\b/;
const NAMED_THEME = /\[data-cds-theme\s*[*~|^$]?=/;
const CLAY = '#d97757';
const CLAY_EMPHASIZED = '#c6613f';
const BUILT_IN = { base: { blue: BLUE, gray: GRAY }, legacy: null, legacySelectors: [], themeRules: [], clayEmphasized: CLAY_EMPHASIZED };

function paletteVars({ accent, tint }, { blue, gray }) {
  const vars = [];
  const customAccent = accent !== ACCENT;
  const onAccent = customAccent && lightness(accent) > 0.72 ? gray[900] || GRAY[900] : null;
  if (customAccent) {
    for (const [step, value] of Object.entries(shiftScale(blue, '450', accent))) {
      vars.push(`--cds-blue-${step}: ${value};`, `--cds-hsl-blue-${step}: ${hslTriplet(value)};`);
    }
    if (onAccent) vars.push(`--cds-role-accent-on: ${onAccent};`);
  }
  if (tint > 0) {
    for (const [step, value] of Object.entries(tintScale(gray, customAccent ? accent : blue[450], tint / 100))) {
      vars.push(`--cds-gray-${step}: ${value};`, `--cds-hsl-gray-${step}: ${hslTriplet(value)};`);
    }
  }
  return { vars: vars.join(' '), onAccent };
}

function buildCss(options, scales = BUILT_IN) {
  const { accent, brand, tint } = options;
  const { base, legacy, legacySelectors, themeRules, clayEmphasized } = scales;
  const baseColors = paletteVars(options, base);
  const legacyColors = legacy && paletteVars(options, legacy);
  const rules = [];
  if (baseColors.vars) rules.push(`:root:root:root, [data-cds-unthemed][data-cds-unthemed] { ${baseColors.vars} }`);
  if (legacyColors?.vars) {
    for (const selector of legacySelectors) {
      rules.push(`:is(${selector})[data-cds-fizzy-lake][data-cds-fizzy-lake] { ${legacyColors.vars} }`);
    }
  }
  for (const { selector, surfaces, hover, hasOnAccent, conditions, isLegacy } of themeRules) {
    const palette = isLegacy && legacy ? legacy : base;
    const { onAccent } = isLegacy && legacyColors ? legacyColors : baseColors;
    const declarations = [];
    if (tint > 0) {
      const tinted = tintScale(surfaces, accent === ACCENT ? palette.blue[450] : accent, tint / 100);
      for (const [name, value] of Object.entries(tinted)) declarations.push(`${name}: ${value};`);
    }
    if (hover && accent !== ACCENT) declarations.push(`--cds-fill-accent-hover: ${shiftColor(hover, palette.blue[450], accent)};`);
    if (hasOnAccent && onAccent) declarations.push(`--cds-on-accent: ${onAccent};`);
    if (!declarations.length) continue;
    const css = `:is(${selector}):is(.cds-root.cds-root, .cds-dark-scope.cds-dark-scope) { ${declarations.join(' ')} }`;
    rules.push(conditions.reduceRight((body, condition) => `${condition} { ${body} }`, css));
  }
  if (brand !== CLAY) {
    const emphasized = shiftColor(clayEmphasized, CLAY, brand);
    const clay = `--cds-clay: ${brand}; --cds-clay-emphasized: ${emphasized};`;
    rules.push(
      `:root:root:root { --cds-hsl-clay: ${hslTriplet(brand)}; --cds-hsl-clay-emphasized: ${hslTriplet(emphasized)}; ${clay} }`,
      `.cds-root.cds-root.cds-root { ${clay} }`,
      '[fill="#d97757" i] { fill: var(--cds-clay); }',
      '[stroke="#d97757" i] { stroke: var(--cds-clay); }',
      '[stop-color="#d97757" i] { stop-color: var(--cds-clay); }',
      '.text-\\[\\#D97757\\].text-\\[\\#D97757\\] { color: var(--cds-clay); }',
      '.border-\\[\\#D97757\\].border-\\[\\#D97757\\] { border-color: var(--cds-clay); }',
      '.to-\\[\\#d97757\\].to-\\[\\#d97757\\] { --tw-gradient-to: var(--cds-clay); }',
      '.from-\\[\\#db6843\\].from-\\[\\#db6843\\] { --tw-gradient-from: var(--cds-clay-emphasized); }'
    );
  }
  return rules.join('\n');
}

const hex = value => {
  value = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(value)) value = '#' + [...value.slice(1)].map(digit => digit + digit).join('');
  return HEX.test(value) ? value : null;
};

function readPalette(style) {
  const palette = { blue: {}, gray: {} };
  for (const name of style) {
    const match = PALETTE_COLOR.exec(name);
    if (match) {
      const value = hex(style.getPropertyValue(name));
      if (value) palette[match[1]][match[2]] = value;
    }
  }
  return palette;
}

function readScales(document) {
  const found = { ...BUILT_IN, legacySelectors: [], themeRules: [] };
  const walk = (rules, conditions) => {
    for (const rule of rules) {
      if (rule.cssRules?.length) {
        const condition = rule.media ? `@media ${rule.media.mediaText}`
          : rule.constructor.name === 'CSSSupportsRule' ? `@supports ${rule.conditionText}` : null;
        walk(rule.cssRules, condition ? [...conditions, condition] : conditions);
      }
      const { selectorText: selector, style } = rule;
      if (!style || !selector || NAMED_THEME.test(selector)) continue;
      const isLegacy = FIZZY_COLOR.test(selector);
      if (!conditions.length && (isLegacy || selector.includes(':root')) &&
          hex(style.getPropertyValue('--cds-blue-450')) && hex(style.getPropertyValue('--cds-gray-450'))) {
        const palette = readPalette(style);
        if (isLegacy) {
          found.legacy = palette;
          found.legacySelectors.push(selector);
        } else {
          found.base = palette;
        }
      }
      if (!conditions.length && selector === ':root') {
        found.clayEmphasized = hex(style.getPropertyValue('--cds-clay-emphasized')) || found.clayEmphasized;
      }
      if (!CDS_SCOPE.test(selector)) continue;
      const surfaces = {};
      const hover = hex(style.getPropertyValue('--cds-fill-accent-hover'));
      const hasOnAccent = Boolean(hex(style.getPropertyValue('--cds-on-accent')));
      for (const name of style) {
        if (!SURFACE_COLOR.test(name)) continue;
        const value = hex(style.getPropertyValue(name));
        if (value) surfaces[name] = value;
      }
      if (hover || hasOnAccent || Object.keys(surfaces).length) found.themeRules.push({ selector, surfaces, hover, hasOnAccent, conditions, isLegacy });
    }
  };
  for (const sheet of document.styleSheets) {
    if (sheet.disabled || sheet.ownerNode?.hasAttribute('data-tamler-plugin')) continue;
    try {
      const media = sheet.media?.mediaText;
      walk(sheet.cssRules, media && media !== 'all' ? [`@media ${media}`] : []);
    } catch {}
  }
  return found;
}

const color = (value, fallback) => typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : fallback;

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

module.exports.start = ({ document, storage, addStyle, mount, observe, on, warn }) => {
  const style = addStyle('');
  let scales = readScales(document);
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
    if (options.brand !== CLAY && !stopMask) stopMask = mount('[data-cds="WorkingMark"] span[style*="background-image"]', maskSprite, { attributes: false });
    else if (options.brand === CLAY && stopMask) { stopMask(); stopMask = null; }
  }
  apply();
  storage.subscribe(apply);
  function updateScales() {
    scales = readScales(document);
    applied = null;
    apply();
  }
  const isStylesheet = node => node.matches?.('link[rel~="stylesheet"], style:not([data-tamler-plugin])');
  on(document, 'load', event => {
    if (isStylesheet(event.target)) updateScales();
  }, true);
  observe(document.head || document.documentElement, mutations => {
    if (mutations.some(({ target, addedNodes, removedNodes }) => isStylesheet(target) ||
        [...addedNodes, ...removedNodes].some(isStylesheet))) updateScales();
  }, { childList: true, subtree: true });
};

module.exports.buildCss = buildCss;
