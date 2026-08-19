import * as THREE from 'three';

/**
 * TargetImpactExplosion —— 训练靶命中魔法爆炸系统
 *
 * 接口：playMagicExplosion(position, power)
 *   power = 1   普通攻击
 *   power = 1.5 重击
 *   power = 2.5 终极技能
 *
 * 时间轴：
 *   0.00s  巨大闪光 + (音效/震屏由外部 onImpact 编排)
 *   0.05s  冲击波扩散
 *   0.08s  火星喷射
 *   0.15s  黑红烟雾膨胀
 *   0.30s  烟柱上升
 *   0.60s  顶部红黑云团形成
 *   1.0-3s 烟雾扩散
 *   ~3.6s  全部淡出并回收
 *
 * 性能：全部走对象池 + Points 粒子（着色器单 draw call），
 * 移动端自动降级粒子数与灯光寿命，不使用大量独立 Mesh。
 */

const IS_MOBILE = window.matchMedia('(pointer: coarse)').matches;

const SMOKE_COUNT = IS_MOBILE ? 110 : 210;
const SPARK_COUNT = IS_MOBILE ? 60 : 120;
const POOL_SIZE = 3;

/* ---------------- 烟雾着色器（每粒子尺寸/颜色/透明度） ---------------- */
const SMOKE_VERT = `
attribute float aSize;
attribute vec3 aColor;
attribute float aAlpha;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (300.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const SMOKE_FRAG = `
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.12, d) * vAlpha;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor, a);
}`;

/* 烟雾角色：0=底部扩散 1=烟柱 2=顶部云团 */
const ROLE_BASE = 0, ROLE_COLUMN = 1, ROLE_CAP = 2;

class ExplosionInstance {
  constructor(scene) {
    this.scene = scene;
    this.active = false;
    this.elapsed = 0;
    this.power = 1;
    this.origin = new THREE.Vector3();

    this._buildFlash();
    this._buildShockwave();
    this._buildSmoke();
    this._buildSparks();
  }

  /* ---------- 1. 瞬间巨大闪光 ---------- */
  _buildFlash() {
    // 核心：暖白
    this.flashCore = new THREE.Sprite(new THREE.SpriteMaterial({
      color: 0xfff3d8, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.flashCore.visible = false;
    this.scene.add(this.flashCore);

    // 外围：红色光晕
    this.flashHalo = new THREE.Sprite(new THREE.SpriteMaterial({
      color: 0xff4a30, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.flashHalo.visible = false;
    this.scene.add(this.flashHalo);

    // 能量边缘：更大更淡的暗红壳层，营造“能量爆开”体积感
    this.flashEdge = new THREE.Sprite(new THREE.SpriteMaterial({
      color: 0x8f1a10, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.flashEdge.visible = false;
    this.scene.add(this.flashEdge);

    // 能量光柱：命中瞬间冲天而起
    this.beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.32, 0.55, 9, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffd9a0, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      })
    );
    this.beam.visible = false;
    this.scene.add(this.beam);

    // 动态光：明显照亮附近场景（移动端寿命更短）
    this.light = new THREE.PointLight(0xffd9a8, 0, 26, 2);
    this.light.visible = false;
    this.scene.add(this.light);
  }

  /* ---------- 2. 魔法冲击波（双环：内红外金） ---------- */
  _buildShockwave() {
    const mk = (color) => {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(0.85, 1.0, 48),
        new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: 0, side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending, depthWrite: false,
        })
      );
      m.visible = false;
      this.scene.add(m);
      return m;
    };
    this.ringRed = mk(0xd93a22);   // 暗红外环，扩散稍慢
    this.ringGold = mk(0xffc95e);  // 金色内环，扩散更快

    // 地面冲击环：贴地扩散的余波
    this.ringGround = new THREE.Mesh(
      new THREE.RingGeometry(0.88, 1.0, 56),
      new THREE.MeshBasicMaterial({
        color: 0xff8a3d, transparent: true, opacity: 0, side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    this.ringGround.rotation.x = -Math.PI / 2;
    this.ringGround.visible = false;
    this.scene.add(this.ringGround);
  }

  /* ---------- 3. 红黑蘑菇云（单次 draw call 的 Points） ---------- */
  _buildSmoke() {
    const n = SMOKE_COUNT;
    const geo = new THREE.BufferGeometry();
    this.smokePos = new Float32Array(n * 3);
    this.smokeSize = new Float32Array(n);
    this.smokeColor = new Float32Array(n * 3);
    this.smokeAlpha = new Float32Array(n);
    geo.setAttribute('position', new THREE.BufferAttribute(this.smokePos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.smokeSize, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.smokeColor, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.smokeAlpha, 1));

    this.smoke = new THREE.Points(geo, new THREE.ShaderMaterial({
      vertexShader: SMOKE_VERT, fragmentShader: SMOKE_FRAG,
      transparent: true, depthWrite: false,
    }));
    this.smoke.frustumCulled = false;
    this.smoke.visible = false;
    this.scene.add(this.smoke);

    // CPU 侧粒子数据
    this.smokeVel = new Float32Array(n * 3);
    this.smokeRole = new Uint8Array(n);
    this.smokeDelay = new Float32Array(n);
    this.smokeSize0 = new Float32Array(n);
    this.smokeSize1 = new Float32Array(n);
  }

  /* ---------- 4. 魔法火星 ---------- */
  _buildSparks() {
    const n = SPARK_COUNT;
    const geo = new THREE.BufferGeometry();
    this.sparkPos = new Float32Array(n * 3);
    this.sparkColor = new Float32Array(n * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.sparkColor, 3));

    this.sparks = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.13, vertexColors: true, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    }));
    this.sparks.frustumCulled = false;
    this.sparks.visible = false;
    this.scene.add(this.sparks);

    this.sparkVel = new Float32Array(n * 3);
    this.sparkDelay = new Float32Array(n);
    this.sparkLife = new Float32Array(n);
  }

  /* ================= 播放 ================= */
  play(position, power = 1) {
    this.active = true;
    this.elapsed = 0;
    this.power = power;
    this.origin.copy(position);

    /* ---- 闪光初始化 ---- */
    this.flashCore.position.copy(position);
    this.flashCore.scale.setScalar(0.5);
    this.flashCore.material.opacity = 1;
    this.flashCore.visible = true;

    this.flashHalo.position.copy(position);
    this.flashHalo.scale.setScalar(1.2 * power);
    this.flashHalo.material.opacity = 0.85;
    this.flashHalo.visible = true;

    this.flashEdge.position.copy(position);
    this.flashEdge.scale.setScalar(2.0 * power);
    this.flashEdge.material.opacity = 0.6;
    this.flashEdge.visible = true;

    this.beam.position.set(position.x, position.y + 4.0, position.z);
    this.beam.scale.set(0.4 * power, 1, 0.4 * power);
    this.beam.material.opacity = 0.9;
    this.beam.visible = true;

    this.light.position.copy(position);
    this.light.intensity = (IS_MOBILE ? 150 : 260) * power;
    this.light.visible = true;

    /* ---- 冲击波初始化 ---- */
    for (const r of [this.ringRed, this.ringGold]) {
      r.position.copy(position);
      r.scale.setScalar(0.3);
      r.material.opacity = 0.95;
      r.visible = true;
    }
    this.ringGround.position.set(position.x, 0.08, position.z);
    this.ringGround.scale.setScalar(0.4);
    this.ringGround.material.opacity = 0.85;
    this.ringGround.visible = true;

    /* ---- 烟雾初始化 ---- */
    const n = SMOKE_COUNT;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      this.smokePos[i3] = position.x;
      this.smokePos[i3 + 1] = position.y;
      this.smokePos[i3 + 2] = position.z;
      this.smokeAlpha[i] = 0;

      const roll = Math.random();
      const theta = Math.random() * Math.PI * 2;
      if (roll < 0.4) {
        // 底部：贴地向外扩散的黑红烟
        this.smokeRole[i] = ROLE_BASE;
        this.smokeDelay[i] = 0.15 + Math.random() * 0.15;
        const sp = (2.2 + Math.random() * 2.2) * power;
        this.smokeVel[i3] = Math.cos(theta) * sp;
        this.smokeVel[i3 + 1] = 0.3 + Math.random() * 0.8;
        this.smokeVel[i3 + 2] = Math.sin(theta) * sp;
        this.smokeSize0[i] = 0.7 * power;
        this.smokeSize1[i] = (2.6 + Math.random()) * power;
      } else if (roll < 0.75) {
        // 中部：向上喷的粗烟柱
        this.smokeRole[i] = ROLE_COLUMN;
        this.smokeDelay[i] = 0.3 + Math.random() * 0.2;
        this.smokeVel[i3] = Math.cos(theta) * 0.5 * Math.random();
        this.smokeVel[i3 + 1] = (3.2 + Math.random() * 2.2) * power;
        this.smokeVel[i3 + 2] = Math.sin(theta) * 0.5 * Math.random();
        this.smokeSize0[i] = 0.8 * power;
        this.smokeSize1[i] = (3.0 + Math.random() * 1.2) * power;
      } else {
        // 顶部：向两侧摊开的大云团
        this.smokeRole[i] = ROLE_CAP;
        this.smokeDelay[i] = 0.6 + Math.random() * 0.25;
        const sp = (1.2 + Math.random() * 1.4) * power;
        this.smokeVel[i3] = Math.cos(theta) * sp;
        this.smokeVel[i3 + 1] = (1.4 + Math.random() * 0.9) * power;
        this.smokeVel[i3 + 2] = Math.sin(theta) * sp;
        this.smokeSize0[i] = 1.0 * power;
        this.smokeSize1[i] = (3.8 + Math.random() * 1.6) * power;
      }

      // 颜色：黑 / 深红 / 暗红 为主，少量橙红发光
      const glow = Math.random();
      let cr, cg, cb;
      if (glow < 0.18) { cr = 1.0; cg = 0.42; cb = 0.12; }        // 橙红发光
      else if (glow < 0.45) { cr = 0.55; cg = 0.08; cb = 0.06; }   // 深红
      else if (glow < 0.75) { cr = 0.3; cg = 0.04; cb = 0.04; }    // 暗红
      else { cr = 0.06; cg = 0.05; cb = 0.06; }                    // 黑
      this.smokeColor[i3] = cr;
      this.smokeColor[i3 + 1] = cg;
      this.smokeColor[i3 + 2] = cb;
    }
    this._smokeDirty();
    this.smoke.visible = true;

    /* ---- 火星初始化 ---- */
    const m = SPARK_COUNT;
    for (let i = 0; i < m; i++) {
      const i3 = i * 3;
      this.sparkPos[i3] = position.x;
      this.sparkPos[i3 + 1] = position.y;
      this.sparkPos[i3 + 2] = position.z;

      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const sp = (5 + Math.random() * 7) * Math.min(power, 1.6);
      this.sparkVel[i3] = Math.sin(phi) * Math.cos(theta) * sp;
      this.sparkVel[i3 + 1] = Math.abs(Math.cos(phi)) * sp * 0.9 + 1.5;
      this.sparkVel[i3 + 2] = Math.sin(phi) * Math.sin(theta) * sp;
      this.sparkDelay[i] = 0.08 + Math.random() * 0.08;
      this.sparkLife[i] = 0.5 + Math.random() * 0.4;

      // 金 / 红 / 橙
      const c = Math.random();
      if (c < 0.4) { this.sparkColor[i3] = 1.0; this.sparkColor[i3 + 1] = 0.78; this.sparkColor[i3 + 2] = 0.28; }
      else if (c < 0.7) { this.sparkColor[i3] = 1.0; this.sparkColor[i3 + 1] = 0.3; this.sparkColor[i3 + 2] = 0.12; }
      else { this.sparkColor[i3] = 1.0; this.sparkColor[i3 + 1] = 0.5; this.sparkColor[i3 + 2] = 0.1; }
    }
    this.sparks.geometry.attributes.position.needsUpdate = true;
    this.sparks.geometry.attributes.color.needsUpdate = true;
    this.sparks.material.opacity = 1;
    this.sparks.visible = true;
  }

  _smokeDirty() {
    this.smoke.geometry.attributes.position.needsUpdate = true;
    this.smoke.geometry.attributes.aSize.needsUpdate = true;
    this.smoke.geometry.attributes.aColor.needsUpdate = true;
    this.smoke.geometry.attributes.aAlpha.needsUpdate = true;
  }

  /* ================= 帧更新 ================= */
  update(dt, camera) {
    if (!this.active) return;
    this.elapsed += dt;
    const t = this.elapsed;
    const power = this.power;

    /* ---- 1. 闪光：0~0.22s 爆发 ---- */
    if (this.flashCore.visible) {
      const ft = t / 0.22;
      if (ft >= 1) {
        this.flashCore.visible = false;
        this.flashHalo.visible = false;
        this.flashEdge.visible = false;
      } else {
        this.flashCore.scale.setScalar((0.5 + ft * 4.2) * power);
        this.flashCore.material.opacity = 1 - ft;
        this.flashHalo.scale.setScalar((1.2 + ft * 4.6) * power);
        this.flashHalo.material.opacity = 0.85 * (1 - ft);
        this.flashEdge.scale.setScalar((2.0 + ft * 6.0) * power);
        this.flashEdge.material.opacity = 0.6 * (1 - ft);
      }
    }
    // 能量光柱：0.28s 内拉高变细并消失
    if (this.beam.visible) {
      const bt = t / 0.28;
      if (bt >= 1) {
        this.beam.visible = false;
      } else {
        const w = (0.4 + bt * 0.9) * power;
        this.beam.scale.set(w, 1 + bt * 0.35, w);
        this.beam.material.opacity = 0.9 * (1 - bt) * (1 - bt);
      }
    }
    if (this.light.visible) {
      const lt = t / (IS_MOBILE ? 0.24 : 0.38); // 移动端动态光更短
      if (lt >= 1) {
        this.light.visible = false;
        this.light.intensity = 0;
      } else {
        this.light.intensity = (IS_MOBILE ? 150 : 260) * power * (1 - lt) * (1 - lt);
      }
    }

    /* ---- 2. 冲击波：0.05s 起，0.4~0.7s 扩散消失 ---- */
    const wt = (t - 0.05) / 0.55;
    if (wt >= 0) {
      if (wt >= 1) {
        this.ringRed.visible = false;
        this.ringGold.visible = false;
      } else {
        const ease = 1 - Math.pow(1 - wt, 2.2);
        this.ringGold.scale.setScalar((0.3 + ease * 7.0) * power);
        this.ringGold.material.opacity = 0.95 * (1 - wt);
        this.ringRed.scale.setScalar((0.3 + ease * 5.2) * power);
        this.ringRed.material.opacity = 0.8 * (1 - wt);
        // 始终面向摄像机，保证“圆环”观感
        this.ringGold.lookAt(camera.position);
        this.ringRed.lookAt(camera.position);
      }
    }
    // 地面冲击环：稍慢、更大
    const gt = (t - 0.06) / 0.7;
    if (gt >= 0) {
      if (gt >= 1) {
        this.ringGround.visible = false;
      } else {
        const ge = 1 - Math.pow(1 - gt, 2.0);
        this.ringGround.scale.setScalar((0.4 + ge * 9.5) * power);
        this.ringGround.material.opacity = 0.85 * (1 - gt);
      }
    }

    /* ---- 3. 蘑菇云：0.15s 起，~3.4s 淡出 ---- */
    if (this.smoke.visible) {
      const SMOKE_END = 3.4;
      if (t >= SMOKE_END) {
        this.smoke.visible = false;
      } else {
        const n = SMOKE_COUNT;
        for (let i = 0; i < n; i++) {
          const local = t - this.smokeDelay[i];
          if (local <= 0) { this.smokeAlpha[i] = 0; continue; }
          const i3 = i * 3;

          // 位移 + 阻力 + 微浮升
          const drag = Math.max(0, 1 - 1.6 * dt);
          this.smokeVel[i3] *= drag;
          this.smokeVel[i3 + 2] *= drag;
          this.smokeVel[i3 + 1] = this.smokeVel[i3 + 1] * drag + 0.5 * dt; // 热气上升
          this.smokePos[i3] += this.smokeVel[i3] * dt;
          this.smokePos[i3 + 1] += this.smokeVel[i3 + 1] * dt;
          this.smokePos[i3 + 2] += this.smokeVel[i3 + 2] * dt;

          // 尺寸随时间膨胀
          const grow = Math.min(1, local / 1.6);
          this.smokeSize[i] = this.smokeSize0[i] + (this.smokeSize1[i] - this.smokeSize0[i]) * grow;

          // 透明度：快速淡入，后段淡出（底部烟更早散）
          const total = this.smokeRole[i] === ROLE_BASE ? 2.2 : 3.2;
          const lt = local / total;
          const fadeIn = Math.min(1, local / 0.12);
          const fadeOut = lt < 0.55 ? 1 : 1 - (lt - 0.55) / 0.45;
          this.smokeAlpha[i] = 0.62 * fadeIn * Math.max(0, fadeOut);
        }
        this.smoke.geometry.attributes.position.needsUpdate = true;
        this.smoke.geometry.attributes.aSize.needsUpdate = true;
        this.smoke.geometry.attributes.aAlpha.needsUpdate = true;
      }
    }

    /* ---- 4. 火星：0.08s 起，受重力坠落 ---- */
    if (this.sparks.visible) {
      let anyAlive = false;
      const m = SPARK_COUNT;
      for (let i = 0; i < m; i++) {
        const local = t - this.sparkDelay[i];
        if (local <= 0) continue;
        if (local >= this.sparkLife[i]) continue;
        anyAlive = true;
        const i3 = i * 3;
        this.sparkVel[i3 + 1] -= 14 * dt; // 重力
        this.sparkPos[i3] += this.sparkVel[i3] * dt;
        this.sparkPos[i3 + 1] += this.sparkVel[i3 + 1] * dt;
        this.sparkPos[i3 + 2] += this.sparkVel[i3 + 2] * dt;
        if (this.sparkPos[i3 + 1] < 0.03) this.sparkPos[i3 + 1] = 0.03; // 落地停在地面
      }
      this.sparks.material.opacity = Math.max(0, 1 - (t - 0.08) / 0.85);
      this.sparks.geometry.attributes.position.needsUpdate = true;
      if (!anyAlive) this.sparks.visible = false;
    }

    /* ---- 全部结束，回收 ---- */
    if (t >= 3.6) {
      this.active = false;
      this.flashCore.visible = false;
      this.flashHalo.visible = false;
      this.flashEdge.visible = false;
      this.beam.visible = false;
      this.light.visible = false;
      this.ringRed.visible = false;
      this.ringGold.visible = false;
      this.ringGround.visible = false;
      this.smoke.visible = false;
      this.sparks.visible = false;
    }
  }
}

/**
 * 管理器：对象池 + 对外接口
 */
export class TargetImpactExplosion {
  constructor(scene) {
    this.scene = scene;
    this.pool = [];
    for (let i = 0; i < POOL_SIZE; i++) this.pool.push(new ExplosionInstance(scene));
  }

  /** 播放一次魔法爆炸。position: Vector3, power: 1 / 1.5 / 2.5 */
  playMagicExplosion(position, power = 1) {
    const inst = this.pool.find((p) => !p.active) || this.pool[0]; // 全忙时抢占最旧
    inst.play(position, power);
  }

  update(dt, camera) {
    for (const inst of this.pool) inst.update(dt, camera);
  }
}
