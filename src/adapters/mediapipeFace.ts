/**
 * The ONLY module that touches MediaPipe Face Landmarker. Converts results into
 * a plain BlendshapeMap + face-present flag so core code never imports MediaPipe types.
 *
 * Assets load from public/ (same origin): no runtime CDN / model-host network.
 */
import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from '@mediapipe/tasks-vision';
import { assetUrl, wasmAssetDir } from '../core/assetUrl';
import { blendshapesFromCategories, type BlendshapeMap } from '../core/expressionRules';

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
}

export interface FaceDetector {
  readonly delegate: 'GPU' | 'CPU' | null;
  /** Last detect/load error message (cleared on successful detect). */
  readonly lastError: string | null;
  load(): Promise<void>;
  detect(video: HTMLVideoElement, timestampMs: number): FaceFrame | null;
  close(): void;
}

export function toFaceFrame(result: FaceLandmarkerResult, timestampMs: number): FaceFrame | null {
  const landmarks = result.faceLandmarks?.[0];
  if (!landmarks || !landmarks.length) return null;
  const cats = result.faceBlendshapes?.[0]?.categories ?? [];
  return {
    timestampMs,
    present: true,
    blendshapes: blendshapesFromCategories(cats),
    landmarks: landmarks.map((l) => ({ x: l.x, y: l.y, z: l.z })),
  };
}

async function assertAssetReachable(url: string, label: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'HEAD', cache: 'no-cache' });
  } catch (err) {
    throw new Error(`${label} fetch failed (${url}): ${(err as Error)?.message ?? err}`);
  }
  // Some static hosts omit HEAD; fall back to ranged GET.
  if (res.status === 405 || res.status === 501) {
    res = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, cache: 'no-cache' });
  }
  if (!res.ok) {
    throw new Error(`${label} HTTP ${res.status} at ${url}`);
  }
}

export class MediaPipeFaceDetector implements FaceDetector {
  private landmarker: FaceLandmarker | null = null;
  private fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
  private lastTs = -1;
  delegate: 'GPU' | 'CPU' | null = null;
  lastError: string | null = null;
  /** Resolved URLs after a successful load (for HUD / debug). */
  loadedModelUrl: string | null = null;
  loadedWasmDir: string | null = null;

  constructor(private opts: FaceDetectorOptions) {}

  async load(): Promise<void> {
    this.lastError = null;
    const wasmDir = wasmAssetDir(this.opts.wasmPath);
    const model = assetUrl(this.opts.modelPath);
    this.loadedWasmDir = wasmDir;
    this.loadedModelUrl = model;

    await assertAssetReachable(model, 'Face model');
    // Probe one wasm script so a wrong BASE_URL fails with a clear message (not a WASM instantiate crash).
    await assertAssetReachable(`${wasmDir}/vision_wasm_internal.js`, 'MediaPipe WASM');

    if (!this.fileset) this.fileset = await FilesetResolver.forVisionTasks(wasmDir);
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
      next = await create(delegate);
    } catch (err) {
      if (delegate === 'CPU') {
        this.lastError = String((err as Error)?.message ?? err);
        throw err;
      }
      console.warn('[face] GPU delegate failed, falling back to CPU', err);
      delegate = 'CPU';
      try {
        next = await create(delegate);
      } catch (err2) {
        this.lastError = String((err2 as Error)?.message ?? err2);
        throw err2;
      }
    }
    this.landmarker?.close();
    this.landmarker = next;
    this.delegate = delegate;
    this.lastTs = -1;
  }

  detect(video: HTMLVideoElement, timestampMs: number): FaceFrame | null {
    if (!this.landmarker || video.readyState < 2) return null;
    const ts = timestampMs <= this.lastTs ? this.lastTs + 1 : timestampMs;
    this.lastTs = ts;
    try {
      const result = this.landmarker.detectForVideo(video, ts);
      this.lastError = null;
      return toFaceFrame(result, timestampMs);
    } catch (err) {
      this.lastError = String((err as Error)?.message ?? err);
      console.error('[face] detectForVideo failed', err);
      return null;
    }
  }

  close(): void {
    this.landmarker?.close();
    this.landmarker = null;
    this.delegate = null;
  }
}
