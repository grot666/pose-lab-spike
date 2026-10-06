import { describe, expect, it } from 'vitest';
import {
  blendshapesToMorphs,
  idleHeadPose,
  idleMorphs,
  landmarksToHeadPose,
  lerpMorphs,
  FACE_LM,
  type FaceLandmark,
} from '../src/core/avatarMorphs';
import type { BlendshapeMap } from '../src/core/expressionRules';

function shapes(partial: BlendshapeMap): BlendshapeMap {
  return { ...partial };
}

function mesh(overrides: Partial<Record<number, FaceLandmark>> = {}): FaceLandmark[] {
  // Minimal fake mesh: enough indices for landmarksToHeadPose
  const pts: FaceLandmark[] = Array.from({ length: 300 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  pts[FACE_LM.nose] = { x: 0.5, y: 0.48, z: -0.05 };
  pts[FACE_LM.chin] = { x: 0.5, y: 0.72, z: 0 };
  pts[FACE_LM.forehead] = { x: 0.5, y: 0.28, z: 0 };
  pts[FACE_LM.eyeOuterL] = { x: 0.38, y: 0.42, z: 0 };
  pts[FACE_LM.eyeOuterR] = { x: 0.62, y: 0.42, z: 0 };
  for (const [k, v] of Object.entries(overrides)) {
    pts[Number(k)] = v!;
  }
  return pts;
}

describe('blendshapesToMorphs', () => {
  it('maps smile / frown / jaw / blink / brow / tongue', () => {
    const m = blendshapesToMorphs(
      shapes({
        mouthSmileLeft: 0.8,
        mouthSmileRight: 0.6,
        mouthFrownLeft: 0.1,
        mouthFrownRight: 0.1,
        jawOpen: 0.55,
        eyeBlinkLeft: 0.9,
        eyeBlinkRight: 0.2,
        eyeWideLeft: 0.1,
        eyeWideRight: 0.1,
        browInnerUp: 0.7,
        tongueOut: 0.4,
      }),
    );
    expect(m.smile).toBeCloseTo(0.7, 5);
    expect(m.jawOpen).toBeCloseTo(0.55, 5);
    expect(m.blinkL).toBeCloseTo(0.9, 5);
    expect(m.blinkR).toBeCloseTo(0.2, 5);
    expect(m.browUp).toBeGreaterThanOrEqual(0.7);
    expect(m.tongueOut).toBeCloseTo(0.4, 5);
    // Strong smile suppresses frown drive
    expect(m.frown).toBeLessThan(0.1);
  });

  it('treats missing blendshapes as idle zeros', () => {
    expect(blendshapesToMorphs(shapes({}))).toEqual(idleMorphs());
  });

  it('clamps out-of-range and ignores non-finite', () => {
    const m = blendshapesToMorphs(
      shapes({
        mouthSmileLeft: 2,
        mouthSmileRight: -1,
        jawOpen: Number.NaN,
      }),
    );
    expect(m.smile).toBe(0.5); // avg(1, 0)
    expect(m.jawOpen).toBe(0);
  });
});

describe('landmarksToHeadPose', () => {
  it('returns null when required landmarks are missing', () => {
    expect(landmarksToHeadPose([])).toBeNull();
    expect(landmarksToHeadPose([{ x: 0.5, y: 0.5, z: 0 }])).toBeNull();
  });

  it('estimates near-zero pose for a frontal symmetric face', () => {
    const p = landmarksToHeadPose(mesh());
    expect(p).not.toBeNull();
    expect(Math.abs(p!.yaw)).toBeLessThan(0.15);
    expect(Math.abs(p!.roll)).toBeLessThan(0.1);
    expect(p!.x).toBeGreaterThan(0.4);
    expect(p!.x).toBeLessThan(0.6);
    expect(p!.scale).toBeGreaterThan(0.05);
  });

  it('yaw follows nose offset toward image +x', () => {
    const frontal = landmarksToHeadPose(mesh())!;
    const turned = landmarksToHeadPose(
      mesh({
        [FACE_LM.nose]: { x: 0.58, y: 0.48, z: -0.05 },
      }),
    )!;
    expect(turned.yaw).toBeGreaterThan(frontal.yaw);
  });

  it('roll follows tilted eye line', () => {
    const p = landmarksToHeadPose(
      mesh({
        [FACE_LM.eyeOuterL]: { x: 0.38, y: 0.38, z: 0 },
        [FACE_LM.eyeOuterR]: { x: 0.62, y: 0.46, z: 0 },
      }),
    )!;
    expect(p.roll).toBeGreaterThan(0.1);
  });
});

describe('lerpMorphs', () => {
  it('interpolates toward target', () => {
    const a = idleMorphs();
    const b = { ...idleMorphs(), smile: 1, jawOpen: 1 };
    const mid = lerpMorphs(a, b, 0.5);
    expect(mid.smile).toBeCloseTo(0.5, 5);
    expect(mid.jawOpen).toBeCloseTo(0.5, 5);
  });
});

describe('idleHeadPose', () => {
  it('centers the avatar', () => {
    const p = idleHeadPose();
    expect(p.x).toBe(0.5);
    expect(p.yaw).toBe(0);
  });
});
