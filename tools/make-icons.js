#!/usr/bin/env node
// Generates the PWA/home-screen icons as plain PNGs using only Node's
// built-in zlib — no image library to install, no build step. Run with:
//   node tools/make-icons.js
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [180, 192, 512]; // apple-touch-icon, manifest, manifest
const OUT_DIR = path.join(__dirname, '..', 'icons');
const BG = [0x00, 0x7a, 0xff]; // --primary
const FG = [0xff, 0xff, 0xff];

// --- Minimal PNG encoder ---------------------------------------------------
// A PNG is a signature, then a series of length-prefixed, CRC-checked chunks.
// For an 8-bit RGBA image the only chunks needed are IHDR (dimensions),
// IDAT (zlib-deflated pixel data, one leading filter-type byte per scanline —
// 0 for "no filter" keeps this simple), and IEND.

function crc32(buf) {
    let crc = ~0;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let bit = 0; bit < 8; bit++) {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }
    return ~crc >>> 0;
}

function chunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(size, rgba) {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0); // width
    ihdr.writeUInt32BE(size, 4); // height
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // color type: truecolor + alpha
    // bytes 10-12 (compression, filter, interlace) stay 0

    const stride = size * 4;
    const raw = Buffer.alloc((stride + 1) * size);
    for (let y = 0; y < size; y++) {
        const rowStart = y * (stride + 1);
        raw[rowStart] = 0; // filter type: none
        rgba.copy(raw, rowStart + 1, y * stride, y * stride + stride);
    }

    const idat = zlib.deflateSync(raw, { level: 9 });

    return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// --- Icon artwork -----------------------------------------------------------

/** A dumbbell: two round plates joined by a thin bar — ●━━━● rather than
 *  rectangular blocks, which at these proportions just read as a letter H.
 *  Plain circles/rects need no anti-aliasing to stay crisp at 180px. iOS
 *  applies its own corner mask, so the background is left a plain square. */
function drawIcon(size) {
    const rgba = Buffer.alloc(size * size * 4);

    const setPixel = (x, y, [r, g, b]) => {
        const i = (y * size + x) * 4;
        rgba[i] = r;
        rgba[i + 1] = g;
        rgba[i + 2] = b;
        rgba[i + 3] = 255;
    };

    const fillRect = (x0, y0, x1, y1, color) => {
        const xStart = Math.max(0, Math.round(x0));
        const xEnd = Math.min(size, Math.round(x1));
        const yStart = Math.max(0, Math.round(y0));
        const yEnd = Math.min(size, Math.round(y1));
        for (let y = yStart; y < yEnd; y++) {
            for (let x = xStart; x < xEnd; x++) setPixel(x, y, color);
        }
    };

    const fillCircle = (cx, cy, r, color) => {
        const xStart = Math.max(0, Math.round(cx - r));
        const xEnd = Math.min(size, Math.round(cx + r));
        const yStart = Math.max(0, Math.round(cy - r));
        const yEnd = Math.min(size, Math.round(cy + r));
        const rSquared = r * r;
        for (let y = yStart; y < yEnd; y++) {
            for (let x = xStart; x < xEnd; x++) {
                const dx = x + 0.5 - cx;
                const dy = y + 0.5 - cy;
                if (dx * dx + dy * dy <= rSquared) setPixel(x, y, color);
            }
        }
    };

    fillRect(0, 0, size, size, BG);

    const mid = size / 2;
    const plateRadius = size * 0.17;
    const plateInset = size * 0.235;

    fillRect(size * 0.3, mid - size * 0.045, size * 0.7, mid + size * 0.045, FG);
    fillCircle(plateInset, mid, plateRadius, FG);
    fillCircle(size - plateInset, mid, plateRadius, FG);

    return rgba;
}

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const size of SIZES) {
    const png = encodePng(size, drawIcon(size));
    const file = path.join(OUT_DIR, `icon-${size}.png`);
    fs.writeFileSync(file, png);
    console.log(`Wrote ${path.relative(process.cwd(), file)} (${png.length} bytes)`);
}
