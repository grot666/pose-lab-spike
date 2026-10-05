#!/usr/bin/env node
// Guard run before `npm run dev` / `npm run build`: fail fast with a helpful
// message if the local model / wasm assets are missing.
import fs from 'node:fs';
import path from 'node:path';
import { MODELS, MODELS_DIR, WASM_DIR } from './assets.mjs';

const missing = [];
for (const m of MODELS) {
  const p = path.join(MODELS_DIR, m.file);
  if (!fs.existsSync(p) || fs.statSync(p).size < 1_000_000) missing.push(`public/models/${m.file}`);
}
for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm']) {
  if (!fs.existsSync(path.join(WASM_DIR, f))) missing.push(`public/mediapipe/wasm/${f}`);
}
if (missing.length) {
  console.error('\n[check-assets] Missing local MediaPipe assets:\n  ' + missing.join('\n  '));
  console.error('\nRun once:  npm run fetch-models\n');
  process.exit(1);
}
console.log('[check-assets] local MediaPipe models + wasm present');
