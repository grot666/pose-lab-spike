import { describe, expect, it, vi } from 'vitest';
import { ButtonSafewordSource, SafewordController, type ButtonLike, type SafewordSource } from '../src/core/safeword';

class FakeButton implements ButtonLike {
  listeners = new Map<string, Set<(e: unknown) => void>>();
  addEventListener(type: string, fn: (e: unknown) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  fire(type: string) {
    const e = { preventDefault: vi.fn() };
    this.listeners.get(type)?.forEach((fn) => fn(e));
    return e;
  }
  count() {
    return [...this.listeners.values()].reduce((s, l) => s + l.size, 0);
  }
}

describe('SafewordController + ButtonSafewordSource', () => {
  it('fires listeners exactly once on button press and disarms all sources', () => {
    const btn = new FakeButton();
    const ctl = new SafewordController([new ButtonSafewordSource(btn, 'corner', () => 123)]);
    const spy = vi.fn();
    ctl.onTrigger(spy);
    ctl.arm();
    expect(btn.count()).toBe(2);
    btn.fire('pointerdown');
    btn.fire('click'); // same physical press -> ignored by latch (already detached)
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ sourceId: 'corner', kind: 'button', at: 123 });
    expect(ctl.triggered).toBe(true);
    expect(ctl.isArmed).toBe(false);
    expect(btn.count()).toBe(0);
  });

  it('does nothing before arm()', () => {
    const btn = new FakeButton();
    const ctl = new SafewordController([new ButtonSafewordSource(btn)]);
    const spy = vi.fn();
    ctl.onTrigger(spy);
    btn.fire('pointerdown');
    expect(spy).not.toHaveBeenCalled();
  });

  it('prevents default on press (no ghost clicks / zoom)', () => {
    const btn = new FakeButton();
    const ctl = new SafewordController([new ButtonSafewordSource(btn)]);
    ctl.arm();
    const e = btn.fire('pointerdown');
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('is final: cannot be re-armed; late subscribers are told immediately', () => {
    const ctl = new SafewordController([], () => 5);
    ctl.arm();
    ctl.trigger('test');
    ctl.arm();
    expect(ctl.isArmed).toBe(false);
    const late = vi.fn();
    ctl.onTrigger(late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('first source wins when several fire', () => {
    const mk = (id: string): SafewordSource & { fire: () => void } => {
      let trig: ((e: { sourceId: string; kind: 'external'; at: number }) => void) | null = null;
      return {
        id,
        kind: 'external',
        attach: (t) => (trig = t),
        detach: () => (trig = null),
        fire: () => trig?.({ sourceId: id, kind: 'external', at: 0 }),
      };
    };
    const a = mk('a');
    const b = mk('b');
    const ctl = new SafewordController([a, b]);
    const spy = vi.fn();
    ctl.onTrigger(spy);
    ctl.arm();
    b.fire();
    a.fire();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(ctl.lastEvent?.sourceId).toBe('b');
  });

  it('a throwing listener does not block the others', () => {
    const ctl = new SafewordController([]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ok = vi.fn();
    ctl.onTrigger(() => {
      throw new Error('boom');
    });
    ctl.onTrigger(ok);
    ctl.arm();
    ctl.trigger();
    expect(ok).toHaveBeenCalled();
    err.mockRestore();
  });

  it('rejects duplicate source ids', () => {
    const btn = new FakeButton();
    const ctl = new SafewordController([new ButtonSafewordSource(btn, 'x')]);
    expect(() => ctl.addSource(new ButtonSafewordSource(btn, 'x'))).toThrow();
  });
});
