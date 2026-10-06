import { describe, expect, it } from 'vitest';
import { assetUrl, wasmAssetDir } from '../src/core/assetUrl';

describe('assetUrl (Pages-safe BASE_URL)', () => {
  it('keeps assets under /pose-lab-spike/ when the page URL has a trailing slash', () => {
    const href = 'https://grot666.github.io/pose-lab-spike/?mode=face';
    expect(assetUrl('models/face_landmarker.task', href)).toBe(
      'https://grot666.github.io/pose-lab-spike/models/face_landmarker.task',
    );
    expect(wasmAssetDir('mediapipe/wasm', href)).toBe('https://grot666.github.io/pose-lab-spike/mediapipe/wasm');
  });

  it('does not escape the project root when the path lacks a trailing slash', () => {
    const href = 'https://grot666.github.io/pose-lab-spike?mode=face';
    expect(assetUrl('models/face_landmarker.task', href)).toBe(
      'https://grot666.github.io/pose-lab-spike/models/face_landmarker.task',
    );
    expect(assetUrl('mediapipe/wasm', href)).toBe('https://grot666.github.io/pose-lab-spike/mediapipe/wasm');
  });

  it('resolves correctly from index.html', () => {
    const href = 'https://grot666.github.io/pose-lab-spike/index.html?mode=face';
    expect(assetUrl('models/face_landmarker.task', href)).toBe(
      'https://grot666.github.io/pose-lab-spike/models/face_landmarker.task',
    );
  });
});
