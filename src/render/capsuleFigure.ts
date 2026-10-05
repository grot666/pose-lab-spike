/**
 * Translucent 33-joint capsule figure driven by unified WORLD landmarks
 * (metres, y up, z toward camera). Joints = spheres, bones = cylinders;
 * together they read as capsules. Colour/opacity follow per-joint visibility.
 */
import * as THREE from 'three';
import { JOINT_COUNT, POSE_CONNECTIONS, type Landmark } from '../core/landmarks';
import { visibilityHue } from './colors';

const UP = new THREE.Vector3(0, 1, 0);
const FOOT_JOINTS = [25, 26, 27, 28, 29, 30, 31, 32];

function boneRadius(a: number, b: number): number {
  if (a <= 10 && b <= 10) return 0.006; // face
  if ((a === 11 && b === 12) || (a === 23 && b === 24) || (a === 11 && b === 23) || (a === 12 && b === 24)) return 0.035;
  if (a >= 15 && a <= 22 && b >= 15 && b <= 22) return 0.01; // hands
  if (a >= 27 && b >= 27) return 0.016; // feet
  if ((a === 23 || a === 24) && (b === 25 || b === 26)) return 0.045; // thighs
  if ((a === 25 || a === 26) && (b === 27 || b === 28)) return 0.035; // shins
  return 0.028; // arms
}

export class CapsuleFigure {
  readonly group = new THREE.Group();
  private joints: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>[] = [];
  private bones: { mesh: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial>; a: number; b: number }[] = [];
  private presence = 0;
  private targetPresence = 0;
  private groundOffset = 1.0;
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private tmpC = new THREE.Color();
  /** Hips-centre in world space after grounding (for the AI beam). */
  readonly center = new THREE.Vector3(0, 1, 0);

  constructor() {
    const jointGeo = new THREE.SphereGeometry(1, 20, 14);
    for (let i = 0; i < JOINT_COUNT; i++) {
      const m = new THREE.Mesh(
        jointGeo,
        new THREE.MeshStandardMaterial({
          color: 0x9fe8ff,
          emissive: 0x2a7f9f,
          emissiveIntensity: 0.6,
          transparent: true,
          opacity: 0.55,
          roughness: 0.3,
          depthWrite: false,
        }),
      );
      const r = i <= 10 ? 0.014 : i >= 17 && i <= 22 ? 0.012 : 0.03;
      m.scale.setScalar(r);
      this.joints.push(m);
      this.group.add(m);
    }
    const boneGeo = new THREE.CylinderGeometry(1, 1, 1, 16, 1, true);
    for (const [a, b] of POSE_CONNECTIONS) {
      const mesh = new THREE.Mesh(
        boneGeo,
        new THREE.MeshStandardMaterial({
          color: 0xbdefff,
          emissive: 0x3b8fb0,
          emissiveIntensity: 0.45,
          transparent: true,
          opacity: 0.3,
          roughness: 0.2,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      mesh.userData.radius = boneRadius(a, b);
      this.bones.push({ mesh, a, b });
      this.group.add(mesh);
    }
    this.group.visible = false;
  }

  /** Mirror for the selfie (front camera) view so the figure moves like a mirror. */
  setMirrored(m: boolean): void {
    this.group.scale.x = m ? -1 : 1;
  }

  setPose(world: readonly Landmark[] | null): void {
    this.targetPresence = world ? 1 : 0;
    if (!world) return;
    // ground the figure: lowest visible-ish lower-body joint touches the floor
    let minY = Infinity;
    for (const j of FOOT_JOINTS) if (world[j].visibility > 0.2) minY = Math.min(minY, world[j].y);
    if (!Number.isFinite(minY)) minY = Math.min(...world.map((l) => l.y));
    const target = -minY + 0.02;
    this.groundOffset += (target - this.groundOffset) * 0.15;

    for (let i = 0; i < JOINT_COUNT; i++) {
      const l = world[i];
      const m = this.joints[i];
      m.position.set(l.x, l.y + this.groundOffset, l.z);
      const hue = visibilityHue(l.visibility) / 360;
      this.tmpC.setHSL(hue, 0.9, 0.62);
      m.material.color.copy(this.tmpC);
      m.material.emissive.setHSL(hue, 0.9, 0.3);
      m.userData.vis = l.visibility;
    }
    for (const { mesh, a, b } of this.bones) {
      const pa = this.tmpA.copy(this.joints[a].position);
      const pb = this.tmpB.copy(this.joints[b].position);
      const len = pa.distanceTo(pb);
      mesh.position.addVectors(pa, pb).multiplyScalar(0.5);
      const dir = pb.sub(pa).normalize();
      mesh.quaternion.setFromUnitVectors(UP, dir);
      const r = mesh.userData.radius as number;
      mesh.scale.set(r, Math.max(1e-4, len), r);
      const v = Math.min(world[a].visibility, world[b].visibility);
      const hue = visibilityHue(v) / 360;
      mesh.material.color.setHSL(hue, 0.85, 0.7);
      mesh.material.emissive.setHSL(hue, 0.85, 0.3);
      mesh.userData.vis = v;
    }
    this.center.set(0, this.groundOffset, 0);
    if (this.group.scale.x < 0) this.center.x = -this.center.x;
  }

  update(dtSec: number): void {
    this.presence += (this.targetPresence - this.presence) * (1 - Math.exp(-dtSec * 6));
    this.group.visible = this.presence > 0.02;
    for (const m of this.joints) {
      const v = (m.userData.vis as number | undefined) ?? 1;
      m.material.opacity = this.presence * (v < 0.5 ? 0.18 : 0.6);
    }
    for (const { mesh } of this.bones) {
      const v = (mesh.userData.vis as number | undefined) ?? 1;
      mesh.material.opacity = this.presence * (v < 0.5 ? 0.1 : 0.32);
    }
  }
}
