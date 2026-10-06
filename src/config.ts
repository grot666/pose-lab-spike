/**
 * Runtime configuration (numbers / switches only).
 * All user-facing COPY lives exclusively in src/content/i18n/{zh-CN,en}.yaml.
 * Pose rules live exclusively in src/content/poses.yaml.
 * Expression rules live exclusively in src/content/expressions.yaml.
 */
export type Lang = 'zh-CN' | 'en';
export type ModelTier = 'lite' | 'full' | 'heavy';
export type SequenceMode = 'random' | 'sequential';
export type FacingMode = 'user' | 'environment';

export interface AppConfig {
  /** Default language. Override at runtime with ?lang=en / ?lang=zh-CN. */
  defaultLang: Lang;
  /** Language used when a key is missing in the active language. */
  fallbackLang: Lang;
  camera: { width: number; height: number; facingMode: FacingMode };
  model: {
    defaultTier: ModelTier;
    /** Paths are relative to Vite BASE_URL -> served from public/, never from the network. */
    wasmPath: string;
    modelPaths: Record<ModelTier, string>;
    preferGpu: boolean;
    minPoseDetectionConfidence: number;
    minPosePresenceConfidence: number;
    minTrackingConfidence: number;
  };
  /** Face Landmarker (expression ?mode=face and avatar ?mode=avatar). Same offline public/ pattern. */
  face: {
    modelPath: string;
    preferGpu: boolean;
    minFaceDetectionConfidence: number;
    minFacePresenceConfidence: number;
    minTrackingConfidence: number;
    numFaces: number;
  };
  /**
   * Session timing overrides for ?mode=face (mobile-friendly).
   * Shorter holds + lower enter/leave N so mild expressions can register.
   */
  faceSession: {
    enterFrames: number;
    leaveFrames: number;
    holdMinMs: number;
    holdMaxMs: number;
    personDetectFrames: number;
    enterTimeoutMs: number;
    commandAnnounceMs: number;
    resultShowMs: number;
    /** DiagLog throttle for expression score lines (ms). */
    scoreLogIntervalMs: number;
  };
  filter: { minCutoff: number; beta: number; dCutoff: number };
  debounce: { enterFrames: number; leaveFrames: number };
  tracking: {
    /** Visibility threshold for a joint to count as "visible". */
    visibilityThreshold: number;
    /** Mean visibility of shoulders+hips required to count as tracked. */
    coreVisibility: number;
    /** Consecutive bad time before declaring full track loss (avoids flicker). */
    lostAfterMs: number;
    /** Consecutive good frames before leaving the lost state. */
    regainFrames: number;
  };
  session: {
    sequenceMode: SequenceMode;
    /** Number of pose commands per round. 0 = one pass over all poses. */
    posesPerRound: number;
    /** Time allowed to get into the commanded pose. */
    enterTimeoutMs: number;
    /** Hold duration range (a value is drawn uniformly per command; min==max for fixed). */
    holdMinMs: number;
    holdMaxMs: number;
    /** Frames of a stable person before the round starts. */
    personDetectFrames: number;
    /** How long the command is announced before the enter countdown starts. */
    commandAnnounceMs: number;
    /** How long a success/fail result is shown before the next command. */
    resultShowMs: number;
  };
  ui: {
    /** Debug panel refresh rate (Hz) - DOM updates are throttled. */
    debugHz: number;
    /** Show debug panel expanded on load (default on). ?debug=0 closes; ?debug=1 forces open. */
    debugOpen: boolean;
  };
  audio: {
    /** Master switch. Cue files/paths live in src/audio/labCues.ts. */
    enabled: boolean;
    /** Defaults before the user changes anything (persisted to localStorage afterwards). Also ?mute=1. */
    defaultVolume: number;
    defaultMuted: boolean;
    storageKey: string;
    /** Bus gains (multiplied by per-cue volume and the master volume). */
    busGain: { ambience: number; sfx: number };
    ambienceFadeInMs: number;
    /** Fade when a round ends (report screen). */
    ambienceFadeOutMs: number;
    /** Fade on safeword - short, but avoids a click. */
    safewordFadeMs: number;
  };
  /**
   * Multi-device room sync (PeerJS cloud broker). Single-device mode ignores this.
   * CSP must allow connect-src to peerHost (see index.html).
   */
  room: {
    peerHost: string;
    peerPort: number;
    peerPath: string;
    peerSecure: boolean;
    /** Max landmark send rate from camera (Hz). */
    landmarkHz: number;
    /** Max session-snapshot send rate from camera (Hz). */
    sessionHz: number;
  };
}

export const config: AppConfig = {
  defaultLang: 'zh-CN',
  fallbackLang: 'en',
  camera: { width: 1280, height: 720, facingMode: 'user' },
  model: {
    defaultTier: 'full',
    wasmPath: 'mediapipe/wasm',
    modelPaths: {
      lite: 'models/pose_landmarker_lite.task',
      full: 'models/pose_landmarker_full.task',
      heavy: 'models/pose_landmarker_heavy.task',
    },
    preferGpu: true,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  },
  face: {
    modelPath: 'models/face_landmarker.task',
    // CPU default: Face Landmarker GPU + three.js WebGL on the same page can
    // starve/empty-infer on some devices; create-time GPU→CPU fallback remains.
    preferGpu: false,
    // Loose gates — webcam framing often yields marginal presence scores.
    minFaceDetectionConfidence: 0.3,
    minFacePresenceConfidence: 0.3,
    minTrackingConfidence: 0.3,
    numFaces: 1,
  },
  faceSession: {
    // Pose defaults are enter=10 / leave=15 / hold 5–15s — too sticky for faces.
    enterFrames: 4,
    leaveFrames: 6,
    holdMinMs: 2_000,
    holdMaxMs: 4_500,
    personDetectFrames: 6,
    enterTimeoutMs: 12_000,
    commandAnnounceMs: 1_400,
    resultShowMs: 2_200,
    scoreLogIntervalMs: 500,
  },
  filter: { minCutoff: 1.2, beta: 0.05, dCutoff: 1.0 },
  debounce: { enterFrames: 10, leaveFrames: 15 },
  tracking: {
    visibilityThreshold: 0.5,
    coreVisibility: 0.5,
    lostAfterMs: 400,
    regainFrames: 3,
  },
  session: {
    sequenceMode: 'random',
    posesPerRound: 0,
    enterTimeoutMs: 10_000,
    holdMinMs: 5_000,
    holdMaxMs: 15_000,
    personDetectFrames: 15,
    commandAnnounceMs: 1_800,
    resultShowMs: 2_600,
  },
  ui: { debugHz: 6, debugOpen: true },
  audio: {
    enabled: true,
    defaultVolume: 0.6,
    defaultMuted: false,
    storageKey: 'pose-lab.audio',
    busGain: { ambience: 1, sfx: 0.8 },
    ambienceFadeInMs: 2500,
    ambienceFadeOutMs: 1500,
    safewordFadeMs: 200,
  },
  room: {
    peerHost: '0.peerjs.com',
    peerPort: 443,
    peerPath: '/',
    peerSecure: true,
    landmarkHz: 20,
    sessionHz: 10,
  },
};
