/**
 * Face-mode debug panel: version, detector status, diagnostic ring-buffer
 * lines, and a Copy logs button. Reuses the shared #debug <details>.
 */
import { buildLabel } from '../core/buildInfo';
import { diagLog } from '../core/diagLog';
import type { I18n } from '../core/i18n';
import type { FaceDetectDebug } from '../adapters/mediapipeFace';
import { el } from './dom';

export interface FaceDebugSnapshot {
  fps: number;
  inferMs: number;
  detect: FaceDetectDebug;
  modelUrl: string | null;
  wasmDir: string | null;
  present: boolean;
  phase: string;
  targetId: string | null;
  exprStatus: string | null;
  exprScore: number | null;
  exprReason: string | null;
  topShapes: string;
  mirrored: boolean;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export class FaceDebugPanel {
  private body!: HTMLElement;
  private fields: Record<string, HTMLElement> = {};
  private logPre!: HTMLElement;
  private copyBtn!: HTMLButtonElement;
  private copyStatus!: HTMLElement;
  private visibleLogN = 40;

  constructor(
    private root: HTMLDetailsElement,
    private i18n: I18n,
    openByDefault: boolean,
  ) {
    this.root.classList.remove('hidden');
    this.root.open = openByDefault;
    this.build();
  }

  private t(k: string): string {
    return this.i18n.t(`debug.${k}`);
  }

  private field(key: string, label: string): HTMLElement {
    const v = el('b', {}, '—');
    this.fields[key] = v;
    return el('div', { class: 'kv' }, el('span', {}, label), v);
  }

  build(): void {
    const open = this.root.open;
    this.fields = {};
    const summary = el('summary', {}, `${this.t('title')} · ${buildLabel()}`);

    this.copyBtn = el('button', { type: 'button', class: 'dbg-copy-btn' }, this.t('copy_logs')) as HTMLButtonElement;
    this.copyStatus = el('span', { class: 'dbg-copy-status muted' }, '');
    this.copyBtn.addEventListener('click', () => void this.onCopy());

    this.logPre = el('pre', { class: 'dbg-log' }, '');

    this.body = el(
      'div',
      { class: 'debug-body face-debug-body' },
      el(
        'section',
        {},
        this.field('version', this.t('version')),
        this.field('fps', this.t('fps')),
        this.field('infer', this.t('inference')),
        this.field('delegate', this.t('delegate')),
        this.field('phase', this.t('face_phase')),
        this.field('faces', this.t('face_count')),
        this.field('presence', this.t('face_presence')),
        this.field('face_gate', this.t('face_gate')),
        this.field('expr_target', this.t('expr_target')),
        this.field('expr_score', this.t('expr_score')),
        this.field('expr_reason', this.t('expr_reason')),
        this.field('top_shapes', this.t('top_shapes')),
        this.field('mirror', this.t('mirror')),
        this.field('video', this.t('video_dims')),
        this.field('ready', this.t('ready_state')),
        this.field('skip', this.t('skip_reason')),
        this.field('error', this.t('last_error')),
        this.field('reload', this.t('needs_reload')),
        this.field('model', this.t('model_url')),
        this.field('wasm', this.t('wasm_dir')),
      ),
      el(
        'section',
        { class: 'wide' },
        el('h4', {}, this.t('diag_log')),
        el('div', { class: 'dbg-copy-row' }, this.copyBtn, this.copyStatus),
        this.logPre,
      ),
    );
    this.root.replaceChildren(summary, this.body);
    this.root.open = open;
  }

  private async onCopy(): Promise<void> {
    const header = [
      `POSE LAB face diag ${buildLabel()}`,
      `url=${typeof location !== 'undefined' ? location.href : ''}`,
      `ua=${typeof navigator !== 'undefined' ? navigator.userAgent : ''}`,
      '---',
    ].join('\n');
    const body = diagLog.text();
    const ok = await copyText(`${header}\n${body || '(empty)'}`);
    this.copyStatus.textContent = ok ? this.t('copied') : this.t('copy_failed');
    window.setTimeout(() => {
      this.copyStatus.textContent = '';
    }, 2000);
  }

  render(s: FaceDebugSnapshot): void {
    if (!this.root.open) return;
    const d = s.detect;
    const f = this.fields;
    f.version.textContent = buildLabel();
    f.fps.textContent = Number.isFinite(s.fps) ? s.fps.toFixed(1) : '—';
    f.infer.textContent = `${s.inferMs.toFixed(1)} ms`;
    f.delegate.textContent = d.delegate ?? '—';
    f.phase.textContent = s.phase;
    f.faces.textContent = String(d.faceCount);
    f.presence.textContent = s.present ? '1' : String(d.presenceScore);
    f.face_gate.textContent = !s.present
      ? this.i18n.t('face.hud_no_face')
      : s.exprStatus === 'pass'
        ? this.i18n.t('face.hud_expr_pass')
        : s.targetId
          ? this.i18n.t('face.hud_expr_fail')
          : this.i18n.t('face.hud_face_ok');
    f.expr_target.textContent = s.targetId ?? '—';
    f.expr_score.textContent =
      s.exprScore === null || !Number.isFinite(s.exprScore)
        ? '—'
        : `${Math.round(s.exprScore * 100)}% / 100% (${s.exprStatus ?? '—'})`;
    f.expr_reason.textContent = s.exprReason ?? '—';
    f.top_shapes.textContent = s.topShapes || '—';
    f.mirror.textContent = s.mirrored
      ? this.i18n.t('face.mirror_label', { w: d.videoWidth, h: d.videoHeight })
      : this.i18n.t('face.mirror_off', { w: d.videoWidth, h: d.videoHeight });
    f.video.textContent = `${d.videoWidth}×${d.videoHeight}`;
    f.ready.textContent = String(d.readyState);
    f.skip.textContent = d.skipReason ?? '—';
    f.error.textContent = d.lastError ? (d.lastError.length > 120 ? `${d.lastError.slice(0, 120)}…` : d.lastError) : '—';
    f.reload.textContent = d.needsReload ? 'YES' : 'no';
    f.model.textContent = s.modelUrl ?? '—';
    f.wasm.textContent = s.wasmDir ?? '—';
    this.logPre.textContent = diagLog.lines(this.visibleLogN).join('\n') || this.t('diag_empty');
  }
}
