/**
 * Room sync protocol (pure): message shapes, landmark packing, apply helpers.
 * Transport (PeerJS) lives in adapters/; this module is unit-tested without WebRTC.
 *
 * Camera owns detection + session. Viewer renders from received landmarks + snapshots.
 * Safeword from either peer ends the session for both.
 */
import { JOINT_COUNT, type Landmark, type PoseFrame } from './landmarks';
import type { SessionPhase, SessionSnapshot, Outcome, FailReason } from './session';
import type { TrackState } from './tracking';
import type { RoomRole } from './roomCode';

export const ROOM_PROTOCOL_VERSION = 1;

/** Floats per landmark: x, y, z, visibility. */
export const LANDMARK_STRIDE = 4;
export const LANDMARK_FLAT_LEN = JOINT_COUNT * LANDMARK_STRIDE;

export type RoomHelloMsg = {
  v: typeof ROOM_PROTOCOL_VERSION;
  type: 'hello';
  role: RoomRole;
};

export type RoomLandmarksMsg = {
  v: typeof ROOM_PROTOCOL_VERSION;
  type: 'landmarks';
  /** Sender performance.now (opaque; viewer uses for ordering only). */
  t: number;
  /** Image landmarks, flat [x,y,z,vis] * 33. */
  i: number[];
  /** World landmarks, flat [x,y,z,vis] * 33. */
  w: number[];
  track: TrackState;
};

/** Compact session snapshot for the wire (same fields as SessionSnapshot). */
export type RoomSessionMsg = {
  v: typeof ROOM_PROTOCOL_VERSION;
  type: 'session';
  phase: SessionPhase;
  round: number;
  poseId: string | null;
  poseIndex: number;
  step: number;
  total: number;
  paused: boolean;
  enterRemainingMs: number;
  holdElapsedMs: number;
  holdTargetMs: number;
  debounceIn: boolean;
  debounceProgress: number;
  lastOutcome: Outcome | null;
  lastFailReason: FailReason;
  leavesThisAttempt: number;
  personFrames: number;
  subjectN: number;
  /** Last spoken status i18n key (viewer echoes voice line). */
  statusKey: string;
  hint: string | null;
  resultMood: 'success' | 'fail' | 'idle';
};

export type RoomEventMsg = {
  v: typeof ROOM_PROTOCOL_VERSION;
  type: 'event';
  /** Discrete cue for audio / one-shot UI on the viewer. */
  name: 'command' | 'enter' | 'leave' | 'result_success' | 'result_fail' | 'track_lost' | 'track_regained' | 'person_found' | 'round_complete';
};

export type RoomSafewordMsg = {
  v: typeof ROOM_PROTOCOL_VERSION;
  type: 'safeword';
  at: number;
  sourceId: string;
  /** Which side pressed it. */
  from: RoomRole;
};

export type RoomPingMsg = {
  v: typeof ROOM_PROTOCOL_VERSION;
  type: 'ping' | 'pong';
  t: number;
};

export type RoomMessage = RoomHelloMsg | RoomLandmarksMsg | RoomSessionMsg | RoomEventMsg | RoomSafewordMsg | RoomPingMsg;

export function packLandmarks(landmarks: Landmark[]): number[] {
  const out = new Array<number>(LANDMARK_FLAT_LEN);
  for (let j = 0; j < JOINT_COUNT; j++) {
    const lm = landmarks[j];
    const o = j * LANDMARK_STRIDE;
    if (lm) {
      out[o] = lm.x;
      out[o + 1] = lm.y;
      out[o + 2] = lm.z;
      out[o + 3] = lm.visibility;
    } else {
      out[o] = out[o + 1] = out[o + 2] = 0;
      out[o + 3] = 0;
    }
  }
  return out;
}

export function unpackLandmarks(flat: number[]): Landmark[] | null {
  if (!Array.isArray(flat) || flat.length !== LANDMARK_FLAT_LEN) return null;
  const out: Landmark[] = new Array(JOINT_COUNT);
  for (let j = 0; j < JOINT_COUNT; j++) {
    const o = j * LANDMARK_STRIDE;
    out[j] = { x: flat[o], y: flat[o + 1], z: flat[o + 2], visibility: flat[o + 3] };
  }
  return out;
}

export function packPoseFrame(frame: PoseFrame, track: TrackState): RoomLandmarksMsg {
  return {
    v: ROOM_PROTOCOL_VERSION,
    type: 'landmarks',
    t: frame.timestampMs,
    i: packLandmarks(frame.image),
    w: packLandmarks(frame.world),
    track,
  };
}

export function unpackPoseFrame(msg: RoomLandmarksMsg): PoseFrame | null {
  const image = unpackLandmarks(msg.i);
  const world = unpackLandmarks(msg.w);
  if (!image || !world) return null;
  return { timestampMs: msg.t, image, world };
}

export function packSession(
  snap: SessionSnapshot,
  extras: {
    subjectN: number;
    statusKey: string;
    hint: string | null;
    resultMood: 'success' | 'fail' | 'idle';
  },
): RoomSessionMsg {
  return {
    v: ROOM_PROTOCOL_VERSION,
    type: 'session',
    phase: snap.phase,
    round: snap.round,
    poseId: snap.poseId,
    poseIndex: snap.poseIndex,
    step: snap.step,
    total: snap.total,
    paused: snap.paused,
    enterRemainingMs: snap.enterRemainingMs,
    holdElapsedMs: snap.holdElapsedMs,
    holdTargetMs: snap.holdTargetMs,
    debounceIn: snap.debounceIn,
    debounceProgress: snap.debounceProgress,
    lastOutcome: snap.lastOutcome,
    lastFailReason: snap.lastFailReason,
    leavesThisAttempt: snap.leavesThisAttempt,
    personFrames: snap.personFrames,
    subjectN: extras.subjectN,
    statusKey: extras.statusKey,
    hint: extras.hint,
    resultMood: extras.resultMood,
  };
}

export function unpackSessionSnapshot(msg: RoomSessionMsg): SessionSnapshot {
  return {
    phase: msg.phase,
    round: msg.round,
    poseId: msg.poseId,
    poseIndex: msg.poseIndex,
    step: msg.step,
    total: msg.total,
    paused: msg.paused,
    enterRemainingMs: msg.enterRemainingMs,
    holdElapsedMs: msg.holdElapsedMs,
    holdTargetMs: msg.holdTargetMs,
    debounceIn: msg.debounceIn,
    debounceProgress: msg.debounceProgress,
    lastOutcome: msg.lastOutcome,
    lastFailReason: msg.lastFailReason,
    leavesThisAttempt: msg.leavesThisAttempt,
    personFrames: msg.personFrames,
  };
}

const PHASES = new Set<SessionPhase>(['idle', 'searching', 'command', 'entering', 'holding', 'result', 'report', 'stopped']);
const TRACKS = new Set<TrackState>(['idle', 'tracking', 'partial', 'lost']);
const ROLES = new Set<RoomRole>(['camera', 'viewer']);

function isNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function isStr(x: unknown): x is string {
  return typeof x === 'string';
}

/** Validate + narrow an unknown JSON payload into a RoomMessage (or null). */
export function parseRoomMessage(raw: unknown): RoomMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.v !== ROOM_PROTOCOL_VERSION || typeof m.type !== 'string') return null;

  switch (m.type) {
    case 'hello':
      if (!ROLES.has(m.role as RoomRole)) return null;
      return { v: ROOM_PROTOCOL_VERSION, type: 'hello', role: m.role as RoomRole };
    case 'landmarks': {
      if (!isNum(m.t) || !Array.isArray(m.i) || !Array.isArray(m.w) || !TRACKS.has(m.track as TrackState)) return null;
      if (m.i.length !== LANDMARK_FLAT_LEN || m.w.length !== LANDMARK_FLAT_LEN) return null;
      if (!m.i.every(isNum) || !m.w.every(isNum)) return null;
      return {
        v: ROOM_PROTOCOL_VERSION,
        type: 'landmarks',
        t: m.t,
        i: m.i as number[],
        w: m.w as number[],
        track: m.track as TrackState,
      };
    }
    case 'session': {
      if (!PHASES.has(m.phase as SessionPhase)) return null;
      if (!isNum(m.round) || !isNum(m.poseIndex) || !isNum(m.step) || !isNum(m.total)) return null;
      if (typeof m.paused !== 'boolean' || typeof m.debounceIn !== 'boolean') return null;
      if (!isNum(m.enterRemainingMs) || !isNum(m.holdElapsedMs) || !isNum(m.holdTargetMs)) return null;
      if (!isNum(m.debounceProgress) || !isNum(m.leavesThisAttempt) || !isNum(m.personFrames) || !isNum(m.subjectN)) return null;
      if (m.poseId !== null && !isStr(m.poseId)) return null;
      if (!isStr(m.statusKey)) return null;
      if (m.hint !== null && !isStr(m.hint)) return null;
      const mood = m.resultMood;
      if (mood !== 'success' && mood !== 'fail' && mood !== 'idle') return null;
      const lastOutcome = m.lastOutcome;
      if (lastOutcome !== null && lastOutcome !== 'success' && lastOutcome !== 'fail') return null;
      const lastFailReason = m.lastFailReason;
      if (lastFailReason !== 'none' && lastFailReason !== 'enter_timeout') return null;
      return {
        v: ROOM_PROTOCOL_VERSION,
        type: 'session',
        phase: m.phase as SessionPhase,
        round: m.round,
        poseId: m.poseId as string | null,
        poseIndex: m.poseIndex,
        step: m.step,
        total: m.total,
        paused: m.paused,
        enterRemainingMs: m.enterRemainingMs,
        holdElapsedMs: m.holdElapsedMs,
        holdTargetMs: m.holdTargetMs,
        debounceIn: m.debounceIn,
        debounceProgress: m.debounceProgress,
        lastOutcome: lastOutcome as Outcome | null,
        lastFailReason: lastFailReason as FailReason,
        leavesThisAttempt: m.leavesThisAttempt,
        personFrames: m.personFrames,
        subjectN: m.subjectN,
        statusKey: m.statusKey,
        hint: m.hint as string | null,
        resultMood: mood,
      };
    }
    case 'event': {
      const names = new Set([
        'command',
        'enter',
        'leave',
        'result_success',
        'result_fail',
        'track_lost',
        'track_regained',
        'person_found',
        'round_complete',
      ]);
      if (!names.has(m.name as string)) return null;
      return { v: ROOM_PROTOCOL_VERSION, type: 'event', name: m.name as RoomEventMsg['name'] };
    }
    case 'safeword':
      if (!isNum(m.at) || !isStr(m.sourceId) || !ROLES.has(m.from as RoomRole)) return null;
      return { v: ROOM_PROTOCOL_VERSION, type: 'safeword', at: m.at, sourceId: m.sourceId, from: m.from as RoomRole };
    case 'ping':
    case 'pong':
      if (!isNum(m.t)) return null;
      return { v: ROOM_PROTOCOL_VERSION, type: m.type, t: m.t };
    default:
      return null;
  }
}

/**
 * Apply ordering for landmark streams: drop stale frames (lower t than last accepted).
 * Returns the new last-accepted timestamp, or null if the frame was dropped.
 */
export function acceptLandmarkTimestamp(prevAccepted: number, incoming: number): number | null {
  if (!Number.isFinite(incoming)) return null;
  if (incoming < prevAccepted) return null;
  return incoming;
}
