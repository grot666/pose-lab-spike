/**
 * Synthetic 33-joint skeletons for rule tests, in the unified world convention
 * (metres, origin hip centre, +x image-right = subject's left, +y up, +z toward camera).
 * Body: shoulder width 0.36, hip width 0.20, torso 0.50, thigh/shin ~0.45.
 */
import { J, JOINT_COUNT, type Landmark, type PoseFrame, type Vec3 } from '../../src/core/landmarks';

type V = [number, number, number];
type Head = 'neutral' | 'down' | 'up';

export interface SkeletonSpec {
  elbows: [V, V]; // [left, right]
  wrists: [V, V];
  knees: [V, V];
  ankles: [V, V];
  head?: Head;
  /** Visibility overrides by joint name. */
  vis?: Partial<Record<keyof typeof J, number>>;
}

const v = (p: V): Vec3 => ({ x: p[0], y: p[1], z: p[2] });

const HEADS: Record<Head, { nose: V; ear: V }> = {
  neutral: { nose: [0, 0.72, 0.08], ear: [0.07, 0.74, -0.02] },
  down: { nose: [0, 0.64, 0.07], ear: [0.07, 0.72, 0.0] },
  up: { nose: [0, 0.77, 0.06], ear: [0.07, 0.73, -0.02] },
};

export function buildSkeleton(spec: SkeletonSpec): Landmark[] {
  const lms: Landmark[] = Array.from({ length: JOINT_COUNT }, () => ({ x: 0, y: 0, z: 0, visibility: 0.95 }));
  const set = (name: keyof typeof J, p: Vec3) => Object.assign(lms[J[name]], p);
  const head = HEADS[spec.head ?? 'neutral'];

  set('left_shoulder', v([0.18, 0.5, 0]));
  set('right_shoulder', v([-0.18, 0.5, 0]));
  set('left_hip', v([0.1, 0, 0]));
  set('right_hip', v([-0.1, 0, 0]));
  set('nose', v(head.nose));
  set('left_ear', v(head.ear));
  set('right_ear', v([-head.ear[0], head.ear[1], head.ear[2]]));
  const [n0, n1, n2] = head.nose;
  set('left_eye_inner', v([n0 + 0.015, n1 + 0.025, n2 - 0.01]));
  set('left_eye', v([n0 + 0.03, n1 + 0.027, n2 - 0.015]));
  set('left_eye_outer', v([n0 + 0.045, n1 + 0.025, n2 - 0.02]));
  set('right_eye_inner', v([n0 - 0.015, n1 + 0.025, n2 - 0.01]));
  set('right_eye', v([n0 - 0.03, n1 + 0.027, n2 - 0.015]));
  set('right_eye_outer', v([n0 - 0.045, n1 + 0.025, n2 - 0.02]));
  set('mouth_left', v([n0 + 0.025, n1 - 0.035, n2 - 0.01]));
  set('mouth_right', v([n0 - 0.025, n1 - 0.035, n2 - 0.01]));

  const sides = ['left', 'right'] as const;
  sides.forEach((s, i) => {
    set(`${s}_elbow`, v(spec.elbows[i]));
    set(`${s}_wrist`, v(spec.wrists[i]));
    set(`${s}_knee`, v(spec.knees[i]));
    set(`${s}_ankle`, v(spec.ankles[i]));
    // hand points: extend 6 cm along the forearm direction
    const e = spec.elbows[i];
    const w = spec.wrists[i];
    const d = [w[0] - e[0], w[1] - e[1], w[2] - e[2]];
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    const hand = (k: number): Vec3 => v([w[0] + (d[0] / l) * k, w[1] + (d[1] / l) * k, w[2] + (d[2] / l) * k]);
    set(`${s}_pinky`, hand(0.07));
    set(`${s}_index`, hand(0.08));
    set(`${s}_thumb`, hand(0.04));
    const a = spec.ankles[i];
    set(`${s}_heel`, v([a[0], a[1] - 0.04, a[2] - 0.05]));
    set(`${s}_foot_index`, v([a[0], a[1] - 0.06, a[2] + 0.15]));
  });

  for (const [name, vis] of Object.entries(spec.vis ?? {})) lms[J[name as keyof typeof J]].visibility = vis as number;
  // hand points inherit wrist visibility
  for (const s of sides) {
    for (const p of ['pinky', 'index', 'thumb'] as const) lms[J[`${s}_${p}`]].visibility = lms[J[`${s}_wrist`]].visibility;
  }
  return lms;
}

/** Mirror pair helper: left value given, right gets x negated. */
const pair = (p: V): [V, V] => [p, [-p[0], p[1], p[2]]];

const STANDING_LEGS = { knees: pair([0.1, -0.45, 0]), ankles: pair([0.06, -0.9, -0.02]) };
const ARMS_AT_SIDES = { elbows: pair([0.2, 0.2, 0]), wrists: pair([0.21, -0.07, 0]) };
const HIGH_KNEEL_LEGS = { knees: pair([0.1, -0.45, 0.02]), ankles: pair([0.1, -0.5, -0.4]) };
const LOW_VIS_ANKLES = { left_ankle: 0.4, right_ankle: 0.4 };

export const FIXTURES = {
  attention: buildSkeleton({ ...STANDING_LEGS, ...ARMS_AT_SIDES }),
  at_your_service: buildSkeleton({
    knees: pair([0.13, -0.45, 0]),
    ankles: pair([0.17, -0.9, -0.02]),
    elbows: pair([0.2, 0.22, -0.08]),
    wrists: pair([0.03, 0.0, -0.15]),
    vis: { left_wrist: 0.15, right_wrist: 0.2 },
  }),
  inspection: buildSkeleton({
    knees: pair([0.22, -0.45, 0]),
    ankles: pair([0.3, -0.9, -0.02]),
    elbows: pair([0.36, 0.72, -0.02]),
    wrists: pair([0.06, 0.82, -0.08]),
  }),
  wait: buildSkeleton({
    ...STANDING_LEGS,
    elbows: pair([0.2, 0.22, 0.05]),
    wrists: pair([0.04, -0.02, 0.15]),
    head: 'down',
  }),
  kneel: buildSkeleton({ ...HIGH_KNEEL_LEGS, ...ARMS_AT_SIDES, vis: LOW_VIS_ANKLES }),
  nadu: buildSkeleton({
    knees: pair([0.25, -0.12, 0.38]),
    ankles: pair([0.12, -0.2, -0.05]),
    elbows: pair([0.22, 0.22, 0.12]),
    wrists: pair([0.2, -0.04, 0.25]),
    vis: { left_ankle: 0.3, right_ankle: 0.3 },
  }),
  collar_me: buildSkeleton({
    ...HIGH_KNEEL_LEGS,
    elbows: pair([0.32, 0.68, 0]),
    wrists: pair([0.07, 0.72, -0.07]),
    head: 'up',
    vis: LOW_VIS_ANKLES,
  }),
} as const;

export type FixtureName = keyof typeof FIXTURES;

/** Wrap world landmarks into a PoseFrame with a simple orthographic image projection. */
export function toFrame(world: Landmark[], timestampMs = 0): PoseFrame {
  return {
    timestampMs,
    world,
    image: world.map((l) => ({ x: 0.5 + l.x / 2.4, y: 0.5 - l.y / 2.4, z: -l.z, visibility: l.visibility })),
  };
}

/** Deterministic PRNG (mulberry32) for noise tests. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
