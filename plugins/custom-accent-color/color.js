// Преобразования sRGB ↔ OKLab/OKLCH и сдвиг палитры Claude к выбранному цвету.

const HEX = /^#[0-9a-f]{6}$/i;

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => v / 255);
}

function rgbToHex(rgb) {
  return '#' + rgb.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
}

const toLinear = v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const toGamma = v => v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;

function rgbToOklab([r, g, b]) {
  [r, g, b] = [r, g, b].map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ];
}

function oklabToRgb([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ].map(toGamma);
}

function toOklch(hex) {
  const [L, a, b] = rgbToOklab(hexToRgb(hex));
  return [L, Math.hypot(a, b), Math.atan2(b, a)];
}

const inGamut = rgb => rgb.every(v => v >= -0.0005 && v <= 1.0005);

// Цвет вне sRGB приводится уменьшением насыщенности при той же светлоте и оттенке.
function fromOklch(L, C, H) {
  L = Math.min(1, Math.max(0, L));
  let rgb = oklabToRgb([L, C * Math.cos(H), C * Math.sin(H)]);
  if (inGamut(rgb)) return rgbToHex(rgb);
  let low = 0;
  let high = C;
  for (let i = 0; i < 24; i++) {
    const mid = (low + high) / 2;
    if (inGamut(oklabToRgb([L, mid * Math.cos(H), mid * Math.sin(H)]))) low = mid; else high = mid;
  }
  return rgbToHex(oklabToRgb([L, low * Math.cos(H), low * Math.sin(H)]));
}

// Шкала Claude сдвигается так, чтобы базовая ступень стала выбранным цветом.
// Светлота смещается сильнее у базовой ступени и не меняется у белого и чёрного концов: шкала остаётся монотонной.
function shiftScale(scale, baseKey, target) {
  const [Lb, Cb, Hb] = toOklch(scale[baseKey]);
  const [Lt, Ct, Ht] = toOklch(target);
  const dL = Lt - Lb;
  const ratio = Cb > 0 ? Ct / Cb : 0;
  const result = {};
  for (const [key, hex] of Object.entries(scale)) {
    if (key === baseKey) { result[key] = target.toLowerCase(); continue; }
    const [L, C, H] = toOklch(hex);
    const weight = L <= Lb ? L / Lb : (1 - L) / (1 - Lb);
    // У почти серых выбранных цветов исходный оттенок не важен, но шкала не должна получить случайный.
    result[key] = fromOklch(L + dL * weight, C * ratio, Ct < 0.002 ? H : H + (Ht - Hb));
  }
  return result;
}

// Подмешивает оттенок к серым: середина шкалы окрашивается сильнее, белый и чёрный почти не меняются.
function tintScale(scale, target, amount) {
  if (!amount) return { ...scale };
  const [, , H] = toOklch(target);
  const result = {};
  for (const [key, hex] of Object.entries(scale)) {
    const [L, a, b] = rgbToOklab(hexToRgb(hex));
    const strength = 0.045 * (1 - (2 * L - 1) ** 2) * amount;
    result[key] = rgbToHex(oklabToRgb([L, a * (1 - amount) + Math.cos(H) * strength, b * (1 - amount) + Math.sin(H) * strength]));
  }
  return result;
}

// Формат старых переменных Claude: «H S% L%» для hsl(var(--x)).
function hslTriplet(hex) {
  const [r, g, b] = hexToRgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  const round = v => Math.round(v * 1000) / 1000;
  return `${round(h)} ${round(s * 100)}% ${round(l * 100)}%`;
}

// Пересчёт с заменой оттенка и насыщенности: так из оранжевого Claude получается его «emphasized»-пара для любого цвета.
function shiftColor(hex, from, to) {
  const [L, C, H] = toOklch(hex);
  const [Lf, Cf, Hf] = toOklch(from);
  const [Lt, Ct, Ht] = toOklch(to);
  return fromOklch(L + (Lt - Lf), Cf > 0 ? C * Ct / Cf : 0, H + (Ht - Hf));
}

const lightness = hex => toOklch(hex)[0];

module.exports = { HEX, shiftScale, tintScale, shiftColor, hslTriplet, lightness };
