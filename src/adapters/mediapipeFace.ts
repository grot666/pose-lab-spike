/**
 * The ONLY module that touches MediaPipe Face Landmarker. Converts results into
 * a plain BlendshapeMap + face-present flag so core code never imports MediaPipe types.
 *
 * Assets load from public/ (same origin): no runtime CDN / model-host network.
 *
 * Important MediaPipe VIDEO-mode pitfalls handled here:
 * - Timestamps must be strictly increasing integer ms (duplicate/decreasing throws
 *   and wedges the calculator graph until the task is recreated).
 * - Calling detectForVideo with 0×0 frames also wedges the graph — skip instead.
 * - After any detectForVideo throw, close + set needsReload so the app can load() again.
 */
import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from '@mediapipe/tasks-vision';
import { assetUrl, wasmAssetDir } from '../core/assetUrl';
import { diagLog } from '../core/diagLog';
import { blendshapesFromCategories, type BlendshapeMap } from '../core/expressionRules';
import { nextVideoTimestampMs } from '../core/videoTimestamp';

export interface FaceDetectorOptions {
  wasmPath: string;
  /** Relative to BASE_URL, e.g. models/face_landmarker.task */
  modelPath: string;
  preferGpu: boolean;
  minFaceDetectionConfidence: number;
  minFacePresenceConfidence: number;
  minTrackingConfidence: number;
  numFaces: number;
}

export interface FaceFrame {
  timestampMs: number;
  /** True when at least one face mesh was returned. */
  present: boolean;
  blendshapes: BlendshapeMap;
  /** Normalized face landmarks (image space) for optional overlay; may be empty. */
  landmarks: Array<{ x: number; y: number; z: number }>;
  /** Faces returned by MediaPipe this call (0 when absent). */
  faceCount: number;
}

export interface FaceDetectDebug {
  faceCount: number;
  /** 1 when a face mesh was returned, else 0 (Landmarker does not expose a raw score). */
  presenceScore: number;
  lastError: string | null;
  skipReason: string | null;
  delegate: 'GPU' | 'CPU' | null;
  videoWidth: number;
  videoHeight: number;
  readyState: number;
  timestampMs: number;
  needsReload: boolean;
  detectAttempts: number;
  detectHits: number;
  detectMisses: number;
}

export interface FaceDetector {
  readonly delegate: 'GPU' | 'CPU' | null;
  /** Last detect/load error message (cleared on successful detect). */
  readonly lastError: string | null;
  /** After a detectForVideo fault the graph is dead — caller must load() again. */
  readonly needsReload: boolean;
  readonly debug: FaceDetectDebug;
  readonly loadedModelUrl: string | null;
  readonly loadedWasmDir: string | null;
  load(): Promise<void>;
  detect(video: HTMLVideoElement, timestampMs: number): FaceFrame | null;
  close(): void;
}

export function toFaceFrame(result: FaceLandmarkerResult, timestampMs: number): FaceFrame | null {
  const faceCount = result.faceLandmarks?.length ?? 0;
  const landmarks = result.faceLandmarks?.[0];
  if (!landmarks || !landmarks.length) return null;
  const cats = result.faceBlendshapes?.[0]?.categories ?? [];
  return {
    timestampMs,
    present: true,
    blendshapes: blendshapesFromCategories(cats),
    landmarks: landmarks.map((l) => ({ x: l.x, y: l.y, z: l.z })),
    faceCount,
  };
}

async function assertAssetReachable(url: string, label: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'HEAD', cache: 'no-cache' });
  } catch (err) {
    throw new Error(`${label} fetch failed (${url}): ${(err as Error)?.message ?? err}`);
  }
  // Some static hosts omit HEAD or block it; fall back to ranged GET.
  if (!res.ok || res.status === 405 || res.status === 501) {
    try {
      res = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, cache: 'no-cache' });
    } catch (err) {
      throw new Error(`${label} ranged GET failed (${url}): ${(err as Error)?.message ?? err}`);
    }
  }
  if (!res.ok && res.status !== 206) {
    throw new Error(`${label} HTTP ${res.status} at ${url}`);
  }
  diagLog.push('model', `${label} reachable`, { status: res.status, url });
}

export class MediaPipeFaceDetector implements FaceDetector {
  private landmarker: FaceLandmarker | null = null;
  private fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
  private lastTs = -1;
  private skipReason: string | null = null;
  private lastFaceCount = 0;
  private lastPresence = 0;
  private lastVideoW = 0;
  private lastVideoH = 0;
  private lastReadyState = 0;
  private lastUsedTs = -1;
  private detectAttempts = 0;
  private detectHits = 0;
  private detectMisses = 0;
  private lastLoggedSkip: string | null = null;
  private lastMissLogAt = 0;
  private lastHitLogAt = 0;
  needsReload = false;
  delegate: 'GPU' | 'CPU' | null = null;
  lastError: string | null = null;
  /** Resolved URLs after a successful load (for HUD / debug). */
  loadedModelUrl: string | null = null;
  loadedWasmDir: string | null = null;

  constructor(private opts: FaceDetectorOptions) {}

  get debug(): FaceDetectDebug {
    return {
      faceCount: this.lastFaceCount,
      presenceScore: this.lastPresence,
      lastError: this.lastError,
      skipReason: this.skipReason,
      delegate: this.delegate,
      videoWidth: this.lastVideoW,
      videoHeight: this.lastVideoH,
      readyState: this.lastReadyState,
      timestampMs: this.lastUsedTs,
      needsReload: this.needsReload,
      detectAttempts: this.detectAttempts,
      detectHits: this.detectHits,
      detectMisses: this.detectMisses,
    };
  }

  async load(): Promise<void> {
    this.lastError = null;
    this.needsReload = false;
    this.skipReason = null;
    this.lastLoggedSkip = null;
    const wasmDir = wasmAssetDir(this.opts.wasmPath);
    const model = assetUrl(this.opts.modelPath);
    this.loadedWasmDir = wasmDir;
    this.loadedModelUrl = model;
    diagLog.push('model', 'load start', {
      model,
      wasmDir,
      preferGpu: this.opts.preferGpu ? 1 : 0,
      minDet: this.opts.minFaceDetectionConfidence,
      minPres: this.opts.minFacePresenceConfidence,
      minTrack: this.opts.minTrackingConfidence,
    });

    await assertAssetReachable(model, 'Face model');
    // Probe one wasm script so a wrong BASE_URL fails with a clear message (not a WASM instantiate crash).
    await assertAssetReachable(`${wasmDir}/vision_wasm_internal.js`, 'MediaPipe WASM');

    if (!this.fileset) {
      diagLog.push('model', 'FilesetResolver.forVisionTasks', { wasmDir });
      this.fileset = await FilesetResolver.forVisionTasks(wasmDir);
    }
    const create = (delegate: 'GPU' | 'CPU') =>
      FaceLandmarker.createFromOptions(this.fileset!, {
        baseOptions: { modelAssetPath: model, delegate },
        runningMode: 'VIDEO',
        numFaces: this.opts.numFaces,
        minFaceDetectionConfidence: this.opts.minFaceDetectionConfidence,
        minFacePresenceConfidence: this.opts.minFacePresenceConfidence,
        minTrackingConfidence: this.opts.minTrackingConfidence,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: false,
      });
    let next: FaceLandmarker;
    let delegate: 'GPU' | 'CPU' = this.opts.preferGpu ? 'GPU' : 'CPU';
    try {
      diagLog.push('model', `createFromOptions ${delegate}`);
      next = await create(delegate);
    } catch (err) {
      if (delegate === 'CPU') {
        this.lastError = String((err as Error)?.message ?? err);
        diagLog.push('error', 'Face Landmarker create failed (CPU)', { error: this.lastError });
        throw err;
      }
      console.warn('[face] GPU delegate failed, falling back to CPU', err);
      diagLog.push('model', 'GPU create failed → CPU fallback', { error: String((err as Error)?.message ?? err) });
      delegate = 'CPU';
      try {
        next = await create(delegate);
      } catch (err2) {
        this.lastError = String((err2 as Error)?.message ?? err2);
        diagLog.push('error', 'Face Landmarker create failed (CPU fallback)', { error: this.lastError });
        throw err2;
      }
    }
    this.landmarker?.close();
    this.landmarker = next;
    this.delegate = delegate;
    this.lastTs = -1;
    this.lastUsedTs = -1;
    diagLog.push('model', 'load ok', { delegate });
  }

  detect(video: HTMLVideoElement, timestampMs: number): FaceFrame | null {
    this.lastVideoW = video.videoWidth || 0;
    this.lastVideoH = video.videoHeight || 0;
    this.lastReadyState = video.readyState;

    if (this.needsReload || !this.landmarker) {
      this.noteSkip(this.needsReload ? 'needs_reload' : 'not_loaded');
      this.lastFaceCount = 0;
      this.lastPresence = 0;
      return null;
    }
    if (video.readyState < 2) {
      this.noteSkip(`readyState_${video.readyState}`);
      this.lastFaceCount = 0;
      this.lastPresence = 0;
      return null;
    }
    // 0×0 frames throw inside MediaPipe and permanently wedge the graph — never call.
    if (video.videoWidth < 1 || video.videoHeight < 1) {
      this.noteSkip('zero_size');
      this.lastFaceCount = 0;
      this.lastPresence = 0;
      return null;
    }

    const ts = nextVideoTimestampMs(timestampMs, this.lastTs);
    this.lastTs = ts;
    this.lastUsedTs = ts;
    this.skipReason = null;
    this.lastLoggedSkip = null;
    this.detectAttempts += 1;
    try {
      const result = this.landmarker.detectForVideo(video, ts);
      this.lastError = null;
      this.lastFaceCount = result.faceLandmarks?.length ?? 0;
      this.lastPresence = this.lastFaceCount > 0 ? 1 : 0;
      const frame = toFaceFrame(result, timestampMs);
      if (frame) {
        this.detectHits += 1;
        const now = typeof performance !== 'undefined' ? performance.now() : 0;
        if (now - this.lastHitLogAt > 1000) {
          this.lastHitLogAt = now;
          const lm0 = frame.landmarks[0];
          diagLog.push('detect', 'hit', {
            faces: frame.faceCount,
            blendshapes: Object.keys(frame.blendshapes).length,
            ts,
            x0: lm0?.x ?? -1,
            y0: lm0?.y ?? -1,
            hits: this.detectHits,
            attempts: this.detectAttempts,
          });
        }
      } else {
        this.detectMisses += 1;
        const now = typeof performance !== 'undefined' ? performance.now() : 0;
        if (now - this.lastMissLogAt > 500) {
          this.lastMissLogAt = now;
          diagLog.push('detect', 'miss', {
            faces: this.lastFaceCount,
            ts,
            w: this.lastVideoW,
            h: this.lastVideoH,
            rs: this.lastReadyState,
            misses: this.detectMisses,
            attempts: this.detectAttempts,
            delegate: this.delegate ?? '—',
          });
        }
      }
      return frame;
    } catch (err) {
      this.lastError = String((err as Error)?.message ?? err);
      this.lastFaceCount = 0;
      this.lastPresence = 0;
      this.detectMisses += 1;
      console.error('[face] detectForVideo failed — landmarker wedged, will reload', err);
      diagLog.push('error', 'detectForVideo threw — graph wedged', {
        error: this.lastError,
        ts,
        w: this.lastVideoW,
        h: this.lastVideoH,
        rs: this.lastReadyState,
      });
      // Any detectForVideo fault leaves the calculator graph unusable.
      try {
        this.landmarker.close();
      } catch {
        /* ignore */
      }
      this.landmarker = null;
      this.delegate = null;
      this.needsReload = true;
      this.skipReason = 'wedged';
      return null;
    }
  }

  private noteSkip(reason: string): void {
    this.skipReason = reason;
    if (this.lastLoggedSkip === reason) return;
    this.lastLoggedSkip = reason;
    diagLog.push('detect', `skip:${reason}`, {
      w: this.lastVideoW,
      h: this.lastVideoH,
      rs: this.lastReadyState,
      needsReload: this.needsReload ? 1 : 0,
    });
  }

  close(): void {
    diagLog.push('model', 'close');
    this.landmarker?.close();
    this.landmarker = null;
    this.delegate = null;
    this.needsReload = false;
  }
}
