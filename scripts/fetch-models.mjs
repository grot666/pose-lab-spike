#!/usr/bin/env node
// One-time setup: download Pose + Face Landmarker .task models and copy the
// MediaPipe WASM runtime (version-matched to node_modules) into public/.
// After this, the app needs NO network at runtime for models.
//
//   npm run fetch-models            # download missing models + (re)copy wasm
//   npm run fetch-models -- --force # re-download models even if present
import fs from 'node:fs';
import path from 'node:path';
import { MODELS, MODELS_DIR, WASM_DIR, WASM_FILES, WASM_SRC_DIR } from './assets.mjs';

const force = process.argv.includes('--force');

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = `${dest}.part`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
  return buf.length;
}

async function main() {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  fs.mkdirSync(WASM_DIR, { recursive: true });

  for (const m of MODELS) {
    const dest = path.join(MODELS_DIR, m.file);
    const min = m.minBytes ?? 1_000_000;
    if (!force && fs.existsSync(dest) && fs.statSync(dest).size > min) {
      console.log(`[models] ${m.file} present (${(fs.statSync(dest).size / 1e6).toFixed(1)} MB) - skip`);
      continue;
    }
    process.stdout.write(`[models] downloading ${m.file} ... `);
    const n = await download(m.url, dest);
    console.log(`${(n / 1e6).toFixed(1)} MB`);
  }

  if (!fs.existsSync(WASM_SRC_DIR)) {
    throw new Error(`MediaPipe wasm not found at ${WASM_SRC_DIR}. Run "npm install" first.`);
  }
  for (const f of WASM_FILES) {
    const src = path.join(WASM_SRC_DIR, f);
    if (!fs.existsSync(src)) {
      console.warn(`[wasm] ${f} not shipped by this @mediapipe/tasks-vision version - skip`);
      continue;
    }
    fs.copyFileSync(src, path.join(WASM_DIR, f));
    console.log(`[wasm] copied ${f}`);
  }
  console.log('Done. Assets are local; the app runs offline from here on.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
