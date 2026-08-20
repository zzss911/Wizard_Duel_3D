import * as THREE from 'three';

/**
 * WardenBoss —— 典狱长 Boss 实体
 * 临时占位模型：高约 2.8m，深灰黑重甲，暗红魔法纹路，发光红眼，重型法杖。
 * 实现 Enemy 兼容接口（hp/takeDamage/radius/headPosition/getCastOrigin/applyImpact），
 * CombatSystem 无需改动即可处理 Boss 弹道碰撞。
 */
const IS_MOBILE = window.matchMedia('(pointer: coarse)').matches;

export class WardenBoss {
  constructor(scene) {
    this.scene = scene;
    this.isBoss = true;
    this.isEnemy = true;

    this.maxHp = 600;
    this.hp = this.maxHp;
    this.radius = 1.2;
    this.speed = 1.8;
    this.dead = false;

    this.spawnPosition = new THREE.Vector3(0, 0, -10);
    this.position = this.spawnPosition.clone();
    this._facing = 0;

    this.moveIntent = new THREE.Vector3();
    this.stagger = 0;
    this._flash = 0;
    this._castGlow = 0;
    this._deathT = 0;

    this.speedMult = 1;
    this._slowT = 0;
    this.cooldown = 0;
    this.attackCooldown = 1.5;

    // 技能冷却（Boss AI 用）
    this.skill1Cd = 0;
    this.skill1CdMax = 6;
    this.skill2Cd = 0;
    this.skill2CdMax = 10;

    this._invulnT = 0;
    this.phase2 = false;
    this.onDeath = null;

    this._buildMesh();
  }

  get isInvincible() {
    return this._invulnT > 0;
  }

  get headPosition() {
    return new THREE.Vector3(this.position.x, this.position.y + 2.6, this.position.z);
  }

  getCastOrigin(out) {
    return out.set(
      this.position.x + Math.sin(this._facing) * 1.0,
      this.position.y + 2.2,
      this.position.z + Math.cos(this._facing) * 1.0
    );
  }

  setCastGlow(v) {
    this._castGlow = v;
  }

  setInvulnerable(t) {
    this._invulnT = Math.max(this._invulnT, t);
  }

  faceTowards(point, dt) {
    const targetYaw = Math.atan2(point.x - this.position.x, point.z - this.position.z);
    let diff = targetYaw - this._facing;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this._facing += diff * Math.min(1, dt * 4);
  }

  _buildMesh() {
    this.group = new THREE.Group();

    const armorMat = new THREE.MeshStandardMaterial({
      color: 0x2a2530, roughness: 0.45, metalness: 0.7,
    });
    const armorDarkMat = new THREE.MeshStandardMaterial({
      color: 0x1a1620, roughness: 0.55, metalness: 0.6,
    });
    const runeMat = new THREE.MeshStandardMaterial({
      color: 0x8a1a1a, roughness: 0.3, metalness: 0.4,
      emissive: 0xc82020, emissiveIntensity: 1.2,
    });
    const eyeMat = new THREE.MeshStandardMaterial({
      color: 0xff2020, roughness: 0.1, metalness: 0.2,
      emissive: 0xff0000, emissiveIntensity: 3.0,
    });

    const add = (mesh, x, y, z) => {
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      this.group.add(mesh);
      return mesh;
    };

    // 下身重甲裙摆
    const skirt = add(new THREE.Mesh(new THREE.ConeGeometry(1.0, 1.6, 12, 1, true), armorDarkMat), 0, 0.8, 0);

    // 上身重甲
    const torso = add(new THREE.Mesh(new THREE.CapsuleGeometry(0.65, 1.0, 8, 16), armorMat), 0, 2.0, 0);

    // 肩甲
    add(new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 12), armorMat), -0.72, 2.55, 0);
    add(new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 12), armorMat), 0.72, 2.55, 0);

    // 胸口暗红纹路
    const chestRune = add(new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.6), runeMat), 0, 2.1, 0.62);
    chestRune.rotation.x = -0.1;

    // 头盔
    const helm = add(new THREE.Mesh(new THREE.SphereGeometry(0.38, 14, 14, 0, Math.PI * 2, 0, Math.PI * 0.7), armorDarkMat), 0, 2.95, 0);
    // 面甲
    add(new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.3, 0.12), armorMat), 0, 2.82, 0.34);
    // 发光红眼
    const eyeL = add(new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), eyeMat), -0.13, 2.86, 0.36);
    const eyeR = add(new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), eyeMat), 0.13, 2.86, 0.36);
    this.eyeMat = eyeMat;

    // 重型法杖
    const staff = new THREE.Group();
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.08, 2.8, 8),
      new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.8 })
    );
    pole.castShadow = true;
    staff.add(pole);
    // 锤头
    const hammer = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 0.35), armorMat);
    hammer.position.y = 1.55;
    hammer.castShadow = true;
    staff.add(hammer);
    // 锤头发光符文
    const hammerRune = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.06, 0.37), runeMat);
    hammerRune.position.y = 1.4;
    staff.add(hammerRune);
    staff.position.set(0.85, 1.0, 0.15);
    staff.rotation.z = -0.08;
    this.group.add(staff);
    this.staff = staff;
    this.hammerRune = hammerRune;

    // 暗红雾气：环绕粒子
    this._buildFog();

    // 发光法阵（脚下）
    this._buildGroundRune();

    this.runeMat = runeMat;
    this.armorMat = armorMat;
    this.group.position.copy(this.position);
    this.group.visible = false;
    this.scene.add(this.group);
  }

  _buildFog() {
    const n = IS_MOBILE ? 20 : 40;
    const geo = new THREE.BufferGeometry();
    this._fogPos = new Float32Array(n * 3);
    this._fogVel = new Float32Array(n * 3);
    this._fogPhase = new Float32Array(n);
    this._fogSize = new Float32Array(n);
    geo.setAttribute('position', new THREE.BufferAttribute(this._fogPos, 3));

    this.fogMat = new THREE.PointsMaterial({
      color: 0x8a2020, size: 0.5, transparent: true, opacity: 0.3,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    this.fog = new THREE.Points(geo, this.fogMat);
    this.fog.frustumCulled = false;
    this.fog.visible = false;
    this.scene.add(this.fog);
    this._fogN = n;

    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 0.8 + Math.random() * 0.8;
      this._fogPos[i * 3] = Math.cos(a) * r;
      this._fogPos[i * 3 + 1] = 0.2 + Math.random() * 2.5;
      this._fogPos[i * 3 + 2] = Math.sin(a) * r;
      this._fogVel[i * 3] = (Math.random() - 0.5) * 0.3;
      this._fogVel[i * 3 + 1] = 0.2 + Math.random() * 0.3;
      this._fogVel[i * 3 + 2] = (Math.random() - 0.5) * 0.3;
      this._fogPhase[i] = Math.random() * Math.PI * 2;
      this._fogSize[i] = 0.3 + Math.random() * 0.4;
    }
  }

  _buildGroundRune() {
    this.groundRuneMat = new THREE.MeshBasicMaterial({
      color: 0xc82020, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    this.groundRune = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.2, 32),
      this.groundRuneMat
    );
    this.groundRune.rotation.x = -Math.PI / 2;
    this.groundRune.visible = false;
    this.scene.add(this.groundRune);
  }

  /** 入场时显示地面法阵 */
  showIntroRune() {
    this.groundRune.visible = true;
    this.groundRuneMat.opacity = 0;
  }

  update(dt, arenaRadius) {
    // 法杖符文发光
    this.hammerRune.material.emissiveIntensity = 1.0 + this._castGlow * 4.0;
    this.runeMat.emissiveIntensity = 0.8 + this._castGlow * 2.5;

    // 眼睛闪烁
    this.eyeMat.emissiveIntensity = 2.5 + Math.sin(performance.now() * 0.005) * 0.5 + this._castGlow * 2;

    if (this.dead) {
      this._deathT += dt;
      // 跪下 + 裂纹发光 + 消散
      const dp = Math.min(1, this._deathT / 2.0);
      this.group.rotation.x = -dp * 0.6;
      this.group.position.y = -dp * 1.2;
      // 纹路失控闪烁
      this.runeMat.emissiveIntensity = 0.5 + Math.sin(this._deathT * 20) * 2;
      this.eyeMat.emissiveIntensity = Math.max(0, 3 - this._deathT * 1.5);
      return;
    }

    this.cooldown = Math.max(0, this.cooldown - dt);
    this.stagger = Math.max(0, this.stagger - dt);
    this._invulnT = Math.max(0, this._invulnT - dt);
    this.skill1Cd = Math.max(0, this.skill1Cd - dt);
    this.skill2Cd = Math.max(0, this.skill2Cd - dt);

    if (this._slowT > 0) {
      this._slowT -= dt;
      if (this._slowT <= 0) this.speedMult = 1;
    }

    if (this._flash > 0) {
      this._flash -= dt;
      const flashAmount = Math.max(0, this._flash) / 0.15;
      this.armorMat.emissive.setHex(0xff3030);
      this.armorMat.emissiveIntensity = flashAmount * 1.5;
    } else {
      this.armorMat.emissiveIntensity = 0;
    }

    // 移动
    if (this.stagger <= 0 && this.moveIntent.lengthSq() > 0.001) {
      this.position.addScaledVector(this.moveIntent, this.speed * this.speedMult * dt);
    }

    // 边界
    const flat = Math.hypot(this.position.x, this.position.z);
    const maxR = arenaRadius - this.radius;
    if (flat > maxR) {
      this.position.x *= maxR / flat;
      this.position.z *= maxR / flat;
    }

    this.group.position.copy(this.position);
    this.group.rotation.y = this._facing;

    // 地面法阵跟随
    this.groundRune.position.set(this.position.x, 0.05, this.position.z);
    if (this.groundRune.visible) {
      this.groundRuneMat.opacity = 0.4 + Math.sin(performance.now() * 0.003) * 0.2;
    }

    // 雾气更新
    if (this.fog.visible) {
      this._updateFog(dt);
    }
  }

  _updateFog(dt) {
    const n = this._fogN;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      this._fogPhase[i] += dt;
      this._fogPos[i3] += this._fogVel[i3] * dt + Math.sin(this._fogPhase[i] * 1.3) * 0.01;
      this._fogPos[i3 + 1] += this._fogVel[i3 + 1] * dt;
      this._fogPos[i3 + 2] += this._fogVel[i3 + 2] * dt + Math.cos(this._fogPhase[i] * 1.1) * 0.01;
      // 重置到身体周围
      if (this._fogPos[i3 + 1] > 3.5) {
        const a = Math.random() * Math.PI * 2;
        const r = 0.8 + Math.random() * 0.8;
        this._fogPos[i3] = Math.cos(a) * r;
        this._fogPos[i3 + 1] = 0.2;
        this._fogPos[i3 + 2] = Math.sin(a) * r;
      }
      // 转到世界坐标（加上 Boss 位置）
      this._fogPos[i3] += 0; // 雾的坐标在 group 局部，但 Points 不跟随 group
    }
    // 把雾的坐标设为 Boss 世界位置 + 局部偏移
    const bx = this.position.x, bz = this.position.z;
    const worldPos = this.fog.geometry.attributes.position.array;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      worldPos[i3] = bx + this._fogPos[i3];
      worldPos[i3 + 1] = this._fogPos[i3 + 1];
      worldPos[i3 + 2] = bz + this._fogPos[i3 + 2];
    }
    this.fog.geometry.attributes.position.needsUpdate = true;
  }

  takeDamage(amount) {
    if (this.dead || this._invulnT > 0) return;
    this.hp = Math.max(0, this.hp - amount);
    this._flash = 0.15;
    // Boss 不受硬直（不设 stagger），只有短暂闪光
    if (this.hp <= 0) {
      this.dead = true;
      this._deathT = 0;
      this.onDeath && this.onDeath(this);
    }
  }

  applyImpact(dir, power = 1) {
    // Boss 几乎不受击退
    // 轻微偏移可忽略
  }

  applySlow(mult, duration) {
    this.speedMult = mult;
    this._slowT = duration;
  }

  onCast() {}

  setPhase2() {
    this.phase2 = true;
    // 第二阶段：纹路更亮、雾气更浓
    this.runeMat.emissive.setHex(0xff3030);
    this.runeMat.emissiveIntensity = 2.0;
    this.fogMat.opacity = 0.5;
  }

  show() {
    this.group.visible = true;
    this.fog.visible = true;
  }

  hide() {
    this.group.visible = false;
    this.fog.visible = false;
    this.groundRune.visible = false;
  }

  reset() {
    this.dead = false;
    this.hp = this.maxHp;
    this.phase2 = false;
    this._deathT = 0;
    this._flash = 0;
    this._castGlow = 0;
    this._invulnT = 0;
    this.cooldown = 0;
    this.stagger = 0;
    this.skill1Cd = 0;
    this.skill2Cd = 0;
    this.speedMult = 1;
    this._slowT = 0;
    this.moveIntent.set(0, 0, 0);
    this.position.copy(this.spawnPosition);
    this.group.rotation.set(0, 0, 0);
    this.group.position.copy(this.position);
    this.runeMat.emissive.setHex(0xc82020);
    this.runeMat.emissiveIntensity = 1.2;
    this.fogMat.opacity = 0.3;
  }
}
