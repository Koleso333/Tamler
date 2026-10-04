const { HEX, shiftScale, tintScale, shiftColor, hslTriplet, lightness } = require('./color');

// Исходные шкалы Claude Design System (сборка aa6da7d0d3): :where(:root) { --cds-gray-*, --cds-blue-* }.
const STEPS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 150, 200, 250, 300, 350, 400, 450, 500, 550, 600, 650, 700, 750, 800, 810, 820, 830, 840, 850, 860, 870, 880, 890, 900];
const scale = colors => Object.fromEntries(STEPS.map((step, index) => [step, colors[index]]));
const GRAY = scale(['#ffffff', '#fcfcfb', '#f9f9f7', '#f6f6f4', '#f3f3f0', '#f0efec', '#edece8', '#eae9e4', '#e7e6e1', '#e4e3dd', '#e1e0d9', '#d2d1c7', '#c3c2b7', '#b4b3a8', '#a5a49a', '#97958d', '#898781', '#7b7974', '#6d6b67', '#5f5e5a', '#52514e', '#454442', '#383835', '#2c2c2a', '#20201f', '#1e1e1d', '#1c1c1b', '#1a1a19', '#181817', '#151515', '#131313', '#111111', '#0f0f0f', '#0d0d0d', '#0b0b0b']);
const BLUE = scale(['#ffffff', '#fafcff', '#f5f9fe', '#f0f7fe', '#ebf4fc', '#e7f1fb', '#e2eefa', '#ddebfa', '#d7e8fa', '#d2e5fa', '#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b', '#062b57', '#032042', '#031e3d', '#021c39', '#021a36', '#021831', '#03162c', '#051426', '#07121f', '#091018', '#0a0d11', '#0b0b0b']);
const ACCENT = BLUE[450];
const CLAY = '#d97757';
const CLAY_EMPHASIZED = '#c6613f';

// Акцент Claude — это шкала --cds-blue-*: от неё считаются --cds-role-accent-*, а через --cds-hsl-blue-* и старые --accent-*.
// Палитра объявлена на :root с низкой специфичностью, поэтому :root:root:root перекрывает её без !important,
// а вложенные .cds-root наследуют уже пересчитанные значения.
function buildCss({ accent, brand, tint }) {
  const vars = [];
  const clay = [];
  if (accent !== ACCENT) {
    const blue = shiftScale(BLUE, 450, accent);
    for (const step of STEPS) vars.push(`--cds-blue-${step}: ${blue[step]};`, `--cds-hsl-blue-${step}: ${hslTriplet(blue[step])};`);
    // Белый текст на светлом акценте (жёлтый, мятный) не читается.
    if (lightness(accent) > 0.72) vars.push(`--cds-role-accent-on: ${GRAY[900]};`);
  }
  if (tint > 0) {
    const gray = tintScale(GRAY, accent, tint / 100);
    for (const step of STEPS) vars.push(`--cds-gray-${step}: ${gray[step]};`, `--cds-hsl-gray-${step}: ${hslTriplet(gray[step])};`);
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
    clay.length ? `.cds-root.cds-root.cds-root { ${clay.join(' ')} }` : '',
    ...rules
  ].filter(Boolean).join('\n');
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

module.exports.start = ({ storage, addStyle, mount, warn }) => {
  const style = addStyle('');
  let applied = null;
  let stopMask = null;
  function apply() {
    const tint = Number(storage.get('tint'));
    const options = { accent: color(storage.get('accent'), ACCENT), brand: color(storage.get('brand'), CLAY), tint: Number.isFinite(tint) ? Math.min(100, Math.max(0, tint)) : 0 };
    const key = JSON.stringify(options);
    if (key === applied) return;
    applied = key;
    try { style.textContent = buildCss(options); }
    catch (error) { style.textContent = ''; warn('palette failed', error); }
    // Атрибуты не отслеживаются: style спрайта меняется каждый кадр анимации, а на совпадение селектора это не влияет.
    if (options.brand !== CLAY && !stopMask) stopMask = mount('[data-cds="WorkingMark"] span[style*="background-image"]', maskSprite, { attributes: false });
    else if (options.brand === CLAY && stopMask) { stopMask(); stopMask = null; }
  }
  apply();
  storage.subscribe(apply);
};

module.exports.buildCss = buildCss;
