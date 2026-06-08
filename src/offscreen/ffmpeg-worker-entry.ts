// Re-export the ffmpeg.wasm worker code so esbuild can bundle it as
// `ffmpeg-worker.js` in the extension's static directory. The FFmpeg
// instance loads this URL via `classWorkerURL` (see yt-mp4-muxer.ts),
// which spins it up as a Web Worker. The worker then `importScripts`
// the chrome-extension://.../ffmpeg-core.js and proxies all FS / exec
// calls to the wasm core.
//
// The worker.js shipped by @ffmpeg/ffmpeg expects to be loaded as an
// ES module (`type: "module"`) — esbuild's `format: "esm"` output keeps
// the import semantics intact.

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — worker.js has no .d.ts but it's a side-effect import.
import "@ffmpeg/ffmpeg/worker";
