/**
 * Stylized VTuber avatar skin (皮套): large sci-fi face plate driven by
 * AvatarMorphs + HeadPose. Not photoreal — neon lab aesthetic for live stage.
 */
import * as THREE from 'three';
import type { AvatarMorphs, HeadPose } from '../core/avatarMorphs';
import { idleHeadPose, idleMorphs } from '../core/avatarMorphs';

const COL = {
  plate: 0x0a1628,
  neon: 0x9fdcff,
  neonWarm: 0xffd6a0,
  eye: 0x7ef0ff,
  lid: 0x152238,
  lip: 0xff6b9d,
  tongue: 0xff4d7a,
  brow: 0xb7e6ff,
};

export class AvatarSkin {
  readonly group = new THREE.Group();
  private head = new THREE.Group();
  private jaw = new THREE.Group();
  private eyeL: THREE.Mesh;
  private eyeR: THREE.Mesh;
  private lidL: THREE.Mesh;
  private lidR: THREE.Mesh;
  private browL: THREE.Mesh;
  private browR: THREE.Mesh;
  private mouthOpen: THREE.Mesh;
  private smileArc: THREE.Mesh;
  private frownArc: THREE.Mesh;
  private tongue: THREE.Mesh;
  private plateMat: THREE.MeshStandardMaterial;
  private rimLight: THREE.PointLight;
  private morphs = idleMorphs();
  private pose = idleHeadPose();
  private mirrored = true;
  private present = false;
  private idlePulse = 0;

  constructor() {
    this.group.add(this.head);
    this.head.position.set(0, 1.15, 0);

    this.plateMat = new THREE.MeshStandardMaterial({
      color: COL.plate,
      metalness: 0.55,
      roughness: 0.35,
      emissive: new THREE.Color(COL.neon),
      emissiveIntensity: 0.12,
    });

    // Skull / face plate — slightly elongated ellipsoid
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.55, 48, 36), this.plateMat);
    skull.scale.set(0.92, 1.08, 0.85);
    this.head.add(skull);

    // Neon face outline ring
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.58, 0.018, 12, 64),
      new THREE.MeshBasicMaterial({ color: COL.neon, transparent: true, opacity: 0.85 }),
    );
    ring.position.z = 0.28;
    ring.scale.set(0.95, 1.05, 1);
    this.head.add(ring);

    // Cheek fins (sci-fi ears)
    const finMat = new THREE.MeshStandardMaterial({
      color: 0x12304a,
      metalness: 0.6,
      roughness: 0.3,
      emissive: COL.neon,
      emissiveIntensity: 0.2,
    });
    for (const side of [-1, 1]) {
      const fin = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.42, 6), finMat);
      fin.rotation.z = side * (Math.PI / 2 + 0.35);
      fin.rotation.y = side * -0.4;
      fin.position.set(side * 0.58, 0.08, 0);
      this.head.add(fin);
    }

    // Antenna
    const ant = new THREE.Mesh(
      new THREE.CylinderGeometry(0.02, 0.025, 0.35, 8),
      new THREE.MeshBasicMaterial({ color: COL.neon }),
    );
    ant.position.set(0, 0.72, 0);
    this.head.add(ant);
    const antTip = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 12, 12),
      new THREE.MeshBasicMaterial({ color: COL.neonWarm }),
    );
    antTip.position.set(0, 0.92, 0);
    this.head.add(antTip);

    const eyeGeo = new THREE.SphereGeometry(0.09, 24, 18);
    const eyeMat = () =>
      new THREE.MeshStandardMaterial({
        color: COL.eye,
        emissive: COL.eye,
        emissiveIntensity: 0.9,
        metalness: 0.2,
        roughness: 0.25,
      });
    this.eyeL = new THREE.Mesh(eyeGeo, eyeMat());
    this.eyeR = new THREE.Mesh(eyeGeo, eyeMat());
    this.eyeL.position.set(-0.18, 0.12, 0.42);
    this.eyeR.position.set(0.18, 0.12, 0.42);
    this.head.add(this.eyeL, this.eyeR);

    // Pupils
    const pupilGeo = new THREE.SphereGeometry(0.035, 12, 12);
    const pupilMat = new THREE.MeshBasicMaterial({ color: 0x041018 });
    for (const eye of [this.eyeL, this.eyeR]) {
      const p = new THREE.Mesh(pupilGeo, pupilMat);
      p.position.z = 0.07;
      eye.add(p);
    }

    const lidGeo = new THREE.SphereGeometry(0.095, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2);
    const lidMat = new THREE.MeshStandardMaterial({ color: COL.lid, metalness: 0.4, roughness: 0.5 });
    this.lidL = new THREE.Mesh(lidGeo, lidMat);
    this.lidR = new THREE.Mesh(lidGeo, lidMat.clone());
    this.lidL.position.copy(this.eyeL.position);
    this.lidR.position.copy(this.eyeR.position);
    this.lidL.rotation.x = Math.PI; // cover from top when scaled
    this.lidR.rotation.x = Math.PI;
    this.head.add(this.lidL, this.lidR);

    const browGeo = new THREE.BoxGeometry(0.16, 0.03, 0.04);
    const browMat = new THREE.MeshBasicMaterial({ color: COL.brow });
    this.browL = new THREE.Mesh(browGeo, browMat);
    this.browR = new THREE.Mesh(browGeo, browMat.clone());
    this.browL.position.set(-0.18, 0.28, 0.44);
    this.browR.position.set(0.18, 0.28, 0.44);
    this.head.add(this.browL, this.browR);

    // Jaw group (opens downward)
    this.head.add(this.jaw);
    this.jaw.position.set(0, -0.12, 0.35);

    const mouthMat = new THREE.MeshStandardMaterial({
      color: COL.lip,
      emissive: COL.lip,
      emissiveIntensity: 0.35,
      metalness: 0.1,
      roughness: 0.55,
    });
    this.mouthOpen = new THREE.Mesh(new THREE.CapsuleGeometry(0.08, 0.02, 6, 12), mouthMat);
    this.mouthOpen.rotation.z = Math.PI / 2;
    this.mouthOpen.scale.set(1.4, 0.15, 0.6);
    this.jaw.add(this.mouthOpen);

    this.smileArc = new THREE.Mesh(
      new THREE.TorusGeometry(0.14, 0.018, 8, 24, Math.PI),
      new THREE.MeshBasicMaterial({ color: COL.lip }),
    );
    this.smileArc.rotation.x = Math.PI;
    this.smileArc.position.set(0, -0.02, 0.06);
    this.jaw.add(this.smileArc);

    this.frownArc = new THREE.Mesh(
      new THREE.TorusGeometry(0.12, 0.016, 8, 20, Math.PI),
      new THREE.MeshBasicMaterial({ color: 0xaa6688 }),
    );
    this.frownArc.position.set(0, -0.06, 0.06);
    this.jaw.add(this.frownArc);

    this.tongue = new THREE.Mesh(
      new THREE.SphereGeometry(0.06, 12, 10),
      new THREE.MeshStandardMaterial({
        color: COL.tongue,
        emissive: COL.tongue,
        emissiveIntensity: 0.25,
      }),
    );
    this.tongue.scale.set(1.1, 0.55, 1.4);
    this.tongue.position.set(0, -0.08, 0.08);
    this.tongue.visible = false;
    this.jaw.add(this.tongue);

    this.rimLight = new THREE.PointLight(COL.neon, 1.2, 6, 2);
    this.rimLight.position.set(0, 1.4, 1.2);
    this.group.add(this.rimLight);

    this.apply(idleMorphs(), idleHeadPose(), false);
  }

  setMirrored(m: boolean): void {
    this.mirrored = m;
  }

  /**
   * Drive the skin. `present=false` eases toward idle + gentle idle pulse.
   */
  apply(morphs: AvatarMorphs, pose: HeadPose, present: boolean): void {
    this.morphs = morphs;
    this.pose = pose;
    this.present = present;
  }

  update(dt: number, t: number): void {
    this.idlePulse = t;
    const m = this.morphs;
    const p = this.pose;

    // Head rotation (mirror yaw when selfie preview is mirrored)
    const yaw = this.mirrored ? -p.yaw : p.yaw;
    const roll = this.mirrored ? -p.roll : p.roll;
    const targetQX = new THREE.Quaternion().setFromEuler(new THREE.Euler(p.pitch, yaw, roll, 'YXZ'));
    this.head.quaternion.slerp(targetQX, 1 - Math.exp(-12 * dt));

    // Stage position: map face center → lab space; scale with face size
    const targetScale = this.present ? 0.85 + p.scale * 4.5 : 0.95;
    const s = this.head.scale.x + (targetScale - this.head.scale.x) * (1 - Math.exp(-8 * dt));
    this.head.scale.setScalar(s);

    // Keep avatar large and centered (VTuber stage), slight parallax from head x/y
    const px = this.mirrored ? 1 - p.x : p.x;
    const tx = (px - 0.5) * 1.1;
    const ty = 1.05 + (0.45 - p.y) * 0.8;
    this.head.position.x += (tx - this.head.position.x) * (1 - Math.exp(-6 * dt));
    this.head.position.y += (ty - this.head.position.y) * (1 - Math.exp(-6 * dt));

    // Eyes / lids
    const blinkL = Math.max(m.blinkL, m.eyeWideL > 0.4 ? 0 : m.blinkL);
    const blinkR = Math.max(m.blinkR, m.eyeWideR > 0.4 ? 0 : m.blinkR);
    this.lidL.scale.set(1, 0.15 + blinkL * 1.7, 1);
    this.lidR.scale.set(1, 0.15 + blinkR * 1.7, 1);
    const wideL = 1 + m.eyeWideL * 0.35;
    const wideR = 1 + m.eyeWideR * 0.35;
    this.eyeL.scale.set(wideL, wideL * (1 - blinkL * 0.85), wideL);
    this.eyeR.scale.set(wideR, wideR * (1 - blinkR * 0.85), wideR);

    // Brows
    const browLift = m.browUp * 0.1;
    this.browL.position.y = 0.28 + browLift;
    this.browR.position.y = 0.28 + browLift;
    this.browL.rotation.z = 0.15 + m.browUp * 0.25;
    this.browR.rotation.z = -0.15 - m.browUp * 0.25;

    // Jaw / mouth
    this.jaw.rotation.x = m.jawOpen * 0.55;
    const openH = 0.12 + m.jawOpen * 1.6;
    this.mouthOpen.scale.set(1.4 + m.smile * 0.25, openH, 0.6);
    this.smileArc.visible = m.smile > 0.08;
    this.smileArc.scale.setScalar(0.7 + m.smile * 0.6);
    this.smileArc.position.y = -0.02 - m.jawOpen * 0.04;
    (this.smileArc.material as THREE.MeshBasicMaterial).opacity = Math.min(1, m.smile * 1.4);
    (this.smileArc.material as THREE.MeshBasicMaterial).transparent = true;

    this.frownArc.visible = m.frown > 0.08 && m.smile < 0.35;
    this.frownArc.scale.setScalar(0.7 + m.frown * 0.5);
    (this.frownArc.material as THREE.MeshBasicMaterial).opacity = Math.min(1, m.frown * 1.3);
    (this.frownArc.material as THREE.MeshBasicMaterial).transparent = true;

    this.tongue.visible = m.tongueOut > 0.15;
    this.tongue.position.z = 0.08 + m.tongueOut * 0.12;
    this.tongue.position.y = -0.06 - m.jawOpen * 0.05;
    this.tongue.scale.set(1.1, 0.55 + m.tongueOut * 0.4, 1.2 + m.tongueOut * 0.5);

    // Presence glow
    const glow = this.present ? 0.14 + m.smile * 0.1 + m.browUp * 0.05 : 0.06 + 0.03 * Math.sin(this.idlePulse * 2);
    this.plateMat.emissiveIntensity = glow;
    this.rimLight.intensity = this.present ? 1.4 : 0.6;
  }
}
