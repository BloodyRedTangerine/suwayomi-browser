// Minimal deterministic ZIP writer: sorted entries, one fixed timestamp, no extra fields, no attributes.
// Used for jdk23.jar and for the release archives, so identical inputs give identical bytes on any machine/time zone.
import { deflateRawSync, crc32 } from 'node:zlib';

function dosDateTime(epochSeconds) {
  const date = new Date(Math.max(epochSeconds, 315532800) * 1000); // UTC fields only: independent of TZ
  const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
  const day = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { time, day };
}

/**
 * @param {Array<{name: string, data: Uint8Array}>} entries
 * @param {{epochSeconds: number, level?: number}} options
 * @returns {Buffer}
 */
export function createZip(entries, { epochSeconds, level = 6 }) {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const names = new Set();
  const { time, day } = dosDateTime(epochSeconds);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of sorted) {
    if (names.has(entry.name)) throw new Error('Duplicate ZIP entry: ' + entry.name);
    names.add(entry.name);
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength);
    const deflated = level === 0 ? data : deflateRawSync(data, { level });
    const useDeflate = level !== 0 && deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);
    const utf8Flag = /^[\x20-\x7e]*$/.test(entry.name) ? 0 : 0x0800;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(utf8Flag, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(day, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(utf8Flag, 8);
    central.writeUInt16LE(method, 10); central.writeUInt16LE(time, 12); central.writeUInt16LE(day, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  if (offset > 0xfffffff0 || sorted.length >= 0xffff) throw new Error('ZIP64 is not supported by this writer');
  const centralSize = centrals.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(sorted.length, 8); end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}
