/** 2D overlay of the 33-point skeleton on top of the camera preview, coloured by visibility. */
import { POSE_CONNECTIONS, type PoseFrame } from '../core/landmarks';
import { visibilityCss } from './colors';

export class Skeleton2D {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;

  constructor(
    private canvas: HTMLCanvasElement,
    private video: HTMLVideoElement,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unsupported');
    this.ctx = ctx;
  }

  private fit(): { x: number; y: number; w: number; h: number } {
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.round(cw * this.dpr);
    const H = Math.round(ch * this.dpr);
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    // match the video's object-fit: contain letterboxing
    const vw = this.video.videoWidth || 16;
    const vh = this.video.videoHeight || 9;
    const s = Math.min(W / vw, H / vh);
    const w = vw * s;
    const h = vh * s;
    return { x: (W - w) / 2, y: (H - h) / 2, w, h };
  }

  clear(): void {
    this.fit();
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  draw(frame: PoseFrame | null, dim = false): void {
    const r = this.fit();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!frame) return;
    const pts = frame.image.map((l) => ({ x: r.x + l.x * r.w, y: r.y + l.y * r.h, v: l.visibility }));
    const alpha = dim ? 0.35 : 1;
    ctx.lineCap = 'round';
    for (const [a, b] of POSE_CONNECTIONS) {
      const pa = pts[a];
      const pb = pts[b];
      const v = Math.min(pa.v, pb.v);
      ctx.strokeStyle = visibilityCss(v, (v < 0.5 ? 0.35 : 0.9) * alpha);
      ctx.lineWidth = (a >= 11 ? 4 : 2) * this.dpr;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      ctx.fillStyle = visibilityCss(p.v, (p.v < 0.5 ? 0.45 : 1) * alpha);
      ctx.beginPath();
      ctx.arc(p.x, p.y, (i >= 11 ? 5 : 3) * this.dpr * (p.v < 0.5 ? 0.7 : 1), 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
