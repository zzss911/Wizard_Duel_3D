import * as THREE from 'three';
import { buildWizard, PLAYER_PALETTE } from './WizardModel.js';

/**
 * Player —— 玩家角色（施法者）
 * 只维护自身状态：位置 / 朝向 / HP / 受击反馈 / 施法光效。
 * 移动方向相对摄像机水平朝向计算，所有速度基于 deltaTime。
 */
export class Player {
  constructor(scene) {
    this.scene = scene;
    this.isPlayer = true;

    // ---- 数值（与开发文档 5.1 一致）----
    this.maxHp = 100;
    this.hp = this.maxHp;
    this.speed = 5.2;
    this.attackCooldown = 0.45;
    this.cooldown = 0;
    this.radius = 0.7;
    this.dead = false;

    // ---- 闪避（文档 5.1/5.3：3.2m 位移、短暂无敌、2.2s 冷却） ----
    this.dodgeCooldownMax = 2.2;
    this.dodgeCd = 0;
    this._dodgeT = 0;                  // 位移进行时间
    this._dodgeDuration = 0.18;        // 3.2m / 0.18s ≈ 17.8 m/s
    this._dodgeDist = 3.2;
    this._dodgeDir = new THREE.Vector3();
    this._invulnT = 0;                 // 无敌窗口
    this._hitInvulnT = 0;              // 受击保护窗口（0.5s）

    // ---- 技能冷却 ----
    this.skill1CdMax = 6;              // 爆裂咒
    this.skill1Cd = 0;
    this.skill2CdMax = 8;              // 束缚咒
    this.skill2Cd = 0;

    this.spawnPosition = new THREE.Vector3(0, 0, 8);
    this.position = this.spawnPosition.clone();
    this._facing = Math.PI;            // 初始面向场地中心（-Z）
    this._flash = 0;
    this._castGlow = 0;                // 施法蓄力光效强度

    this._buildMesh();
  }

  _buildMesh() {
    const { group, gemMat, glowSprite, robeMat } = buildWizard(PLAYER_PALETTE);
    this.group = group;
    this.gemMat = gemMat;
    this.glowSprite = glowSprite;
    this.bodyMat = robeMat;
    this.group.position.copy(this.position);
    this.group.rotation.y = this._facing;
    this.scene.add(this.group);
  }

  /** 头部/胸口高度，供摄像机与弹道瞄准使用 */
  get headPosition() {
    return new THREE.Vector3(this.position.x, this.position.y + 1.4, this.position.z);
  }

  /** 施法原点（世界坐标，杖尖附近） */
  getCastOrigin(out) {
    return out.set(
      this.position.x + Math.sin(this._facing) * 0.7,
      this.position.y + 1.5,
      this.position.z + Math.cos(this._facing) * 0.7
    );
  }

  /** 开火成功时调用：触发短暂蓄力/释放光效 */
  onCast() {
    this._castGlow = 1;
  }

  /** 是否处于闪避无敌窗口（CombatSystem 命中判定时查询） */
  get isInvincible() {
    return this._invulnT > 0 || this._hitInvulnT > 0;
  }

  /**
   * 尝试闪避：朝当前移动方向快速位移 + 短暂无敌。
   * @returns {boolean} 是否成功触发
   */
  tryDodge(mv, cameraYaw) {
    if (this.dead || this.dodgeCd > 0 || this._dodgeT > 0) return false;

    if (mv.x !== 0 || mv.y !== 0) {
      const fwd = new THREE.Vector3(-Math.sin(cameraYaw), 0, -Math.cos(cameraYaw));
      const right = new THREE.Vector3(Math.cos(cameraYaw), 0, -Math.sin(cameraYaw));
      this._dodgeDir.set(0, 0, 0)
        .addScaledVector(right, mv.x)
        .addScaledVector(fwd, mv.y)
        .normalize();
    } else {
      // 无移动输入时朝面向方向闪
      this._dodgeDir.set(Math.sin(this._facing), 0, Math.cos(this._facing));
    }

    this.dodgeCd = this.dodgeCooldownMax;
    this._dodgeT = this._dodgeDuration;
    this._invulnT = 0.22;
    return true;
  }

  update(dt, input, cameraYaw, arenaRadius) {
    // ---- 施法光效衰减（死亡后仍允许余光散去） ----
    if (this._castGlow > 0) {
      this._castGlow = Math.max(0, this._castGlow - dt * 3.2);
    }
    const glow = 0.9 + this._castGlow * 3.2;
    this.gemMat.emissiveIntensity = glow;
    this.glowSprite.material.opacity = 0.45 + this._castGlow * 0.55;
    const gs = 0.7 + this._castGlow * 0.9;
    this.glowSprite.scale.set(gs, gs, 1);

    if (this.dead) return;

    this.cooldown = Math.max(0, this.cooldown - dt);
    this.dodgeCd = Math.max(0, this.dodgeCd - dt);
    this.skill1Cd = Math.max(0, this.skill1Cd - dt);
    this.skill2Cd = Math.max(0, this.skill2Cd - dt);
    this._invulnT = Math.max(0, this._invulnT - dt);
    this._hitInvulnT = Math.max(0, this._hitInvulnT - dt);
    if (this._flash > 0) {
      this._flash -= dt;
      this.bodyMat.emissive.setHex(this._flash > 0 ? 0xff5040 : 0x000000);
      this.bodyMat.emissiveIntensity = Math.max(0, this._flash) * 4;
    }

    // ---- 闪避位移（覆盖普通移动） ----
    if (this._dodgeT > 0) {
      this._dodgeT -= dt;
      this.position.addScaledVector(this._dodgeDir, (this._dodgeDist / this._dodgeDuration) * dt);
      const flatD = Math.hypot(this.position.x, this.position.z);
      const maxRD = arenaRadius - this.radius;
      if (flatD > maxRD) {
        this.position.x *= maxRD / flatD;
        this.position.z *= maxRD / flatD;
      }
      this._facing = Math.atan2(this._dodgeDir.x, this._dodgeDir.z);
      this.group.position.copy(this.position);
      this.group.rotation.y = this._facing;
      return;
    }

    // ---- 相对摄像机方向移动 ----
    const mv = input.getMoveVector();
    if (mv.x !== 0 || mv.y !== 0) {
      const fwd = new THREE.Vector3(-Math.sin(cameraYaw), 0, -Math.cos(cameraYaw));
      const right = new THREE.Vector3(Math.cos(cameraYaw), 0, -Math.sin(cameraYaw));
      const move = new THREE.Vector3()
        .addScaledVector(right, mv.x)
        .addScaledVector(fwd, mv.y);
      if (move.lengthSq() > 1) move.normalize();

      this.position.addScaledVector(move, this.speed * dt);

      // 圆形边界限制，不掉落
      const flat = Math.hypot(this.position.x, this.position.z);
      const maxR = arenaRadius - this.radius;
      if (flat > maxR) {
        this.position.x *= maxR / flat;
        this.position.z *= maxR / flat;
      }

      // 平滑朝向移动方向
      const targetYaw = Math.atan2(move.x, move.z);
      let diff = targetYaw - this._facing;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      this._facing += diff * Math.min(1, dt * 12);
    }

    this.group.position.copy(this.position);
    this.group.rotation.y = this._facing;
  }

  takeDamage(amount) {
    if (this.dead) return;
    this.hp = Math.max(0, this.hp - amount);
    this._flash = 0.18;
    this._hitInvulnT = 0.5;
    if (this.hp <= 0) this.die();
  }

  die() {
    this.dead = true;
    this.group.rotation.x = -Math.PI / 2;
    this.group.position.y = 0.4;
  }

  /** 重新开始：满血复活回原位 */
  reset() {
    this.dead = false;
    this.hp = this.maxHp;
    this.cooldown = 0;
    this.dodgeCd = 0;
    this.skill1Cd = 0;
    this.skill2Cd = 0;
    this._dodgeT = 0;
    this._invulnT = 0;
    this._hitInvulnT = 0;
    this.position.copy(this.spawnPosition);
    this._facing = Math.PI;
    this.group.rotation.set(0, this._facing, 0);
    this.group.position.copy(this.position);
  }
}
