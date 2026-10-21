// JVM Strings contain UTF-16 code units, including lone surrogates. The native
// creation ABI accepts modified UTF-8, not the scalar-value UTF-8 of TextEncoder.
export function encodeModifiedUtf8(value) {
  let length = 0;
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    length += unit > 0 && unit < 0x80 ? 1 : unit <= 0x7ff ? 2 : 3;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit > 0 && unit < 0x80) bytes[offset++] = unit;
    else if (unit <= 0x7ff) {
      bytes[offset++] = 0xc0 | (unit >>> 6);
      bytes[offset++] = 0x80 | (unit & 0x3f);
    } else {
      bytes[offset++] = 0xe0 | (unit >>> 12);
      bytes[offset++] = 0x80 | ((unit >>> 6) & 0x3f);
      bytes[offset++] = 0x80 | (unit & 0x3f);
    }
  }
  return bytes;
}

export function decodeCompactString(bytes, coder) {
  if (coder !== 0 && coder !== 1) throw new Error('Invalid Java compact-string coder');
  if (coder === 1 && bytes.length % 2) throw new Error('Odd Java UTF-16 byte count');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = coder === 0 ? bytes.length : bytes.length / 2;
  const parts = [];
  for (let offset = 0; offset < size; offset += 8192) {
    const count = Math.min(8192, size - offset), units = new Array(count);
    for (let i = 0; i < count; i++) units[i] = coder === 0 ? bytes[offset + i] : view.getUint16((offset + i) * 2, true);
    parts.push(String.fromCharCode(...units));
  }
  return parts.join('');
}
