/**
 * Short room codes for multi-device sessions (no accounts).
 * Alphabet omits ambiguous glyphs (0/O, 1/I/L) so codes are easy to read aloud.
 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 4;
export const ROOM_PEER_PREFIX = 'poselab';

const CODE_RE = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

/** Normalise user input: trim, upper-case, strip spaces/separators and invalid glyphs. */
export function normalizeRoomCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/O/g, '') // ambiguous with 0 (neither in alphabet)
    .replace(/[IL]/g, '') // ambiguous with 1
    .replace(/[01]/g, '')
    .replace(new RegExp(`[^${ROOM_CODE_ALPHABET}]`, 'g'), '')
    .slice(0, ROOM_CODE_LENGTH);
}

/** True when `code` is already a valid normalised room code. */
export function isValidRoomCode(code: string): boolean {
  return CODE_RE.test(code);
}

/** Generate a random room code (injectable RNG for tests). */
export function generateRoomCode(random: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    out += ROOM_CODE_ALPHABET[Math.floor(random() * ROOM_CODE_ALPHABET.length) % ROOM_CODE_ALPHABET.length];
  }
  return out;
}

/**
 * Deterministic PeerJS peer id for the camera (host) of a room.
 * Viewer connects to this id; camera opens with it.
 */
export function roomHostPeerId(code: string): string {
  if (!isValidRoomCode(code)) throw new Error(`invalid room code: ${code}`);
  return `${ROOM_PEER_PREFIX}-${code}`;
}

export type RoomRole = 'camera' | 'viewer';

export function parseRoomRole(raw: string | null | undefined): RoomRole | null {
  if (raw === 'camera' || raw === 'viewer') return raw;
  return null;
}

/** Read `?role=` + `?room=` from a search string. Both required for room mode. */
export function parseRoomParams(search: string): { role: RoomRole; room: string } | null {
  const q = new URLSearchParams(search.startsWith('?') ? search : `?${search}`);
  const role = parseRoomRole(q.get('role'));
  const room = normalizeRoomCode(q.get('room') ?? '');
  if (!role || !isValidRoomCode(room)) return null;
  return { role, room };
}

/** Build a same-origin URL with role + room (preserves other query params). */
export function roomUrl(
  role: RoomRole,
  room: string,
  baseHref = typeof location !== 'undefined' ? location.href : 'https://example/',
): string {
  const url = new URL(baseHref);
  url.searchParams.set('role', role);
  url.searchParams.set('room', room);
  return url.toString();
}
