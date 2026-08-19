import * as THREE from 'three';

/**
 * Effects —— 命中粒子爆散
 * 固定池复用：8 组爆发，每组 14 粒子，重力 + 淡出。
 */
const BURST_COUNT = 8;
const PARTICLES = 14;

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.bursts = [];

    for (let i = 0; i < BURST_COUNT; i++) {
      const geo = new THREE.BufferGeometry();
      const positions = new Float32Array(PARTICLES * 3);
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.PointsMaterial({
        color: 0xffd76a, size: 0.14, transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const points = new THREE.Points(geo, mat);
      points.visible = false;
      scene.add(points);

      this.bursts.push({
        points,
        velocities: new Float32Array(PARTICLES * 3),
        life: 0,
        active: false,
      });
    }
  }

  /** 在 worldPos 处触发一次爆散 */
  burst(worldPos, color = 0xffd76a, strength = 10) {
    const b = this.bursts.find((b) => !b.active) || this.bursts[0];
    const pos = b.points.geometry.attributes.position.array;

    for (let i = 0; i < PARTICLES; i++) {
      pos[i * 3] = worldPos.x;
      pos[i * 3 + 1] = worldPos.y;
      pos[i * 3 + 2] = worldPos.z;

      // 随机球向速度
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const sp = (0.6 + Math.random() * 0.4) * (strength * 0.45);
      b.velocities[i * 3] = Math.sin(phi) * Math.cos(theta) * sp;
      b.velocities[i * 3 + 1] = Math.cos(phi) * sp + 1.5;
      b.velocities[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * sp;
    }
    b.points.geometry.attributes.position.needsUpdate = true;
    b.points.material.color.setHex(color);
    b.points.material.opacity = 1;
    b.points.visible = true;
    b.life = 0.45;
    b.active = true;
  }

  update(dt) {
    for (const b of this.bursts) {
      if (!b.active) continue;
      b.life -= dt;
      if (b.life <= 0) {
        b.active = false;
        b.points.visible = false;
        continue;
      }
      const pos = b.points.geometry.attributes.position.array;
      for (let i = 0; i < PARTICLES; i++) {
        b.velocities[i * 3 + 1] -= 9 * dt; // 重力
        pos[i * 3] += b.velocities[i * 3] * dt;
        pos[i * 3 + 1] += b.velocities[i * 3 + 1] * dt;
        pos[i * 3 + 2] += b.velocities[i * 3 + 2] * dt;
      }
      b.points.geometry.attributes.position.needsUpdate = true;
      b.points.material.opacity = b.life / 0.45;
    }
  }
}
