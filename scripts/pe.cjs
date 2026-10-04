const fs = require('node:fs');

function readPe(path) {
  const buffer = fs.readFileSync(path);
  if (buffer.toString('ascii', 0, 2) !== 'MZ') throw new Error('Not a PE executable');
  const pe = buffer.readUInt32LE(60);
  const optional = pe + 24;
  const directories = optional + (buffer.readUInt16LE(optional) === 523 ? 112 : 96);
  const sections = [];
  for (let i = 0; i < buffer.readUInt16LE(pe + 6); i++) {
    const offset = optional + buffer.readUInt16LE(pe + 20) + i * 40;
    sections.push({
      address: buffer.readUInt32LE(offset + 12),
      size: Math.max(buffer.readUInt32LE(offset + 8), buffer.readUInt32LE(offset + 16)),
      offset: buffer.readUInt32LE(offset + 20)
    });
  }
  const offsetOf = address => {
    const section = sections.find(entry => address >= entry.address && address < entry.address + entry.size);
    if (!section) throw new Error(`Invalid RVA: ${address}`);
    return section.offset + address - section.address;
  };
  const stringAt = address => {
    const offset = offsetOf(address);
    return buffer.toString('ascii', offset, buffer.indexOf(0, offset));
  };
  const exports = [];
  const imports = [];
  const delayAddress = buffer.readUInt32LE(directories + 13 * 8);
  if (delayAddress) {
    for (let table = offsetOf(delayAddress); buffer.readUInt32LE(table + 4); table += 32) {
      if (!(buffer.readUInt32LE(table) & 1)) throw new Error('Unsupported delay import format');
      const dll = stringAt(buffer.readUInt32LE(table + 4));
      const names = offsetOf(buffer.readUInt32LE(table + 16));
      const stride = buffer.readUInt16LE(optional) === 523 ? 8 : 4;
      for (let i = 0; ; i++) {
        const value = stride === 8 ? buffer.readBigUInt64LE(names + i * stride) : BigInt(buffer.readUInt32LE(names + i * stride));
        if (!value) break;
        if (value & (1n << BigInt(stride * 8 - 1))) imports.push({ dll, ordinal: Number(value & 65535n) });
        else imports.push({ dll, name: stringAt(Number(value) + 2) });
      }
    }
  }
  const exportAddress = buffer.readUInt32LE(directories);
  if (exportAddress) {
    const table = offsetOf(exportAddress);
    const names = offsetOf(buffer.readUInt32LE(table + 32));
    for (let i = 0; i < buffer.readUInt32LE(table + 24); i++) exports.push(stringAt(buffer.readUInt32LE(names + i * 4)));
  }
  const sentinel = buffer.indexOf('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
  const fuses = sentinel < 0 ? null : {
    schema: buffer[sentinel + 32],
    states: buffer.toString('ascii', sentinel + 34, sentinel + 34 + buffer[sentinel + 33])
  };
  return { machine: buffer.readUInt16LE(pe + 4), exports, imports, fuses };
}

module.exports = { readPe };
