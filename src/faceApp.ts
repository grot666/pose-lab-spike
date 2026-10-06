/**
 * Standalone facial-expression observation mode (?mode=face).
 * Reuses PoseSession state machine, HUD, lab scene, audio, safeword.
 * Does NOT mix into the default pose session; local-only (no PeerJS room).
 */
import { CameraAdapter } from './adapters/camera';
import { MediaPipeFaceDetector, type FaceDetector, type FaceFrame } from './adapters/mediapipeFace';
import { WakeLockAdapter } from './adapters/wakeLock';
import { AudioBank, SilentAudioBackend } from './audio/audioBank';
import { loadAudioPrefs, safeLocalStorage, saveAudioPrefs } from './audio/audioPrefs';
import { LAB_CUE, LAB_CUES } from './audio/labCues';
import { WebAudioBackend } from './audio/webAudioBackend';
import { config, type Lang } from './config';
import { assetUrl } from './core/assetUrl';
import type { I18n } from './core/i18n';
import {
  evaluateExpression,
  firstFailingRule,
  type ExpressionDefinition,
  type ExpressionEvaluation,
} from './core/expressionRules';
import { FaceTrackingMonitor } from './core/faceTracking';
import { FpsMeter, RollingStat, buildRoundReport } from './core/metrics';
import { ButtonSafewordSource, SafewordController } from './core/safeword';
import { PoseSession, type SessionEvent, type SessionSnapshot } from './core/session';
import { AudioToggle } from './render/audioToggle';
import { $ } from './render/dom';
import { Hud } from './render/hud';
import { LabScene } from './render/labScene';
import type { Mood } from './render/sphereAI';

/** Sparse face-mesh indices useful for a light overlay. */
const FACE_RING = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];

export class FaceApp {
  private exprs: ExpressionDefinition[];
  private exprMap = new Map<string, ExpressionDefinition>();
  private readonly video = $('#video') as HTMLVideoElement;
  private readonly camWrap = $('#cam-wrap');
  private readonly overlay = $('#overlay') as HTMLCanvasElement;
  private readonly camera: CameraAdapter;
  private readonly detector: FaceDetector;
  private readonly wakeLock = new WakeLockAdapter();
  private readonly tracking = new FaceTrackingMonitor({
    lostAfterMs: config.tracking.lostAfterMs,
    regainFrames: config.tracking.regainFrames,
  });
  private readonly fps = new FpsMeter();
  private readonly infer = new RollingStat(600);
  private readonly session: PoseSession;
  private readonly safeword: SafewordController;
  private readonly hud: Hud;
  private readonly lab: LabScene;
  private readonly audio: AudioBank;
  private readonly audioToggle: AudioToggle;

  private running = false;
  private vfcHandle = 0;
  private rafHandle = 0;
  private subjectN = Math.floor(1000 + Math.random() * 9000);
  private lastConfidence = 0;
  private lastSayAt = 0;
  private hintRule: string | null = null;
  private hintRuleSince = 0;
  private hintShownAt = 0;
  private resultMood: Mood = 'success';
  private noFaceSince: number | null = null;
  private lastDetectErrorShown = '';
  private reloadInFlight: Promise<void> | null = null;
  private readonly faceDebugEl = document.getElementById('face-debug');

  constructor(
    exprs: ExpressionDefinition[],
    private i18n: I18n<Lang>,
  ) {
    this.exprs = exprs;
    this.indexExprs();
    const q = new URLSearchParams(location.search);
    const sequence = q.get('seq') === 'sequential' ? 'sequential' : q.get('seq') === 'random' ? 'random' : config.session.sequenceMode;

    this.camera = new CameraAdapter(this.video, { ...config.camera });
    this.detector = new MediaPipeFaceDetector({
      wasmPath: config.model.wasmPath,
      modelPath: config.face.modelPath,
      preferGpu: config.face.preferGpu,
      minFaceDetectionConfidence: config.face.minFaceDetectionConfidence,
      minFacePresenceConfidence: config.face.minFacePresenceConfidence,
      minTrackingConfidence: config.face.minTrackingConfidence,
      numFaces: config.face.numFaces,
    });
    this.session = new PoseSession(
      exprs.map((e) => e.id),
      { ...config.session, sequenceMode: sequence, ...config.debounce },
    );
    this.session.on((e) => this.onSessionEvent(e));

    this.hud = new Hud(i18n);
    this.hud.setContentPrefix('expressions');
    this.lab = new LabScene($('#three') as HTMLCanvasElement);

    const store = safeLocalStorage();
    const prefs = loadAudioPrefs(store, config.audio.storageKey, {
      muted: config.audio.defaultMuted,
      volume: config.audio.defaultVolume,
    });
    if (q.get('mute') === '1') prefs.muted = true;
    this.audio = new AudioBank({
      backend: config.audio.enabled ? new WebAudioBackend(assetUrl, config.audio.busGain) : new SilentAudioBackend(),
      cues: LAB_CUES,
      volume: prefs.volume,
      muted: prefs.muted,
    });

    this.safeword = new SafewordController([new ButtonSafewordSource($('#safeword-btn'))]);
    this.safeword.onTrigger(() => this.onSafeword());
    this.safeword.arm();

    this.audioToggle = new AudioToggle($('#audio-btn') as HTMLButtonElement, i18n, () => this.toggleMute());
    this.audioToggle.set(prefs.muted);
    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === 'm' || e.key === 'M') this.toggleMute();
    });
    document.addEventListener('visibilitychange', () => this.audio.setSuspended(document.hidden));

    this.i18n.globals.subjectId = this.subjectId();
    this.hud.applyStatic();
    this.hud.setSubject();
    this.hud.setTrack('idle');
    this.hud.update(this.session.snapshot());
    this.hud.say('face.status.idle');
    this.renderLangLinks();
    this.lab.setMirrored(true);
    this.lab.setMood('idle');
    this.lab.start();

    document.body.dataset.mode = 'face';
    $('#debug').classList.add('hidden');
    this.faceDebugEl?.classList.remove('hidden');
    this.renderFaceDebug(null);
    $('#face-entry').classList.remove('hidden');

    $('#face-start-btn').addEventListener('click', () => void this.start());
    this.i18n.onChange(() => this.onI18nChange());
  }

  setExpressions(exprs: ExpressionDefinition[]): void {
    this.exprs = exprs;
    this.indexExprs();
    this.session.setPoseIds(exprs.map((e) => e.id));
    console.info('[pose-lab] expressions.yaml reloaded:', exprs.map((e) => e.id).join(', '));
  }

  private indexExprs(): void {
    this.exprMap = new Map(this.exprs.map((e) => [e.id, e]));
  }

  private subjectId(): string {
    return this.i18n.t('subject.id_format', { n: this.subjectN });
  }

  private renderLangLinks(): void {
    const nav = $('#lang-links');
    nav.replaceChildren();
    for (const lang of ['zh-CN', 'en'] as Lang[]) {
      const a = document.createElement('a');
      const url = new URL(location.href);
      url.searchParams.set('lang', lang);
      a.href = url.toString();
      a.textContent = this.i18n.tIn(lang, 'meta.lang_name');
      if (lang === this.i18n.lang) a.className = 'active';
      nav.append(a);
    }
  }

  private onI18nChange(): void {
    this.i18n.globals.subjectId = this.subjectId();
    this.hud.applyStatic();
    this.hud.setSubject();
    this.audioToggle.render();
    this.renderLangLinks();
    if (this.hud.statusKey) this.hud.say(this.hud.statusKey, this.exprParams());
  }

  private async start(): Promise<void> {
    if (this.safeword.triggered || this.running) return;
    this.audio.unlock();
    void this.audio.loop(LAB_CUE.ambience, config.audio.ambienceFadeInMs);
    try {
      if (!window.isSecureContext) throw Object.assign(new Error('insecure'), { code: 'insecure' });
      this.hud.setStartBusy(this.i18n.t('app.requesting_camera'), 'face-start-btn');
      void this.wakeLock.request().then((ok) => {
        if (!ok && this.wakeLock.supported) console.warn(this.i18n.t('app.wake_lock_failed'));
      });
      try {
        await this.camera.start(config.camera.facingMode);
      } catch (err) {
        console.error(err);
        throw Object.assign(new Error('camera'), { code: 'camera' });
      }
      if (this.safeword.triggered) return this.camera.stop();
      this.camWrap.classList.toggle('mirrored', this.camera.mirrored);
      this.lab.setMirrored(this.camera.mirrored);
      this.hud.setStartBusy(this.i18n.t('face.loading_model'), 'face-start-btn');
      try {
        await this.detector.load();
      } catch (err) {
        console.error(err);
        throw Object.assign(new Error(String((err as Error)?.message ?? err)), { code: 'model' });
      }
      if (this.safeword.triggered) {
        this.camera.stop();
        this.detector.close();
        return;
      }
      this.hud.setStartBusy(null, 'face-start-btn');
      this.hud.hideStart();
      this.running = true;
      this.noFaceSince = null;
      this.lastDetectErrorShown = '';
      this.session.start();
      this.scheduleNext();
    } catch (err) {
      const code = (err as { code?: string }).code;
      this.audio.stop(LAB_CUE.ambience, config.audio.ambienceFadeOutMs);
      this.camera.stop();
      this.hud.setStartBusy(null, 'face-start-btn');
      this.hud.showStartError(
        code === 'insecure'
          ? this.i18n.t('app.insecure_context')
          : code === 'camera'
            ? this.i18n.t('app.camera_denied')
            : this.i18n.t('face.model_failed', {
                error: (err as Error).message,
              }),
      );
    }
  }

  private onSafeword(): void {
    this.running = false;
    this.audio.shutdown(config.audio.safewordFadeMs);
    const v = this.video as HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void };
    v.cancelVideoFrameCallback?.(this.vfcHandle);
    cancelAnimationFrame(this.rafHandle);
    this.camera.stop();
    this.detector.close();
    this.session.stop();
    void this.wakeLock.release();
    this.clearOverlay();
    this.lab.setPose(null);
    this.lab.setProgress(0);
    this.lab.setMood('safeword');
    this.lab.stopAfter(3000);
    this.hud.hideStart();
    this.hud.update(this.session.snapshot());
    this.hud.setTrack('idle');
    this.hud.setLost(false);
    this.hud.setConfidence(null);
    this.faceDebugEl?.classList.add('hidden');
    this.hud.say('safeword.end_title');
    this.hud.showSafewordEnd();
    console.info(JSON.stringify({ safeword: 1, face: 1, atMs: Math.round(performance.now()) }));
  }

  private toggleMute(): void {
    if (this.audio.disposed) return;
    this.audio.setMuted(!this.audio.muted);
    this.audioToggle.set(this.audio.muted);
    saveAudioPrefs(safeLocalStorage(), config.audio.storageKey, {
      muted: this.audio.muted,
      volume: this.audio.volume,
    });
  }

  private scheduleNext(): void {
    if (!this.running) return;
    const v = this.video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    if (v.requestVideoFrameCallback) this.vfcHandle = v.requestVideoFrameCallback(() => this.tick());
    else this.rafHandle = requestAnimationFrame(() => this.tick());
  }

  private tick(): void {
    if (!this.running) return;
    try {
      if (this.camera.active) this.process(performance.now());
    } catch (err) {
      console.error('[face-lab] frame error', err);
    }
    this.scheduleNext();
  }

  private process(now: number): void {
    this.ensureDetectorHealthy();
    const t0 = performance.now();
    const frame = this.detector.detect(this.video, now);
    this.infer.push(performance.now() - t0);
    this.fps.tick(now);
    this.renderFaceDebug(frame);

    const track = this.tracking.update(!!frame?.present, now);
    const lost = track.state === 'lost';
    const faceMissingHud = this.updateFacePresenceHud(!!frame?.present, now);

    const targetId = this.session.targetPoseId;
    const target = targetId ? this.exprMap.get(targetId) : undefined;
    const ev = frame && target ? evaluateExpression(frame.blendshapes, target) : null;
    this.lastConfidence = ev?.score ?? 0;

    const snap = this.session.update({
      nowMs: now,
      track: track.state,
      targetStatus: ev?.status ?? null,
      wristsHidden: false,
    });

    this.drawOverlay(frame, lost);
    this.lab.setMood(this.moodFor(snap));
    this.lab.setProgress(
      snap.phase === 'holding'
        ? snap.holdElapsedMs / snap.holdTargetMs
        : snap.phase === 'result' && snap.lastOutcome === 'success'
          ? 1
          : 0,
    );
    this.hud.setTrack(track.state);
    if (!faceMissingHud) {
      this.hud.setLost(snap.paused || (lost && snap.phase !== 'searching'));
    }
    this.hud.update(snap);
    const showConf =
      (snap.phase === 'entering' || snap.phase === 'holding' || snap.phase === 'result') && ev !== null;
    this.hud.setConfidence(showConf ? this.lastConfidence : null);
    this.updateVoice(snap, ev, now);
  }

  private ensureDetectorHealthy(): void {
    if (!this.detector.needsReload || this.reloadInFlight || this.safeword.triggered) return;
    this.reloadInFlight = this.detector
      .load()
      .then(() => {
        this.lastDetectErrorShown = '';
        this.hud.setHint(null);
        console.info('[face-lab] Face Landmarker reloaded after graph fault');
      })
      .catch((err) => {
        const msg = String((err as Error)?.message ?? err);
        this.hud.setHint(this.i18n.t('face.detect_error', { error: msg }));
        console.error('[face-lab] Face Landmarker reload failed', err);
      })
      .finally(() => {
        this.reloadInFlight = null;
      });
  }

  private renderFaceDebug(frame: FaceFrame | null): void {
    const el = this.faceDebugEl;
    if (!el) return;
    const d = this.detector.debug;
    const err = d.lastError || d.skipReason || '—';
    const meta = `del:${d.delegate ?? '—'} ${d.videoWidth}x${d.videoHeight} rs:${d.readyState} ts:${d.timestampMs}${d.needsReload ? ' RELOAD' : ''}`;
    el.textContent = this.i18n.t('face.debug_hud', {
      faces: frame?.faceCount ?? d.faceCount,
      presence: (frame?.present ? 1 : d.presenceScore).toFixed(2),
      error: err.length > 80 ? `${err.slice(0, 80)}…` : err,
      meta,
    });
    el.classList.remove('hidden');
  }

    /** @returns true when the lost banner was set for prolonged no-face during search. */
  private updateFacePresenceHud(present: boolean, now: number): boolean {
    const detectErr = this.detector.lastError;
    if (detectErr && detectErr !== this.lastDetectErrorShown) {
      this.lastDetectErrorShown = detectErr;
      this.hud.setHint(this.i18n.t('face.detect_error', { error: detectErr }));
      console.error('[face-lab] detector error', detectErr);
    }
    if (present) {
      this.noFaceSince = null;
      if (!detectErr && this.lastDetectErrorShown) {
        this.lastDetectErrorShown = '';
        this.hud.setHint(null);
      }
      return false;
    }
    if (this.noFaceSince === null) this.noFaceSince = now;
    const missingFor = now - this.noFaceSince;
    const snap = this.session.snapshot();
    // During searching, PoseSession suppresses the lost banner; surface a dedicated face-missing cue.
    if (snap.phase === 'searching' && missingFor > 1500) {
      this.hud.setLost(true);
      const banner = document.getElementById('lost-banner');
      if (banner) banner.textContent = this.i18n.t('face.no_face');
      return true;
    }
    return false;
  }

  private drawOverlay(frame: FaceFrame | null, lost: boolean): void {
    const canvas = this.overlay;
    const w = this.video.videoWidth || canvas.clientWidth;
    const h = this.video.videoHeight || canvas.clientHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!frame || lost || !frame.landmarks.length) return;
    ctx.strokeStyle = 'rgba(120, 220, 255, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    for (const idx of FACE_RING) {
      const p = frame.landmarks[idx];
      if (!p) continue;
      const x = p.x * canvas.width;
      const y = p.y * canvas.height;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    }
    if (started) {
      ctx.closePath();
      ctx.stroke();
    }
  }

  private clearOverlay(): void {
    const ctx = this.overlay.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
  }

  private moodFor(s: SessionSnapshot): Mood {
    if (s.paused) return 'lost';
    switch (s.phase) {
      case 'idle':
        return 'idle';
      case 'searching':
        return 'searching';
      case 'command':
        return 'command';
      case 'entering':
        return 'entering';
      case 'holding':
        return 'holding';
      case 'result':
        return this.resultMood;
      case 'report':
        return 'report';
      case 'stopped':
        return 'safeword';
    }
  }

  private exprParams(): Record<string, string> {
    const id = this.session.targetPoseId;
    return id ? { pose: this.i18n.t(`expressions.${id}.name`) } : {};
  }

  private updateVoice(s: SessionSnapshot, ev: ExpressionEvaluation | null, now: number): void {
    const since = now - this.lastSayAt;
    if (s.phase === 'searching' && since > 6000) this.say('face.status.searching', now);
    if (s.phase === 'holding' && !s.paused && since > 4500) this.say('face.status.holding', now);

    let hint: string | null = null;
    if ((s.phase === 'entering' || s.phase === 'holding') && !s.paused && ev) {
      if (ev.status === 'fail') {
        const rule = firstFailingRule(ev);
        if (rule !== this.hintRule) {
          this.hintRule = rule;
          this.hintRuleSince = now;
        }
        if (rule && now - this.hintRuleSince > 450) hint = this.i18n.t(`hints.${rule}`);
      } else this.hintRule = null;
    }
    const current = (document.getElementById('hint-line')?.textContent ?? '') || null;
    if (hint !== current && (hint === null || now - this.hintShownAt > 1200)) {
      this.hud.setHint(hint);
      this.hintShownAt = now;
    }
  }

  private say(key: string, now = performance.now()): void {
    this.hud.say(key, this.exprParams());
    this.lastSayAt = now;
  }

  private onSessionEvent(e: SessionEvent): void {
    switch (e.type) {
      case 'person_found':
        this.tracking.resetStats();
        this.fps.stat.clear();
        this.infer.clear();
        this.say('face.status.person_found');
        break;
      case 'phase':
        if (e.phase === 'entering' && this.hud.statusKey !== 'face.status.leave') this.say('face.status.entering');
        if (e.phase === 'searching') this.say('face.status.searching');
        break;
      case 'command':
        void this.audio.play(LAB_CUE.command);
        break;
      case 'enter':
        this.say('face.status.entered');
        break;
      case 'leave':
        this.say('face.status.leave');
        break;
      case 'result':
        this.resultMood = e.outcome === 'success' ? 'success' : 'fail';
        void this.audio.play(e.outcome === 'success' ? LAB_CUE.success : LAB_CUE.fail);
        this.say(e.outcome === 'success' ? 'face.status.success' : 'face.status.fail_timeout');
        this.hud.setHint(null);
        break;
      case 'track_lost':
        void this.audio.play(LAB_CUE.trackLost);
        this.say('face.status.track_lost');
        break;
      case 'track_regained':
        this.say('face.status.track_regained');
        break;
      case 'round_complete': {
        const st = this.tracking.stats;
        const report = buildRoundReport(e.summary, {
          fpsMean: this.fps.stat.mean,
          inferMsMean: this.infer.mean,
          inferMsP95: this.infer.percentile(95),
          modelTier: 0,
          gpu: this.detector.delegate === 'GPU' ? 1 : 0,
          jitterRawMm: 0,
          jitterFilteredMm: 0,
          minCutoff: 0,
          beta: 0,
          dCutoff: 0,
          enterFrames: config.debounce.enterFrames,
          leaveFrames: config.debounce.leaveFrames,
          trackLostEvents: st.lostEvents,
          trackLostMs: st.lostMsTotal + st.currentLostMs,
          trackedRatio: st.frames ? st.trackedFrames / st.frames : 0,
          wristHiddenRatio: 0,
        });
        // Tag face mode in console metrics (numbers only): mode=1 means face.
        const tagged = { ...report, mode: 1 as const };
        console.info(JSON.stringify(tagged));
        this.audio.stop(LAB_CUE.ambience, config.audio.ambienceFadeOutMs);
        this.hud.setHint(null);
        this.hud.setConfidence(null);
        this.hud.showReport(
          report,
          e.summary.attempts.reduce<string[]>((ids, a) => ((ids[a.poseIndex] = a.poseId), ids), []),
          () => {
            this.audio.unlock();
            void this.audio.loop(LAB_CUE.ambience, config.audio.ambienceFadeInMs);
            this.session.nextRound();
          },
        );
        break;
      }
    }
  }
}
