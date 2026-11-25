// A small PNG reader for the tools (8-bit RGB or RGBA, not interlaced: what OpenCV and PIL write by default).
import fs from 'node:fs';
import zlib from 'node:zlib';
import type { OcrImage } from '../src/ppocr.ts';

/** 8-bit RGB/RGBA, non-interlaced PNG → RGBA. */
export function readPng(file: string): OcrImage {
  const b = fs.readFileSync(file);
  let p = 8, width = 0, height = 0, type = 0;
  const idat: Buffer[] = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), kind = b.toString('latin1', p + 4, p + 8), data = b.subarray(p + 8, p + 8 + len);
    if (kind === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); type = data[9]; if (data[8] !== 8 || data[12]) throw new Error('unsupported PNG'); }
    if (kind === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const bpp = type === 6 ? 4 : type === 2 ? 3 : 0;
  if (!bpp) throw new Error('unsupported PNG colour type ' + type);
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = width * bpp;
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0, up = y ? px[(y - 1) * stride + x] : 0, ul = y && x >= bpp ? px[(y - 1) * stride + x - bpp] : 0;
      const pa = Math.abs(up - ul), pb = Math.abs(a - ul), pc = Math.abs(a + up - 2 * ul);
      const pred = [0, a, up, (a + up) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? up : ul][f];
      px[y * stride + x] = (row[x] + pred) & 255;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) for (let k = 0; k < 4; k++) data[i * 4 + k] = k < bpp ? px[i * bpp + k] : 255;
  return { data, width, height };
}
