// Single source of truth for the local MediaPipe assets this spike needs.
// Used by fetch-models.mjs (one-time setup) and check-assets.mjs (pre dev/build guard).
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const MODELS_DIR = path.join(PUBLIC_DIR, 'models');
export const WASM_DIR = path.join(PUBLIC_DIR, 'mediapipe', 'wasm');
export const WASM_SRC_DIR = path.join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');

const MODEL_BASE = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker';

export const MODELS = ['lite', 'full', 'heavy'].map((tier) => ({
  tier,
  file: `pose_landmarker_${tier}.task`,
  url: `${MODEL_BASE}/pose_landmarker_${tier}/float16/latest/pose_landmarker_${tier}.task`,
}));

export const WASM_FILES = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
  'vision_wasm_module_internal.js',
  'vision_wasm_module_internal.wasm',
];
