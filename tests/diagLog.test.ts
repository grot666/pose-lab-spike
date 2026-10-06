import { describe, expect, it } from 'vitest';
import { DiagLog } from '../src/core/diagLog';

describe('DiagLog', () => {
  it('keeps insertion order until capacity, then overwrites oldest', () => {
    const log = new DiagLog(3);
    log.push('a', '1');
    log.push('a', '2');
    log.push('a', '3');
    expect(log.events().map((e) => e.msg)).toEqual(['1', '2', '3']);
    log.push('a', '4');
    expect(log.events().map((e) => e.msg)).toEqual(['2', '3', '4']);
    expect(log.size).toBe(3);
  });

  it('formats lines with tag and data', () => {
    const log = new DiagLog(5);
    log.push('detect', 'miss', { faces: 0, w: 640 });
    const line = log.lines(1)[0]!;
    expect(line).toMatch(/\[detect\] miss/);
    expect(line).toContain('faces=0');
    expect(line).toContain('w=640');
  });

  it('text() joins lines', () => {
    const log = new DiagLog(5);
    log.push('cam', 'ready');
    log.push('model', 'loaded');
    expect(log.text().split('\n')).toHaveLength(2);
  });
});
