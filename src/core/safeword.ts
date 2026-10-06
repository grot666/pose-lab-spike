/**
 * Safeword plumbing.
 *
 * SafewordSource  - anything that can raise the safeword (button now; voice,
 *                   gesture, hardware key... later). Sources only REPORT; they
 *                   never stop anything themselves.
 * SafewordController - owns the sources, latches the FIRST trigger, notifies
 *                   listeners exactly once and disarms every source. The app
 *                   subscribes and performs the hard stop (loop + camera off).
 *
 * The spike ships ButtonSafewordSource and ExternalSafewordSource
 * (remote peer / room sync).
 */

export type SafewordSourceKind = 'button' | 'keyboard' | 'voice' | 'gesture' | 'external';

export interface SafewordEvent {
  /** Id of the source that fired. */
  sourceId: string;
  kind: SafewordSourceKind;
  /** ms timestamp (performance.now) of the trigger. */
  at: number;
}

export type SafewordTrigger = (event: SafewordEvent) => void;

export interface SafewordSource {
  readonly id: string;
  readonly kind: SafewordSourceKind;
  /** Start listening; call `trigger` when the safeword is invoked. Must be idempotent. */
  attach(trigger: SafewordTrigger): void;
  /** Stop listening and release resources. Must be idempotent. */
  detach(): void;
}

export type SafewordListener = (event: SafewordEvent) => void;

export class SafewordController {
  private sources: SafewordSource[] = [];
  private listeners = new Set<SafewordListener>();
  private fired: SafewordEvent | null = null;
  private armed = false;

  constructor(sources: SafewordSource[] = [], private now: () => number = () => performance.now()) {
    sources.forEach((s) => this.addSource(s));
  }

  get triggered(): boolean {
    return this.fired !== null;
  }

  get lastEvent(): SafewordEvent | null {
    return this.fired;
  }

  get isArmed(): boolean {
    return this.armed;
  }

  addSource(source: SafewordSource): void {
    if (this.sources.some((s) => s.id === source.id)) throw new Error(`duplicate safeword source "${source.id}"`);
    this.sources.push(source);
    if (this.armed) source.attach(this.handle);
  }

  /** Subscribe; returns an unsubscribe function. Late subscribers after a trigger are called immediately. */
  onTrigger(listener: SafewordListener): () => void {
    this.listeners.add(listener);
    if (this.fired) listener(this.fired);
    return () => this.listeners.delete(listener);
  }

  /** Begin listening on all sources. No-op once triggered (safeword is final). */
  arm(): void {
    if (this.armed || this.fired) return;
    this.armed = true;
    this.sources.forEach((s) => s.attach(this.handle));
  }

  disarm(): void {
    if (!this.armed) return;
    this.armed = false;
    this.sources.forEach((s) => s.detach());
  }

  /** Programmatic trigger (e.g. from tests or a future integration). */
  trigger(sourceId = 'manual', kind: SafewordSourceKind = 'external'): void {
    this.handle({ sourceId, kind, at: this.now() });
  }

  private handle = (event: SafewordEvent): void => {
    if (this.fired) return; // latch: first trigger wins, later ones are ignored
    this.fired = event;
    this.disarm();
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch (err) {
        console.error('[safeword] listener error', err);
      }
    }
  };
}

/** Minimal element contract so the source is testable without a DOM. */
export interface ButtonLike {
  addEventListener(type: string, fn: (e: unknown) => void): void;
  removeEventListener(type: string, fn: (e: unknown) => void): void;
}

/**
 * Corner button source. Uses pointerdown (fires immediately, no click delay,
 * works on touch) plus click as a keyboard/assistive fallback.
 */
export class ButtonSafewordSource implements SafewordSource {
  readonly kind = 'button' as const;
  private trigger: SafewordTrigger | null = null;

  constructor(
    private button: ButtonLike,
    readonly id = 'corner-button',
    private now: () => number = () => performance.now(),
  ) {}

  private onPress = (e: unknown): void => {
    (e as { preventDefault?: () => void } | undefined)?.preventDefault?.();
    this.trigger?.({ sourceId: this.id, kind: this.kind, at: this.now() });
  };

  attach(trigger: SafewordTrigger): void {
    if (this.trigger) return;
    this.trigger = trigger;
    this.button.addEventListener('pointerdown', this.onPress);
    this.button.addEventListener('click', this.onPress);
  }

  detach(): void {
    if (!this.trigger) return;
    this.trigger = null;
    this.button.removeEventListener('pointerdown', this.onPress);
    this.button.removeEventListener('click', this.onPress);
  }
}


/**
 * Programmatic source for remote peers (room sync). Call `fire()` when the
 * other device sends a safeword message; the controller still latches once.
 */
export class ExternalSafewordSource implements SafewordSource {
  readonly kind = 'external' as const;
  private triggerFn: SafewordTrigger | null = null;

  constructor(
    readonly id = 'remote-peer',
    private now: () => number = () => performance.now(),
  ) {}

  attach(trigger: SafewordTrigger): void {
    this.triggerFn = trigger;
  }

  detach(): void {
    this.triggerFn = null;
  }

  /** Raise the safeword if currently attached (armed). */
  fire(sourceId = this.id, at = this.now()): void {
    this.triggerFn?.({ sourceId, kind: this.kind, at });
  }
}
