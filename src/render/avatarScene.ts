/**
 * Dedicated stage for the VTuber avatar skin — fills the lab panel with a
 * large live face (not a tiny HUD). Sci-fi chamber + bloom, no capsule figure.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { AvatarMorphs, HeadPose } from '../core/avatarMorphs';
import { AvatarSkin } from './avatarSkin';

export class AvatarScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(38, 1, 0.05, 40);
  readonly avatar: AvatarSkin;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private timer = new THREE.Timer();
  private ro: ResizeObserver;
  private running = false;
  private raf = 0;
  private stopAt: number | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setClearColor(0x04050a, 1);

    this.scene.fog = new THREE.FogExp2(0x04050a, 0.08);
    // Framed like a VTuber cam — face fills the panel
    this.camera.position.set(0, 1.15, 2.55);
    this.camera.lookAt(0, 1.15, 0);

    this.scene.add(new THREE.AmbientLight(0x7080b0, 0.4));
    const key = new THREE.DirectionalLight(0xffffff, 0.55);
    key.position.set(1.5, 2.5, 2);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x5f7cff, 0.7);
    rim.position.set(-2.5, 1.5, -1);
    this.scene.add(rim);

    const grid = new THREE.GridHelper(10, 40, 0x1f3b5a, 0x0d1726);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.45;
    grid.position.y = -0.15;
    this.scene.add(grid);

    // Soft backdrop disc behind the avatar
    const back = new THREE.Mesh(
      new THREE.CircleGeometry(1.6, 64),
      new THREE.MeshBasicMaterial({ color: 0x0a1528, transparent: true, opacity: 0.85 }),
    );
    back.position.set(0, 1.15, -0.8);
    this.scene.add(back);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.95, 1.05, 64),
      new THREE.MeshBasicMaterial({ color: 0x9fdcff, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
    );
    ring.position.set(0, 1.15, -0.79);
    this.scene.add(ring);

    this.avatar = new AvatarSkin();
    this.scene.add(this.avatar.group);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.95, 0.5, 0.2);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
  }

  private resize(): void {
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w, h);
    this.camera.aspect = w / h;
    this.camera.fov = w / h < 1 ? 48 : 38;
    this.camera.updateProjectionMatrix();
  }

  setMirrored(m: boolean): void {
    this.avatar.setMirrored(m);
  }

  setAvatar(morphs: AvatarMorphs, pose: HeadPose, present: boolean): void {
    this.avatar.apply(morphs, pose, present);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer.connect(document);
    const loop = (ts?: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      this.timer.update(ts);
      this.frame();
      if (this.stopAt !== null && performance.now() >= this.stopAt) this.stop();
    };
    loop();
  }

  stopAfter(ms: number): void {
    this.stopAt = performance.now() + ms;
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private frame(): void {
    const dt = Math.min(0.1, this.timer.getDelta());
    const t = this.timer.getElapsed();
    this.avatar.update(dt, t);
    this.composer.render(dt);
  }

  dispose(): void {
    this.stop();
    this.timer.dispose();
    this.ro.disconnect();
    this.renderer.dispose();
  }
}
