/**
 * Live VTuber avatar skin mode (?mode=avatar).
 * Face Landmarker → blendshape morphs + head pose → large stage 皮套.
 * Continuous tracking (not the expression compliance game). Local-only.
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
import {
  blendshapesToMorphs,
  idleHeadPose,
  idleMorphs,
  landmarksToHeadPose,
  lerpMorphs,
  type AvatarMorphs,
  type HeadPose,
} from './core/avatarMorphs';
import { buildLabel } from './core/buildInfo';
import { diagLog } from './core/diagLog';
import { topBlendshapes } from './core/expressionRules';
import { FaceTrackingMonitor } from './core/faceTracking';
import type { I18n } from './core/i18n';
import { FpsMeter, RollingStat } from './core/metrics';
import { OneEuroFilter } from './core/oneEuro';
import { ButtonSafewordSource, SafewordController } from './core/safeword';
import { AudioToggle } from './render/audioToggle';
import { AvatarScene } from './render/avatarScene';
import { $ } from './render/dom';
import { FaceDebugPanel } from './render/faceDebugPanel';
import { Hud } from './render/hud';

export class AvatarApp {
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
  private readonly safeword: SafewordController;
  private readonly hud: Hud;
  private readonly scene: AvatarScene;
  private readonly audio: AudioBank;
  private readonly audioToggle: AudioToggle;
  private readonly faceDebugEl = document.getElementById('face-debug');
  private readonly faceDebug: FaceDebugPanel;

  private running = false;
  private vfcHandle = 0;
  private rafHandle = 0;
  private subjectN = Math.floor(1000 + Math.random() * 9000);
  private reloadInFlight: Promise<void> | null = null;
  private lastDetectErrorShown = '';
  private lastDebugAt = 0;
  private presenceLogged: boolean | null = null;
  private morphs: AvatarMorphs = idleMorphs();
  private pose: HeadPose = idleHeadPose();
  private poseFilters: Record<keyof HeadPose, OneEuroFilter>;

  constructor(private i18n: I18n<Lang>) {
    const q = new URLSearchParams(location.search);
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

    const fp = { ...config.filter };
    this.poseFilters = {
      yaw: new OneEuroFilter(fp),
      pitch: new OneEuroFilter(fp),
      roll: new OneEuroFilter(fp),
      x: new OneEuroFilter({ ...fp, minCutoff: 0.8 }),
      y: new OneEuroFilter({ ...fp, minCutoff: 0.8 }),
      scale: new OneEuroFilter({ ...fp, minCutoff: 0.6 }),
    };

    this.hud = new Hud(i18n);
    this.scene = new AvatarScene($('#three') as HTMLCanvasElement);

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
    this.hud.say('avatar.status.idle');
    // Hide pose/expression session chrome — live avatar only
    $('#command').textContent = '';
    $('#instruction').textContent = '';
    $('#countdown').textContent = '';
    $('#round-info').textContent = '';
    $('#phase-badge').textContent = this.i18n.t('avatar.phase_live');
    this.renderLangLinks();
    this.scene.setMirrored(true);
    this.scene.start();

    document.body.dataset.mode = 'avatar';
    const dbgRoot = $('#debug') as HTMLDetailsElement;
    const debugParam = q.get('debug');
    const debugOpen = debugParam === '0' ? false : config.ui.debugOpen || debugParam === '1';
    this.faceDebug = new FaceDebugPanel(dbgRoot, i18n, debugOpen);
    this.faceDebugEl?.classList.remove('hidden');
    this.renderBuildBadge();
    diagLog.push('app', 'avatar mode boot', {
      version: buildLabel(),
      debugOpen: debugOpen ? 1 : 0,
      href: location.href,
      secure: window.isSecureContext ? 1 : 0,
    });
    this.renderFaceDebug(null);
    $('#avatar-entry').classList.remove('hidden');

    $('#avatar-start-btn').addEventListener('click', () => void this.start());
    this.i18n.onChange(() => this.onI18nChange());
  }

  private renderBuildBadge(): void {
    const el = document.getElementById('build-badge');
    if (el) el.textContent = buildLabel();
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
    this.faceDebug.build();
    $('#phase-badge').textContent = this.i18n.t('avatar.phase_live');
    if (this.hud.statusKey) this.hud.say(this.hud.statusKey);
  }

  private async start(): Promise<void> {
    if (this.safeword.triggered || this.running) return;
    this.audio.unlock();
    void this.audio.loop(LAB_CUE.ambience, config.audio.ambienceFadeInMs);
    diagLog.push('app', 'avatar start clicked');
    try {
      if (!window.isSecureContext) throw Object.assign(new Error('insecure'), { code: 'insecure' });
      this.hud.setStartBusy(this.i18n.t('app.requesting_camera'), 'avatar-start-btn');
      void this.wakeLock.request().then((ok) => {
        if (!ok && this.wakeLock.supported) console.warn(this.i18n.t('app.wake_lock_failed'));
      });
      try {
        await this.camera.start(config.camera.facingMode);
      } catch (err) {
        console.error(err);
        diagLog.push('error', 'camera start failed', { error: String((err as Error)?.message ?? err) });
        throw Object.assign(new Error('camera'), { code: 'camera' });
      }
      if (this.safeword.triggered) return this.camera.stop();
      this.camWrap.classList.toggle('mirrored', this.camera.mirrored);
      this.scene.setMirrored(this.camera.mirrored);
      this.hud.setStartBusy(this.i18n.t('face.loading_model'), 'avatar-start-btn');
      try {
        await this.detector.load();
      } catch (err) {
        console.error(err);
        diagLog.push('error', 'model load failed', { error: String((err as Error)?.message ?? err) });
        throw Object.assign(new Error(String((err as Error)?.message ?? err)), { code: 'model' });
      }
      if (this.safeword.triggered) {
        this.camera.stop();
        this.detector.close();
        return;
      }
      this.hud.setStartBusy(null, 'avatar-start-btn');
      this.hud.hideStart();
      this.running = true;
      this.presenceLogged = null;
      this.lastDetectErrorShown = '';
      diagLog.push('app', 'avatar running', {
        delegate: this.detector.delegate ?? '—',
        model: this.detector.loadedModelUrl ?? '',
      });
      this.hud.say('avatar.status.live');
      this.lastDebugAt = 0;
      this.renderFaceDebug(null);
      this.scheduleNext();
    } catch (err) {
      const code = (err as { code?: string }).code;
      this.audio.stop(LAB_CUE.ambience, config.audio.ambienceFadeOutMs);
      this.camera.stop();
      this.hud.setStartBusy(null, 'avatar-start-btn');
      this.hud.showStartError(
        code === 'insecure'
          ? this.i18n.t('app.insecure_context')
          : code === 'camera'
            ? this.i18n.t('app.camera_denied')
            : this.i18n.t('face.model_failed', { error: (err as Error).message }),
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
    void this.wakeLock.release();
    this.clearOverlay();
    this.scene.setAvatar(idleMorphs(), idleHeadPose(), false);
    this.scene.stopAfter(3000);
    this.hud.hideStart();
    this.hud.setTrack('idle');
    this.hud.setLost(false);
    diagLog.push('app', 'safeword');
    this.hud.say('safeword.end_title');
    this.hud.showSafewordEnd();
    console.info(JSON.stringify({ safeword: 1, avatar: 1, atMs: Math.round(performance.now()) }));
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
      console.error('[avatar-lab] frame error', err);
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
    this.updatePresenceHud(!!frame?.present, lost);

    if (frame?.present) {
      const rawMorphs = blendshapesToMorphs(frame.blendshapes);
      this.morphs = lerpMorphs(this.morphs, rawMorphs, 0.45);
      const rawPose = landmarksToHeadPose(frame.landmarks);
      if (rawPose) this.pose = this.smoothPose(rawPose, now / 1000);
      this.scene.setAvatar(this.morphs, this.pose, true);
      this.drawOverlay(frame);
      this.hud.setTrack('tracking');
      this.hud.setLost(false);
    } else {
      this.morphs = lerpMorphs(this.morphs, idleMorphs(), 0.12);
      this.scene.setAvatar(this.morphs, this.pose, false);
      this.clearOverlay();
      this.hud.setTrack(lost ? 'lost' : track.state);
    }
  }

  private smoothPose(raw: HeadPose, tSec: number): HeadPose {
    const f = this.poseFilters;
    return {
      yaw: f.yaw.filter(raw.yaw, tSec),
      pitch: f.pitch.filter(raw.pitch, tSec),
      roll: f.roll.filter(raw.roll, tSec),
      x: f.x.filter(raw.x, tSec),
      y: f.y.filter(raw.y, tSec),
      scale: f.scale.filter(raw.scale, tSec),
    };
  }

  private ensureDetectorHealthy(): void {
    if (!this.detector.needsReload || this.reloadInFlight || this.safeword.triggered) return;
    diagLog.push('reload', 'Face Landmarker reload start');
    this.reloadInFlight = this.detector
      .load()
      .then(() => {
        this.lastDetectErrorShown = '';
        this.hud.setHint(null);
        diagLog.push('reload', 'Face Landmarker reload ok', { delegate: this.detector.delegate ?? '—' });
      })
      .catch((err) => {
        const msg = String((err as Error)?.message ?? err);
        this.hud.setHint(this.i18n.t('face.detect_error', { error: msg }));
        diagLog.push('error', 'Face Landmarker reload failed', { error: msg });
      })
      .finally(() => {
        this.reloadInFlight = null;
      });
  }

  private updatePresenceHud(present: boolean, lost: boolean): void {
    const detectErr = this.detector.lastError;
    if (detectErr && detectErr !== this.lastDetectErrorShown) {
      this.lastDetectErrorShown = detectErr;
      this.hud.setHint(this.i18n.t('face.detect_error', { error: detectErr }));
    }
    if (present) {
      if (this.presenceLogged !== true) {
        diagLog.push('presence', 'face acquired');
        this.presenceLogged = true;
        this.hud.say('avatar.status.tracking');
      }
      if (!detectErr && this.lastDetectErrorShown) {
        this.lastDetectErrorShown = '';
        this.hud.setHint(null);
      }
      return;
    }
    if (this.presenceLogged !== false) {
      diagLog.push('presence', 'face missing');
      this.presenceLogged = false;
    }
    if (lost) {
      this.hud.setLost(true);
      const banner = document.getElementById('lost-banner');
      if (banner) banner.textContent = this.i18n.t('face.no_face');
    }
  }

  private renderFaceDebug(frame: FaceFrame | null): void {
    const el = this.faceDebugEl;
    const d = this.detector.debug;
    const present = !!frame?.present;
    const shapes = frame?.blendshapes ?? {};
    if (el) {
      const status = this.i18n.t(present ? 'avatar.hud_driving' : 'face.hud_no_face');
      const m = this.morphs;
      const morphLine = this.i18n.t('avatar.hud_morphs', {
        smile: m.smile.toFixed(2),
        jaw: m.jawOpen.toFixed(2),
        blink: ((m.blinkL + m.blinkR) / 2).toFixed(2),
        brow: m.browUp.toFixed(2),
      });
      const poseLine = this.i18n.t('avatar.hud_pose', {
        yaw: ((this.pose.yaw * 180) / Math.PI).toFixed(0),
        pitch: ((this.pose.pitch * 180) / Math.PI).toFixed(0),
        roll: ((this.pose.roll * 180) / Math.PI).toFixed(0),
      });
      const top = topBlendshapes(shapes, 5)
        .map((b) => `${b.name}=${b.score.toFixed(2)}`)
        .join(' ');
      const topLine = top ? this.i18n.t('face.hud_top_shapes', { shapes: top }) : '';
      const vw = d.videoWidth || this.video.videoWidth;
      const vh = d.videoHeight || this.video.videoHeight;
      const mirror = this.camera.mirrored
        ? this.i18n.t(vh > vw && vw > 0 ? 'face.mirror_portrait' : 'face.mirror_label', { w: vw, h: vh })
        : this.i18n.t('face.mirror_off', { w: vw, h: vh });
      const err = d.lastError || d.skipReason || '—';
      const meta = `del:${d.delegate ?? '—'} ${vw}x${vh} rs:${d.readyState} hit:${d.detectHits}/${d.detectAttempts}${d.needsReload ? ' RELOAD' : ''} ${buildLabel()}`;
      el.textContent = [
        `${status} · ${this.i18n.t('face.debug_faces', { faces: frame?.faceCount ?? d.faceCount, presence: (present ? 1 : d.presenceScore).toFixed(2) })}`,
        morphLine,
        poseLine,
        topLine,
        mirror,
        this.i18n.t('face.debug_meta', { error: err.length > 60 ? `${err.slice(0, 60)}…` : err, meta }),
      ]
        .filter(Boolean)
        .join('\n');
      el.classList.toggle('ok', present);
      el.classList.toggle('warn', false);
      el.classList.toggle('bad', !present);
      el.classList.remove('hidden');
    }
    this.renderMirrorBadge(d.videoWidth || this.video.videoWidth, d.videoHeight || this.video.videoHeight);
    const now = performance.now();
    if (now - this.lastDebugAt > 1000 / config.ui.debugHz) {
      this.lastDebugAt = now;
      this.faceDebug.render({
        fps: this.fps.stat.mean,
        inferMs: this.infer.mean,
        detect: d,
        modelUrl: this.detector.loadedModelUrl,
        wasmDir: this.detector.loadedWasmDir,
        present,
        phase: 'live',
        targetId: null,
        exprStatus: null,
        exprScore: null,
        exprReason: present
          ? `smile=${this.morphs.smile.toFixed(2)} jaw=${this.morphs.jawOpen.toFixed(2)} blink=${((this.morphs.blinkL + this.morphs.blinkR) / 2).toFixed(2)}`
          : null,
        topShapes: topBlendshapes(shapes, 5)
          .map((b) => `${b.name}=${b.score.toFixed(2)}`)
          .join(' '),
        mirrored: this.camera.mirrored,
      });
    }
  }

  private renderMirrorBadge(w: number, h: number): void {
    const badge = document.getElementById('mirror-badge');
    if (!badge) return;
    if (!this.running) {
      badge.classList.add('hidden');
      return;
    }
    const portrait = h > w && w > 0;
    badge.textContent = this.camera.mirrored
      ? this.i18n.t(portrait ? 'face.mirror_portrait' : 'face.mirror_label', { w, h })
      : this.i18n.t('face.mirror_off', { w, h });
    badge.classList.remove('hidden');
  }

  private drawOverlay(frame: FaceFrame): void {
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
    // Light face oval only — avatar lives on the lab stage, not as a HUD face
    const nose = frame.landmarks[1];
    const chin = frame.landmarks[152];
    const eyeL = frame.landmarks[33];
    const eyeR = frame.landmarks[263];
    if (!nose || !chin || !eyeL || !eyeR) return;
    const cx = ((eyeL.x + eyeR.x) / 2) * canvas.width;
    const cy = ((nose.y + chin.y) / 2) * canvas.height;
    const rx = Math.hypot(eyeR.x - eyeL.x, eyeR.y - eyeL.y) * canvas.width * 1.1;
    const ry = Math.hypot(chin.x - nose.x, chin.y - nose.y) * canvas.height * 1.6;
    ctx.strokeStyle = 'rgba(120, 220, 255, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  private clearOverlay(): void {
    const ctx = this.overlay.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
  }
}
