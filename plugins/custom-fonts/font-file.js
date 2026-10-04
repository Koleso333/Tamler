// Семейство, насыщенность и начертание шрифтового файла.
// TTF/OTF и WOFF читаются по таблицам name, OS/2 и fvar; WOFF2 сжат Brotli, для него — разбор имени файла.

const WEIGHTS = { thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300, regular: 400, normal: 400, book: 400, medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900 };

function fromFileName(name) {
  let base = name.replace(/\.[^.]+$/, '');
  const variable = /variablefont|\[[^\]]*wght[^\]]*\]|-vf$/i.test(base);
  base = base.replace(/[-_ ]?(variablefont[^-]*|\[[^\]]*\]|vf)$/i, '');
  let weight = 400;
  let italic = false;
  const match = /^(.*?)[-_ ]((?:thin|hairline|extra ?light|ultra ?light|light|regular|normal|book|medium|semi ?bold|demi ?bold|bold|extra ?bold|ultra ?bold|black|heavy)?(?:italic|oblique)?)$/i.exec(base);
  if (match && match[2]) {
    base = match[1];
    const token = match[2].toLowerCase().replace(/\s/g, '');
    italic = /italic|oblique/.test(token);
    weight = WEIGHTS[token.replace(/italic|oblique/, '')] || 400;
  }
  return { family: base.replace(/[_]+/g, ' ').trim() || name, weight: variable ? '100 900' : String(weight), style: italic ? 'italic' : 'normal' };
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Таблицы шрифта: для WOFF распаковываются по отдельности.
async function tables(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = view.getUint32(0);
  const result = {};
  if (signature === 0x774f4646) {
    const count = view.getUint16(12);
    for (let index = 0; index < count; index++) {
      const at = 44 + index * 20;
      const tag = String.fromCharCode(...bytes.subarray(at, at + 4));
      const offset = view.getUint32(at + 4);
      const compressed = view.getUint32(at + 8);
      const length = view.getUint32(at + 12);
      if (!['name', 'OS/2', 'fvar'].includes(tag)) continue;
      const data = bytes.subarray(offset, offset + compressed);
      result[tag] = compressed < length ? await inflate(data) : data;
    }
    return result;
  }
  if (signature !== 0x00010000 && signature !== 0x4f54544f && signature !== 0x74727565) return null;
  const count = view.getUint16(4);
  for (let index = 0; index < count; index++) {
    const at = 12 + index * 16;
    const tag = String.fromCharCode(...bytes.subarray(at, at + 4));
    result[tag] = bytes.subarray(view.getUint32(at + 8), view.getUint32(at + 8) + view.getUint32(at + 12));
  }
  return result;
}

function readName(table) {
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const count = view.getUint16(2);
  const storage = view.getUint16(4);
  const records = [];
  for (let index = 0; index < count; index++) {
    const at = 6 + index * 12;
    records.push({ platform: view.getUint16(at), language: view.getUint16(at + 4), id: view.getUint16(at + 6), length: view.getUint16(at + 8), offset: view.getUint16(at + 10) });
  }
  const decode = record => {
    const data = table.subarray(storage + record.offset, storage + record.offset + record.length);
    if (record.platform === 3 || record.platform === 0) {
      let text = '';
      for (let index = 0; index + 1 < data.length; index += 2) text += String.fromCharCode((data[index] << 8) | data[index + 1]);
      return text;
    }
    return String.fromCharCode(...data);
  };
  // Типографское семейство (16) объединяет Regular/Bold/Light; старое (1) — запасной вариант.
  for (const id of [16, 1]) {
    const candidates = records.filter(record => record.id === id);
    const best = candidates.find(record => record.platform === 3 && record.language === 0x409) || candidates.find(record => record.platform === 3 || record.platform === 0) || candidates[0];
    if (best) return decode(best).trim();
  }
  return '';
}

async function describeFont(name, buffer) {
  const fallback = fromFileName(name);
  try {
    const found = await tables(new Uint8Array(buffer));
    if (!found?.name) return fallback;
    const family = readName(found.name) || fallback.family;
    let weight = fallback.weight;
    let style = fallback.style;
    if (found['OS/2']?.length >= 64) {
      const view = new DataView(found['OS/2'].buffer, found['OS/2'].byteOffset, found['OS/2'].byteLength);
      weight = String(view.getUint16(4) || 400);
      style = view.getUint16(62) & 1 ? 'italic' : 'normal';
    }
    if (found.fvar) {
      const view = new DataView(found.fvar.buffer, found.fvar.byteOffset, found.fvar.byteLength);
      const offset = view.getUint16(4);
      const count = view.getUint16(8);
      const size = view.getUint16(10);
      for (let index = 0; index < count; index++) {
        const at = offset + index * size;
        if (String.fromCharCode(...found.fvar.subarray(at, at + 4)) !== 'wght') continue;
        weight = `${Math.round(view.getInt32(at + 4) / 65536)} ${Math.round(view.getInt32(at + 12) / 65536)}`;
      }
    }
    return { family, weight, style };
  } catch { return fallback; }
}

module.exports = { describeFont, fromFileName };
