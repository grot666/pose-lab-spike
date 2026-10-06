/**
 * Orchestrator: wires adapters (camera, MediaPipe, wake lock) -> core
 * (tracking, smoothing, rules, debounce, session, metrics, safeword) -> render
 * (2D skeleton, three.js lab, HUD, debug panel) + audio bank (ambience + UI cues).
 *
 * Modes: local (default), camera (phone host + PeerJS broadcast), viewer (desktop
 * receives landmarks + session; no MediaPipe). Room via ?role=&room= or lobby UI.
 */
import { CameraAdapter } from './adapters/camera';
import { MediaPipePoseDetector, type PoseDetector } from './adapters/mediapipePose';
import { WakeLockAdapter } from './adapters/wakeLock';
import { AudioBank, SilentAudioBackend } from './audio/audioBank';
import { loadAudioPrefs, safeLocalStorage, saveAudioPrefs } from './audio/audioPrefs';
import { LAB_CUE, LAB_CUES } from './audio/labCues';
import { WebAudioBackend } from './audio/webAudioBackend';
import { assetUrl } from './core/assetUrl';
import { config, type FacingMode, type Lang, type ModelTier } from './config';
import { buildLabel } from './core/buildInfo';
import { diagLog } from './core/diagLog';
import { computeAllAngles, headPitch, torsoTilt } from './core/geometry';
import type { I18n } from './core/i18n';
import { JitterMeter } from './core/jitter';
import { CORE_JOINTS, J, type PoseFrame } from './core/landmarks';
import { FpsMeter, RollingStat, buildRoundReport } from './core/metrics';
import { PoseSmoother } from './core/oneEuro';
import { evaluatePose, firstFailingRule, type PoseDefinition, type PoseEvaluation } from './core/poseRules';
import { ButtonSafewordSource, ExternalSafewordSource, SafewordController } from './core/safeword';
import { parseRoomParams, type RoomRole } from './core/roomCode';
import type { RoomEventMsg, RoomSessionMsg } from './core/roomProtocol';
import { PoseSession, type SessionEvent, type SessionSnapshot } from './core/session';
import { TrackingMonitor, type TrackSnapshot, type TrackState } from './core/tracking';
import { DebugPanel, type DebugSettings } from './render/debugPanel';
import { AudioToggle } from './render/audioToggle';
import { $ } from './render/dom';
import { Hud } from './render/hud';
import { LabScene } from './render/labScene';
import { Lobby } from './render/lobby';
import { Skeleton2D } from './render/skeleton2d';
import type { Mood } from './render/sphereAI';
import { RoomBridge } from './sync/roomBridge';
import type { PeerRoomState } from './adapters/peerRoom';

const TIERS: ModelTier[] = ['lite', 'full', 'heavy'];

export type AppMode = 'local' | 'camera' | 'viewer';

/** Cue src resolved via core/assetUrl (BASE_URL-safe for GitHub Pages). */
const JITTER_JOINTS = [J.nose, ...CORE_JOINTS, J.left_elbow, J.right_elbow, J.left_knee, J.right_knee];

export class App {
  private poses: PoseDefinition[];
  private poseMap = new Map<string, PoseDefinition>();
  private readonly video = $('#video') as HTMLVideoElement;
  private readonly camWrap = $('#cam-wrap');
  private readonly camera: CameraAdapter;
  private readonly detector: PoseDetector;
  private readonly wakeLock = new WakeLockAdapter();
  private readonly tracking = new TrackingMonitor({ ...config.tracking });
  private readonly smoother = new PoseSmoother({ ...config.filter });
  private readonly jitterRaw = new JitterMeter(JITTER_JOINTS, 0.08);
  private readonly jitterFilt = new JitterMeter(JITTER_JOINTS, 0.08);
  private readonly fps = new FpsMeter();
  private readonly infer = new RollingStat(600);
  private readonly session: PoseSession;
  private readonly safeword: SafewordController;
  private readonly hud: Hud;
  private readonly debug: DebugPanel;
  private readonly lab: LabScene;
  private readonly skeleton: Skeleton2D;
  private readonly audio: AudioBank;
  private readonly audioToggle: AudioToggle;
  private readonly lobby: Lobby;
  private readonly mode: AppMode;
  private readonly roomCode: string | null;
  private room: RoomBridge | null = null;
  private readonly remoteSafeword = new ExternalSafewordSource('remote-peer');
  private lastHint: string | null = null;
  private remoteStatusKey = '';

  private running = false;
  private busy: string | null = null;
  private vfcHandle = 0;
  private rafHandle = 0;
  private subjectN = Math.floor(1000 + Math.random() * 9000);
  private lastFrame: PoseFrame | null = null;
  private lastTrack: TrackSnapshot | null = null;
  private lastEval: PoseEvaluation | null = null;
  private lastDebugAt = 0;
  private lastSayAt = 0;
  private hintRule: string | null = null;
  private hintRuleSince = 0;
  private hintShownAt = 0;
  private resultMood: Mood = 'success';

  constructor(
    poses: PoseDefinition[],
    private i18n: I18n<Lang>,
  ) {
    this.poses = poses;
    this.indexPoses();
    const q = new URLSearchParams(location.search);
    const roomParams = parseRoomParams(location.search);
    this.mode = roomParams?.role ?? 'local';
    this.roomCode = roomParams?.room ?? null;
    const tierParam = q.get('tier') as ModelTier | null;
    const tier = tierParam && TIERS.includes(tierParam) ? tierParam : config.model.defaultTier;
    const sequence = q.get('seq') === 'sequential' ? 'sequential' : q.get('seq') === 'random' ? 'random' : config.session.sequenceMode;

    this.camera = new CameraAdapter(this.video, { ...config.camera });
    this.detector = new MediaPipePoseDetector({ ...config.model });
    this.session = new PoseSession(
      poses.map((p) => p.id),
      { ...config.session, sequenceMode: sequence, ...config.debounce },
    );
    this.session.on((e) => this.onSessionEvent(e));

    this.hud = new Hud(i18n);
    this.lab = new LabScene($('#three') as HTMLCanvasElement);
    this.skeleton = new Skeleton2D($('#overlay') as HTMLCanvasElement, this.video);

    const store = safeLocalStorage();
    const prefs = loadAudioPrefs(store, config.audio.storageKey, { muted: config.audio.defaultMuted, volume: config.audio.defaultVolume });
    if (q.get('mute') === '1') prefs.muted = true;
    this.audio = new AudioBank({
      backend: config.audio.enabled ? new WebAudioBackend(assetUrl, config.audio.busGain) : new SilentAudioBackend(),
      cues: LAB_CUES,
      volume: prefs.volume,
      muted: prefs.muted,
    });

    const settings: DebugSettings = {
      tier,
      facing: config.camera.facingMode,
      smoothing: true,
      ...config.filter,
      ...config.debounce,
      holdMinS: config.session.holdMinMs / 1000,
      holdMaxS: config.session.holdMaxMs / 1000,
      sequence,
      audioMuted: prefs.muted,
      audioVolume: prefs.volume,
    };
    const dbgRoot = $('#debug') as HTMLDetailsElement;
    const debugParam = q.get('debug');
    dbgRoot.open = debugParam === '0' ? false : config.ui.debugOpen || debugParam === '1';
    const buildBadge = document.getElementById('build-badge');
    if (buildBadge) buildBadge.textContent = buildLabel();
    diagLog.push('app', 'pose mode boot', { version: buildLabel(), debugOpen: dbgRoot.open ? 1 : 0 });
    this.debug = new DebugPanel(dbgRoot, i18n, settings, {
      onTier: (t) => void this.switchTier(t),
      onFacing: (f) => void this.switchFacing(f),
      onSettings: (s) => this.applySettings(s),
    });

    // Safeword: armed from the very first moment, even before Start.
    this.safeword = new SafewordController([new ButtonSafewordSource($('#safeword-btn')), this.remoteSafeword]);
    this.safeword.onTrigger((ev) => this.onSafeword(ev.sourceId === 'remote-peer'));
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
    this.hud.say('status.idle');
    this.renderLangLinks();
    this.lab.setMirrored(true);
    this.lab.setMood('idle');
    this.lab.start();

    this.lobby = new Lobby(i18n, () => void this.start(), () => void this.start());
    this.i18n.onChange(() => this.onI18nChange());

    if (this.mode !== 'local' && this.roomCode) {
      this.initRoom(this.mode, this.roomCode);
      if (this.mode === 'viewer') $('#viewer-placeholder').classList.remove('hidden');
    }
  }

  private initRoom(role: RoomRole, code: string): void {
    this.room = new RoomBridge(role, code, {
      onState: (s, d) => this.onRoomState(s, d),
      onLandmarks: (frame, track) => this.applyRemoteLandmarks(frame, track),
      onSession: (msg, snap) => this.applyRemoteSession(msg, snap),
      onEvent: (name) => this.applyRemoteEvent(name),
      onRemoteSafeword: () => this.remoteSafeword.fire(),
    });
    this.room.start();
    this.lobby.setStartEnabled(true);
  }

  private onRoomState(state: PeerRoomState, detail?: string): void {
    const code = this.roomCode ?? '';
    if (state === 'connecting') this.lobby.setStatus(this.i18n.t('room.connecting', { code }), 'info');
    else if (state === 'waiting_peer') {
      this.lobby.setStatus(detail === 'peer_closed' ? this.i18n.t('room.peer_lost') : this.i18n.t('room.waiting_peer', { code }), 'warn');
    } else if (state === 'connected') this.lobby.setStatus(this.i18n.t('room.connected', { code }), 'ok');
    else if (state === 'error') {
      const text = detail === 'room_taken' ? this.i18n.t('room.error_taken', { code }) : this.i18n.t('room.error', { detail: detail ?? 'error' });
      this.lobby.setStatus(text, 'err');
      this.hud.showStartError(text);
    } else if (state === 'closed') this.lobby.setStatus(this.i18n.t('room.peer_lost'), 'warn');
  }

  private subjectId(): string {
    return this.i18n.t('subject.id_format', { n: this.subjectN });
  }

  private indexPoses(): void {
    this.poseMap = new Map(this.poses.map((p) => [p.id, p]));
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

  // ---------------------------------------------------------------- hot reload
  setPoses(poses: PoseDefinition[]): void {
    this.poses = poses;
    this.indexPoses();
    this.session.setPoseIds(poses.map((p) => p.id));
    console.info('[pose-lab] poses.yaml reloaded:', poses.map((p) => p.id).join(', '));
  }

  private onI18nChange(): void {
    this.i18n.globals.subjectId = this.subjectId();
    this.hud.applyStatic();
    this.hud.setSubject();
    this.debug.build();
    this.audioToggle.render();
    this.renderLangLinks();
    this.lobby.reapplyI18n();
    if (this.hud.statusKey) this.hud.say(this.hud.statusKey, this.poseParams());
  }

  // ---------------------------------------------------------------- lifecycle
  private async start(): Promise<void> {
    if (this.safeword.triggered || this.running) return;
    // Inside the click gesture, before any await: unlock Web Audio (autoplay policy) and start the hum.
    this.audio.unlock();
    void this.audio.loop(LAB_CUE.ambience, config.audio.ambienceFadeInMs);

    if (this.mode === 'viewer') {
      this.hud.hideStart();
      this.running = true;
      this.hud.say('status.idle');
      this.scheduleViewerRender();
      return;
    }

    try {
      if (!window.isSecureContext) throw Object.assign(new Error('insecure'), { code: 'insecure' });
      this.lobby.setStartEnabled(false);
      this.hud.setStartBusy(this.i18n.t('app.requesting_camera'));
      void this.wakeLock.request().then((ok) => {
        if (!ok && this.wakeLock.supported) console.warn(this.i18n.t('app.wake_lock_failed'));
      });
      try {
        await this.camera.start(this.debug.settings.facing);
      } catch (err) {
        console.error(err);
        throw Object.assign(new Error('camera'), { code: 'camera' });
      }
      if (this.safeword.triggered) return this.camera.stop();
      this.applyMirror();
      this.hud.setStartBusy(this.i18n.t('app.loading_model', { tier: this.debug.settings.tier }));
      try {
        await this.detector.load(this.debug.settings.tier);
      } catch (err) {
        console.error(err);
        throw Object.assign(new Error(String((err as Error)?.message ?? err)), { code: 'model' });
      }
      if (this.safeword.triggered) {
        this.camera.stop();
        this.detector.close();
        return;
      }
      this.hud.hideStart();
      this.running = true;
      this.session.start();
      this.scheduleNext();
    } catch (err) {
      const code = (err as { code?: string }).code;
      this.audio.stop(LAB_CUE.ambience, config.audio.ambienceFadeOutMs);
      this.camera.stop();
      this.lobby.setStartEnabled(true);
      this.hud.setStartBusy(null);
      this.hud.showStartError(
        code === 'insecure'
          ? this.i18n.t('app.insecure_context')
          : code === 'camera'
            ? this.i18n.t('app.camera_denied')
            : this.i18n.t('app.model_failed', { error: (err as Error).message }),
      );
    }
  }

  private scheduleViewerRender(): void {
    if (!this.running || this.mode !== 'viewer') return;
    this.rafHandle = requestAnimationFrame(() => this.scheduleViewerRender());
  }

  private onSafeword(fromRemote = false): void {
    if (!fromRemote) this.room?.sendSafeword('corner-button');
    this.running = false;
    this.room?.destroy();
    this.room = null;
    this.audio.shutdown(config.audio.safewordFadeMs);
    const v = this.video as HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void };
    v.cancelVideoFrameCallback?.(this.vfcHandle);
    cancelAnimationFrame(this.rafHandle);
    this.camera.stop();
    this.detector.close();
    this.session.stop();
    void this.wakeLock.release();
    this.skeleton.clear();
    this.lab.setPose(null);
    this.lab.setProgress(0);
    this.lab.setMood('safeword');
    this.lab.stopAfter(3000);
    this.hud.hideStart();
    this.hud.update(this.session.snapshot());
    this.hud.setTrack('idle');
    this.hud.setLost(false);
    this.hud.say('safeword.end_title');
    this.hud.showSafewordEnd();
    console.info(JSON.stringify({ safeword: 1, atMs: Math.round(performance.now()) }));
  }

  private applyMirror(): void {
    const m = this.camera.mirrored;
    this.camWrap.classList.toggle('mirrored', m);
    this.lab.setMirrored(m);
  }

  private async switchTier(tier: ModelTier): Promise<void> {
    if (!this.running) return;
    this.busy = this.i18n.t('app.loading_model', { tier });
    this.debug.setTierBusy(this.busy);
    try {
      await this.detector.load(tier);
      this.smoother.reset();
      this.infer.clear();
    } catch (err) {
      console.error(err);
    } finally {
      this.busy = null;
      this.debug.setTierBusy(null);
    }
  }

  private async switchFacing(f: FacingMode): Promise<void> {
    if (!this.running) return;
    this.busy = this.i18n.t('debug.switching');
    try {
      await this.camera.start(f);
      this.applyMirror();
      this.smoother.reset();
    } catch (err) {
      console.error(err);
    } finally {
      this.busy = null;
    }
  }

  // ---------------------------------------------------------------- audio
  private toggleMute(): void {
    if (this.audio.disposed) return;
    this.debug.settings.audioMuted = !this.audio.muted;
    this.debug.syncInputs();
    this.applyAudio(this.debug.settings);
  }

  private applyAudio(s: Pick<DebugSettings, 'audioMuted' | 'audioVolume'>): void {
    if (s.audioMuted !== this.audio.muted) this.audio.setMuted(s.audioMuted);
    if (s.audioVolume !== this.audio.volume) this.audio.setVolume(s.audioVolume);
    this.audioToggle.set(this.audio.muted);
    saveAudioPrefs(safeLocalStorage(), config.audio.storageKey, { muted: this.audio.muted, volume: this.audio.volume });
  }

  private applySettings(s: DebugSettings): void {
    this.applyAudio(s);
    this.smoother.setParams({ minCutoff: s.minCutoff, beta: s.beta, dCutoff: s.dCutoff });
    if (this.smoother.enabled !== s.smoothing) this.smoother.reset();
    this.smoother.enabled = s.smoothing;
    this.session.setDebounceFrames(s.enterFrames, s.leaveFrames);
    this.session.opts.holdMinMs = s.holdMinS * 1000;
    this.session.opts.holdMaxMs = s.holdMaxS * 1000;
    this.session.opts.sequenceMode = s.sequence;
  }

  // ---------------------------------------------------------------- frame loop
  private scheduleNext(): void {
    if (!this.running) return;
    const v = this.video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    if (v.requestVideoFrameCallback) this.vfcHandle = v.requestVideoFrameCallback(() => this.tick());
    else this.rafHandle = requestAnimationFrame(() => this.tick());
  }

  private tick(): void {
    if (!this.running) return;
    try {
      if (!this.busy && this.camera.active) this.process(performance.now());
    } catch (err) {
      console.error('[pose-lab] frame error', err);
    }
    this.scheduleNext();
  }

  private process(now: number): void {
    const t0 = performance.now();
    const raw = this.detector.detect(this.video, now);
    this.infer.push(performance.now() - t0);
    this.fps.tick(now);

    const track = this.tracking.update(raw, now);
    const lost = track.state === 'lost';
    if (!raw || lost) {
      this.smoother.reset();
      this.jitterRaw.reset();
      this.jitterFilt.reset();
    }
    const frame = raw && !lost ? this.smoother.apply(raw) : null;
    if (raw && frame) {
      this.jitterRaw.push(raw.world);
      this.jitterFilt.push(frame.world);
    }

    const targetId = this.session.targetPoseId;
    const target = targetId ? this.poseMap.get(targetId) : undefined;
    const ev = frame && target ? evaluatePose(frame.world, target, { visibilityThreshold: config.tracking.visibilityThreshold }) : null;

    const prevTrack = this.lastTrack?.state;
    const snap = this.session.update({
      nowMs: now,
      track: track.state,
      targetStatus: ev?.status ?? null,
      wristsHidden: track.wristsHidden,
    });

    this.lastFrame = frame;
    this.lastTrack = track;
    this.lastEval = ev;

    // ---- render
    this.skeleton.draw(frame ?? (raw && !lost ? raw : null), lost);
    this.lab.setPose(frame ? frame.world : null);
    this.lab.setMood(this.moodFor(snap));
    this.lab.setProgress(snap.phase === 'holding' ? snap.holdElapsedMs / snap.holdTargetMs : snap.phase === 'result' && snap.lastOutcome === 'success' ? 1 : 0);
    if (prevTrack !== track.state) this.hud.setTrack(track.state);
    this.hud.setLost(snap.paused || (lost && snap.phase !== 'searching'));
    this.hud.update(snap);
    this.updateVoice(snap, track, ev, now);
    if (now - this.lastDebugAt > 1000 / config.ui.debugHz) {
      this.lastDebugAt = now;
      this.renderDebug(track);
    }

    if (this.mode === 'camera' && this.room) {
      if (frame) this.room.sendLandmarks(frame, track.state, now);
      this.room.sendSession(
        snap,
        {
          subjectN: this.subjectN,
          statusKey: this.hud.statusKey,
          hint: this.lastHint,
          resultMood: this.resultMood === 'success' || this.resultMood === 'fail' ? this.resultMood : 'idle',
        },
        now,
      );
    }
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

  private poseParams(): Record<string, string> {
    const id = this.session.targetPoseId;
    return id ? { pose: this.i18n.t(`poses.${id}.name`) } : {};
  }

  /** Ambient lines + correction hints (debounced so text does not flicker). */
  private updateVoice(s: SessionSnapshot, track: TrackSnapshot, ev: PoseEvaluation | null, now: number): void {
    const since = now - this.lastSayAt;
    if (s.phase === 'searching' && since > 6000) this.say('status.searching', now);
    if (s.phase === 'holding' && !s.paused && since > 4500) this.say('status.holding', now);

    let hint: string | null = null;
    if ((s.phase === 'entering' || s.phase === 'holding') && !s.paused && ev) {
      if (ev.status === 'fail') {
        const rule = firstFailingRule(ev);
        if (rule !== this.hintRule) {
          this.hintRule = rule;
          this.hintRuleSince = now;
        }
        // only surface a correction once the same rule has failed for a moment
        if (rule && now - this.hintRuleSince > 450) hint = this.i18n.t(`hints.${rule}`);
      } else if (ev.status === 'unknown') {
        this.hintRule = null;
        if (track.wristsHidden && !(ev.poseId === 'at_your_service')) hint = this.i18n.t('status.wrists_hidden');
        else if (track.lowerBodyHidden) hint = this.i18n.t('status.lower_body_hidden');
      } else this.hintRule = null;
    } else if (s.phase === 'searching' && track.lowerBodyHidden) {
      hint = this.i18n.t('status.lower_body_hidden');
    }
    const current = (document.getElementById('hint-line')?.textContent ?? '') || null;
    if (hint !== current && (hint === null || now - this.hintShownAt > 1200)) {
      this.hud.setHint(hint);
      this.lastHint = hint;
      this.hintShownAt = now;
    }
  }

  private say(key: string, now = performance.now()): void {
    this.hud.say(key, this.poseParams());
    this.lastSayAt = now;
  }

  private onSessionEvent(e: SessionEvent): void {
    switch (e.type) {
      case 'person_found':
        this.room?.sendEvent('person_found');
        this.tracking.resetStats();
        this.fps.stat.clear();
        this.infer.clear();
        this.jitterRaw.clearStats();
        this.jitterFilt.clearStats();
        this.say('status.person_found');
        break;
      case 'phase':
        if (e.phase === 'entering' && this.hud.statusKey !== 'status.leave') this.say('status.entering');
        if (e.phase === 'searching') this.say('status.searching');
        break;
      case 'command':
        this.room?.sendEvent('command');
        this.room?.sendSession(
          this.session.snapshot(),
          { subjectN: this.subjectN, statusKey: this.hud.statusKey, hint: this.lastHint, resultMood: 'idle' },
          performance.now(),
          true,
        );
        void this.audio.play(LAB_CUE.command);
        break;
      case 'enter':
        this.room?.sendEvent('enter');
        this.say('status.entered');
        break;
      case 'leave':
        this.room?.sendEvent('leave');
        this.say('status.leave');
        break;
      case 'result':
        this.resultMood = e.outcome === 'success' ? 'success' : 'fail';
        this.room?.sendEvent(e.outcome === 'success' ? 'result_success' : 'result_fail');
        void this.audio.play(e.outcome === 'success' ? LAB_CUE.success : LAB_CUE.fail);
        this.say(e.outcome === 'success' ? 'status.success' : 'status.fail_timeout');
        this.hud.setHint(null);
        break;
      case 'track_lost':
        this.room?.sendEvent('track_lost');
        void this.audio.play(LAB_CUE.trackLost);
        this.say('status.track_lost');
        break;
      case 'track_regained':
        this.room?.sendEvent('track_regained');
        this.say('status.track_regained');
        break;
      case 'round_complete': {
        this.room?.sendEvent('round_complete');
        const st = this.tracking.stats;
        const report = buildRoundReport(e.summary, {
          fpsMean: this.fps.stat.mean,
          inferMsMean: this.infer.mean,
          inferMsP95: this.infer.percentile(95),
          modelTier: Math.max(0, TIERS.indexOf(this.detector.tier ?? 'full')),
          gpu: this.detector.delegate === 'GPU' ? 1 : 0,
          jitterRawMm: this.jitterRaw.mean,
          jitterFilteredMm: this.jitterFilt.mean,
          minCutoff: this.debug.settings.minCutoff,
          beta: this.debug.settings.beta,
          dCutoff: this.debug.settings.dCutoff,
          enterFrames: this.debug.settings.enterFrames,
          leaveFrames: this.debug.settings.leaveFrames,
          trackLostEvents: st.lostEvents,
          trackLostMs: st.lostMsTotal + st.currentLostMs,
          trackedRatio: st.frames ? (st.trackedFrames + st.partialFrames) / st.frames : 0,
          wristHiddenRatio: st.frames ? st.wristHiddenFrames / st.frames : 0,
        });
        // numbers-only metrics JSON
        console.info(JSON.stringify(report));
        this.audio.stop(LAB_CUE.ambience, config.audio.ambienceFadeOutMs);
        this.hud.setHint(null);
        this.hud.showReport(
          report,
          e.summary.attempts.reduce<string[]>((ids, a) => ((ids[a.poseIndex] = a.poseId), ids), []),
          () => {
            // the "next round" click is a fresh gesture: hum back on
            this.audio.unlock();
            void this.audio.loop(LAB_CUE.ambience, config.audio.ambienceFadeInMs);
            this.session.nextRound();
          },
        );
        break;
      }
    }
  }

  private renderDebug(track: TrackSnapshot): void {
    const f = this.lastFrame;
    let target = this.lastEval;
    if (!target && f) {
      // no active command: show the best-matching pose to help tune rules
      let best: PoseEvaluation | null = null;
      for (const p of this.poses) {
        const ev = evaluatePose(f.world, p, { visibilityThreshold: config.tracking.visibilityThreshold });
        if (!best || ev.score > best.score) best = ev;
      }
      target = best;
    }
    this.debug.render({
      fps: this.fps.fps,
      inferMs: this.infer.last,
      inferP95: this.infer.percentile(95),
      delegate: `${this.detector.delegate ?? '—'} · ${this.camera.resolution.width}×${this.camera.resolution.height}`,
      busy: this.busy,
      trackState: track.state,
      stats: this.tracking.stats,
      visibility: f ? f.image.map((l) => l.visibility) : null,
      angles: f ? computeAllAngles(f.world) : {},
      headPitch: f ? headPitch(f.world) : NaN,
      torsoTilt: f ? torsoTilt(f.world) : NaN,
      jitterRaw: this.jitterRaw.value,
      jitterFiltered: this.jitterFilt.value,
      target,
      audioState: `${this.audio.state}${this.audio.isLooping(LAB_CUE.ambience) ? ' · ambience' : ''}`,
    });
  }

  // ---------------------------------------------------------------- room viewer
  private applyRemoteLandmarks(frame: PoseFrame, track: TrackState): void {
    if (!this.running || this.mode !== 'viewer') return;
    this.lastFrame = frame;
    const lost = track === 'lost';
    this.skeleton.draw(lost ? null : frame, lost);
    this.lab.setPose(lost ? null : frame.world);
    this.hud.setTrack(track);
    $('#viewer-placeholder').classList.add('hidden');
    const now = performance.now();
    if (now - this.lastDebugAt > 1000 / config.ui.debugHz) {
      this.lastDebugAt = now;
      this.renderDebug({
        state: track,
        rawPresent: track === 'tracking' || track === 'partial',
        wristsHidden: false,
        wristHidden: [false, false],
        lowerBodyHidden: false,
        coreVisibility: 1,
      });
    }
  }

  private applyRemoteSession(msg: RoomSessionMsg, snap: SessionSnapshot): void {
    if (!this.running || this.mode !== 'viewer') return;
    this.subjectN = msg.subjectN;
    this.i18n.globals.subjectId = this.subjectId();
    this.hud.setSubject();
    if (msg.resultMood === 'success' || msg.resultMood === 'fail') this.resultMood = msg.resultMood;
    this.lab.setMood(this.moodFor(snap));
    this.lab.setProgress(
      snap.phase === 'holding'
        ? snap.holdElapsedMs / Math.max(1, snap.holdTargetMs)
        : snap.phase === 'result' && snap.lastOutcome === 'success'
          ? 1
          : 0,
    );
    this.hud.setLost(snap.paused);
    this.hud.update(snap);
    if (msg.statusKey && msg.statusKey !== this.remoteStatusKey) {
      this.remoteStatusKey = msg.statusKey;
      const poseParams: Record<string, string | number> = snap.poseId
        ? { pose: this.i18n.t(`poses.${snap.poseId}.name`) }
        : {};
      this.hud.say(msg.statusKey, poseParams);
    }
    if (msg.hint !== this.lastHint) {
      this.lastHint = msg.hint;
      this.hud.setHint(msg.hint);
    }
  }

  private applyRemoteEvent(name: RoomEventMsg['name']): void {
    if (!this.running || this.mode !== 'viewer') return;
    switch (name) {
      case 'command':
        void this.audio.play(LAB_CUE.command);
        break;
      case 'result_success':
        this.resultMood = 'success';
        void this.audio.play(LAB_CUE.success);
        break;
      case 'result_fail':
        this.resultMood = 'fail';
        void this.audio.play(LAB_CUE.fail);
        break;
      case 'track_lost':
        void this.audio.play(LAB_CUE.trackLost);
        break;
      case 'round_complete':
        this.audio.stop(LAB_CUE.ambience, config.audio.ambienceFadeOutMs);
        break;
      default:
        break;
    }
  }
}
