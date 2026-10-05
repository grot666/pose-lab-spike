/**
 * Expandable debug panel: perf, model tier, camera, visibility bars, track
 * stats, joint angles, jitter, target-rule status, and live sliders for the
 * One Euro filter / debounce / hold range.
 */
import type { FacingMode, ModelTier, SequenceMode } from '../config';
import type { AngleName } from '../core/geometry';
import type { I18n } from '../core/i18n';
import { JOINT_NAMES } from '../core/landmarks';
import type { PoseEvaluation, RuleResult } from '../core/poseRules';
import type { TrackStats, TrackState } from '../core/tracking';
import { visibilityCss } from './colors';
import { el } from './dom';

export interface DebugSettings {
  tier: ModelTier;
  facing: FacingMode;
  smoothing: boolean;
  minCutoff: number;
  beta: number;
  dCutoff: number;
  enterFrames: number;
  leaveFrames: number;
  holdMinS: number;
  holdMaxS: number;
  sequence: SequenceMode;
  audioMuted: boolean;
  audioVolume: number;
}

export interface DebugCallbacks {
  onTier(t: ModelTier): void;
  onFacing(f: FacingMode): void;
  onSettings(s: DebugSettings): void;
}

export interface DebugData {
  fps: number;
  inferMs: number;
  inferP95: number;
  delegate: string;
  busy: string | null;
  trackState: TrackState;
  stats: TrackStats;
  visibility: number[] | null;
  angles: Partial<Record<AngleName, number>>;
  headPitch: number;
  torsoTilt: number;
  jitterRaw: number;
  jitterFiltered: number;
  target: PoseEvaluation | null;
  audioState: string;
}

const fmt = (v: number, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '—');

export class DebugPanel {
  private body!: HTMLElement;
  private fields: Record<string, HTMLElement> = {};
  private visBars: HTMLElement[] = [];

  constructor(
    private root: HTMLDetailsElement,
    private i18n: I18n,
    public settings: DebugSettings,
    private cb: DebugCallbacks,
  ) {
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

  private slider(key: keyof DebugSettings, label: string, min: number, max: number, step: number): HTMLElement {
    const val = el('output', {}, String(this.settings[key]));
    const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(this.settings[key]) });
    input.addEventListener('input', () => {
      (this.settings as unknown as Record<string, number>)[key] = Number(input.value);
      if (key === 'holdMinS' && this.settings.holdMinS > this.settings.holdMaxS) this.settings.holdMaxS = this.settings.holdMinS;
      if (key === 'holdMaxS' && this.settings.holdMaxS < this.settings.holdMinS) this.settings.holdMinS = this.settings.holdMaxS;
      val.textContent = input.value;
      this.cb.onSettings({ ...this.settings });
      this.syncInputs();
    });
    input.dataset.key = key;
    return el('label', { class: 'slider' }, el('span', {}, label), input, val);
  }

  /** Push external settings changes (e.g. the top-bar mute toggle) into the inputs. */
  syncInputs(): void {
    this.root.querySelectorAll<HTMLInputElement>('input[type=checkbox][data-key]').forEach((i) => {
      i.checked = !!this.settings[i.dataset.key as keyof DebugSettings];
    });
    this.root.querySelectorAll<HTMLInputElement>('input[type=range]').forEach((i) => {
      const k = i.dataset.key as keyof DebugSettings;
      if (String(this.settings[k]) !== i.value) {
        i.value = String(this.settings[k]);
        (i.nextElementSibling as HTMLElement).textContent = i.value;
      }
    });
  }

  private select<T extends string>(options: [T, string][], value: T, onChange: (v: T) => void): HTMLSelectElement {
    const s = el('select', {}, ...options.map(([v, l]) => el('option', { value: v }, l)));
    s.value = value;
    s.addEventListener('change', () => onChange(s.value as T));
    return s;
  }

  /** (Re)build DOM - also called when i18n hot-reloads. */
  build(): void {
    const open = this.root.open;
    this.fields = {};
    const summary = el('summary', {}, this.t('title'));
    const tier = this.select<ModelTier>(
      [
        ['lite', 'lite'],
        ['full', 'full'],
        ['heavy', 'heavy'],
      ],
      this.settings.tier,
      (v) => {
        this.settings.tier = v;
        this.cb.onTier(v);
      },
    );
    const facing = this.select<FacingMode>(
      [
        ['user', this.t('front')],
        ['environment', this.t('back')],
      ],
      this.settings.facing,
      (v) => {
        this.settings.facing = v;
        this.cb.onFacing(v);
      },
    );
    const seq = this.select<SequenceMode>(
      [
        ['random', this.t('random')],
        ['sequential', this.t('sequential')],
      ],
      this.settings.sequence,
      (v) => {
        this.settings.sequence = v;
        this.cb.onSettings({ ...this.settings });
      },
    );
    const smooth = el('input', { type: 'checkbox' });
    smooth.checked = this.settings.smoothing;
    smooth.addEventListener('change', () => {
      this.settings.smoothing = smooth.checked;
      this.cb.onSettings({ ...this.settings });
    });

    const mute = el('input', { type: 'checkbox' });
    mute.dataset.key = 'audioMuted';
    mute.checked = this.settings.audioMuted;
    mute.addEventListener('change', () => {
      this.settings.audioMuted = mute.checked;
      this.cb.onSettings({ ...this.settings });
    });

    this.visBars = JOINT_NAMES.map((n, i) => el('i', { title: `${i} ${n}` }));
    const angles = el('div', { class: 'grid2', id: 'dbg-angles' });
    this.fields.angles = angles;
    const rules = el('div', { class: 'rules' });
    this.fields.rules = rules;

    this.body = el(
      'div',
      { class: 'debug-body' },
      el(
        'section',
        {},
        this.field('fps', this.t('fps')),
        this.field('infer', this.t('inference')),
        el('div', { class: 'kv' }, el('span', {}, this.t('model_tier')), tier),
        this.field('delegate', this.t('delegate')),
        el('div', { class: 'kv' }, el('span', {}, this.t('camera')), facing),
        this.field('busy', ''),
      ),
      el(
        'section',
        {},
        el('h4', {}, this.t('track_stats')),
        this.field('state', this.t('state')),
        this.field('tracked', this.t('tracked_ratio')),
        this.field('lostEvents', this.t('lost_events')),
        this.field('lostMs', this.t('lost_ms')),
        this.field('wristHidden', this.t('wrist_hidden_ratio')),
        el('h4', {}, this.t('jitter')),
        this.field('jitterRaw', this.t('raw')),
        this.field('jitterFilt', this.t('filtered')),
      ),
      el('section', { class: 'wide' }, el('h4', {}, this.t('visibility')), el('div', { class: 'visbars' }, ...this.visBars)),
      el('section', {}, el('h4', {}, this.t('joint_angles')), angles),
      el('section', {}, el('h4', {}, this.t('target_rules')), rules),
      el(
        'section',
        {},
        el('h4', {}, this.t('one_euro')),
        el('label', { class: 'check' }, smooth, el('span', {}, this.t('smoothing_on'))),
        this.slider('minCutoff', this.t('min_cutoff'), 0.05, 5, 0.05),
        this.slider('beta', this.t('beta'), 0, 1, 0.005),
        this.slider('dCutoff', this.t('d_cutoff'), 0.1, 5, 0.1),
        el('h4', {}, this.t('debounce')),
        this.slider('enterFrames', this.t('enter_frames'), 1, 40, 1),
        this.slider('leaveFrames', this.t('leave_frames'), 1, 60, 1),
        el('h4', {}, this.t('session')),
        this.slider('holdMinS', this.t('hold_min'), 1, 30, 1),
        this.slider('holdMaxS', this.t('hold_max'), 1, 30, 1),
        el('div', { class: 'kv' }, el('span', {}, this.t('sequence')), seq),
        el('h4', {}, this.t('audio')),
        el('label', { class: 'check' }, mute, el('span', {}, this.t('audio_mute'))),
        this.slider('audioVolume', this.t('audio_volume'), 0, 1, 0.05),
        this.field('audioState', this.t('audio_state')),
      ),
    );
    this.root.replaceChildren(summary, this.body);
    this.root.open = open;
  }

  setTierBusy(text: string | null): void {
    if (this.fields.busy) this.fields.busy.textContent = text ?? '';
  }

  private ruleLine(r: RuleResult, depth = 0): HTMLElement[] {
    const vals = r.values.filter((v) => Number.isFinite(v)).map((v) => fmt(v, Math.abs(v) < 10 ? 2 : 0));
    const line = el('div', { class: `rule ${r.status}`, style: `padding-left:${depth * 10}px` }, `${r.id}`, el('em', {}, vals.join(' / ')));
    return [line, ...(r.children ?? []).flatMap((c) => this.ruleLine(c, depth + 1))];
  }

  render(d: DebugData): void {
    if (!this.root.open) return;
    const f = this.fields;
    f.fps.textContent = fmt(d.fps, 1);
    f.infer.textContent = `${fmt(d.inferMs, 1)} ms (p95 ${fmt(d.inferP95, 1)})`;
    f.delegate.textContent = d.delegate;
    f.busy.textContent = d.busy ?? '';
    f.state.textContent = this.i18n.t(`track.${d.trackState}`);
    const s = d.stats;
    f.tracked.textContent = s.frames ? `${fmt(((s.trackedFrames + s.partialFrames) / s.frames) * 100)}%` : '—';
    f.lostEvents.textContent = String(s.lostEvents);
    f.lostMs.textContent = `${fmt((s.lostMsTotal + s.currentLostMs) / 1000, 1)} s`;
    f.wristHidden.textContent = s.frames ? `${fmt((s.wristHiddenFrames / s.frames) * 100)}%` : '—';
    f.jitterRaw.textContent = `${fmt(d.jitterRaw, 1)} mm`;
    f.jitterFilt.textContent = `${fmt(d.jitterFiltered, 1)} mm`;
    f.audioState.textContent = d.audioState;

    this.visBars.forEach((b, i) => {
      const v = d.visibility?.[i] ?? 0;
      b.style.setProperty('--v', String(v));
      b.style.background = visibilityCss(v);
    });

    f.angles.replaceChildren(
      ...Object.entries(d.angles).map(([k, v]) => el('div', { class: 'kv' }, el('span', {}, k), el('b', {}, `${fmt(v as number)}°`))),
      el('div', { class: 'kv' }, el('span', {}, this.t('head_pitch')), el('b', {}, `${fmt(d.headPitch)}°`)),
      el('div', { class: 'kv' }, el('span', {}, this.t('torso_tilt')), el('b', {}, `${fmt(d.torsoTilt)}°`)),
    );

    if (d.target) {
      f.rules.replaceChildren(
        el('div', { class: `rule head ${d.target.status}` }, d.target.poseId, el('em', {}, `${d.target.passCount}/${d.target.rules.length}`)),
        ...d.target.rules.flatMap((r) => this.ruleLine(r)),
      );
    } else f.rules.replaceChildren(el('div', { class: 'muted' }, this.t('no_target')));
  }
}
