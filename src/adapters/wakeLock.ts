/** Screen Wake Lock: keep the phone screen on during a session; re-acquire on tab return. */
export class WakeLockAdapter {
  private sentinel: WakeLockSentinel | null = null;
  private wanted = false;

  get supported(): boolean {
    return 'wakeLock' in navigator;
  }

  get held(): boolean {
    return !!this.sentinel && !this.sentinel.released;
  }

  private onVisibility = () => {
    if (this.wanted && document.visibilityState === 'visible' && !this.held) void this.acquire();
  };

  async request(): Promise<boolean> {
    this.wanted = true;
    document.addEventListener('visibilitychange', this.onVisibility);
    return this.acquire();
  }

  private async acquire(): Promise<boolean> {
    if (!this.supported) return false;
    try {
      this.sentinel = await navigator.wakeLock.request('screen');
      return true;
    } catch (err) {
      console.warn('[wakelock] request failed', err);
      return false;
    }
  }

  async release(): Promise<void> {
    this.wanted = false;
    document.removeEventListener('visibilitychange', this.onVisibility);
    try {
      await this.sentinel?.release();
    } catch {
      /* ignore */
    }
    this.sentinel = null;
  }
}
