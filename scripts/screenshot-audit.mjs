#!/usr/bin/env node
/**
 * T19: screenshot sanity analysis — the strongest *programmatic* substitute for
 * looking at the images.
 *
 * Why this exists: in this session no model can receive image input, so "inspect
 * the screenshot visually" cannot be done. Rather than claim it was, this script
 * computes what a look would have caught most importantly:
 *
 *   - **not blank**: the fraction of non-background pixels. A white/blank page (the
 *     #1 failure mode the plan names) scores near 0.
 *   - **text present**: dark-pixel count in the content area, which a rendered
 *     page with paragraphs has in the thousands.
 *   - **not a single flat colour**: distinct-colour estimate, so a solid fill
 *     cannot pass as content.
 *
 * What it CANNOT do (stated, not hidden): judge overlap, clipping, alignment or
 * "does it look right". Those need eyes; the DOM-level checks in readiness-ui.mjs
 * (overflow widths, visible-element assertions, console errors) cover part of it,
 * and the honest limitation is recorded in the execution log.
 *
 * Usage: node scripts/screenshot-audit.mjs <png...>
 */
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

/** Minimal PNG reader: 8-bit RGB/RGBA, non-interlaced (what Playwright writes). */
function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let offset = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error("interlaced PNG is not supported");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG format: depth=${bitDepth} colorType=${colorType}`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const prior = y === 0 ? null : pixels.subarray((y - 1) * stride, y * stride);
    const current = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? current[x - channels] : 0;
      const b = prior ? prior[x] : 0;
      const c = prior && x >= channels ? prior[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += Math.floor((a + b) / 2);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      current[x] = value & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

/**
 * Statistics a human would notice at a glance. Theme-aware: this app renders on a
 * dark background (#0b0c0e) with light text (#eceef1), so "ink" means pixels that
 * differ from the *page's own background*, whichever luminance that is. The first
 * version of this function assumed a light theme and reported a dark page as
 * 99% "dark" — which is why the background colour is measured, not assumed.
 */
export function analyzePng(buffer) {
  const { width, height, channels, pixels } = decodePng(buffer);
  const lumaAt = (i) => 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
  const total = width * height;

  // Background = the most common colour, sampled on a grid (cheap and robust).
  const histogram = new Map();
  for (let y = 0; y < height; y += 3) {
    for (let x = 0; x < width; x += 3) {
      const i = (y * width + x) * channels;
      const key = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
      histogram.set(key, (histogram.get(key) ?? 0) + 1);
    }
  }
  let backgroundKey = 0, backgroundCount = -1;
  for (const [key, count] of histogram) {
    if (count > backgroundCount) { backgroundKey = key; backgroundCount = count; }
  }
  const bgR = (backgroundKey >> 16) & 0xff, bgG = (backgroundKey >> 8) & 0xff, bgB = backgroundKey & 0xff;
  const bgLuma = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB;
  const darkTheme = bgLuma < 128;

  let foreground = 0;
  let strongInk = 0;
  const colors = new Set();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels;
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      const distance = Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB);
      if (distance > 24) foreground += 1;            // not the page background
      // Text-weight contrast in the direction the theme implies.
      const luma = lumaAt(i);
      if (darkTheme ? luma > bgLuma + 96 : luma < bgLuma - 96) strongInk += 1;
      if (colors.size < 4096) colors.add((r << 16) | (g << 8) | b);
    }
  }
  return {
    width,
    height,
    background: `#${backgroundKey.toString(16).padStart(6, "0")}`,
    theme: darkTheme ? "dark" : "light",
    content_ratio: Number((foreground / total).toFixed(4)),
    text_ink_ratio: Number((strongInk / total).toFixed(4)),
    distinct_colors: colors.size >= 4096 ? ">=4096" : colors.size,
  };
}

if (process.argv[1] && process.argv[1].endsWith("screenshot-audit.mjs")) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error("usage: node scripts/screenshot-audit.mjs <png...>");
    process.exit(2);
  }
  const report = {};
  let failed = false;
  for (const file of files) {
    try {
      const stats = analyzePng(readFileSync(file));
      // A rendered page with content has substantial ink; a blank one has almost
      // none. The thresholds are deliberately loose (this is a blank-page alarm,
      // not a taste judgement).
      const problems = [];
      if (stats.content_ratio < 0.005) problems.push("page looks blank");
      if (stats.text_ink_ratio < 0.0005) problems.push("no text-weight ink detected");
      if (stats.distinct_colors === 1) problems.push("single flat colour");
      report[file.replace(/\\/g, "/").split("/").pop()] = { ...stats, problems };
      if (problems.length) failed = true;
    } catch (error) {
      report[file] = { error: String(error?.message ?? error) };
      failed = true;
    }
  }
  console.log(JSON.stringify(report, null, 2));
  process.exit(failed ? 1 : 0);
}
