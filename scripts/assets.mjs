// Single source of truth for the local MediaPipe assets this spike needs.
// Used by fetch-models.mjs (one-time setup) and check-assets.mjs (pre dev/build guard).
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const MODELS_DIR = path.join(PUBLIC_DIR, 'models');
export const WASM_DIR = path.join(PUBLIC_DIR, 'mediapipe', 'wasm');
export const WASM_SRC_DIR = path.join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');

const POSE_BASE = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker';
const FACE_BASE = 'https://storage.googleapis.com/mediapipe-models/face_landmarker';

/** Pose Landmarker tiers (body). */
export const POSE_MODELS = ['lite', 'full', 'heavy'].map((tier) => ({
  tier,
  file: `pose_landmarker_${tier}.task`,
  url: `${POSE_BASE}/pose_landmarker_${tier}/float16/latest/pose_landmarker_${tier}.task`,
  /** Skip-if-present size floor (bytes). Pose models are multi-MB. */
  minBytes: 1_000_000,
}));

/**
 * Face Landmarker (landmarks + 52 ARKit-style blendshapes).
 * Single bundle; float16 ~3–4 MB.
 */
export const FACE_MODELS = [
  {
    tier: 'face',
    file: 'face_landmarker.task',
    url: `${FACE_BASE}/face_landmarker/float16/1/face_landmarker.task`,
    minBytes: 500_000,
  },
];

/** All .task models the app expects under public/models/. */
export const MODELS = [...POSE_MODELS, ...FACE_MODELS];

export const WASM_FILES = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
  'vision_wasm_module_internal.js',
  'vision_wasm_module_internal.wasm',
];
