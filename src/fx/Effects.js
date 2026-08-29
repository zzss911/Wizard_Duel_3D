import * as THREE from 'three';

/**
 * Effects —— 命中粒子爆散 + 命中闪光
 * 固定池复用：8 组爆发，每组 14 粒子，重力 + 淡出。
 * impactFlash：6 个 Sprite 池，快速 scale-up + fade（~0.2s）。
 */
const BURST_COUNT = 8;
const PARTICLES = 14;
const FLASH_COUNT = 6;
const RING_COUNT = 3;

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.bursts = [];
    this._particleScale = 1.0;

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
        maxLife: 0.45,
        active: false,
      });
    }

    // ---- impact flash pool ----
    this.flashes = [];
    const flashTex = this._makeFlashTexture();
    for (let i = 0; i < FLASH_COUNT; i++) {
      const mat = new THREE.SpriteMaterial({
        map: flashTex,
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      scene.add(sprite);
      this.flashes.push({ sprite, life: 0, maxLife: 0.22, active: false });
    }

    // ---- shockwave ring pool ----
    this.rings = [];
    const ringGeo = new THREE.RingGeometry(0.85, 1.0, 48);
    for (let i = 0; i < RING_COUNT; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffa03c,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(ringGeo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      scene.add(mesh);
      this.rings.push({ mesh, life: 0, maxLife: 0.55, active: false });
    }
  }

  _makeFlashTexture() {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    const ctx = c.getContext('2d');
    const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.3, 'rgba(255,255,255,0.6)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
  }

  /** 在 worldPos 处触发一次爆散 */
  burst(worldPos, color = 0xffd76a, strength = 10, particleSize = 0.14) {
    const b = this.bursts.find((b) => !b.active) || this.bursts[0];
    const pos = b.points.geometry.attributes.position.array;
    const count = Math.max(1, Math.round(PARTICLES * this._particleScale));

    for (let i = 0; i < PARTICLES; i++) {
      const active = i < count;
      pos[i * 3] = worldPos.x;
      pos[i * 3 + 1] = worldPos.y;
      pos[i * 3 + 2] = worldPos.z;

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
    b.points.material.size = particleSize * this._particleScale;
    b.points.visible = true;
    b.life = 0.45;
    b.maxLife = 0.45;
    b.active = true;
  }

  /** 命中闪光：快速 scale-up + fade */
  impactFlash(worldPos, color = 0xffffff, scale = 1.5) {
    const f = this.flashes.find((f) => !f.active) || this.flashes[0];
    f.sprite.position.copy(worldPos);
    f.sprite.scale.setScalar(0.3);
    f.sprite.material.color.setHex(color);
    f.sprite.material.opacity = 0.9;
    f.sprite.visible = true;
    f.life = 0;
    f.maxLife = 0.22;
    f._targetScale = scale;
    f.active = true;
  }

  /** 冲击波环：从命中点向外扩散 + fade（~0.55s） */
  shockwave(worldPos, color = 0xffa03c, maxScale = 5.0) {
    const r = this.rings.find((r) => !r.active) || this.rings[0];
    r.mesh.position.copy(worldPos);
    r.mesh.scale.setScalar(0.3);
    r.mesh.material.color.setHex(color);
    r.mesh.material.opacity = 0.9 * this._particleScale;
    r.mesh.visible = true;
    r.life = 0;
    r.maxLife = 0.55;
    r._maxScale = maxScale * (0.5 + this._particleScale * 0.5);
    r._baseOpacity = 0.9 * this._particleScale;
    r.active = true;
  }

  setParticleScale(scale) {
    this._particleScale = Math.max(0.2, Math.min(1.0, scale));
  }

  update(dt) {
    for (const b of this.bursts) {
      if (!b.active) continue;
      b.life += dt;
      if (b.life >= b.maxLife) {
        b.active = false;
        b.points.visible = false;
        continue;
      }
      const pos = b.points.geometry.attributes.position.array;
      for (let i = 0; i < PARTICLES; i++) {
        b.velocities[i * 3 + 1] -= 9 * dt;
        pos[i * 3] += b.velocities[i * 3] * dt;
        pos[i * 3 + 1] += b.velocities[i * 3 + 1] * dt;
        pos[i * 3 + 2] += b.velocities[i * 3 + 2] * dt;
      }
      b.points.geometry.attributes.position.needsUpdate = true;
      b.points.material.opacity = 1 - b.life / b.maxLife;
    }

    for (const f of this.flashes) {
      if (!f.active) continue;
      f.life += dt;
      if (f.life >= f.maxLife) {
        f.active = false;
        f.sprite.visible = false;
        continue;
      }
      const t = f.life / f.maxLife;
      f.sprite.scale.setScalar(f._targetScale * (0.3 + t * 1.2));
      f.sprite.material.opacity = 0.9 * (1 - t);
    }

    for (const r of this.rings) {
      if (!r.active) continue;
      r.life += dt;
      if (r.life >= r.maxLife) {
        r.active = false;
        r.mesh.visible = false;
        continue;
      }
      const t = r.life / r.maxLife;
      const ease = 1 - Math.pow(1 - t, 2.2);
      r.mesh.scale.setScalar(0.3 + ease * r._maxScale);
      r.mesh.material.opacity = (r._baseOpacity || 0.9) * (1 - t);
    }
  }
}
