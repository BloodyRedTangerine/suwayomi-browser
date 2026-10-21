import { decodeBytes, encodeBytes } from './transport.mjs';

export const IMAGE_LIMITS = Object.freeze({ pixels: 8 * 1024 * 1024, encodedBytes: 16 * 1024 * 1024 });
export function validateDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > 65535 || height > 65535 || width * height > IMAGE_LIMITS.pixels) throw new Error('Image dimensions exceed browser bitmap limits');
  return { width, height };
}

/** Preflight common raster headers before asking the browser to allocate decoded pixels. */
export function inspectRaster(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start, length) => String.fromCharCode(...bytes.subarray(start, start + length));
  let width, height, mime;
  if (bytes.length >= 24 && bytes[0] === 137 && ascii(1, 7) === 'PNG\r\n\x1a\n' && ascii(12, 4) === 'IHDR') {
    width = view.getUint32(16); height = view.getUint32(20); mime = 'image/png';
  } else if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))) {
    width = view.getUint16(6, true); height = view.getUint16(8, true); mime = 'image/gif';
  } else if (bytes.length >= 25 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const kind = ascii(12, 4);
    if (kind === 'VP8X' && bytes.length >= 30) {
      width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    } else if (kind === 'VP8L' && bytes[20] === 47) {
      const packed = view.getUint32(21, true);
      width = (packed & 0x3fff) + 1; height = ((packed >>> 14) & 0x3fff) + 1;
    } else if (kind === 'VP8 ' && bytes.length >= 30 && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) {
      width = view.getUint16(26, true) & 0x3fff; height = view.getUint16(28, true) & 0x3fff;
    }
    mime = 'image/webp';
  } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 8) {
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5); mime = 'image/jpeg'; break;
      }
      offset += length;
    }
  }
  if (!mime || !width || !height) throw new Error('Invalid or unsupported raster image header');
  return { ...validateDimensions(width, height), mime };
}

export async function imageOperation(request, { binary } = {}) {
  if (request.action === 'layoutText') return renderTextLayout(request);
  const usesBinary = request.binary === true && typeof request.bodyFile === 'string';
  if (!usesBinary && (typeof request.body !== 'string' || request.body.length > Math.ceil(IMAGE_LIMITS.pixels * 4 / 3) * 4)) throw new Error('Image payload exceeds browser bitmap limits');
  if (usesBinary && !binary) throw new Error('Local binary image channel unavailable');
  const bytes = usesBinary ? binary.read(request.bodyFile, request.action === 'decode' ? IMAGE_LIMITS.encodedBytes : IMAGE_LIMITS.pixels * 4) : decodeBytes(request.body);
  const output = bytes => usesBinary ? { bodyFile: binary.write(bytes), byteLength: bytes.byteLength } : { body: encodeBytes(bytes) };
  if (request.action === 'decode') {
    if (bytes.length > IMAGE_LIMITS.encodedBytes) throw new Error('Encoded image exceeds 16 MiB');
    const info = inspectRaster(bytes);
    if (request.boundsOnly === true) return info;
    const image = await createImageBitmap(new Blob([bytes], { type: info.mime }), { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    try {
      if (image.width !== info.width || image.height !== info.height) throw new Error('Decoded dimensions differ from image header');
      const canvas = new OffscreenCanvas(info.width, info.height);
      const context = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
      if (!context) throw new Error('Browser 2D image context unavailable');
      context.drawImage(image, 0, 0);
      return { ...info, ...output(context.getImageData(0, 0, info.width, info.height).data) };
    } finally { image.close(); }
  }
  if (request.action !== 'encode') throw new Error('Unknown browser image operation');
  const { width, height } = validateDimensions(request.width, request.height);
  if (bytes.length !== width * height * 4) throw new Error('RGBA image byte count differs from dimensions');
  if (!Number.isInteger(request.quality) || request.quality < 0 || request.quality > 100) throw new Error('Invalid image encoding quality');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(request.mime)) throw new Error('Unsupported browser image encoding format');
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { colorSpace: 'srgb' });
  if (!context) throw new Error('Browser 2D image context unavailable');
  const data = context.createImageData(width, height); data.data.set(bytes); context.putImageData(data, 0, 0);
  const blob = await canvas.convertToBlob({ type: request.mime, quality: request.quality / 100 });
  if (blob.type !== request.mime) throw new Error('Browser codec substituted a different image format');
  if (blob.size > IMAGE_LIMITS.encodedBytes) throw new Error('Encoded image exceeds 16 MiB');
  return { mime: blob.type, ...output(new Uint8Array(await blob.arrayBuffer())) };
}

function renderTextLayout(request) {
  const text = request.text;
  if (typeof text !== 'string' || text.length > 1_000_000) throw new Error('Invalid browser text layout input');
  const width = request.width;
  if (!Number.isInteger(width) || width <= 0 || width > 8192) throw new Error('Invalid browser text layout width');
  const size = request.textSize;
  if (!Number.isFinite(size) || size <= 0 || size > 512) throw new Error('Invalid browser text size');
  if (![0, 1, 2, 3].includes(request.style) || ![0, 1, 2, 3, 4].includes(request.alignment)) throw new Error('Unsupported browser text style or alignment');
  const breakStrategy = request.breakStrategy ?? 0;
  const hyphenationFrequency = request.hyphenationFrequency ?? 0;
  if (![0, 1, 2].includes(breakStrategy) || ![0, 1, 2, 3, 4].includes(hyphenationFrequency)) throw new Error('Unsupported browser line-break options');
  const family = typeof request.family === 'string' && /^[\p{L}\p{N} _-]{1,80}$/u.test(request.family) ? request.family : 'sans-serif';
  const italic = (request.style & 2) !== 0;
  const bold = (request.style & 1) !== 0 || request.fakeBold === true;
  const context = new OffscreenCanvas(1, 1).getContext('2d');
  if (!context) throw new Error('Browser Canvas2D text renderer unavailable');
  context.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${size}px ${family}`;
  context.textBaseline = 'alphabetic';
  const metrics = context.measureText('Mg');
  const ascent = metrics.fontBoundingBoxAscent || metrics.actualBoundingBoxAscent || size * 0.8;
  const descent = metrics.fontBoundingBoxDescent || metrics.actualBoundingBoxDescent || size * 0.25;
  const scale = Number.isFinite(request.textScaleX) ? request.textScaleX : 1;
  const skew = Number.isFinite(request.textSkewX) ? request.textSkewX : 0;
  const spacingMultiplier = Number.isFinite(request.spacingMultiplier) && request.spacingMultiplier >= 0 ? request.spacingMultiplier : 1;
  const spacingExtra = Number.isFinite(request.spacingExtra) ? request.spacingExtra : 0;

  function measured(value) { return context.measureText(value).width * Math.abs(scale); }
  const boundaryBytes = Math.ceil((text.length + 1) / 8);
  function setBit(bytes, offset) { bytes[offset >>> 3] |= 1 << (offset & 7); }
  function hasBit(bytes, offset) { return (bytes[offset >>> 3] & (1 << (offset & 7))) !== 0; }
  function fallbackBoundaries(graphemes) {
    const bytes = new Uint8Array(boundaryBytes);
    setBit(bytes, 0); setBit(bytes, text.length);
    if (graphemes) {
      let offset = 0;
      for (const value of text) { offset += value.length; setBit(bytes, offset); }
    } else {
      for (const match of text.matchAll(/\s+|[-‐‑‒–—/]+/gu)) setBit(bytes, match.index + match[0].length);
    }
    return bytes;
  }
  function readBoundaries(encoded, label, graphemes) {
    if (typeof encoded !== 'string') return fallbackBoundaries(graphemes);
    const bytes = decodeBytes(encoded);
    if (bytes.length !== boundaryBytes || !hasBit(bytes, text.length)) throw new Error(`Invalid ${label} boundary data`);
    return bytes;
  }
  const lineBreaks = readBoundaries(request.lineBreaks, 'line-break', false);
  const graphemeBreaks = readBoundaries(request.graphemeBreaks, 'grapheme', true);
  function nextBoundary(bytes, from, to) {
    for (let offset = from + 1; offset < to; offset++) if (hasBit(bytes, offset)) return offset;
    return to;
  }
  function renderedLine(start, end) {
    return text.slice(start, end).replace(/\s+$/u, '');
  }
  function wrapGreedy(start, end) {
    if (start === end) return [{ text: '', start, end }];
    const lines = [];
    let cursor = start;
    while (cursor < end) {
      let best = cursor;
      let candidateEnd = cursor;
      while (candidateEnd < end) {
        const next = nextBoundary(lineBreaks, candidateEnd, end);
        if (measured(text.slice(cursor, next)) > width) break;
        best = next;
        candidateEnd = next;
      }
      if (best === cursor) {
        candidateEnd = cursor;
        while (candidateEnd < end) {
          const next = nextBoundary(graphemeBreaks, candidateEnd, end);
          if (measured(text.slice(cursor, next)) > width && candidateEnd > cursor) break;
          best = next;
          candidateEnd = next;
        }
        if (best === cursor) best = nextBoundary(graphemeBreaks, cursor, end);
      }
      lines.push({ text: renderedLine(cursor, best), start: cursor, end: best });
      if (lines.length > 8192) throw new Error('Text layout exceeds browser line limits');
      cursor = best;
    }
    return lines;
  }
  function wrapOptimized(start, end) {
    if (start === end) return [{ text: '', start, end }];
    const units = [];
    let cursor = start;
    while (cursor < end) {
      const next = nextBoundary(lineBreaks, cursor, end);
      units.push({ start: cursor, end: next });
      if (units.length > 256) return null;
      cursor = next;
    }
    if (units.some(unit => measured(text.slice(unit.start, unit.end)) > width)) return null;

    const costs = new Float64Array(units.length + 1);
    costs.fill(Number.POSITIVE_INFINITY);
    costs[units.length] = 0;
    const nextUnits = new Int32Array(units.length);
    nextUnits.fill(-1);
    for (let startUnit = units.length - 1; startUnit >= 0; startUnit--) {
      let lineText = '';
      for (let endUnit = startUnit; endUnit < units.length && endUnit - startUnit < 128; endUnit++) {
        lineText += text.slice(units[endUnit].start, units[endUnit].end);
        const lineWidth = measured(lineText);
        if (lineWidth > width) break;
        const slack = (width - lineWidth) / width;
        const finalLine = endUnit === units.length - 1;
        let lineCost = breakStrategy === 2 ? slack * slack : slack * slack * slack;
        if (breakStrategy === 1 && finalLine) lineCost *= 0.05;
        // Avoid choosing a break immediately after a visible hyphen unless the
        // paragraph width makes it necessary.
        if (!finalLine && /[-‐‑‒–—]$/u.test(lineText)) lineCost += 0.15;
        const candidate = lineCost + costs[endUnit + 1];
        if (candidate < costs[startUnit]) {
          costs[startUnit] = candidate;
          nextUnits[startUnit] = endUnit + 1;
        }
      }
      if (nextUnits[startUnit] < 0) return null;
    }
    const lines = [];
    for (let unit = 0; unit < units.length;) {
      const next = nextUnits[unit];
      const lineStart = units[unit].start;
      const lineEnd = units[next - 1].end;
      lines.push({ text: renderedLine(lineStart, lineEnd), start: lineStart, end: lineEnd });
      unit = next;
    }
    return lines;
  }
  function wrapParagraph(start, end) {
    return breakStrategy === 0 ? wrapGreedy(start, end) : (wrapOptimized(start, end) || wrapGreedy(start, end));
  }
  const lines = [];
  let paragraphStart = 0;
  while (true) {
    let paragraphEnd = paragraphStart;
    while (paragraphEnd < text.length && text[paragraphEnd] !== '\n' && text[paragraphEnd] !== '\r') paragraphEnd++;
    const paragraphLines = wrapParagraph(paragraphStart, paragraphEnd);
    if (paragraphLines.length === 0) paragraphLines.push({ text: '', start: paragraphStart, end: paragraphEnd });
    lines.push(...paragraphLines);
    if (lines.length > 8192) throw new Error('Text layout exceeds browser line limits');
    if (paragraphEnd === text.length) break;
    let nextParagraph = paragraphEnd + 1;
    if (text[paragraphEnd] === '\r' && text[nextParagraph] === '\n') nextParagraph++;
    lines[lines.length - 1].end = nextParagraph;
    paragraphStart = nextParagraph;
    if (paragraphStart === text.length) {
      lines.push({ text: '', start: paragraphStart, end: paragraphStart });
      break;
    }
  }
  const includePad = request.includePad === true;
  const verticalPad = includePad ? Math.max(0, Math.ceil(size * 0.12)) : 0;
  const lineAdvance = Math.max(1, Math.ceil((ascent + descent) * spacingMultiplier + spacingExtra));
  const height = lines.length ? Math.max(1, verticalPad * 2 + Math.ceil(ascent + descent) + (lines.length - 1) * lineAdvance) : 1;
  validateDimensions(width, height);
  const canvas = new OffscreenCanvas(width, height);
  const output = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  if (!output) throw new Error('Browser Canvas2D text renderer unavailable');
  const color = Number(request.color) >>> 0;
  const alpha = (color >>> 24) & 255;
  output.fillStyle = `rgba(${(color >>> 16) & 255},${(color >>> 8) & 255},${color & 255},${alpha / 255})`;
  output.font = context.font;
  output.textBaseline = 'alphabetic';
  output.save();
  output.transform(scale, 0, skew, 1, 0, 0);
  lines.forEach((line, index) => {
    const lineWidth = measured(line.text);
    const alignment = request.alignment;
    let x = alignment === 2 ? (width - lineWidth) / 2 : (alignment === 1 || alignment === 4) ? width - lineWidth : 0;
    if (scale < 0) x = width - x;
    const baseline = verticalPad + ascent + index * lineAdvance;
    output.fillText(line.text, x, baseline);
    if (request.underline || request.strike) {
      const lineY = baseline + (request.underline ? Math.max(1, descent * 0.35) : -ascent * 0.35);
      output.fillRect(x, lineY, lineWidth, Math.max(1, size / 16));
    }
  });
  output.restore();
  return {
    width,
    height,
    lines: lines.length,
    lineEnds: lines.map(line => line.end),
    lineWidths: lines.map(line => measured(line.text)),
    body: encodeBytes(output.getImageData(0, 0, width, height).data),
  };
}
