/**
 * Pure mapping: Face Landmarker blendshapes + landmarks → VTuber avatar drives.
 * No DOM / three.js — unit-tested morph + head-pose math only.
 */

import type { BlendshapeMap } from './expressionRules';

/** Landmark with normalized image coords (MediaPipe face mesh). */
export interface FaceLandmark {
  x: number;
  y: number;
  z: number;
}

/** Continuous expression drives for a live avatar skin (皮套). */
export interface AvatarMorphs {
  /** Mouth corner lift 0..1 */
  smile: number;
  /** Mouth corner drop 0..1 */
  frown: number;
  /** Jaw drop 0..1 */
  jawOpen: number;
  /** Left / right eye closure 0..1 */
  blinkL: number;
  blinkR: number;
  /** Eye widen 0..1 */
  eyeWideL: number;
  eyeWideR: number;
  /** Brow raise 0..1 */
  browUp: number;
  /** Tongue out 0..1 */
  tongueOut: number;
}

/** Head pose in radians + normalized frame position for staging the avatar. */
export interface HeadPose {
  /** +yaw = subject turns to their left (nose moves toward image +x when unmirrored). */
  yaw: number;
  /** +pitch = chin up / look up. */
  pitch: number;
  /** +roll = head tilt clockwise from the camera's view. */
  roll: number;
  /** Face center in normalized image space [0,1]. */
  x: number;
  y: number;
  /** Relative face size from inter-ocular distance (≈0.05–0.35 typical). */
  scale: number;
}

/** MediaPipe Face Mesh indices used for pose. */
export const FACE_LM = {
  nose: 1,
  chin: 152,
  forehead: 10,
  eyeOuterL: 33, // subject's right eye outer (image left when facing camera)
  eyeOuterR: 263, // subject's left eye outer (image right)
  eyeInnerL: 133,
  eyeInnerR: 362,
  mouthL: 61,
  mouthR: 291,
} as const;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function shape(shapes: BlendshapeMap, name: string): number {
  const v = shapes[name];
  return Number.isFinite(v) ? clamp01(v as number) : 0;
}

function avg(...xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Map ARKit-style blendshapes to simplified VTuber morph drives.
 * Missing keys read as 0 (idle face) — continuous skin, not pass/fail gates.
 */
export function blendshapesToMorphs(shapes: BlendshapeMap): AvatarMorphs {
  const smile = avg(shape(shapes, 'mouthSmileLeft'), shape(shapes, 'mouthSmileRight'));
  const frown = avg(shape(shapes, 'mouthFrownLeft'), shape(shapes, 'mouthFrownRight'));
  const jawOpen = shape(shapes, 'jawOpen');
  // Soften mutual exclusion: strong smile reduces frown drive a bit.
  const smileN = clamp01(smile);
  const frownN = clamp01(frown * (1 - smileN * 0.7));
  return {
    smile: smileN,
    frown: frownN,
    jawOpen: clamp01(jawOpen),
    blinkL: shape(shapes, 'eyeBlinkLeft'),
    blinkR: shape(shapes, 'eyeBlinkRight'),
    eyeWideL: shape(shapes, 'eyeWideLeft'),
    eyeWideR: shape(shapes, 'eyeWideRight'),
    browUp: clamp01(
      Math.max(
        shape(shapes, 'browInnerUp'),
        avg(shape(shapes, 'browOuterUpLeft'), shape(shapes, 'browOuterUpRight')),
      ),
    ),
    tongueOut: shape(shapes, 'tongueOut'),
  };
}

function lm(
  landmarks: ReadonlyArray<FaceLandmark>,
  idx: number,
): FaceLandmark | null {
  const p = landmarks[idx];
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return p;
}

/**
 * Estimate head pose from a sparse face-mesh subset (no PnP / no transform matrix).
 * Returns null when required landmarks are missing.
 */
export function landmarksToHeadPose(
  landmarks: ReadonlyArray<FaceLandmark>,
): HeadPose | null {
  const nose = lm(landmarks, FACE_LM.nose);
  const chin = lm(landmarks, FACE_LM.chin);
  const forehead = lm(landmarks, FACE_LM.forehead);
  const eyeL = lm(landmarks, FACE_LM.eyeOuterL);
  const eyeR = lm(landmarks, FACE_LM.eyeOuterR);
  if (!nose || !chin || !forehead || !eyeL || !eyeR) return null;

  const midEyeX = (eyeL.x + eyeR.x) / 2;
  const midEyeY = (eyeL.y + eyeR.y) / 2;
  const eyeDist = Math.hypot(eyeR.x - eyeL.x, eyeR.y - eyeL.y);
  if (!(eyeDist > 1e-4)) return null;

  // Roll from eye line.
  const roll = Math.atan2(eyeR.y - eyeL.y, eyeR.x - eyeL.x);

  // Yaw: nose offset from eye midpoint, normalized by eye distance.
  const yaw = clamp((nose.x - midEyeX) / eyeDist, -1.2, 1.2) * 0.9;

  // Pitch: nose between forehead and chin (0 ≈ mid).
  const faceH = Math.hypot(chin.x - forehead.x, chin.y - forehead.y) || eyeDist * 2.2;
  const noseAlong = ((nose.y - forehead.y) / faceH) * 2 - 1; // ~-1 forehead .. +1 chin
  const pitch = clamp(-noseAlong * 0.55, -0.85, 0.85);

  const x = (eyeL.x + eyeR.x + nose.x + chin.x) / 4;
  const y = (midEyeY + nose.y + chin.y) / 3;

  return {
    yaw,
    pitch,
    roll,
    x: clamp(x, 0, 1),
    y: clamp(y, 0, 1),
    scale: clamp(eyeDist, 0.02, 0.5),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Linear blend toward target (for optional app-side smoothing without OneEuro). */
export function lerpMorphs(a: AvatarMorphs, b: AvatarMorphs, t: number): AvatarMorphs {
  const u = clamp01(t);
  const mix = (x: number, y: number) => x + (y - x) * u;
  return {
    smile: mix(a.smile, b.smile),
    frown: mix(a.frown, b.frown),
    jawOpen: mix(a.jawOpen, b.jawOpen),
    blinkL: mix(a.blinkL, b.blinkL),
    blinkR: mix(a.blinkR, b.blinkR),
    eyeWideL: mix(a.eyeWideL, b.eyeWideL),
    eyeWideR: mix(a.eyeWideR, b.eyeWideR),
    browUp: mix(a.browUp, b.browUp),
    tongueOut: mix(a.tongueOut, b.tongueOut),
  };
}

export function idleMorphs(): AvatarMorphs {
  return {
    smile: 0,
    frown: 0,
    jawOpen: 0,
    blinkL: 0,
    blinkR: 0,
    eyeWideL: 0,
    eyeWideR: 0,
    browUp: 0,
    tongueOut: 0,
  };
}

export function idleHeadPose(): HeadPose {
  return { yaw: 0, pitch: 0, roll: 0, x: 0.5, y: 0.45, scale: 0.12 };
}
