/**
 * DOM HUD: phase/track badges, command, countdown, hold progress, the AI's
 * on-screen voice (status line), correction hints, and the report / safeword overlays.
 * All text comes from i18n.
 */
import type { I18n } from '../core/i18n';
import type { RoundReport } from '../core/metrics';
import type { SessionSnapshot } from '../core/session';
import type { TrackState } from '../core/tracking';
import { $, el } from './dom';

export class Hud {
  private phaseBadge = $('#phase-badge');
  private trackBadge = $('#track-badge');
  private subject = $('#subject-id');
  private round = $('#round-info');
  private command = $('#command');
  private instruction = $('#instruction');
  private countdown = $('#countdown');
  private confidenceEl = $('#confidence');
  private holdBar = $('#hold-bar') as HTMLElement;
  private holdFill = $('#hold-fill') as HTMLElement;
  private holdText = $('#hold-text');
  private status = $('#status-line');
  private hint = $('#hint-line');
  private lostBanner = $('#lost-banner');
  private startScreen = $('#start-screen');
  private startError = $('#start-error');
  private report = $('#report');
  private safewordEnd = $('#safeword-end');
  private lastStatusKey = '';
  /** i18n key prefix for command/name/instruction: poses | expressions */
  private contentPrefix: 'poses' | 'expressions' = 'poses';

  constructor(private i18n: I18n) {}

  setContentPrefix(prefix: 'poses' | 'expressions'): void {
    this.contentPrefix = prefix;
  }

  /** Fill every [data-i18n] / [data-i18n-aria] element. Re-run on language HMR. */
  applyStatic(): void {
    document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((e) => {
      e.textContent = this.i18n.t(e.dataset.i18n!);
    });
    document.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((e) => {
      e.setAttribute('aria-label', this.i18n.t(e.dataset.i18nAria!));
    });
    document.documentElement.lang = this.i18n.lang;
    document.title = this.i18n.t('app.title');
  }

  setSubject(): void {
    this.subject.textContent = this.i18n.t('hud.subject');
  }

  hideStart(): void {
    this.startScreen.classList.add('hidden');
  }

  setStartBusy(text: string | null, btnId = 'start-btn'): void {
    const btn = document.getElementById(btnId) as HTMLButtonElement | null;
    if (btn) btn.disabled = !!text;
    $('#start-progress').textContent = text ?? '';
  }

  /** Match confidence 0..1 for expression / pose HUD; null hides. */
  setConfidence(score: number | null): void {
    if (!this.confidenceEl) return;
    if (score === null || !Number.isFinite(score)) {
      this.confidenceEl.textContent = '';
      this.confidenceEl.classList.add('hidden');
      return;
    }
    this.confidenceEl.classList.remove('hidden');
    this.confidenceEl.textContent = this.i18n.t('hud.confidence', { pct: Math.round(score * 100) });
  }

  showStartError(text: string): void {
    this.startError.textContent = text;
    this.startError.classList.remove('hidden');
  }

  setTrack(state: TrackState): void {
    this.trackBadge.textContent = this.i18n.t(`track.${state}`);
    this.trackBadge.dataset.state = state;
  }

  setLost(lost: boolean): void {
    this.lostBanner.classList.toggle('hidden', !lost);
    if (lost) this.lostBanner.textContent = this.i18n.t('status.track_lost');
  }

  /** The Observer speaks (variant picked once per call; caller decides when to change). */
  say(key: string, params: Record<string, string | number> = {}): void {
    this.lastStatusKey = key;
    this.status.textContent = this.i18n.t(key, params);
    this.status.classList.remove('flash');
    void this.status.offsetWidth; // restart CSS animation
    this.status.classList.add('flash');
  }

  get statusKey(): string {
    return this.lastStatusKey;
  }

  setHint(text: string | null): void {
    this.hint.textContent = text ?? '';
    this.hint.classList.toggle('hidden', !text);
  }

  update(s: SessionSnapshot): void {
    this.phaseBadge.textContent = this.i18n.t(`hud.phase.${s.phase}`);
    this.phaseBadge.dataset.phase = s.phase;
    document.body.dataset.phase = s.phase;
    this.round.textContent = s.round > 0 && s.total > 0 ? this.i18n.t('hud.round', { round: s.round, step: s.step + 1, total: s.total }) : '';

    const showCmd = s.poseId && (s.phase === 'command' || s.phase === 'entering' || s.phase === 'holding' || s.phase === 'result');
    this.command.textContent = showCmd ? this.i18n.t(`${this.contentPrefix}.${s.poseId}.command`) : '';
    this.instruction.textContent = showCmd ? this.i18n.t(`${this.contentPrefix}.${s.poseId}.instruction`) : '';
    this.command.dataset.outcome = s.phase === 'result' ? (s.lastOutcome ?? '') : '';

    if (s.paused) {
      this.countdown.textContent = this.i18n.t('hud.paused');
      this.countdown.classList.remove('urgent');
    } else if (s.phase === 'entering') {
      this.countdown.textContent = this.i18n.t('hud.enter_countdown', { seconds: Math.ceil(s.enterRemainingMs / 1000) });
      this.countdown.classList.toggle('urgent', s.enterRemainingMs < 3000);
    } else {
      this.countdown.textContent = '';
      this.countdown.classList.remove('urgent');
    }

    const holding = s.phase === 'holding' || (s.phase === 'result' && s.lastOutcome === 'success');
    this.holdBar.classList.toggle('hidden', !holding);
    if (holding) {
      const p = s.phase === 'result' ? 1 : Math.min(1, s.holdElapsedMs / s.holdTargetMs);
      this.holdFill.style.transform = `scaleX(${p})`;
      this.holdText.textContent = this.i18n.t('hud.hold', {
        elapsed: ((s.phase === 'result' ? s.holdTargetMs : s.holdElapsedMs) / 1000).toFixed(1),
        target: (s.holdTargetMs / 1000).toFixed(0),
      });
    }
  }

  showReport(report: RoundReport, poseIds: string[], onNext: () => void): void {
    const t = (k: string, p: Record<string, string | number> = {}) => this.i18n.t(k, p);
    const verdict = report.successRate >= 0.8 ? 'verdict_good' : report.successRate >= 0.5 ? 'verdict_mid' : 'verdict_bad';
    const stat = (label: string, value: string) => el('div', { class: 'stat' }, el('span', {}, label), el('b', {}, value));
    const rows = report.attempts.map((a) => {
      const id = poseIds[a.pose] ?? String(a.pose);
      return el(
        'li',
        { class: a.outcome ? 'ok' : 'bad' },
        t('report.row', {
          pose: t(`${this.contentPrefix}.${id}.name`),
          outcome: t(a.outcome ? 'report.outcome_success' : 'report.outcome_fail'),
          enter: a.enterLatencyMs >= 0 ? (a.enterLatencyMs / 1000).toFixed(1) : t('report.not_entered'),
          hold: (a.holdAchievedMs / 1000).toFixed(1),
          target: (a.holdTargetMs / 1000).toFixed(0),
          leaves: a.leaves,
        }),
      );
    });
    const next = el('button', { class: 'btn primary', type: 'button' }, t('app.next_round'));
    next.addEventListener('click', () => {
      this.report.classList.add('hidden');
      onNext();
    });
    this.report.replaceChildren(
      el(
        'div',
        { class: 'card' },
        el('h2', {}, t('report.title', { round: report.round })),
        el('p', { class: 'verdict' }, t(`report.${verdict}`)),
        el(
          'div',
          { class: 'stats' },
          stat(t('report.success_rate'), `${Math.round(report.successRate * 100)}%`),
          stat(t('report.commands'), String(report.commands)),
          stat(t('report.success'), String(report.success)),
          stat(t('report.fail'), String(report.fail)),
          stat(t('report.leaves'), String(report.leaves)),
          stat(t('report.track_losses'), String(report.trackLosses)),
          stat(t('report.mean_enter'), report.meanEnterLatencyMs >= 0 ? `${(report.meanEnterLatencyMs / 1000).toFixed(1)}s` : '—'),
          stat(t('report.mean_hold'), `${Math.round(report.meanHoldRatio * 100)}%`),
        ),
        el('ol', { class: 'rows' }, ...rows),
        el(
          'p',
          { class: 'perf' },
          t('report.perf', {
            fps: report.perf.fpsMean,
            infer: report.perf.inferMsMean,
            p95: report.perf.inferMsP95,
            jraw: report.perf.jitterRawMm,
            jfilt: report.perf.jitterFilteredMm,
          }),
        ),
        el('p', { class: 'muted' }, t('report.console_hint')),
        next,
      ),
    );
    this.report.classList.remove('hidden');
  }

  hideReport(): void {
    this.report.classList.add('hidden');
  }

  showSafewordEnd(): void {
    const t = (k: string) => this.i18n.t(k);
    this.report.classList.add('hidden');
    this.lostBanner.classList.add('hidden');
    this.setHint(null);
    this.safewordEnd.replaceChildren(
      el(
        'div',
        { class: 'card warm' },
        el('h2', {}, t('safeword.end_title')),
        el('p', { class: 'lead' }, t('safeword.end_body')),
        el('p', {}, t('safeword.end_detail')),
        el('p', {}, t('safeword.end_care')),
        el('p', { class: 'muted' }, t('safeword.end_reload')),
      ),
    );
    this.safewordEnd.classList.remove('hidden');
    document.body.dataset.phase = 'stopped';
    document.body.classList.add('safeword');
  }
}
