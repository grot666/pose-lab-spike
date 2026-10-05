/**
 * Unified landmark model. Everything outside src/adapters works with these
 * types only - no MediaPipe types leak into core/render/content.
 *
 * World coordinate convention (metres, origin = hip centre, right-handed):
 *   +x = image right (the subject's LEFT side when facing the camera, un-mirrored)
 *   +y = up
 *   +z = toward the camera (in front of a subject who faces the camera)
 * This matches three.js defaults, so render code can consume it directly.
 *
 * Image coordinates: x,y normalised to [0,1] of the (un-mirrored) video frame,
 * y down, z = relative depth (smaller = closer), as produced by the detector.
 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Landmark extends Vec3 {
  /** 0..1 likelihood that the joint is visible (not occluded / in frame). */
  visibility: number;
}

export interface PoseFrame {
  /** Monotonic timestamp in ms (performance.now based). */
  timestampMs: number;
  /** 33 normalised image landmarks. */
  image: Landmark[];
  /** 33 world landmarks, metres, convention above. */
  world: Landmark[];
}

export const JOINT_NAMES = [
  'nose',
  'left_eye_inner',
  'left_eye',
  'left_eye_outer',
  'right_eye_inner',
  'right_eye',
  'right_eye_outer',
  'left_ear',
  'right_ear',
  'mouth_left',
  'mouth_right',
  'left_shoulder',
  'right_shoulder',
  'left_elbow',
  'right_elbow',
  'left_wrist',
  'right_wrist',
  'left_pinky',
  'right_pinky',
  'left_index',
  'right_index',
  'left_thumb',
  'right_thumb',
  'left_hip',
  'right_hip',
  'left_knee',
  'right_knee',
  'left_ankle',
  'right_ankle',
  'left_heel',
  'right_heel',
  'left_foot_index',
  'right_foot_index',
] as const;

export type JointName = (typeof JOINT_NAMES)[number];
export const JOINT_COUNT = JOINT_NAMES.length; // 33

export const J: Record<JointName, number> = Object.fromEntries(
  JOINT_NAMES.map((n, i) => [n, i]),
) as Record<JointName, number>;

/** Virtual points = midpoints of two joints (visibility = min of both). */
export const VIRTUAL_POINTS = {
  shoulder_mid: ['left_shoulder', 'right_shoulder'],
  hip_mid: ['left_hip', 'right_hip'],
  ear_mid: ['left_ear', 'right_ear'],
  wrist_mid: ['left_wrist', 'right_wrist'],
  elbow_mid: ['left_elbow', 'right_elbow'],
  knee_mid: ['left_knee', 'right_knee'],
  ankle_mid: ['left_ankle', 'right_ankle'],
} as const satisfies Record<string, readonly [JointName, JointName]>;

export type VirtualPointName = keyof typeof VIRTUAL_POINTS;
export type PointName = JointName | VirtualPointName;

export function isPointName(s: string): s is PointName {
  return s in J || s in VIRTUAL_POINTS;
}

/** Skeleton edges (same topology as MediaPipe's 33-point pose model). */
export const POSE_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10],
  [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [24, 26], [25, 27], [26, 28], [27, 29], [28, 30], [29, 31], [30, 32], [27, 31], [28, 32],
];

/** Joints whose visibility decides whether the body is tracked at all. */
export const CORE_JOINTS: readonly number[] = [J.left_shoulder, J.right_shoulder, J.left_hip, J.right_hip];
export const WRIST_JOINTS: readonly number[] = [J.left_wrist, J.right_wrist];
export const LOWER_BODY_JOINTS: readonly number[] = [J.left_knee, J.right_knee, J.left_ankle, J.right_ankle];

export function getPoint(lms: readonly Landmark[], name: PointName): Landmark {
  if (name in VIRTUAL_POINTS) {
    const [a, b] = VIRTUAL_POINTS[name as VirtualPointName];
    const pa = lms[J[a]];
    const pb = lms[J[b]];
    return {
      x: (pa.x + pb.x) / 2,
      y: (pa.y + pb.y) / 2,
      z: (pa.z + pb.z) / 2,
      visibility: Math.min(pa.visibility, pb.visibility),
    };
  }
  return lms[J[name as JointName]];
}

/** Which raw joints a point depends on (for visibility checks). */
export function pointJoints(name: PointName): number[] {
  if (name in VIRTUAL_POINTS) {
    const [a, b] = VIRTUAL_POINTS[name as VirtualPointName];
    return [J[a], J[b]];
  }
  return [J[name as JointName]];
}

export function cloneLandmarks(lms: readonly Landmark[]): Landmark[] {
  return lms.map((l) => ({ x: l.x, y: l.y, z: l.z, visibility: l.visibility }));
}

export function cloneFrame(f: PoseFrame): PoseFrame {
  return { timestampMs: f.timestampMs, image: cloneLandmarks(f.image), world: cloneLandmarks(f.world) };
}
