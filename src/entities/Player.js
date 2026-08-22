import * as THREE from 'three';
import { buildPlayerModel } from '../player/PlayerModel.js';
import { PlayerAnimationController } from '../player/PlayerAnimationController.js';
import { buildWizard, PLAYER_PALETTE } from './WizardModel.js';

let _glbLoadPromise = null;

async function _loadPlayerGLB() {
  if (_glbLoadPromise) return _glbLoadPromise;
  _glbLoadPromise = (async () => {
    try {
      const { GLTFLoader } = await import('three/addons/GLTFLoader.js');
      const loader = new GLTFLoader();
      const url = 'assets/models/player_rigged.glb';
      const gltf = await loader.loadAsync(url);
      return gltf;
    } catch (e) {
      console.warn('[Player] GLB load failed, will use programmatic model:', e);
      return null;
    }
  })();
  return _glbLoadPromise;
}

/**
 * Player —— 玩家角色（魔法决斗师）
 *
 * v0.3.0: Cast split into CastBasic/CastQ/CastE with token-based pending management.
 * v0.2.0-GLB：正式接入腾讯混元 3D 生成的 GLB 模型。
 * 加载优先级：1. player_rigged.glb  2. 程序化 PlayerModel  3. 旧 WizardModel
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

    // ---- Cast impact sync (v0.3.0) ----
    this._castGeneration = 0;
    this._pendingCast = null; // { type, callback, token, fired }

    // ---- Cast anchor bone reference ----
    this._castBoneAnchor = null; // THREE.Object3D attached to Hand_R bone

    this._buildMesh();

    // ---- 异步加载 GLB ----
    this._glbLoaded = false;
    this._initGLBLoad();
  }

  _initGLBLoad() {
    _loadPlayerGLB().then((gltf) => {
      if (!gltf || this._glbLoaded) return;
      this._applyGLB(gltf);
    }).catch(() => {});
  }

  _applyGLB(gltf) {
    try {
      const model = gltf.scene;
      const clips = gltf.animations || [];

      if (clips.length === 0) {
        console.warn('[Player] GLB has no animations, keeping programmatic model');
        return;
      }

      // Remove existing model
      if (this._modelData) {
        this.visualRoot.remove(this._modelData.group);
        this._modelData.group.traverse((child) => {
          if (child.isMesh) {
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
              if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
              else child.material.dispose();
            }
          }
        });
      }

      // Collect skeleton and find SkinnedMesh for mixer root
      let skeleton = null;
      let skinnedMesh = null;
      model.traverse((child) => {
        if (child.isSkinnedMesh && child.skeleton) {
          skeleton = child.skeleton;
          skinnedMesh = child;
        }
      });

      // Use SkinnedMesh as mixer root so PropertyBinding can access skeleton
      const mixerRoot = skinnedMesh || model;
      this.visualRoot.add(model);

      // Build clips map
      const clipsMap = {};
      for (const clip of clips) {
        const name = clip.name;
        clipsMap[name] = clip;
      }

      // Check required animations (v0.3.0: CastBasic/CastQ/CastE or fallback Cast)
      const required = ['Idle', 'Run', 'Dodge', 'Hit', 'Death'];
      const hasAll = required.every(r => clipsMap[r]);
      if (!hasAll) {
        console.warn('[Player] GLB missing animations:', required.filter(r => !clipsMap[r]));
      }

      // Dispose old animController
      if (this.animController) {
        this.animController.dispose && this.animController.dispose();
      }

      // Create new animController with GLB clips
      this.animController = new PlayerAnimationController(
        mixerRoot, skeleton, clipsMap, true
      );

      // Collect flash materials from GLB
      this._flashMaterials = this._collectFlashMaterials(model);

      // ---- v0.3.0: Attach castAnchor to Hand_R bone ----
      this._attachCastAnchorToSkeleton(model, skeleton);

      this._glbLoaded = true;
      this._usingFallback = false;
      this._modelData = null;
    } catch (e) {
      console.warn('[Player] Failed to apply GLB, keeping programmatic model:', e);
    }
  }

  _attachCastAnchorToSkeleton(model, skeleton) {
    // Find Hand_R bone in the skeleton
    if (!skeleton) return;

    const boneNames = skeleton.bones.map(b => b.name);
    const handRName = boneNames.find(n => n === 'Hand_R' || n === 'hand_R' || n === 'handR');
    if (!handRName) {
      console.warn('[Player] Hand_R bone not found in skeleton, using fixed castAnchor');
      return;
    }

    const handRBone = skeleton.getBoneByName(handRName);
    if (!handRBone) return;

    // Create or reuse castAnchor as child of Hand_R bone
    // Remove from current parent first
    if (this.castAnchor.parent) {
      this.castAnchor.parent.remove(this.castAnchor);
    }

    // Set local offset to approximate wand/staff tip position relative to hand
    // The wand extends forward/up from the hand; offset is tuned to wand tip
    this.castAnchor.position.set(0, 0.35, 0.08);
    this.castAnchor.rotation.set(0, 0, 0);

    // Add as child of the Hand_R bone so it follows all arm animation
    handRBone.add(this.castAnchor);
    this._castBoneAnchor = handRBone;

    // Also move chest/head anchors if they were on group
    if (this.chestAnchor.parent === this.group) {
      // Keep them on group with fixed offsets — they don't need bone precision
    }
  }

  _buildMesh() {
    this.group = new THREE.Group();
    this.visualRoot = new THREE.Group();
    this.group.add(this.visualRoot);

    // 效果锚点
    this.castAnchor = new THREE.Group();
    this.chestAnchor = new THREE.Group();
    this.headAnchor = new THREE.Group();

    // 尝试构建程序化模型，失败则 fallback
    try {
      const model = buildPlayerModel();
      this._modelData = model;
      this.visualRoot.add(model.group);
      this.group.add(model.castAnchor, model.chestAnchor, model.headAnchor);

      this.gemMat = model.gemMat;
      this.glowSprite = model.glowSprite;
      this.robeMat = model.robeMat;
      this._flashMaterials = this._collectFlashMaterials(model.group);

      this.animController = new PlayerAnimationController(
        model.bones.hips, model.skeleton, model.clips, false
      );

      // For programmatic model, attach castAnchor to handR bone
      if (model.bones && model.bones.handR) {
        // Remove castAnchor from group, add to handR bone
        this.group.remove(this.castAnchor);
        this.castAnchor.position.set(0, 0.3, 0.02);
        model.bones.handR.add(this.castAnchor);
        this._castBoneAnchor = model.bones.handR;
      }

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

    this.castAnchor.position.set(0, 1.5, 0.3);
    this.chestAnchor.position.set(0, 1.2, 0);
    this.headAnchor.position.set(0, 1.7, 0);
    this.group.add(this.castAnchor, this.chestAnchor, this.headAnchor);
  }

  /** 头部高度 */
  get headPosition() {
    return new THREE.Vector3(this.position.x, this.position.y + 1.4, this.position.z);
  }

  /**
   * 施法原点 — v0.3.0: Use castAnchor world position if bone-attached.
   * Falls back to fixed offset if GLB not loaded or anchor on group.
   */
  getCastOrigin(out) {
    if (this._castBoneAnchor && this.castAnchor.parent === this._castBoneAnchor) {
      this.castAnchor.getWorldPosition(out);
      return out;
    }
    // Fallback: fixed offset
    return out.set(
      this.position.x + Math.sin(this._facing) * 0.7,
      this.position.y + 1.5,
      this.position.z + Math.cos(this._facing) * 0.7
    );
  }

  /**
   * 施法请求 — v0.3.0: Type-aware cast with token-based pending management.
   *
   * @param {string} castType - 'basic' | 'q' | 'e'
   * @param {function} impactCallback - called at impact frame
   */
  requestCast(castType, impactCallback) {
    this._castGlow = 1;

    // Cancel any existing pending cast (new cast supersedes old)
    if (this._pendingCast && !this._pendingCast.fired) {
      this._pendingCast.fired = true;
    }

    const token = ++this._castGeneration;
    this._pendingCast = {
      type: castType,
      callback: impactCallback,
      token: token,
      fired: false,
    };

    if (this.animController && !this._usingFallback) {
      // Map cast type to animation name
      const animName = castType === 'basic' ? 'CastBasic'
        : castType === 'q' ? 'CastQ'
        : castType === 'e' ? 'CastE'
        : 'CastBasic';

      // Wrap callback with token check to prevent stale execution
      const wrappedCallback = () => {
        if (token !== this._castGeneration) return; // Stale
        if (this._pendingCast && this._pendingCast.fired) return; // Already fired
        if (this._pendingCast) this._pendingCast.fired = true;
        impactCallback();
      };

      const returnedToken = this.animController.playOneShot(animName, wrappedCallback, 0.08);

      // If playOneShot returned -1 (clip not available), fire immediately
      if (returnedToken === -1) {
        if (this._pendingCast) this._pendingCast.fired = true;
        impactCallback();
      }
    } else {
      // Fallback: 立即触发
      if (this._pendingCast) this._pendingCast.fired = true;
      if (impactCallback) impactCallback();
    }
  }

  /** Cancel any pending cast — called on Death, Dodge, reset */
  cancelPendingCast() {
    if (this._pendingCast && !this._pendingCast.fired) {
      this._pendingCast.fired = true;
    }
    this._pendingCast = null;
    if (this.animController) {
      this.animController.cancelPendingImpact();
    }
  }

  /** 旧接口兼容 — 不带 impact sync */
  onCast() {
    this._castGlow = 1;
    if (this.animController && !this._usingFallback) {
      this.animController.playOneShot('CastBasic', null, 0.1);
    }
  }

  get isInvincible() {
    return this._invulnT > 0 || this._hitInvulnT > 0;
  }

  tryDodge(mv, cameraYaw) {
    if (this.dead || this.dodgeCd > 0 || this._dodgeT > 0) return false;

    // Dodge cancels any pending cast
    this.cancelPendingCast();

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
      if (this._isMoving && !(this._dodgeT > 0)) {
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
    this.cancelPendingCast();
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

    // Cancel any pending cast before reset
    this.cancelPendingCast();

    if (this.animController) {
      this.animController.reset();
    }

    this._flash = 0;
    for (const mat of this._flashMaterials) {
      if (mat.emissive) {
        mat.emissive.setHex(mat._origEmissive || 0);
        mat.emissiveIntensity = mat._origEmissiveIntensity || 0;
      }
    }
  }
}
