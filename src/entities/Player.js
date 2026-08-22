import * as THREE from 'three';
import { buildPlayerModel } from '../player/PlayerModel.js';
import { PlayerAnimationController } from '../player/PlayerAnimationController.js';
import { buildWizard, PLAYER_PALETTE } from './WizardModel.js';

/**
 * Player —— 玩家角色（魔法决斗师）
 *
 * v0.2.0：升级为正式骨骼绑定模型 + 动画系统。
 * 模型为视觉层，不影响任何战斗逻辑 / 碰撞 / 手感。
 * 保留旧 WizardModel 作为 fallback。
 */
export class Player {
  constructor(scene) {
    this.scene = scene;
    this.isPlayer = true;

    // ---- 数值（不变）----
    this.maxHp = 100;
    this.hp = this.maxHp;
    this.speed = 5.2;
    this.attackCooldown = 0.45;
    this.cooldown = 0;
    this.radius = 0.7;
    this.dead = false;

    // ---- 闪避（不变）----
    this.dodgeCooldownMax = 2.2;
    this.dodgeCd = 0;
    this._dodgeT = 0;
    this._dodgeDuration = 0.18;
    this._dodgeDist = 3.2;
    this._dodgeDir = new THREE.Vector3();
    this._invulnT = 0;
    this._hitInvulnT = 0;

    // ---- 技能冷却（不变）----
    this.skill1CdMax = 6;
    this.skill1Cd = 0;
    this.skill2CdMax = 8;
    this.skill2Cd = 0;

    this.spawnPosition = new THREE.Vector3(0, 0, 8);
    this.position = this.spawnPosition.clone();
    this._facing = Math.PI;
    this._flash = 0;
    this._castGlow = 0;

    // ---- 移动状态追踪 ----
    this._isMoving = false;
    this._prevDodgeT = 0;

    this._buildMesh();
  }

  _buildMesh() {
    this.group = new THREE.Group();
    this.visualRoot = new THREE.Group();
    this.group.add(this.visualRoot);

    // 效果锚点
    this.castAnchor = new THREE.Group();
    this.chestAnchor = new THREE.Group();
    this.headAnchor = new THREE.Group();

    // 尝试构建正式模型，失败则 fallback
    try {
      const model = buildPlayerModel();
      this._modelData = model;
      this.visualRoot.add(model.group);
      this.group.add(model.castAnchor, model.chestAnchor, model.headAnchor);

      // 引用模型材质用于效果
      this.gemMat = model.gemMat;
      this.glowSprite = model.glowSprite;
      this.robeMat = model.robeMat;
      this._flashMaterials = this._collectFlashMaterials(model.group);

      // 创建动画控制器
      this.animController = new PlayerAnimationController(
        model.bones.hips, model.skeleton, model.clips
      );

      this._usingFallback = false;
    } catch (e) {
      console.warn('[Player] Failed to build player model, using fallback:', e);
      this._buildFallback();
    }

    this.group.position.copy(this.position);
    this.group.rotation.y = this._facing;
    this.scene.add(this.group);
  }

  _collectFlashMaterials(root) {
    const mats = [];
    root.traverse((child) => {
      if (child.isMesh && child.material && !mats.includes(child.material)) {
        if (child.material.emissive) {
          child.material._origEmissive = child.material.emissive.getHex();
          child.material._origEmissiveIntensity = child.material.emissiveIntensity || 0;
        }
        mats.push(child.material);
      }
    });
    return mats;
  }

  _buildFallback() {
    const { group, gemMat, glowSprite, robeMat } = buildWizard(PLAYER_PALETTE);
    this.visualRoot.add(group);
    this.gemMat = gemMat;
    this.glowSprite = glowSprite;
    this.robeMat = robeMat;
    this._flashMaterials = [robeMat];
    this.animController = null;
    this._usingFallback = true;

    // fallback 锚点
    this.castAnchor.position.set(0, 1.5, 0.3);
    this.chestAnchor.position.set(0, 1.2, 0);
    this.headAnchor.position.set(0, 1.7, 0);
    this.group.add(this.castAnchor, this.chestAnchor, this.headAnchor);
  }

  /** 头部高度 */
  get headPosition() {
    return new THREE.Vector3(this.position.x, this.position.y + 1.4, this.position.z);
  }

  /** 施法原点 */
  getCastOrigin(out) {
    return out.set(
      this.position.x + Math.sin(this._facing) * 0.7,
      this.position.y + 1.5,
      this.position.z + Math.cos(this._facing) * 0.7
    );
  }

  onCast() {
    this._castGlow = 1;
    if (this.animController && !this._usingFallback) {
      this.animController.playOneShot('Cast', null, 0.1);
    }
  }

  get isInvincible() {
    return this._invulnT > 0 || this._hitInvulnT > 0;
  }

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
      this._dodgeDir.set(Math.sin(this._facing), 0, Math.cos(this._facing));
    }

    this.dodgeCd = this.dodgeCooldownMax;
    this._dodgeT = this._dodgeDuration;
    this._invulnT = 0.22;
    this._prevDodgeT = this._dodgeT;

    if (this.animController && !this._usingFallback) {
      this.animController.playOneShot('Dodge', null, 0.05);
    }
    return true;
  }

  update(dt, input, cameraYaw, arenaRadius) {
    // ---- 施法光效衰减 ----
    if (this._castGlow > 0) {
      this._castGlow = Math.max(0, this._castGlow - dt * 3.2);
    }
    const glow = 0.9 + this._castGlow * 3.2;
    if (this.gemMat) {
      this.gemMat.emissiveIntensity = glow;
    }
    if (this.glowSprite) {
      this.glowSprite.material.opacity = 0.45 + this._castGlow * 0.55;
      const gs = 0.7 + this._castGlow * 0.9;
      this.glowSprite.scale.set(gs, gs, 1);
    }

    // ---- 受击闪烁 ----
    if (this._flash > 0) {
      this._flash -= dt;
      const flashColor = this._flash > 0 ? 0xff5040 : 0x000000;
      const flashIntensity = Math.max(0, this._flash) * 4;
      for (const mat of this._flashMaterials) {
        if (mat.emissive) {
          mat.emissive.setHex(this._flash > 0 ? 0xff5040 : (mat._origEmissive || 0));
          mat.emissiveIntensity = this._flash > 0 ? flashIntensity : (mat._origEmissiveIntensity || 0);
        }
      }
    }

    // ---- 动画更新（始终运行，即使死亡） ----
    if (this.animController) {
      this.animController.update(dt);
    }

    if (this.dead) return;

    // ---- 冷却 ----
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.dodgeCd = Math.max(0, this.dodgeCd - dt);
    this.skill1Cd = Math.max(0, this.skill1Cd - dt);
    this.skill2Cd = Math.max(0, this.skill2Cd - dt);
    this._invulnT = Math.max(0, this._invulnT - dt);
    this._hitInvulnT = Math.max(0, this._hitInvulnT - dt);

    // ---- 闪避位移 ----
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
      this._prevDodgeT = this._dodgeT;
      return;
    }

    // ---- 相对摄像机方向移动 ----
    const mv = input.getMoveVector();
    const wasMoving = this._isMoving;
    this._isMoving = (mv.x !== 0 || mv.y !== 0);

    if (this._isMoving) {
      const fwd = new THREE.Vector3(-Math.sin(cameraYaw), 0, -Math.cos(cameraYaw));
      const right = new THREE.Vector3(Math.cos(cameraYaw), 0, -Math.sin(cameraYaw));
      const move = new THREE.Vector3()
        .addScaledVector(right, mv.x)
        .addScaledVector(fwd, mv.y);
      if (move.lengthSq() > 1) move.normalize();

      this.position.addScaledVector(move, this.speed * dt);

      const flat = Math.hypot(this.position.x, this.position.z);
      const maxR = arenaRadius - this.radius;
      if (flat > maxR) {
        this.position.x *= maxR / flat;
        this.position.z *= maxR / flat;
      }

      const targetYaw = Math.atan2(move.x, move.z);
      let diff = targetYaw - this._facing;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      this._facing += diff * Math.min(1, dt * 12);
    }

    // ---- 动画状态切换 ----
    if (this.animController) {
      if (this._isMoving && !this._dodgeT > 0) {
        this.animController.setLoopAnim('Run');
      } else if (!this._isMoving) {
        this.animController.setLoopAnim('Idle');
      }
    }

    this.group.position.copy(this.position);
    this.group.rotation.y = this._facing;
  }

  takeDamage(amount) {
    if (this.dead) return;
    this.hp = Math.max(0, this.hp - amount);
    this._flash = 0.18;
    this._hitInvulnT = 0.5;
    if (this.animController && !this._usingFallback) {
      this.animController.playOneShot('Hit', null, 0.08);
    }
    if (this.hp <= 0) this.die();
  }

  die() {
    this.dead = true;
    if (this.animController && !this._usingFallback) {
      this.animController.playOneShot('Death', null, 0.15);
    } else {
      this.group.rotation.x = -Math.PI / 2;
      this.group.position.y = 0.4;
    }
  }

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
    this._isMoving = false;
    this.position.copy(this.spawnPosition);
    this._facing = Math.PI;
    this.group.rotation.set(0, this._facing, 0);
    this.group.position.copy(this.position);

    // 重置动画
    if (this.animController) {
      this.animController.reset();
    }

    // 重置闪烁
    this._flash = 0;
    for (const mat of this._flashMaterials) {
      if (mat.emissive) {
        mat.emissive.setHex(mat._origEmissive || 0);
        mat.emissiveIntensity = mat._origEmissiveIntensity || 0;
      }
    }
  }
}
