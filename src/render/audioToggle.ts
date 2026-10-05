/**
 * Small top-bar mute toggle. Knows nothing about cues or files - it only
 * reflects a muted flag and reports clicks.
 */
import type { I18n } from '../core/i18n';

export class AudioToggle {
  private muted = false;

  constructor(
    private btn: HTMLButtonElement,
    private i18n: I18n,
    onToggle: () => void,
  ) {
    btn.addEventListener('click', () => onToggle());
  }

  set(muted: boolean): void {
    this.muted = muted;
    this.render();
  }

  /** Re-run on language change. */
  render(): void {
    this.btn.textContent = this.i18n.t(this.muted ? 'audio.off' : 'audio.on');
    this.btn.setAttribute('aria-label', this.i18n.t('audio.toggle_aria'));
    this.btn.title = this.i18n.t('audio.toggle_aria');
    this.btn.setAttribute('aria-pressed', String(!this.muted));
    this.btn.dataset.muted = String(this.muted);
  }
}
