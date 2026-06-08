// build.mjs — сборка расширения через esbuild.

import * as esbuild from "esbuild";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = __dirname;
const OUT_DIR = path.join(ROOT, "dist", "extension");
const ROOT_DIR = path.join(ROOT, "YMus");

const ENTRIES = {
  background: {
    entry: path.join(ROOT, "src", "background", "background.ts"),
    out: path.join(OUT_DIR, "background.js"),
    format: "esm",
  },
  content: {
    entry: path.join(ROOT, "src", "content", "content.ts"),
    out: path.join(OUT_DIR, "content.js"),
    format: "iife",
  },
  "ym-page-bridge": {
    entry: path.join(ROOT, "src", "content", "ym-page-bridge.ts"),
    out: path.join(OUT_DIR, "ym-page-bridge.js"),
    format: "iife",
  },
  popup: {
    entry: path.join(ROOT, "src", "popup", "popup.ts"),
    out: path.join(OUT_DIR, "popup.js"),
    format: "esm",
  },
  offscreen: {
    entry: path.join(ROOT, "src", "offscreen", "offscreen.ts"),
    out: path.join(OUT_DIR, "offscreen.js"),
    format: "esm",
  },
  "vk-content": {
    entry: path.join(ROOT, "src", "vk-content", "vk-content.ts"),
    out: path.join(OUT_DIR, "vk-content.js"),
    format: "iife",
  },
  "vk-page-bridge": {
    entry: path.join(ROOT, "src", "vk-content", "vk-page-bridge.ts"),
    out: path.join(OUT_DIR, "vk-page-bridge.js"),
    format: "iife",
  },
  "yt-content": {
    entry: path.join(ROOT, "src", "yt-content", "yt-content.ts"),
    out: path.join(OUT_DIR, "yt-content.js"),
    format: "iife",
  },
  "yt-page-bridge": {
    entry: path.join(ROOT, "src", "yt-content", "yt-page-bridge.ts"),
    out: path.join(OUT_DIR, "yt-page-bridge.js"),
    format: "iife",
  },
  "spotify-content": {
    entry: path.join(ROOT, "src", "spotify-content", "spotify-content.ts"),
    out: path.join(OUT_DIR, "spotify-content.js"),
    format: "iife",
  },
  "ffmpeg-worker": {
    entry: path.join(ROOT, "src", "offscreen", "ffmpeg-worker-entry.ts"),
    out: path.join(OUT_DIR, "ffmpeg-worker.js"),
    // ffmpeg's worker.js uses ES module imports + relative imports of
    // FFMessageType from ./const.js; we need ESM output so dynamic
    // imports + workerType: "module" resolve correctly.
    format: "esm",
  },
};

const STATIC_FILES = [
  { src: path.join(ROOT, "manifest.json"), dst: path.join(OUT_DIR, "manifest.json") },
  { src: path.join(ROOT, "src", "popup", "popup.html"), dst: path.join(OUT_DIR, "popup.html") },
  { src: path.join(ROOT, "src", "offscreen", "offscreen.html"), dst: path.join(OUT_DIR, "offscreen.html") },
  { src: path.join(ROOT, "Icons", "Icon16x16.png"), dst: path.join(OUT_DIR, "icons", "Icon16x16.png") },
  { src: path.join(ROOT, "Icons", "Icon48x48.png"), dst: path.join(OUT_DIR, "icons", "Icon48x48.png") },
  { src: path.join(ROOT, "Icons", "Icon128x128.png"), dst: path.join(OUT_DIR, "icons", "Icon128x128.png") },
];

// Static files for YMus (loadable directly from this folder)
const ROOT_STATIC_FILES = [
  { src: path.join(ROOT, "manifest.json"), dst: path.join(ROOT_DIR, "manifest.json") },
  { src: path.join(ROOT, "src", "popup", "popup.html"), dst: path.join(ROOT_DIR, "popup.html") },
  { src: path.join(ROOT, "src", "offscreen", "offscreen.html"), dst: path.join(ROOT_DIR, "offscreen.html") },
  { src: path.join(ROOT, "Icons", "Icon16x16.png"), dst: path.join(ROOT_DIR, "icons", "Icon16x16.png") },
  { src: path.join(ROOT, "Icons", "Icon48x48.png"), dst: path.join(ROOT_DIR, "icons", "Icon48x48.png") },
  { src: path.join(ROOT, "Icons", "Icon128x128.png"), dst: path.join(ROOT_DIR, "icons", "Icon128x128.png") },
];

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function copyStatic() {
  for (const { src, dst } of STATIC_FILES) {
    await ensureDir(path.dirname(dst));
    await fs.copyFile(src, dst);
    console.log(`📄 ${path.relative(ROOT, src)} → ${path.relative(ROOT, dst)}`);
  }
  // Copy libflac WASM encoder for offscreen MP3→FLAC repacking.
  // Используем wasm-версию (libflac.min.wasm.js + libflac.min.wasm.wasm) —
  // в 2× компактнее asm.js при той же скорости, и не требует libflac.min.js.mem.
  const flacFiles = [
    "libflac.min.wasm.js",
    "libflac.min.wasm.wasm",
  ];
  for (const f of flacFiles) {
    const src = path.join(ROOT, "node_modules", "libflacjs", "dist", f);
    const dst = path.join(OUT_DIR, f);
    await fs.copyFile(src, dst);
    console.log(`📦 libflacjs → ${path.relative(ROOT, dst)}`);
  }
  // Copy ffmpeg.wasm core files for the YouTube MP4 muxer. The core
  // weighs ~31 MB (wasm) + 109 KB (loader) — too large to bundle into
  // offscreen.js, so we ship it as a static file pair and load it via
  // chrome.runtime.getURL at runtime.  We use the ESM build because
  // the bundled worker.js (also ESM) prefers `await import()` over
  // `importScripts` when the worker is loaded with `type: "module"`.
  const ffmpegCoreFiles = [
    "ffmpeg-core.js",
    "ffmpeg-core.wasm",
  ];
  for (const f of ffmpegCoreFiles) {
    const src = path.join(ROOT, "node_modules", "@ffmpeg", "core", "dist", "esm", f);
    const dst = path.join(OUT_DIR, f);
    await fs.copyFile(src, dst);
    console.log(`📦 ffmpeg-core → ${path.relative(ROOT, dst)}`);
  }
  // Copy the youtubei.js prebuilt browser bundle. We dynamic-import
  // this from the service worker via `chrome.runtime.getURL` to avoid
  // bundling its 1.5 MB of code into background.js.
  await fs.copyFile(
    path.join(ROOT, "node_modules", "youtubei.js", "bundle", "browser.js"),
    path.join(OUT_DIR, "youtubei.js"),
  );
  console.log(`📦 youtubei.js → ${path.relative(ROOT, path.join(OUT_DIR, "youtubei.js"))}`);
}

async function copyToRoot() {
  // Copy bundled JS files to YMus
  for (const [name, cfg] of Object.entries(ENTRIES)) {
    const dst = path.join(ROOT_DIR, path.basename(cfg.out));
    await fs.copyFile(cfg.out, dst);
    console.log(`📦 ${path.relative(ROOT, cfg.out)} → ${path.relative(ROOT, dst)}`);
  }
  // Copy libflac WASM encoder (см. copyStatic). Тот же набор файлов в YMus.
  const flacFiles = [
    "libflac.min.wasm.js",
    "libflac.min.wasm.wasm",
  ];
  for (const f of flacFiles) {
    const src = path.join(ROOT, "node_modules", "libflacjs", "dist", f);
    const dst = path.join(ROOT_DIR, f);
    await fs.copyFile(src, dst);
    console.log(`📦 libflacjs → ${path.relative(ROOT, dst)}`);
  }
  // Copy ffmpeg.wasm core files (см. copyStatic). Тот же набор файлов в YMus.
  const ffmpegCoreFiles = [
    "ffmpeg-core.js",
    "ffmpeg-core.wasm",
  ];
  for (const f of ffmpegCoreFiles) {
    const src = path.join(ROOT, "node_modules", "@ffmpeg", "core", "dist", "esm", f);
    const dst = path.join(ROOT_DIR, f);
    await fs.copyFile(src, dst);
    console.log(`📦 ffmpeg-core → ${path.relative(ROOT, dst)}`);
  }
  // Copy youtubei.js browser bundle (см. copyStatic).
  await fs.copyFile(
    path.join(ROOT, "node_modules", "youtubei.js", "bundle", "browser.js"),
    path.join(ROOT_DIR, "youtubei.js"),
  );
  console.log(`📦 youtubei.js → ${path.relative(ROOT, path.join(ROOT_DIR, "youtubei.js"))}`);
  // Copy static files to YMus
  for (const { src, dst } of ROOT_STATIC_FILES) {
    await ensureDir(path.dirname(dst));
    await fs.copyFile(src, dst);
    console.log(`📄 ${path.relative(ROOT, src)} → ${path.relative(ROOT, dst)}`);
  }
}

async function buildAll() {
  await ensureDir(OUT_DIR);
  await ensureDir(ROOT_DIR);
  for (const [name, cfg] of Object.entries(ENTRIES)) {
    await esbuild.build({
      entryPoints: [cfg.entry],
      bundle: true,
      outfile: cfg.out,
      format: cfg.format,
      platform: "browser",
      target: ["chrome120"],
      sourcemap: false,
      logLevel: "info",
      minify: false,
    });
    console.log(`✅ ${name}: ${path.relative(ROOT, cfg.out)}`);
  }
  await copyStatic();
  await copyToRoot();
  console.log("\n🎉 YMus/ ready — load this folder as unpacked extension");
}

buildAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
