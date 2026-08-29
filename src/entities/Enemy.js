import * as THREE from 'three';
import { buildWizard, ENEMY_PALETTE } from './WizardModel.js';

/**
 * Enemy —— AI 敌方魔法师
 * 与 Player 实现相同战斗接口（hp / takeDamage / radius / getCastOrigin / applyImpact），
 * CombatSystem 无需区分。移动意图由 EnemyAI 写入 moveIntent，本类只执行。
 */
export class Enemy {
  constructor(scene) {
    this.scene = scene;
    this.isEnemy = true;

    // ---- 数值（开发文档 5.1：AI 略慢、略弱） ----
    this.maxHp = 100;
    this.hp = this.maxHp;
    this.speed = 4.6;
    this.attackCooldown = 0.8;
    this.cooldown = 0;
    this.radius = 0.7;
    this.dead = false;

    this.spawnPosition = new THREE.Vector3(-7, 0, -9);
    this.position = this.spawnPosition.clone();
    this._facing = 0;

    // AI 写入的移动意图（世界系，归一化）
    this.moveIntent = new THREE.Vector3();

    // 受击硬直 / 击退
    this.stagger = 0;
    this._knock = new THREE.Vector3();
    this._flash = 0;
    this._castGlow = 0;
    this._deathT = 0;

    // 束缚咒减速
    this.speedMult = 1;
    this._slowT = 0;

    this.onDeath = null;

    this._buildMesh();
  }

  _buildMesh() {
    const { group, gemMat, glowSprite, robeMat } = buildWizard(ENEMY_PALETTE);
    this.group = group;
    this.gemMat = gemMat;
    this.glowSprite = glowSprite;
    this.bodyMat = robeMat;
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
  }

  get headPosition() {
    return new THREE.Vector3(this.position.x, this.position.y + 1.4, this.position.z);
  }

  getCastOrigin(out) {
    return out.set(
      this.position.x + Math.sin(this._facing) * 0.7,
      this.position.y + 1.5,
      this.position.z + Math.cos(this._facing) * 0.7
    );
  }

  /** 面向某点的朝向角 */
  faceTowards(point, dt) {
    const targetYaw = Math.atan2(point.x - this.position.x, point.z - this.position.z);
    let diff = targetYaw - this._facing;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this._facing += diff * Math.min(1, dt * 8);
  }

  /** 施法蓄力光效（攻击前摇时由 AI 驱动 0→1，发射后清零） */
  setCastGlow(v) {
    this._castGlow = v;
  }

  update(dt, arenaRadius) {
    // 杖头光效
    this.gemMat.emissiveIntensity = 0.9 + this._castGlow * 3.2;
    this.glowSprite.material.opacity = 0.45 + this._castGlow * 0.55;
    const gs = 0.7 + this._castGlow * 0.9;
    this.glowSprite.scale.set(gs, gs, 1);

    if (this.dead) {
      // 倒地 + 下沉消散
      this._deathT += dt;
      this.group.rotation.x = THREE.MathUtils.lerp(this.group.rotation.x, -Math.PI / 2, Math.min(1, dt * 6));
      if (this._deathT > 0.8) this.group.position.y -= dt * 0.6;
      this._clearSlowVisual();
      return;
    }

    this.cooldown = Math.max(0, this.cooldown - dt);
    this.stagger = Math.max(0, this.stagger - dt);

    // ---- 束缚减速：计时恢复 + 紫色符文可视反馈 ----
    if (this._slowT > 0) {
      this._slowT = Math.max(0, this._slowT - dt);

      if (this._slowT > 0) {
        // 符文环：跟随 + 旋转 + 脉冲
        this.slowRune.visible = true;
        this.slowRune.position.set(this.position.x, 0.05, this.position.z);
        this.slowRune.material.opacity = 0.5 + Math.sin(this._slowT * 8) * 0.2;
        this.slowRune.material.rotation += dt * 1.5;
        const rs = 1.8 + Math.sin(this._slowT * 6) * 0.15;
        this.slowRune.scale.set(rs, rs, 1);

        // 紫色身体发光（仅在非受击闪烁时覆盖）
        if (this._flash <= 0) {
          this.bodyMat.emissive.setHex(0x8a4adf);
          this.bodyMat.emissiveIntensity = 0.5 + Math.sin(this._slowT * 12) * 0.2;
        }
      } else {
        this._clearSlowVisual();
      }
    }

    if (this._flash > 0) {
      this._flash -= dt;
      this.bodyMat.emissive.setHex(this._flash > 0 ? 0xffffff : 0x000000);
      this.bodyMat.emissiveIntensity = Math.max(0, this._flash) * 4;
    }

    // ---- 击退位移（衰减） ----
    if (this._knock.lengthSq() > 0.001) {
      this.position.addScaledVector(this._knock, dt * 4);
      this._knock.multiplyScalar(Math.max(0, 1 - dt * 8));
    }

    // ---- AI 移动意图（硬直时无法移动，受减速影响） ----
    if (this.stagger <= 0 && this.moveIntent.lengthSq() > 0.001) {
      this.position.addScaledVector(this.moveIntent, this.speed * this.speedMult * dt);
    }

    // 场地边界
    const flat = Math.hypot(this.position.x, this.position.z);
    const maxR = arenaRadius - this.radius;
    if (flat > maxR) {
      this.position.x *= maxR / flat;
      this.position.z *= maxR / flat;
    }

    this.group.position.copy(this.position);
    this.group.rotation.y = this._facing;
  }

  takeDamage(amount) {
    if (this.dead) return;
    this.hp = Math.max(0, this.hp - amount);
    this._flash = 0.15;
    this.stagger = 0.22;             // 受击硬直
    if (this.hp <= 0) {
      this.dead = true;
      this._deathT = 0;
      this.onDeath && this.onDeath(this);
    }
  }

  applyImpact(dir, power = 1) {
    if (this.dead) return;
    this._knock.set(dir.x, 0, dir.z).normalize().multiplyScalar(0.5 * power);
  }

  /** 束缚咒：移动速度降低（mult=0.6 即减速 40%），持续 duration 秒 */
  applySlow(mult, duration) {
    if (this.dead) return;
    this.speedMult = mult;
    this._slowT = duration;
  }

  /** 清除减速视觉状态：符文环隐藏 + body emissive 恢复 */
  _clearSlowVisual() {
    this.speedMult = 1;
    this._slowT = 0;
    this.slowRune.visible = false;
    this.slowRune.material.opacity = 0;
    this.bodyMat.emissive.setHex(0x000000);
    this.bodyMat.emissiveIntensity = 0;
  }

  /** 重新开始 */
  reset() {
    this.dead = false;
    this.hp = this.maxHp;
    this.cooldown = 0;
    this.stagger = 0;
    this._deathT = 0;
    this._knock.set(0, 0, 0);
    this.moveIntent.set(0, 0, 0);
    this.position.copy(this.spawnPosition);
    this.group.rotation.set(0, 0, 0);
    this.group.position.copy(this.position);
    this._clearSlowVisual();
  }
}
