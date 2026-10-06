/**
 * getUserMedia wrapper. Frames stay in the <video> element in memory only:
 * nothing is recorded, encoded, saved or uploaded.
 */
import type { FacingMode } from '../config';
import { diagLog } from '../core/diagLog';

export interface CameraOptions {
  width: number;
  height: number;
  facingMode: FacingMode;
}

export class CameraAdapter {
  private stream: MediaStream | null = null;
  facingMode: FacingMode;

  constructor(
    readonly video: HTMLVideoElement,
    private opts: CameraOptions,
  ) {
    this.facingMode = opts.facingMode;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.autoplay = true;
  }

  get active(): boolean {
    return !!this.stream && this.stream.getVideoTracks().some((t) => t.readyState === 'live');
  }

  /** Mirror the preview for the front camera (selfie view). */
  get mirrored(): boolean {
    return this.facingMode === 'user';
  }

  get resolution(): { width: number; height: number } {
    return { width: this.video.videoWidth, height: this.video.videoHeight };
  }

  async start(facingMode: FacingMode = this.facingMode): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia unavailable (needs HTTPS or localhost)');
    this.stop();
    this.facingMode = facingMode;
    diagLog.push('camera', 'getUserMedia start', {
      facing: facingMode,
      idealW: this.opts.width,
      idealH: this.opts.height,
    });
    const videoConstraints: MediaTrackConstraints = {
      facingMode: { ideal: facingMode },
      width: { ideal: this.opts.width },
      height: { ideal: this.opts.height },
      frameRate: { ideal: 30 },
    };
    // Face mode needs the selfie cam; prefer a hard facingMode when ideal fails on some mobiles.
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints });
    } catch (err) {
      if (facingMode !== 'user') {
        diagLog.push('error', 'getUserMedia failed', { error: String((err as Error)?.message ?? err) });
        throw err;
      }
      diagLog.push('camera', 'ideal facing failed, retry exact user', {
        error: String((err as Error)?.message ?? err),
      });
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...videoConstraints, facingMode },
      });
    }
    this.video.srcObject = this.stream;
    await new Promise<void>((resolve) => {
      if (this.video.readyState >= 2) return resolve();
      this.video.onloadeddata = () => resolve();
    });
    await this.video.play();
    // readyState>=2 can race ahead of videoWidth/Height on some browsers — wait for real frames.
    await this.waitForVideoDims(5000);
    const track = this.stream.getVideoTracks()[0];
    const settings = track?.getSettings?.() ?? {};
    diagLog.push('camera', 'ready', {
      w: this.video.videoWidth,
      h: this.video.videoHeight,
      rs: this.video.readyState,
      trackW: settings.width ?? 0,
      trackH: settings.height ?? 0,
      facing: settings.facingMode ?? facingMode,
      label: track?.label?.slice(0, 40) ?? '',
    });
  }

  private waitForVideoDims(timeoutMs: number): Promise<void> {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (this.video.videoWidth > 0 && this.video.videoHeight > 0) return resolve();
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (now - start > timeoutMs) {
          diagLog.push('error', 'camera 0×0 after wait', {
            rs: this.video.readyState,
            timeoutMs,
          });
          return reject(new Error('camera produced 0×0 frames'));
        }
        requestAnimationFrame(tick);
      };
      tick();
    });
  }

  async switchFacing(): Promise<void> {
    await this.start(this.facingMode === 'user' ? 'environment' : 'user');
  }

  /** Hard stop: release the camera (indicator light goes off). */
  stop(): void {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      diagLog.push('camera', 'stopped');
    }
    this.video.pause();
    this.video.srcObject = null;
  }
}
