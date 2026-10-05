/**
 * three.js sci-fi lab: dark chamber, glowing floor platform, the sphere AI and
 * the capsule figure, post-processed with UnrealBloom.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { Landmark } from '../core/landmarks';
import { CapsuleFigure } from './capsuleFigure';
import { SphereAI, type Mood } from './sphereAI';

export class LabScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(42, 1, 0.05, 50);
  readonly sphere = new SphereAI();
  readonly figure = new CapsuleFigure();
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private platform: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private timer = new THREE.Timer();
  private ro: ResizeObserver;
  private running = false;
  private raf = 0;
  private stopAt: number | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.setClearColor(0x04050a, 1);

    this.scene.fog = new THREE.FogExp2(0x04050a, 0.11);
    this.camera.position.set(0.35, 1.45, 4.2);
    this.camera.lookAt(0, 1.05, 0);

    this.scene.add(new THREE.AmbientLight(0x6070a0, 0.35));
    const rim = new THREE.DirectionalLight(0x5f7cff, 0.6);
    rim.position.set(-3, 4, -3);
    this.scene.add(rim);

    // floor grid + glowing platform
    const grid = new THREE.GridHelper(14, 56, 0x1f3b5a, 0x0d1726);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.6;
    this.scene.add(grid);
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(7, 64),
      new THREE.MeshStandardMaterial({ color: 0x070a12, roughness: 0.85, metalness: 0.2 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.002;
    this.scene.add(floor);
    this.platform = new THREE.Mesh(
      new THREE.RingGeometry(0.62, 0.66, 96),
      new THREE.MeshBasicMaterial({ color: 0x9fdcff, transparent: true, opacity: 0.6, side: THREE.DoubleSide }),
    );
    this.platform.rotation.x = -Math.PI / 2;
    this.platform.position.y = 0.003;
    this.scene.add(this.platform);

    // back wall panel lines for a "chamber" feel
    const wallMat = new THREE.MeshBasicMaterial({ color: 0x152238, transparent: true, opacity: 0.5 });
    for (let i = -3; i <= 3; i++) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.02, 3.2, 0.02), wallMat);
      bar.position.set(i * 0.9, 1.6, -2.6);
      this.scene.add(bar);
    }

    this.sphere.setBasePosition(new THREE.Vector3(-0.95, 2.15, 0.35));
    this.scene.add(this.sphere.group, ...this.sphere.worldObjects, this.figure.group);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 1.05, 0.55, 0.18);
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
    // keep the whole figure in view on tall (mobile) and wide panels
    this.camera.fov = w / h < 1 ? 55 : 42;
    this.camera.updateProjectionMatrix();
  }

  setPose(world: readonly Landmark[] | null): void {
    this.figure.setPose(world);
  }

  setMirrored(m: boolean): void {
    this.figure.setMirrored(m);
  }

  setMood(m: Mood): void {
    this.sphere.setMood(m, this.timer.getElapsed());
  }

  setProgress(p: number): void {
    this.sphere.setProgress(p);
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

  /** Keep rendering for `ms` (to let a mood transition settle), then freeze the last frame. */
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
    this.figure.update(dt);
    this.sphere.beamTarget.copy(this.figure.center);
    this.sphere.update(t, dt, this.camera);
    const pm = this.platform.material;
    pm.color.copy(this.sphere.light.color);
    pm.opacity = 0.35 + 0.25 * Math.sin(t * 1.3);
    this.composer.render(dt);
  }

  dispose(): void {
    this.stop();
    this.timer.dispose();
    this.ro.disconnect();
    this.renderer.dispose();
  }
}
