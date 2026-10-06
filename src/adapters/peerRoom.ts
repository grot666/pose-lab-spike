/**
 * PeerJS room transport for the multi-device spike.
 *
 * Camera opens as host with a deterministic peer id (`poselab-{CODE}`).
 * Viewer connects to that id. Data channel uses JSON serialization (no CBOR /
 * unsafe-eval). Signaling goes through the PeerJS cloud free broker
 * (0.peerjs.com) — documented dependency; CSP allows that host only.
 */
import { Peer, type DataConnection, type PeerJSOption } from 'peerjs';
import { roomHostPeerId, type RoomRole } from '../core/roomCode';
import { parseRoomMessage, ROOM_PROTOCOL_VERSION, type RoomMessage } from '../core/roomProtocol';
import { config } from '../config';

export type PeerRoomState = 'idle' | 'connecting' | 'waiting_peer' | 'connected' | 'closed' | 'error';

export type PeerRoomListener = {
  onState?: (state: PeerRoomState, detail?: string) => void;
  onMessage?: (msg: RoomMessage) => void;
  onPeerRole?: (role: RoomRole) => void;
};

export interface PeerRoomOptions {
  role: RoomRole;
  room: string;
  /** Override PeerJS cloud options (tests / self-host). */
  peerOptions?: PeerJSOption;
  /** Injectable Peer constructor (tests). */
  PeerCtor?: typeof Peer;
}

/**
 * Thin wrapper around PeerJS. Owns one data connection to the other role.
 * Call `destroy()` on safeword / teardown.
 */
export class PeerRoom {
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private state: PeerRoomState = 'idle';
  private destroyed = false;
  private readonly listeners: PeerRoomListener;
  private readonly role: RoomRole;
  private readonly room: string;
  private readonly PeerCtor: typeof Peer;
  private readonly peerOptions: PeerJSOption;
  private reconnectTimer = 0;
  private viewerAttempts = 0;

  constructor(opts: PeerRoomOptions, listeners: PeerRoomListener = {}) {
    this.role = opts.role;
    this.room = opts.room;
    this.listeners = listeners;
    this.PeerCtor = opts.PeerCtor ?? Peer;
    this.peerOptions = {
      host: config.room.peerHost,
      port: config.room.peerPort,
      path: config.room.peerPath,
      secure: config.room.peerSecure,
      debug: 0,
      ...opts.peerOptions,
    };
  }

  get currentState(): PeerRoomState {
    return this.state;
  }

  get connected(): boolean {
    return this.state === 'connected' && !!this.conn?.open;
  }

  /** Open signaling + wait for / dial the peer. */
  start(): void {
    if (this.destroyed || this.peer) return;
    this.setState('connecting');
    const hostId = roomHostPeerId(this.room);

    if (this.role === 'camera') {
      this.peer = new this.PeerCtor(hostId, this.peerOptions);
      this.wirePeer();
      this.peer.on('open', () => {
        if (this.destroyed) return;
        this.setState('waiting_peer');
      });
      this.peer.on('connection', (conn) => {
        if (this.destroyed) return;
        if (this.conn) {
          // already have a peer; reject extras
          conn.close();
          return;
        }
        this.attachConn(conn);
      });
    } else {
      // viewer: ephemeral id, dial the camera host
      this.peer = new this.PeerCtor(this.peerOptions);
      this.wirePeer();
      this.peer.on('open', () => {
        if (this.destroyed) return;
        this.dialHost(hostId);
      });
    }
  }

  private wirePeer(): void {
    this.peer?.on('error', (err) => {
      if (this.destroyed) return;
      const msg = String((err as { type?: string; message?: string })?.type ?? (err as Error)?.message ?? err);
      // viewer: peer-unavailable is expected until camera joins — keep retrying
      if (this.role === 'viewer' && /peer-unavailable|network|server-error/i.test(msg)) {
        this.setState('waiting_peer', msg);
        this.scheduleViewerRetry();
        return;
      }
      // camera: id taken means another camera is already hosting this room
      if (this.role === 'camera' && /unavailable-id|peer-unavailable/i.test(msg)) {
        this.setState('error', 'room_taken');
        return;
      }
      this.setState('error', msg);
    });
    this.peer?.on('disconnected', () => {
      if (this.destroyed) return;
      try {
        this.peer?.reconnect();
      } catch {
        /* ignore */
      }
    });
    this.peer?.on('close', () => {
      if (this.destroyed) return;
      this.setState('closed');
    });
  }

  private dialHost(hostId: string): void {
    if (this.destroyed || !this.peer) return;
    this.setState(this.viewerAttempts === 0 ? 'connecting' : 'waiting_peer');
    const conn = this.peer.connect(hostId, { reliable: true, serialization: 'json' });
    this.attachConn(conn);
  }

  private scheduleViewerRetry(): void {
    if (this.destroyed || this.role !== 'viewer') return;
    window.clearTimeout(this.reconnectTimer);
    this.viewerAttempts++;
    const delay = Math.min(8000, 800 + this.viewerAttempts * 400);
    this.reconnectTimer = window.setTimeout(() => {
      if (this.destroyed || this.connected) return;
      try {
        this.conn?.close();
      } catch {
        /* ignore */
      }
      this.conn = null;
      if (this.peer?.open) this.dialHost(roomHostPeerId(this.room));
    }, delay);
  }

  private attachConn(conn: DataConnection): void {
    this.conn = conn;
    conn.on('open', () => {
      if (this.destroyed) return;
      this.viewerAttempts = 0;
      window.clearTimeout(this.reconnectTimer);
      this.setState('connected');
      this.send({ v: ROOM_PROTOCOL_VERSION, type: 'hello', role: this.role });
    });
    conn.on('data', (data) => {
      const msg = parseRoomMessage(data);
      if (!msg) return;
      if (msg.type === 'hello') this.listeners.onPeerRole?.(msg.role);
      if (msg.type === 'ping') {
        this.send({ v: ROOM_PROTOCOL_VERSION, type: 'pong', t: msg.t });
        return;
      }
      this.listeners.onMessage?.(msg);
    });
    conn.on('close', () => {
      if (this.destroyed) return;
      this.conn = null;
      if (this.role === 'viewer') {
        this.setState('waiting_peer', 'peer_closed');
        this.scheduleViewerRetry();
      } else {
        this.setState('waiting_peer', 'peer_closed');
      }
    });
    conn.on('error', (err) => {
      if (this.destroyed) return;
      console.warn('[peer-room] conn error', err);
      if (this.role === 'viewer') this.scheduleViewerRetry();
    });
  }

  send(msg: RoomMessage): boolean {
    if (!this.conn?.open) return false;
    try {
      this.conn.send(msg);
      return true;
    } catch (err) {
      console.warn('[peer-room] send failed', err);
      return false;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    window.clearTimeout(this.reconnectTimer);
    try {
      this.conn?.close();
    } catch {
      /* ignore */
    }
    this.conn = null;
    try {
      this.peer?.destroy();
    } catch {
      /* ignore */
    }
    this.peer = null;
    this.setState('closed');
  }

  private setState(state: PeerRoomState, detail?: string): void {
    this.state = state;
    this.listeners.onState?.(state, detail);
  }
}
