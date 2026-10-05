import { J, type JointName, type Landmark, type Vec3, getPoint } from './landmarks';

export const RAD2DEG = 180 / Math.PI;

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
export function len(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}
export function dist(a: Vec3, b: Vec3): number {
  return len(sub(a, b));
}

/** Angle ABC at vertex B, degrees, 0..180. */
export function angleAt(a: Vec3, b: Vec3, c: Vec3): number {
  const ba = sub(a, b);
  const bc = sub(c, b);
  const d = len(ba) * len(bc);
  if (d < 1e-9) return NaN;
  const cos = Math.min(1, Math.max(-1, dot(ba, bc) / d));
  return Math.acos(cos) * RAD2DEG;
}

/** Named joint angles: vertex in the middle. Used by rules AND the debug panel. */
export const ANGLE_DEFS = {
  elbow_left: ['left_shoulder', 'left_elbow', 'left_wrist'],
  elbow_right: ['right_shoulder', 'right_elbow', 'right_wrist'],
  /** Arm vs torso: 0 = arm hanging down along the body, 180 = straight up. */
  shoulder_left: ['left_hip', 'left_shoulder', 'left_elbow'],
  shoulder_right: ['right_hip', 'right_shoulder', 'right_elbow'],
  /** Torso vs thigh: 180 = straight (standing / high kneel), ~90 = seated. */
  hip_left: ['left_shoulder', 'left_hip', 'left_knee'],
  hip_right: ['right_shoulder', 'right_hip', 'right_knee'],
  /** Thigh vs shin: 180 = straight leg, small = fully folded (sitting on heels). */
  knee_left: ['left_hip', 'left_knee', 'left_ankle'],
  knee_right: ['right_hip', 'right_knee', 'right_ankle'],
} as const satisfies Record<string, readonly [JointName, JointName, JointName]>;

export type AngleName = keyof typeof ANGLE_DEFS;
export const ANGLE_NAMES = Object.keys(ANGLE_DEFS) as AngleName[];

export function isAngleName(s: string): s is AngleName {
  return s in ANGLE_DEFS;
}

export function angleJoints(name: AngleName): number[] {
  return ANGLE_DEFS[name].map((n) => J[n]);
}

export function jointAngle(lms: readonly Landmark[], name: AngleName): number {
  const [a, b, c] = ANGLE_DEFS[name];
  return angleAt(lms[J[a]], lms[J[b]], lms[J[c]]);
}

/** Torso tilt from vertical: angle between hip_mid->shoulder_mid and +y, degrees. */
export function torsoTilt(lms: readonly Landmark[]): number {
  const v = sub(getPoint(lms, 'shoulder_mid'), getPoint(lms, 'hip_mid'));
  const l = len(v);
  if (l < 1e-9) return NaN;
  return Math.acos(Math.min(1, Math.max(-1, v.y / l))) * RAD2DEG;
}

/**
 * Head pitch, degrees: elevation of the ear_mid -> nose vector.
 * Neutral head is around -10..-15 deg (nose slightly below ears),
 * bowed head is strongly negative, raised chin is positive.
 */
export function headPitch(lms: readonly Landmark[]): number {
  const v = sub(getPoint(lms, 'nose'), getPoint(lms, 'ear_mid'));
  const horiz = Math.hypot(v.x, v.z);
  if (horiz < 1e-9 && Math.abs(v.y) < 1e-9) return NaN;
  return Math.atan2(v.y, horiz) * RAD2DEG;
}

/** Scale references so rules are body-size independent. */
export const REFERENCES = ['shoulder_width', 'hip_width', 'torso', 'meter'] as const;
export type ReferenceName = (typeof REFERENCES)[number];

export function referenceLength(lms: readonly Landmark[], ref: ReferenceName): number {
  switch (ref) {
    case 'shoulder_width':
      return dist(lms[J.left_shoulder], lms[J.right_shoulder]);
    case 'hip_width':
      return dist(lms[J.left_hip], lms[J.right_hip]);
    case 'torso':
      return dist(getPoint(lms, 'shoulder_mid'), getPoint(lms, 'hip_mid'));
    case 'meter':
      return 1;
  }
}

export function referenceJoints(ref: ReferenceName): number[] {
  switch (ref) {
    case 'shoulder_width':
      return [J.left_shoulder, J.right_shoulder];
    case 'hip_width':
      return [J.left_hip, J.right_hip];
    case 'torso':
      return [J.left_shoulder, J.right_shoulder, J.left_hip, J.right_hip];
    case 'meter':
      return [];
  }
}

export function computeAllAngles(lms: readonly Landmark[]): Record<AngleName, number> {
  const out = {} as Record<AngleName, number>;
  for (const n of ANGLE_NAMES) out[n] = jointAngle(lms, n);
  return out;
}
