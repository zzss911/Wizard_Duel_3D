import * as THREE from 'three';

/**
 * Projectile —— 魔法弹
 * 发光弹丸 + 拖尾 + 光晕 + 粒子尾迹，对象池复用。
 * 每枚弹道持有自己的材质实例，fire() 时按 skillType 配置视觉。
 * skillType: 'basic' | 'q' | 'e'，控制粒子大小/发射率/散布/螺旋/脉冲。
 */
let _sharedGeo = null;

const SPARKLE_MAX = 16;
const _white = new THREE.Color(0xffffff);

const SKILL_VFX = {
  basic: {
    sparkleSize: 7,  sparkleRate: 0.06, sparkleSpread: 0.12, sparkleSpeed: 0.8,
    coreScale: 0.85, trailScale: [0.6, 0.6, 3.0], glowScale: 0.9,
    spiral: false, pulse: false,
  },
  q: {
    sparkleSize: 12, sparkleRate: 0.04, sparkleSpread: 0.25, sparkleSpeed: 1.5,
    coreScale: 1.0,  trailScale: [1.0, 1.0, 6.0], glowScale: 2.0,
    spiral: true, spiralSpeed: 10, spiralRadius: 0.35,
    pulse: true,  pulseSpeed: 10, pulseAmp: 0.15,
  },
  e: {
    sparkleSize: 9,  sparkleRate: 0.05, sparkleSpread: 0.18, sparkleSpeed: 1.0,
    coreScale: 0.9,  trailScale: [0.5, 0.5, 5.0], glowScale: 1.5,
    spiral: false, pulse: true, pulseSpeed: 6, pulseAmp: 0.12,
  },
};

const SPARKLE_VERT = `
  attribute float aAge;
  varying float vAge;
  uniform float uSize;
  void main() {
    vAge = aAge;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = uSize * (1.0 - aAge) * (300.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const SPARKLE_FRAG = `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vAge;
  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;
    float alpha = (1.0 - vAge) * uOpacity * (1.0 - d * 2.0);
    gl_FragColor = vec4(uColor, alpha);
  }
`;

export class Projectile {
  constructor(scene) {
    this.scene = scene;

    if (!_sharedGeo) {
      _sharedGeo = new THREE.SphereGeometry(0.16, 10, 10);
    }

    this.coreMat = new THREE.MeshBasicMaterial({ color: 0x8fd0ff });
    this.trailMat = new THREE.MeshBasicMaterial({
      color: 0x5aa8ff, transparent: true, opacity: 0.45,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.glowMat = new THREE.SpriteMaterial({
      color: 0x9fd8ff, transparent: true, opacity: 0.8,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });

    this.group = new THREE.Group();
    this.core = new THREE.Mesh(_sharedGeo, this.coreMat);
    this.group.add(this.core);

    this.trail = new THREE.Mesh(_sharedGeo, this.trailMat);
    this.trail.scale.set(0.7, 0.7, 4.5);
    this.trail.position.z = 0.9;
    this.group.add(this.trail);

    this.glow = new THREE.Sprite(this.glowMat);
    this.glow.scale.set(1.1, 1.1, 1);
    this.group.add(this.glow);

    this.group.visible = false;
    scene.add(this.group);

    // ---- 粒子尾迹（世界空间，独立于 group） ----
    this.sparkleGeo = new THREE.BufferGeometry();
    this._sparklePos = new Float32Array(SPARKLE_MAX * 3);
    this._sparkleAge = new Float32Array(SPARKLE_MAX);
    this._sparkleVel = new Float32Array(SPARKLE_MAX * 3);
    this.sparkleGeo.setAttribute('position', new THREE.BufferAttribute(this._sparklePos, 3));
    this.sparkleGeo.setAttribute('aAge', new THREE.BufferAttribute(this._sparkleAge, 1));

    this.sparkleMat = new THREE.ShaderMaterial({
      vertexShader: SPARKLE_VERT,
      fragmentShader: SPARKLE_FRAG,
      uniforms: {
        uColor: { value: new THREE.Color(0xbfddff) },
        uOpacity: { value: 0.8 },
        uSize: { value: 7 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.sparkles = new THREE.Points(this.sparkleGeo, this.sparkleMat);
    this.sparkles.frustumCulled = false;
    this.sparkles.visible = false;
    scene.add(this.sparkles);

    this._sparkleEmitTimer = 0;
    this._sparkleWriteIdx = 0;
    this._sparkleCfg = SKILL_VFX.basic;

    for (let i = 0; i < SPARKLE_MAX; i++) this._sparkleAge[i] = 1.0;

    // ---- 螺旋 & 脉冲状态 ----
    this._spiralAngle = 0;
    this._pulseTime = 0;
    this._spiralPerp1 = new THREE.Vector3();
    this._spiralPerp2 = new THREE.Vector3();

    this.active = false;
    this.velocity = new THREE.Vector3();
    this.damage = 0;
    this.owner = null;
    this.life = 0;
    this.skillType = 'basic';
  }

  /**
   * @param {number} tint 弹丸颜色（默认玩家蓝）
   * @param {object} meta { scale, power, slow, skillType }
   */
  fire(owner, origin, dir, speed, damage, tint = 0x8fd0ff, meta = {}) {
    this.owner = owner;
    this.damage = damage;
    this.life = 2.5;
    this.power = meta.power ?? 1;
    this.slow = meta.slow ?? 0;
    this.skillType = meta.skillType ?? 'basic';
    this.velocity.copy(dir).multiplyScalar(speed);
    this.group.position.copy(origin);
    this.group.lookAt(origin.x + dir.x, origin.y + dir.y, origin.z + dir.z);

    const s = meta.scale ?? 1;
    this.group.scale.setScalar(s);

    this.coreMat.color.setHex(tint);
    this.glowMat.color.setHex(tint);
    this.trailMat.color.setHex(tint).multiplyScalar(0.7);

    // 粒子配置
    const cfg = SKILL_VFX[this.skillType] || SKILL_VFX.basic;
    this._sparkleCfg = cfg;
    this.sparkleMat.uniforms.uSize.value = cfg.sparkleSize;
    this.sparkleMat.uniforms.uColor.value.setHex(tint).lerp(_white, 0.3);

    // 按技能配置核心/拖尾/光晕
    this._configureForSkill(cfg);

    // 螺旋预计算：垂直于速度方向的两个基向量
    this._spiralAngle = 0;
    this._pulseTime = 0;
    const vDir = this.velocity.clone().normalize();
    this._spiralPerp1.set(0, 1, 0).cross(vDir);
    if (this._spiralPerp1.lengthSq() < 0.01) this._spiralPerp1.set(1, 0, 0);
    this._spiralPerp1.normalize();
    this._spiralPerp2.crossVectors(vDir, this._spiralPerp1).normalize();

    for (let i = 0; i < SPARKLE_MAX; i++) this._sparkleAge[i] = 1.0;
    this._sparkleEmitTimer = 0;
    this._sparkleWriteIdx = 0;

    this.group.visible = true;
    this.sparkles.visible = true;
    this.active = true;
  }

  _configureForSkill(cfg) {
    this.core.scale.setScalar(cfg.coreScale);
    this.trail.scale.set(cfg.trailScale[0], cfg.trailScale[1], cfg.trailScale[2]);
    this.glow.scale.setScalar(cfg.glowScale);
  }

  /** 每帧更新粒子尾迹 + 脉冲，由 CombatSystem.update 调用 */
  updateSparkles(dt) {
    if (!this.active) return;
    const cfg = this._sparkleCfg;

    // Q 核心脉冲
    if (cfg.pulse) {
      this._pulseTime += dt;
      const p = 1 + Math.sin(this._pulseTime * cfg.pulseSpeed) * cfg.pulseAmp;
      this.core.scale.setScalar(cfg.coreScale * p);
    }

    // 更新已有粒子
    for (let i = 0; i < SPARKLE_MAX; i++) {
      if (this._sparkleAge[i] >= 1.0) continue;
      this._sparkleAge[i] += dt / 0.4;
      if (this._sparkleAge[i] > 1.0) this._sparkleAge[i] = 1.0;
      this._sparklePos[i * 3]     += this._sparkleVel[i * 3] * dt;
      this._sparklePos[i * 3 + 1] += this._sparkleVel[i * 3 + 1] * dt;
      this._sparklePos[i * 3 + 2] += this._sparkleVel[i * 3 + 2] * dt;
      this._sparkleVel[i * 3 + 1] -= 3.0 * dt;
    }

    // 发射新粒子
    this._sparkleEmitTimer += dt;
    const v = this.velocity;
    const sp = cfg.sparkleSpeed;

    while (this._sparkleEmitTimer >= cfg.sparkleRate) {
      this._sparkleEmitTimer -= cfg.sparkleRate;
      const i = this._sparkleWriteIdx;
      const pos = this.group.position;

      if (cfg.spiral) {
        // Q 螺旋：在弹丸周围的旋转圆上发射
        const ca = Math.cos(this._spiralAngle);
        const sa = Math.sin(this._spiralAngle);
        const r = cfg.spiralRadius;
        this._sparklePos[i * 3]     = pos.x + (this._spiralPerp1.x * ca + this._spiralPerp2.x * sa) * r;
        this._sparklePos[i * 3 + 1] = pos.y + (this._spiralPerp1.y * ca + this._spiralPerp2.y * sa) * r;
        this._sparklePos[i * 3 + 2] = pos.z + (this._spiralPerp1.z * ca + this._spiralPerp2.z * sa) * r;

        // 向后漂移 + 少量随机
        this._sparkleVel[i * 3]     = -v.x * 0.15 + (Math.random() - 0.5) * sp * 0.3;
        this._sparkleVel[i * 3 + 1] = -v.y * 0.15 + (Math.random() - 0.5) * sp * 0.3;
        this._sparkleVel[i * 3 + 2] = -v.z * 0.15 + (Math.random() - 0.5) * sp * 0.3;

        this._spiralAngle += cfg.spiralSpeed * cfg.sparkleRate;
      } else {
        // basic / E：随机散布
        this._sparklePos[i * 3]     = pos.x + (Math.random() - 0.5) * cfg.sparkleSpread;
        this._sparklePos[i * 3 + 1] = pos.y + (Math.random() - 0.5) * cfg.sparkleSpread;
        this._sparklePos[i * 3 + 2] = pos.z + (Math.random() - 0.5) * cfg.sparkleSpread;

        this._sparkleVel[i * 3]     = -v.x * 0.1 + (Math.random() - 0.5) * sp;
        this._sparkleVel[i * 3 + 1] = -v.y * 0.1 + (Math.random() - 0.5) * sp;
        this._sparkleVel[i * 3 + 2] = -v.z * 0.1 + (Math.random() - 0.5) * sp;
      }

      this._sparkleAge[i] = 0.0;
      this._sparkleWriteIdx = (this._sparkleWriteIdx + 1) % SPARKLE_MAX;
    }

    this.sparkleGeo.attributes.position.needsUpdate = true;
    this.sparkleGeo.attributes.aAge.needsUpdate = true;
  }

  despawn() {
    this.active = false;
    this.owner = null;
    this.group.visible = false;
    this.sparkles.visible = false;
    this.group.scale.setScalar(1);
    this.core.scale.setScalar(1);
    this.power = 1;
    this.slow = 0;
    this.skillType = 'basic';
  }
}
