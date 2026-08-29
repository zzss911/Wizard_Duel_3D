import * as THREE from 'three';

/**
 * Target —— M2 静态训练靶
 * 拥有与 Player 相同的受击接口（hp / takeDamage / dead / radius），
 * M3 将被 AI 敌人替换，CombatSystem 无需改动。
 * 被击败后倒地，3 秒后自动站起复原，保证可以持续练习。
 */
export class Target {
  constructor(scene) {
    this.scene = scene;
    this.isTarget = true;

    this.maxHp = 100;
    this.hp = this.maxHp;
    this.attackCooldown = 999;   // 不会攻击
    this.cooldown = 0;
    this.radius = 0.8;
    this.dead = false;
    this.speed = 0;

    this.position = new THREE.Vector3(0, 0, -8);
    this.homePosition = this.position.clone();
    this._flash = 0;
    this._respawn = 0;
    this.onDeath = null;

    // 受击物理反馈（击退 / 旋转 / 变红）
    this._knock = new THREE.Vector3();
    this._spin = 0;
    this._impactT = 0;

    this._buildMesh();
  }

  _buildMesh() {
    this.group = new THREE.Group();

    // 木桩底座
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.24, 1.0, 8),
      new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 0.9 })
    );
    post.position.y = 0.5;
    post.castShadow = true;
    this.group.add(post);

    // 靶身：稻草人胶囊
    this.bodyMat = new THREE.MeshStandardMaterial({ color: 0xc2a35a, roughness: 0.85, emissive: 0x000000 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.5, 0.8, 6, 12), this.bodyMat);
    body.position.y = 1.55;
    body.castShadow = true;
    this.group.add(body);

    // 靶心环
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.3, 0.06, 8, 24),
      new THREE.MeshStandardMaterial({ color: 0xd94a4a, roughness: 0.6 })
    );
    ring.position.set(0, 1.7, 0.42);
    this.group.add(ring);

    this.group.position.copy(this.position);
    this.scene.add(this.group);

    // ---- 束缚咒减速状态：脚下符文环 ----
    const runeCanvas = document.createElement('canvas');
    runeCanvas.width = 128; runeCanvas.height = 128;
    const rctx = runeCanvas.getContext('2d');
    rctx.strokeStyle = 'rgba(180, 106, 255, 0.9)';
    rctx.lineWidth = 3;
    rctx.beginPath();
    rctx.arc(64, 64, 50, 0, Math.PI * 2);
    rctx.stroke();
    rctx.lineWidth = 2;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      rctx.beginPath();
      rctx.moveTo(64 + Math.cos(a) * 30, 64 + Math.sin(a) * 30);
      rctx.lineTo(64 + Math.cos(a) * 45, 64 + Math.sin(a) * 45);
      rctx.stroke();
    }
    const runeTex = new THREE.CanvasTexture(runeCanvas);
    runeTex.needsUpdate = true;

    this.slowRune = new THREE.Sprite(new THREE.SpriteMaterial({
      map: runeTex,
      color: 0xb46aff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    this.slowRune.scale.set(2.0, 2.0, 1);
    this.slowRune.position.y = 0.05;
    this.slowRune.visible = false;
    this.scene.add(this.slowRune);

    this._slowT = 0;
  }

  get headPosition() {
    return new THREE.Vector3(this.position.x, this.position.y + 1.5, this.position.z);
  }

  update(dt) {
    // ---- 束缚咒减速符文环 ----
    if (this._slowT > 0) {
      this._slowT -= dt;
      this.slowRune.visible = true;
      this.slowRune.position.set(this.position.x, 0.05, this.position.z);
      this.slowRune.material.opacity = 0.5 + Math.sin(this._slowT * 8) * 0.2;
      this.slowRune.material.rotation += dt * 1.5;
      const rs = 1.8 + Math.sin(this._slowT * 6) * 0.15;
      this.slowRune.scale.set(rs, rs, 1);
      if (this._slowT <= 0) {
        this.slowRune.visible = false;
        this.slowRune.material.opacity = 0;
      }
    }

    if (this._flash > 0) {
      this._flash -= dt;
      this.bodyMat.emissive.setHex(this._flash > 0 ? 0xffffff : 0x000000);
      this.bodyMat.emissiveIntensity = Math.max(0, this._flash) * 4;
    }

    // ---- 受击物理反馈：0.3s 内击退 + 旋转 + 泛红，随后恢复 ----
    if (this._impactT > 0) {
      this._impactT -= dt;
      const t = Math.max(0, this._impactT) / 0.3;
      this.position.addScaledVector(this._knock, t * dt * 4);
      this.group.rotation.y += this._spin * dt * t;
      this.bodyMat.emissive.setHex(0xff3020);
      this.bodyMat.emissiveIntensity = t * 1.6;
      this._flash = Math.max(this._flash, 0); // 交由 impact 的红色接管
      if (this._impactT <= 0) {
        this.bodyMat.emissive.setHex(0x000000);
        this.bodyMat.emissiveIntensity = 0;
        // 大威力造成的位移缓慢弹回原位
      }
    } else if (!this.dead) {
      // 缓慢归位（重击造成的位移）
      this.position.lerp(this.homePosition, Math.min(1, dt * 1.2));
    }

    if (this.dead) {
      // 倒地动画 + 计时复活
      this.group.rotation.x = THREE.MathUtils.lerp(this.group.rotation.x, -Math.PI / 2, Math.min(1, dt * 8));
      this._respawn -= dt;
      if (this._respawn <= 0) this._revive();
    } else {
      this.group.rotation.x = THREE.MathUtils.lerp(this.group.rotation.x, 0, Math.min(1, dt * 8));
    }
    this.group.position.x = this.position.x;
    this.group.position.z = this.position.z;
  }

  /**
   * 命中冲击反馈。
   * @param {THREE.Vector3} dir 弹道方向（世界坐标，已归一化）
   * @param {number} power 威力：1 普攻 / 1.5 重击 / 2.5 终极
   */
  applyImpact(dir, power = 1) {
    if (this.dead) return;
    this._knock.set(dir.x, 0, dir.z).normalize().multiplyScalar(0.55 * power);
    // 大威力额外后退一小段
    if (power >= 1.5) this.position.addScaledVector(this._knock, 0.5);
    // 限制在场内
    const flat = Math.hypot(this.position.x, this.position.z);
    const maxR = 15;
    if (flat > maxR) {
      this.position.x *= maxR / flat;
      this.position.z *= maxR / flat;
      this.homePosition.x *= maxR / flat;
      this.homePosition.z *= maxR / flat;
    }
    this._spin = (Math.random() > 0.5 ? 1 : -1) * (2.5 + Math.random() * 2) * power;
    this._impactT = 0.3;
  }

  takeDamage(amount) {
    if (this.dead) return;
    this.hp = Math.max(0, this.hp - amount);
    this._flash = 0.15;
    // 受击轻退
    this.group.position.y = 0.05;
    if (this.hp <= 0) {
      this.dead = true;
      this._respawn = 3;
      this.onDeath && this.onDeath();
    }
  }

  _revive() {
    this.dead = false;
    this.hp = this.maxHp;
    this.position.copy(this.homePosition);
    this.group.position.y = 0;
    this._slowT = 0;
    this.slowRune.visible = false;
    this.slowRune.material.opacity = 0;
  }

  /** 束缚咒：Target 不移动，仅显示减速视觉 */
  applySlow(mult, duration) {
    if (this.dead) return;
    this._slowT = Math.max(this._slowT, duration);
  }
}
