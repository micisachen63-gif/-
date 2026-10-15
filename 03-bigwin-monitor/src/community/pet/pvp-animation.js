import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import gifenc from 'gifenc';
import pngjs from 'pngjs';
import jpeg from 'jpeg-js';

const { GIFEncoder, applyPalette, quantize } = gifenc;
const { PNG } = pngjs;
const { decode: decodeJpeg } = jpeg;
const ASSET_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../cloudflare/public/assets/stages');
const WIDTH = 560;
const HEIGHT = 360;
const FRAME_DELAY = 240;
const imageCache = new Map();

function clampStage(stage) {
  return ['young', 'growing', 'mature', 'complete'].includes(stage) ? stage : 'young';
}

async function loadPetImage(product, stage) {
  const key = `${product}:${stage}`;
  if (!imageCache.has(key)) {
    imageCache.set(key, fs.readFile(path.join(ASSET_DIR, `${product}_${clampStage(stage)}.png`)).then((bytes) => (
      bytes[0] === 0xff && bytes[1] === 0xd8 ? decodeJpeg(bytes, { useTArray: true }) : PNG.sync.read(bytes)
    )));
  }
  return imageCache.get(key);
}

const insideRoundRect = (x, y, left, top, width, height, radius) => {
  const cx = Math.max(left + radius, Math.min(x, left + width - radius));
  const cy = Math.max(top + radius, Math.min(y, top + height - radius));
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
};

function blendPixel(canvas, x, y, color, opacity = 1) {
  if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
  const i = (Math.floor(y) * WIDTH + Math.floor(x)) * 4;
  const alpha = Math.max(0, Math.min(1, opacity * (color[3] ?? 255) / 255));
  canvas[i] = canvas[i] * (1 - alpha) + color[0] * alpha;
  canvas[i + 1] = canvas[i + 1] * (1 - alpha) + color[1] * alpha;
  canvas[i + 2] = canvas[i + 2] * (1 - alpha) + color[2] * alpha;
  canvas[i + 3] = 255;
}

function roundedRect(canvas, left, top, width, height, radius, color) {
  const x0 = Math.max(0, Math.floor(left)); const y0 = Math.max(0, Math.floor(top));
  const x1 = Math.min(WIDTH, Math.ceil(left + width)); const y1 = Math.min(HEIGHT, Math.ceil(top + height));
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (insideRoundRect(x + 0.5, y + 0.5, left, top, width, height, radius)) blendPixel(canvas, x, y, color);
  }
}

function drawImage(canvas, image, { x, y, width, height, clip, flipX = false }) {
  const x0 = Math.max(clip.x, Math.floor(x)); const y0 = Math.max(clip.y, Math.floor(y));
  const x1 = Math.min(clip.x + clip.width, Math.ceil(x + width)); const y1 = Math.min(clip.y + clip.height, Math.ceil(y + height));
  const sxScale = image.width / width; const syScale = image.height / height;
  for (let dy = y0; dy < y1; dy++) {
    const sy = Math.min(image.height - 1, Math.max(0, Math.floor((dy + 0.5 - y) * syScale)));
    for (let dx = x0; dx < x1; dx++) {
      if (!insideRoundRect(dx + 0.5, dy + 0.5, clip.x, clip.y, clip.width, clip.height, clip.radius)) continue;
      let sx = Math.min(image.width - 1, Math.max(0, Math.floor((dx + 0.5 - x) * sxScale)));
      if (flipX) sx = image.width - 1 - sx;
      const src = (sy * image.width + sx) * 4;
      const dst = (dy * WIDTH + dx) * 4;
      const a = image.data[src + 3] / 255;
      canvas[dst] = image.data[src] * a + canvas[dst] * (1 - a);
      canvas[dst + 1] = image.data[src + 1] * a + canvas[dst + 1] * (1 - a);
      canvas[dst + 2] = image.data[src + 2] * a + canvas[dst + 2] * (1 - a);
      canvas[dst + 3] = 255;
    }
  }
}

// Transparent cut-out art keeps its aspect ratio and stands on the arena floor;
// legacy opaque paintings keep the original overscan fill.
function fitFighter(image, box) {
  const last = (image.width * image.height - 1) * 4 + 3;
  if (image.data[3] === 255 && image.data[last] === 255) return box;
  const floorGap = 16;
  const s = Math.min(box.width / image.width, (box.height - floorGap) / image.height);
  const width = image.width * s; const height = image.height * s;
  return { x: box.x + (box.width - width) / 2, y: box.y + box.height - floorGap - height, width, height };
}

function line(canvas, x1, y1, x2, y2, color, thickness = 2, opacity = 1) {
  const dx = x2 - x1; const dy = y2 - y1; const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)));
  for (let i = 0; i <= steps; i++) {
    const x = x1 + dx * i / Math.max(1, steps); const y = y1 + dy * i / Math.max(1, steps);
    for (let oy = -thickness; oy <= thickness; oy++) for (let ox = -thickness; ox <= thickness; ox++) {
      if (ox * ox + oy * oy <= thickness * thickness) blendPixel(canvas, x + ox, y + oy, color, opacity);
    }
  }
}

function circle(canvas, cx, cy, radius, color, opacity = 1, stroke = 0) {
  const r = radius + stroke;
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    if (stroke ? d >= radius - stroke && d <= radius + stroke : d <= radius) blendPixel(canvas, x, y, color, opacity);
  }
}

function sparkle(canvas, cx, cy, size, color) {
  line(canvas, cx, cy - size, cx, cy + size, color, 2);
  line(canvas, cx - size, cy, cx + size, cy, color, 2);
  line(canvas, cx - size * 0.55, cy - size * 0.55, cx + size * 0.55, cy + size * 0.55, color, 1);
  line(canvas, cx + size * 0.55, cy - size * 0.55, cx - size * 0.55, cy + size * 0.55, color, 1);
}

function createFrame({ aImage, bImage, roundIndex, phase, attackSide, winner, finalFrame }) {
  const canvas = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    const t = y / HEIGHT;
    const c = [255 - t * 13, 243 - t * 10, 224 + t * 17, 255];
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4;
      canvas[i] = c[0]; canvas[i + 1] = c[1]; canvas[i + 2] = c[2]; canvas[i + 3] = 255;
    }
  }
  circle(canvas, 280, 185, 108, [255, 207, 105], 0.11);
  roundedRect(canvas, 14, 15, 250, 321, 32, [255, 225, 184, 255]);
  roundedRect(canvas, 296, 15, 250, 321, 32, [226, 214, 249, 255]);

  const aLunge = attackSide === 'a' && phase === 1 ? 23 : attackSide === 'a' && phase === 2 ? 11 : 0;
  const bLunge = attackSide === 'b' && phase === 1 ? -23 : attackSide === 'b' && phase === 2 ? -11 : 0;
  const aRecoil = attackSide === 'b' && phase === 2 ? -9 : 0;
  const bRecoil = attackSide === 'a' && phase === 2 ? 9 : 0;
  const bob = Math.sin((roundIndex * 3 + phase) * 1.2) * 3;
  const clipA = { x: 14, y: 15, width: 250, height: 321, radius: 32 };
  const clipB = { x: 296, y: 15, width: 250, height: 321, radius: 32 };
  // Overscan lets the fighters lunge inside their arena without exposing empty strips.
  drawImage(canvas, aImage, { ...fitFighter(aImage, { x: 8 + aLunge + aRecoil, y: 8 + bob, width: 262, height: 335 }), clip: clipA });
  drawImage(canvas, bImage, { ...fitFighter(bImage, { x: 290 + bLunge + bRecoil, y: 8 - bob, width: 262, height: 335 }), clip: clipB, flipX: true });

  roundedRect(canvas, 14, 15, 250, 5, 3, [255, 255, 255, 255]);
  roundedRect(canvas, 296, 15, 250, 5, 3, [255, 255, 255, 255]);
  // Warm outlines frame the arena as one battle scene rather than separate character cards.
  for (const [x, color] of [[14, [236, 184, 104, 255]], [296, [190, 169, 226, 255]]]) {
    for (let i = 0; i < 3; i++) {
      line(canvas, x + 38, 18 + i, x + 212, 18 + i, color, 1, 0.78);
      line(canvas, x + 38, 333 - i, x + 212, 333 - i, color, 1, 0.78);
    }
  }

  // Floor glows and arena sparkles.
  circle(canvas, 135, 328, 40, [255, 208, 113, 255], 0.23);
  circle(canvas, 425, 328, 40, [202, 182, 244, 255], 0.24);
  sparkle(canvas, 280, 54, 11, [255, 255, 255, 255]);
  sparkle(canvas, 280, 310, 8, [255, 244, 202, 255]);

  if (phase === 2) {
    circle(canvas, 280, 184, 47, [255, 243, 179, 255], 0.84);
    circle(canvas, 280, 184, 28, [255, 255, 255, 255], 0.88);
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      line(canvas, 280 + Math.cos(a) * 31, 184 + Math.sin(a) * 31, 280 + Math.cos(a) * 68, 184 + Math.sin(a) * 68, [255, 196, 68, 255], 3);
    }
    sparkle(canvas, 244, 143, 10, [255, 255, 255, 255]);
    sparkle(canvas, 316, 224, 9, [255, 255, 255, 255]);
  }

  if (finalFrame && winner !== 'draw') {
    const cx = winner === 'a' ? 138 : 422;
    circle(canvas, cx, 180, 136, [255, 224, 105, 255], 0.72, 4);
    sparkle(canvas, winner === 'a' ? 65 : 495, 60, 12, [255, 255, 255, 255]);
    sparkle(canvas, winner === 'a' ? 210 : 350, 78, 9, [255, 250, 222, 255]);
  }
  return canvas;
}

/** Build a short, single-play Telegram GIF from the two fighters' current pet-stage art. */
export async function makePvpAnimation({ product, aStage, bStage, rounds = [], winner = 'draw' }) {
  const [aImage, bImage] = await Promise.all([loadPetImage(product, aStage), loadPetImage(product, bStage)]);
  const states = [{ roundIndex: 0, phase: 0, attackSide: 'a' }];
  for (let i = 0; i < Math.max(1, rounds.length); i++) {
    const round = rounds[i] || { winner: 'draw' };
    const attackSide = round.winner === 'b' ? 'b' : round.winner === 'a' ? 'a' : (i % 2 ? 'b' : 'a');
    states.push(
      { roundIndex: i, phase: 0, attackSide },
      { roundIndex: i, phase: 1, attackSide },
      { roundIndex: i, phase: 2, attackSide },
    );
  }
  states.push({ roundIndex: rounds.length, phase: 0, attackSide: winner === 'b' ? 'b' : 'a', finalFrame: true });
  const frames = states.map((state) => createFrame({ aImage, bImage, winner, ...state }));
  const combined = new Uint8Array(frames.reduce((total, frame) => total + frame.length, 0));
  let offset = 0;
  for (const frame of frames) { combined.set(frame, offset); offset += frame.length; }
  const palette = quantize(combined, 256, { format: 'rgb565' });
  const gif = GIFEncoder();
  frames.forEach((frame, index) => gif.writeFrame(applyPalette(frame, palette), WIDTH, HEIGHT, {
    ...(index === 0 ? { palette, repeat: -1 } : {}),
    delay: FRAME_DELAY,
  }));
  gif.finish();
  return { buffer: Buffer.from(gif.bytes()), durationMs: states.length * FRAME_DELAY };
}
