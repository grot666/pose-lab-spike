/**
 * The ONLY module that touches MediaPipe. Converts PoseLandmarkerResult into
 * the unified PoseFrame (see core/landmarks.ts) so nothing else depends on
 * MediaPipe types.
 *
 * Assets are loaded from public/ (same origin): no runtime network access to
 * any CDN / model host.
 */
import { FilesetResolver, PoseLandmarker, type PoseLandmarkerResult } from '@mediapipe/tasks-vision';
import type { ModelTier } from '../config';
import { assetUrl, wasmAssetDir } from '../core/assetUrl';
import { nextVideoTimestampMs } from '../core/videoTimestamp';
import type { Landmark, PoseFrame } from '../core/landmarks';

export interface PoseDetectorOptions {
  wasmPath: string;
  modelPaths: Record<ModelTier, string>;
  preferGpu: boolean;
  minPoseDetectionConfidence: number;
  minPosePresenceConfidence: number;
  minTrackingConfidence: number;
}

export interface PoseDetector {
  readonly tier: ModelTier | null;
  readonly delegate: 'GPU' | 'CPU' | null;
  load(tier: ModelTier): Promise<void>;
  /** Returns null when no person is detected. */
  detect(video: HTMLVideoElement, timestampMs: number): PoseFrame | null;
  close(): void;
}

/** MediaPipe world: metres, hip origin, y DOWN, z smaller = closer. Unified: y up, +z toward camera. */
export function toUnifiedFrame(result: PoseLandmarkerResult, timestampMs: number): PoseFrame | null {
  const img = result.landmarks?.[0];
  const world = result.worldLandmarks?.[0];
  if (!img || !world || img.length < 33 || world.length < 33) return null;
  const image: Landmark[] = img.map((l) => ({ x: l.x, y: l.y, z: l.z, visibility: l.visibility ?? 0 }));
  const w: Landmark[] = world.map((l, i) => ({
    x: l.x,
    y: -l.y,
    z: -l.z,
    visibility: img[i].visibility ?? l.visibility ?? 0,
  }));
  return { timestampMs, image, world: w };
}

export class MediaPipePoseDetector implements PoseDetector {
  private landmarker: PoseLandmarker | null = null;
  private fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
  private lastTs = -1;
  tier: ModelTier | null = null;
  delegate: 'GPU' | 'CPU' | null = null;

  constructor(private opts: PoseDetectorOptions) {}

  async load(tier: ModelTier): Promise<void> {
    if (!this.fileset) this.fileset = await FilesetResolver.forVisionTasks(wasmAssetDir(this.opts.wasmPath));
    const create = (delegate: 'GPU' | 'CPU') =>
      PoseLandmarker.createFromOptions(this.fileset!, {
        baseOptions: { modelAssetPath: assetUrl(this.opts.modelPaths[tier]), delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: this.opts.minPoseDetectionConfidence,
        minPosePresenceConfidence: this.opts.minPosePresenceConfidence,
        minTrackingConfidence: this.opts.minTrackingConfidence,
        outputSegmentationMasks: false,
      });
    let next: PoseLandmarker;
    let delegate: 'GPU' | 'CPU' = this.opts.preferGpu ? 'GPU' : 'CPU';
    try {
      next = await create(delegate);
    } catch (err) {
      if (delegate === 'CPU') throw err;
      console.warn('[pose] GPU delegate failed, falling back to CPU', err);
      delegate = 'CPU';
      next = await create(delegate);
    }
    this.landmarker?.close();
    this.landmarker = next;
    this.tier = tier;
    this.delegate = delegate;
    this.lastTs = -1;
  }

  detect(video: HTMLVideoElement, timestampMs: number): PoseFrame | null {
    if (!this.landmarker || video.readyState < 2) return null;
    // 0×0 frames can wedge the MediaPipe graph — skip until dimensions exist.
    if (video.videoWidth < 1 || video.videoHeight < 1) return null;
    // VIDEO mode requires strictly increasing integer timestamps
    const ts = nextVideoTimestampMs(timestampMs, this.lastTs);
    this.lastTs = ts;
    try {
      const result = this.landmarker.detectForVideo(video, ts);
      return toUnifiedFrame(result, timestampMs);
    } catch (err) {
      console.error('[pose] detectForVideo failed', err);
      return null;
    }
  }

  close(): void {
    this.landmarker?.close();
    this.landmarker = null;
    this.tier = null;
  }
}
