/**
 * The ONLY module that touches MediaPipe Face Landmarker. Converts results into
 * a plain BlendshapeMap + face-present flag so core code never imports MediaPipe types.
 *
 * Assets load from public/ (same origin): no runtime CDN / model-host network.
 */
import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from '@mediapipe/tasks-vision';
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
  load(): Promise<void>;
  detect(video: HTMLVideoElement, timestampMs: number): FaceFrame | null;
  close(): void;
}

function base(path: string): string {
  const b = import.meta.env.BASE_URL || '/';
  return new URL(b.replace(/\/?$/, '/') + path.replace(/^\//, ''), window.location.href).href;
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

export class MediaPipeFaceDetector implements FaceDetector {
  private landmarker: FaceLandmarker | null = null;
  private fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
  private lastTs = -1;
  delegate: 'GPU' | 'CPU' | null = null;

  constructor(private opts: FaceDetectorOptions) {}

  async load(): Promise<void> {
    if (!this.fileset) this.fileset = await FilesetResolver.forVisionTasks(base(this.opts.wasmPath));
    const create = (delegate: 'GPU' | 'CPU') =>
      FaceLandmarker.createFromOptions(this.fileset!, {
        baseOptions: { modelAssetPath: base(this.opts.modelPath), delegate },
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
      if (delegate === 'CPU') throw err;
      console.warn('[face] GPU delegate failed, falling back to CPU', err);
      delegate = 'CPU';
      next = await create(delegate);
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
    const result = this.landmarker.detectForVideo(video, ts);
    return toFaceFrame(result, timestampMs);
  }

  close(): void {
    this.landmarker?.close();
    this.landmarker = null;
    this.delegate = null;
  }
}
