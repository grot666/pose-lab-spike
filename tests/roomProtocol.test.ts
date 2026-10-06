import { describe, expect, it } from 'vitest';
import { JOINT_COUNT, type Landmark, type PoseFrame } from '../src/core/landmarks';
import {
  acceptLandmarkTimestamp,
  LANDMARK_FLAT_LEN,
  packLandmarks,
  packPoseFrame,
  packSession,
  parseRoomMessage,
  ROOM_PROTOCOL_VERSION,
  unpackLandmarks,
  unpackPoseFrame,
  unpackSessionSnapshot,
} from '../src/core/roomProtocol';
import type { SessionSnapshot } from '../src/core/session';

function fakeLandmarks(seed = 0): Landmark[] {
  return Array.from({ length: JOINT_COUNT }, (_, j) => ({
    x: seed + j * 0.01,
    y: seed + j * 0.02,
    z: seed + j * 0.03,
    visibility: (j % 10) / 10,
  }));
}

describe('roomProtocol packing', () => {
  it('round-trips landmarks', () => {
    const lm = fakeLandmarks(1);
    const flat = packLandmarks(lm);
    expect(flat).toHaveLength(LANDMARK_FLAT_LEN);
    const back = unpackLandmarks(flat)!;
    expect(back).toHaveLength(JOINT_COUNT);
    expect(back[0]).toEqual(lm[0]);
    expect(back[32]).toEqual(lm[32]);
  });

  it('rejects wrong-length flat arrays', () => {
    expect(unpackLandmarks([1, 2, 3])).toBeNull();
  });

  it('round-trips a pose frame message', () => {
    const frame: PoseFrame = { timestampMs: 42, image: fakeLandmarks(0), world: fakeLandmarks(1) };
    const msg = packPoseFrame(frame, 'tracking');
    expect(msg.type).toBe('landmarks');
    expect(msg.v).toBe(ROOM_PROTOCOL_VERSION);
    const back = unpackPoseFrame(msg)!;
    expect(back.timestampMs).toBe(42);
    expect(back.image[5]).toEqual(frame.image[5]);
    expect(back.world[5]).toEqual(frame.world[5]);
  });

  it('round-trips session snapshot fields', () => {
    const snap: SessionSnapshot = {
      phase: 'holding',
      round: 2,
      poseId: 'kneel',
      poseIndex: 3,
      step: 1,
      total: 7,
      paused: false,
      enterRemainingMs: 0,
      holdElapsedMs: 1200,
      holdTargetMs: 5000,
      debounceIn: true,
      debounceProgress: 0.5,
      lastOutcome: 'success',
      lastFailReason: 'none',
      leavesThisAttempt: 1,
      personFrames: 15,
    };
    const msg = packSession(snap, { subjectN: 4242, statusKey: 'status.holding', hint: null, resultMood: 'idle' });
    const back = unpackSessionSnapshot(msg);
    expect(back).toEqual(snap);
    expect(msg.subjectN).toBe(4242);
    expect(msg.statusKey).toBe('status.holding');
  });
});

describe('roomProtocol parse + ordering', () => {
  it('parses hello / safeword / event and rejects garbage', () => {
    expect(parseRoomMessage({ v: 1, type: 'hello', role: 'camera' })).toEqual({
      v: 1,
      type: 'hello',
      role: 'camera',
    });
    expect(parseRoomMessage({ v: 1, type: 'safeword', at: 9, sourceId: 'corner', from: 'viewer' })?.type).toBe('safeword');
    expect(parseRoomMessage({ v: 1, type: 'event', name: 'command' })?.type).toBe('event');
    expect(parseRoomMessage({ v: 99, type: 'hello', role: 'camera' })).toBeNull();
    expect(parseRoomMessage({ v: 1, type: 'hello', role: 'nope' })).toBeNull();
    expect(parseRoomMessage(null)).toBeNull();
    expect(parseRoomMessage({ v: 1, type: 'landmarks', t: 1, i: [1], w: [1], track: 'tracking' })).toBeNull();
  });

  it('acceptLandmarkTimestamp drops stale frames', () => {
    expect(acceptLandmarkTimestamp(100, 100)).toBe(100);
    expect(acceptLandmarkTimestamp(100, 101)).toBe(101);
    expect(acceptLandmarkTimestamp(100, 99)).toBeNull();
    expect(acceptLandmarkTimestamp(0, Number.NaN)).toBeNull();
  });

  it('parse round-trips a packed landmarks message', () => {
    const frame: PoseFrame = { timestampMs: 7, image: fakeLandmarks(2), world: fakeLandmarks(3) };
    const packed = packPoseFrame(frame, 'partial');
    const parsed = parseRoomMessage(packed);
    expect(parsed).toEqual(packed);
  });
});
