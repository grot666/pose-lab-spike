import { describe, expect, it } from 'vitest';
import {
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
  parseRoomParams,
  parseRoomRole,
  ROOM_CODE_LENGTH,
  roomHostPeerId,
  roomUrl,
} from '../src/core/roomCode';

describe('roomCode', () => {
  it('generates valid codes of fixed length', () => {
    let i = 0;
    const seq = [0.01, 0.2, 0.4, 0.9, 0.5, 0.7, 0.3, 0.8];
    const code = generateRoomCode(() => seq[i++ % seq.length]!);
    expect(code).toHaveLength(ROOM_CODE_LENGTH);
    expect(isValidRoomCode(code)).toBe(true);
  });

  it('normalises case, separators, and strips ambiguous glyphs', () => {
    expect(normalizeRoomCode(' ab-cd ')).toBe('ABCD');
    expect(normalizeRoomCode('a1o0')).toBe('A'); // 1,O,0 stripped
    expect(normalizeRoomCode('WXYZ')).toBe('WXYZ');
    expect(isValidRoomCode(normalizeRoomCode('w-x-y-z'))).toBe(true);
  });

  it('rejects invalid / short codes', () => {
    expect(isValidRoomCode('AB')).toBe(false);
    expect(isValidRoomCode('ABC1')).toBe(false); // 1 not in alphabet
    expect(isValidRoomCode('ABCD')).toBe(true);
  });

  it('builds host peer id and parses URL params', () => {
    expect(roomHostPeerId('ABCD')).toBe('poselab-ABCD');
    expect(() => roomHostPeerId('bad')).toThrow();
    expect(parseRoomRole('camera')).toBe('camera');
    expect(parseRoomRole('nope')).toBeNull();
    expect(parseRoomParams('?role=viewer&room=ab-cd')).toEqual({ role: 'viewer', room: 'ABCD' });
    expect(parseRoomParams('?role=camera')).toBeNull();
    expect(parseRoomParams('')).toBeNull();
  });

  it('roomUrl sets role and room while preserving other params', () => {
    const u = roomUrl('camera', 'WXYZ', 'https://example.com/pose/?lang=en&debug=1');
    const q = new URL(u).searchParams;
    expect(q.get('role')).toBe('camera');
    expect(q.get('room')).toBe('WXYZ');
    expect(q.get('lang')).toBe('en');
    expect(q.get('debug')).toBe('1');
  });
});
