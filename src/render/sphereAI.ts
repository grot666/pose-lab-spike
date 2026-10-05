/**
 * The Dom: a floating white sphere AI. No face, no voice - it speaks through
 * light: colour, intensity, pulse, orbit rings, a scan beam and a hold-progress halo.
 */
import * as THREE from 'three';

export type Mood =
  | 'idle'
  | 'searching'
  | 'command'
  | 'entering'
  | 'holding'
  | 'success'
  | 'fail'
  | 'lost'
  | 'report'
  | 'safeword';

interface MoodPreset {
  color: number;
  intensity: number;
  pulseHz: number;
  pulseDepth: number;
  ringSpeed: number;
  flicker: number;
  beam: number;
  light: number;
}

export const MOODS: Record<Mood, MoodPreset> = {
  idle: { color: 0xdfe8ff, intensity: 1.1, pulseHz: 0.25, pulseDepth: 0.25, ringSpeed: 0.2, flicker: 0, beam: 0, light: 6 },
  searching: { color: 0xc4e4ff, intensity: 1.5, pulseHz: 0.8, pulseDepth: 0.35, ringSpeed: 1.2, flicker: 0, beam: 0.25, light: 8 },
  command: { color: 0xffffff, intensity: 2.6, pulseHz: 2.0, pulseDepth: 0.15, ringSpeed: 2.5, flicker: 0, beam: 0.6, light: 16 },
  entering: { color: 0xaee9ff, intensity: 2.0, pulseHz: 1.4, pulseDepth: 0.2, ringSpeed: 1.6, flicker: 0, beam: 0.55, light: 12 },
  holding: { color: 0xffffff, intensity: 2.5, pulseHz: 0.5, pulseDepth: 0.08, ringSpeed: 0.6, flicker: 0, beam: 0.35, light: 13 },
  success: { color: 0x9dffd8, intensity: 2.8, pulseHz: 1.2, pulseDepth: 0.3, ringSpeed: 1.0, flicker: 0, beam: 0.2, light: 14 },
  fail: { color: 0xff3b6b, intensity: 2.6, pulseHz: 0.0, pulseDepth: 0, ringSpeed: 3.0, flicker: 0.6, beam: 0.15, light: 12 },
  lost: { color: 0x7d8cab, intensity: 0.8, pulseHz: 0.4, pulseDepth: 0.4, ringSpeed: 2.0, flicker: 0.05, beam: 0.0, light: 4 },
  report: { color: 0xe8e2ff, intensity: 1.6, pulseHz: 0.3, pulseDepth: 0.2, ringSpeed: 0.4, flicker: 0, beam: 0, light: 8 },
  /** Warm white, calm, steady: the safeword state. */
  safeword: { color: 0xffd6a0, intensity: 1.5, pulseHz: 0.0, pulseDepth: 0, ringSpeed: 0.0, flicker: 0, beam: 0, light: 9 },
};

const RING_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const RING_FRAG = /* glsl */ `
uniform float progress;
uniform vec3 color;
uniform float opacity;
varying vec2 vUv;
void main() {
  vec2 p = vUv - 0.5;
  float a = atan(p.x, p.y) / 6.28318530718 + 0.5; // 0..1 clockwise from top
  if (a > progress) discard;
  gl_FragColor = vec4(color * 2.2, opacity);
}`;

export class SphereAI {
  readonly group = new THREE.Group();
  private core: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
  private shell: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private rings: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>[] = [];
  private halo: THREE.Mesh<THREE.RingGeometry, THREE.ShaderMaterial>;
  private beam: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial>;
  private scanRing: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  readonly light: THREE.PointLight;
  private mood: Mood = 'idle';
  private moodSince = 0;
  private color = new THREE.Color(MOODS.idle.color);
  private targetColor = new THREE.Color(MOODS.idle.color);
  private intensity = MOODS.idle.intensity;
  private beamOpacity = 0;
  private progress = 0;
  private ringAngle = 0;
  private basePos = new THREE.Vector3();
  /** World-space point the beam aims at (figure centre). */
  beamTarget = new THREE.Vector3(0, 1, 0);

  constructor(radius = 0.32) {
    this.core = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 64, 48),
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.2, roughness: 0.25, metalness: 0 }),
    );
    this.shell = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 1.25, 48, 32),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.group.add(this.core, this.shell);

    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(radius * (1.55 + i * 0.22), 0.006 + 0.003 * (2 - i), 8, 128),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 - i * 0.12, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      ring.rotation.set(Math.PI / 2 + (i - 1) * 0.5, i * 0.7, 0);
      this.rings.push(ring);
      this.group.add(ring);
    }

    this.halo = new THREE.Mesh(
      new THREE.RingGeometry(radius * 2.15, radius * 2.3, 128, 1),
      new THREE.ShaderMaterial({
        uniforms: { progress: { value: 0 }, color: { value: new THREE.Color(0xffffff) }, opacity: { value: 0.9 } },
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.group.add(this.halo);

    this.light = new THREE.PointLight(0xffffff, 8, 8, 1.6);
    this.group.add(this.light);

    // Scan beam lives in world space (added to the scene by LabScene)
    const beamGeo = new THREE.ConeGeometry(0.55, 1, 48, 1, true);
    beamGeo.translate(0, -0.5, 0); // apex at origin, opening downward along -y
    this.beam = new THREE.Mesh(
      beamGeo,
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.scanRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.45, 0.006, 8, 96),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.scanRing.rotation.x = Math.PI / 2;
  }

  /** Objects that live in world space rather than in the sphere group. */
  get worldObjects(): THREE.Object3D[] {
    return [this.beam, this.scanRing];
  }

  setBasePosition(v: THREE.Vector3): void {
    this.basePos.copy(v);
    this.group.position.copy(v);
  }

  setMood(m: Mood, nowSec: number): void {
    if (m === this.mood) return;
    this.mood = m;
    this.moodSince = nowSec;
    this.targetColor.set(MOODS[m].color);
  }

  get currentMood(): Mood {
    return this.mood;
  }

  /** 0..1 hold progress shown as a halo arc. */
  setProgress(p: number): void {
    this.progress = Math.max(0, Math.min(1, p));
  }

  update(nowSec: number, dtSec: number, camera: THREE.Camera): void {
    const preset = MOODS[this.mood];
    const k = 1 - Math.exp(-dtSec * 4);
    this.color.lerp(this.targetColor, k);

    const sinceMood = nowSec - this.moodSince;
    let target = preset.intensity;
    if (preset.pulseHz > 0) target *= 1 - preset.pulseDepth * 0.5 + preset.pulseDepth * 0.5 * Math.sin(nowSec * Math.PI * 2 * preset.pulseHz);
    if (preset.flicker > 0) target *= 1 - preset.flicker * (Math.random() < 0.25 ? Math.random() : 0);
    if (this.mood === 'command') target *= 1 + 1.0 * Math.exp(-sinceMood * 3); // flash on new instruction
    this.intensity += (target - this.intensity) * (1 - Math.exp(-dtSec * 10));

    this.core.material.emissive.copy(this.color);
    this.core.material.emissiveIntensity = this.intensity;
    this.shell.material.color.copy(this.color);
    this.shell.material.opacity = 0.05 + 0.04 * this.intensity;
    this.light.color.copy(this.color);
    this.light.intensity = preset.light * (0.6 + 0.4 * this.intensity / Math.max(0.1, preset.intensity));

    this.ringAngle += dtSec * preset.ringSpeed;
    this.rings.forEach((r, i) => {
      r.rotation.z = this.ringAngle * (i % 2 ? -1 : 1) * (1 + i * 0.3);
      r.material.color.copy(this.color);
    });

    // halo faces the camera
    this.halo.quaternion.copy(camera.quaternion);
    const u = this.halo.material.uniforms;
    u.progress.value += (this.progress - u.progress.value) * (1 - Math.exp(-dtSec * 12));
    u.color.value.copy(this.color);
    u.opacity.value = this.mood === 'holding' || this.mood === 'success' ? 0.9 : 0.0;

    // float (calm & still when safeword)
    const bob = this.mood === 'safeword' ? 0.015 : 0.05;
    this.group.position.y = this.basePos.y + Math.sin(nowSec * 0.9) * bob;
    this.group.position.x = this.basePos.x + Math.sin(nowSec * 0.37) * bob * 0.6;

    // beam: from sphere to beamTarget
    this.beamOpacity += (preset.beam * 0.12 - this.beamOpacity) * (1 - Math.exp(-dtSec * 5));
    const from = this.group.position;
    const dir = new THREE.Vector3().subVectors(this.beamTarget, from);
    const lenB = dir.length() + 0.9;
    this.beam.position.copy(from);
    this.beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir.normalize());
    this.beam.scale.set(1, lenB, 1);
    this.beam.material.color.copy(this.color);
    this.beam.material.opacity = this.beamOpacity;
    this.beam.visible = this.beamOpacity > 0.002;

    // scan ring sweeping the figure while waiting for compliance / searching
    const scanning = this.mood === 'entering' || this.mood === 'searching' || this.mood === 'lost';
    const so = this.scanRing.material;
    so.opacity += ((scanning ? 0.7 : 0) - so.opacity) * (1 - Math.exp(-dtSec * 4));
    so.color.copy(this.color);
    this.scanRing.position.set(this.beamTarget.x, 0.05 + (0.5 + 0.5 * Math.sin(nowSec * 1.6)) * 1.8, this.beamTarget.z);
    this.scanRing.visible = so.opacity > 0.01;
  }
}
