/**
 * Coordinates PeerRoom transport with the room protocol helpers.
 * Keeps send-rate throttling and last-accepted landmark ordering here so App stays thinner.
 */
import { PeerRoom, type PeerRoomState } from '../adapters/peerRoom';
import type { RoomRole } from '../core/roomCode';
import {
  acceptLandmarkTimestamp,
  packPoseFrame,
  packSession,
  ROOM_PROTOCOL_VERSION,
  type RoomEventMsg,
  type RoomMessage,
  type RoomSessionMsg,
  unpackPoseFrame,
  unpackSessionSnapshot,
} from '../core/roomProtocol';
import type { PoseFrame } from '../core/landmarks';
import type { SessionSnapshot } from '../core/session';
import type { TrackState } from '../core/tracking';
import { config } from '../config';

export type RoomBridgeHandlers = {
  onState: (state: PeerRoomState, detail?: string) => void;
  onLandmarks: (frame: PoseFrame, track: TrackState) => void;
  onSession: (msg: RoomSessionMsg, snap: SessionSnapshot) => void;
  onEvent: (name: RoomEventMsg['name']) => void;
  onRemoteSafeword: (from: RoomRole, sourceId: string) => void;
};

export class RoomBridge {
  private room: PeerRoom;
  private lastLandmarkSent = 0;
  private lastSessionSent = 0;
  private lastAcceptedT = 0;
  private readonly landmarkMinMs: number;
  private readonly sessionMinMs: number;
  readonly role: RoomRole;
  readonly code: string;

  constructor(role: RoomRole, code: string, private handlers: RoomBridgeHandlers) {
    this.role = role;
    this.code = code;
    this.landmarkMinMs = 1000 / Math.max(1, config.room.landmarkHz);
    this.sessionMinMs = 1000 / Math.max(1, config.room.sessionHz);
    this.room = new PeerRoom(
      { role, room: code },
      {
        onState: (s, d) => this.handlers.onState(s, d),
        onMessage: (m) => this.handle(m),
      },
    );
  }

  get connected(): boolean {
    return this.room.connected;
  }

  get state(): PeerRoomState {
    return this.room.currentState;
  }

  start(): void {
    this.room.start();
  }

  destroy(): void {
    this.room.destroy();
  }

  /** Camera → peers: landmarks (rate-limited). */
  sendLandmarks(frame: PoseFrame, track: TrackState, now = performance.now()): void {
    if (this.role !== 'camera' || !this.room.connected) return;
    if (now - this.lastLandmarkSent < this.landmarkMinMs) return;
    this.lastLandmarkSent = now;
    this.room.send(packPoseFrame(frame, track));
  }

  /** Camera → peers: session snapshot (rate-limited). */
  sendSession(
    snap: SessionSnapshot,
    extras: { subjectN: number; statusKey: string; hint: string | null; resultMood: 'success' | 'fail' | 'idle' },
    now = performance.now(),
    force = false,
  ): void {
    if (this.role !== 'camera' || !this.room.connected) return;
    if (!force && now - this.lastSessionSent < this.sessionMinMs) return;
    this.lastSessionSent = now;
    this.room.send(packSession(snap, extras));
  }

  sendEvent(name: RoomEventMsg['name']): void {
    if (this.role !== 'camera' || !this.room.connected) return;
    this.room.send({ v: ROOM_PROTOCOL_VERSION, type: 'event', name });
  }

  sendSafeword(sourceId: string, at = performance.now()): void {
    this.room.send({
      v: ROOM_PROTOCOL_VERSION,
      type: 'safeword',
      at,
      sourceId,
      from: this.role,
    });
  }

  private handle(msg: RoomMessage): void {
    switch (msg.type) {
      case 'landmarks': {
        if (this.role !== 'viewer') return;
        const next = acceptLandmarkTimestamp(this.lastAcceptedT, msg.t);
        if (next === null) return;
        this.lastAcceptedT = next;
        const frame = unpackPoseFrame(msg);
        if (frame) this.handlers.onLandmarks(frame, msg.track);
        break;
      }
      case 'session': {
        if (this.role !== 'viewer') return;
        this.handlers.onSession(msg, unpackSessionSnapshot(msg));
        break;
      }
      case 'event':
        if (this.role !== 'viewer') return;
        this.handlers.onEvent(msg.name);
        break;
      case 'safeword':
        if (msg.from === this.role) return; // ignore echo
        this.handlers.onRemoteSafeword(msg.from, msg.sourceId);
        break;
      default:
        break;
    }
  }
}
