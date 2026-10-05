/**
 * getUserMedia wrapper. Frames stay in the <video> element in memory only:
 * nothing is recorded, encoded, saved or uploaded.
 */
import type { FacingMode } from '../config';

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
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: this.opts.width },
        height: { ideal: this.opts.height },
        frameRate: { ideal: 30 },
      },
    });
    this.video.srcObject = this.stream;
    await new Promise<void>((resolve) => {
      if (this.video.readyState >= 2) return resolve();
      this.video.onloadeddata = () => resolve();
    });
    await this.video.play();
  }

  async switchFacing(): Promise<void> {
    await this.start(this.facingMode === 'user' ? 'environment' : 'user');
  }

  /** Hard stop: release the camera (indicator light goes off). */
  stop(): void {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.video.pause();
    this.video.srcObject = null;
  }
}
