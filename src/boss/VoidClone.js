import * as THREE from 'three';

/**
 * VoidClone —— 镜像领域假身 (Phase E)
 *
 * Lightweight decoy object — NOT a Boss, NOT an AI, NOT a full state machine.
 * VoidWitchAI owns a fixed pool of 2 clones, pre-created in constructor.
 *
 * Lifecycle:
 *   INACTIVE → (activate) → ACTIVE → (takeDamage / lifetime end) → DISSOLVE → INACTIVE
 *
 * One-hit decoy: any valid projectile hit → dead=true → dissolve → inactive.
 * Never calls real boss.takeDamage(). Never shows damage numbers.
 *
 * Visual: procedural, close to VoidWitchBoss but slightly dimmer:
 *   - core light intensity ~85% of boss
 *   - secondary ring opacity slightly lower
 *   - no secondary glow layer
 */

const CLONE_STATE = {
  INACTIVE: 'INACTIVE',
  ACTIVE: 'ACTIVE',
  DISSOLVE: 'DISSOLVE',
};

const COL = {
  robe: 0x1a0e2e,
  robeLight: 0x2a1840,
  skin: 0xc8b8e0,
  voidCore: 0x8a4adf,
  voidGlow: 0x6f3cff,
  ring: 0x7a3adf,
  flash: 0xc0a0ff,
};

const FLOAT_Y = 0.4;
const DISSOLVE_DURATION = 0.38;

export class VoidClone {
  constructor(scene) {
    this.scene = scene;
    this.isEnemy = true;
    this.isBossClone = true;
    this.suppressDamageNumber = true;
    this.isTarget = false;
    this.isPlayer = false;

    this.radius = 0.8;
    this.active = false;
    this.dead = true;
    this._targetable = false;

    this.position = new THREE.Vector3();
    this._facing = 0;
    this._modelHeight = 2.4;

    this._state = CLONE_STATE.INACTIVE;
    this._stateT = 0;
    this._lifetime = 0;
    this._dissolveT = 0;

    this._floatPhase = Math.random() * Math.PI * 2;
    this._ringRotation = 0;
    this._idleTime = 0;
    this._fakeCastProgress = 0;

    // Scratch vectors
    this._tmp = new THREE.Vector3();

    // Ownership
    this._ownedGeometries = new Set();
    this._ownedMaterials = new Set();

    this._buildVisual();
    this.group.visible = false;
    this.scene.add(this.group);
  }

  // ==================== Build ====================

  _buildVisual() {
    this.group = new THREE.Group();
    this.visualRoot = new THREE.Group();
    this.group.add(this.visualRoot);

    // --- Robe (inverted cone) ---
    const robeMat = new THREE.MeshStandardMaterial({
      color: COL.robe, roughness: 0.65, metalness: 0.3,
    });
    this._ownedMaterials.add(robeMat);
    const robeGeo = new THREE.ConeGeometry(0.55, 1.4, 10, 1, true);
    this._ownedGeometries.add(robeGeo);
    const robe = new THREE.Mesh(robeGeo, robeMat);
    robe.position.y = 0.7;
    robe.castShadow = true;

    // --- Torso (slender capsule) ---
    const torsoMat = new THREE.MeshStandardMaterial({
      color: COL.robeLight, roughness: 0.55, metalness: 0.4,
    });
    this._ownedMaterials.add(torsoMat);
    const torsoGeo = new THREE.CapsuleGeometry(0.22, 0.5, 8, 12);
    this._ownedGeometries.add(torsoGeo);
    const torso = new THREE.Mesh(torsoGeo, torsoMat);
    torso.position.y = 1.4;
    torso.castShadow = true;

    // --- Head ---
    const skinMat = new THREE.MeshStandardMaterial({
      color: COL.skin, roughness: 0.35, metalness: 0.1,
    });
    this._ownedMaterials.add(skinMat);
    const headGeo = new THREE.SphereGeometry(0.18, 12, 12);
    this._ownedGeometries.add(headGeo);
    const head = new THREE.Mesh(headGeo, skinMat);
    head.position.y = 1.85;

    // --- Hood ---
    const hoodGeo = new THREE.ConeGeometry(0.25, 0.4, 8);
    this._ownedGeometries.add(hoodGeo);
    const hood = new THREE.Mesh(hoodGeo, robeMat);
    hood.position.y = 2.0;

    // --- Arms ---
    const armLGeo = new THREE.CapsuleGeometry(0.08, 0.5, 6, 8);
    this._ownedGeometries.add(armLGeo);
    const armL = new THREE.Mesh(armLGeo, robeMat);
    armL.position.set(-0.28, 1.4, 0);
    armL.rotation.z = 0.3;

    const armRGeo = new THREE.CapsuleGeometry(0.08, 0.5, 6, 8);
    this._ownedGeometries.add(armRGeo);
    const armR = new THREE.Mesh(armRGeo, robeMat);
    armR.position.set(0.28, 1.4, 0);
    armR.rotation.z = -0.3;

    this.visualRoot.add(robe, torso, head, hood, armL, armR);

    // Store flash materials for dissolve / hit
    this._flashMaterials = [robeMat, torsoMat, skinMat];

    // --- Void core (chest) — slightly dimmer than boss ---
    const coreGeo = new THREE.SphereGeometry(0.1, 12, 12);
    this._ownedGeometries.add(coreGeo);
    this._coreMat = new THREE.MeshBasicMaterial({
      color: COL.voidCore, transparent: true, opacity: 0.7,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this._ownedMaterials.add(this._coreMat);
    this._voidCore = new THREE.Mesh(coreGeo, this._coreMat);
    this._voidCore.position.set(0, 1.5, 0.15);
    this.visualRoot.add(this._voidCore);

    // Core point light — ~85% intensity of boss P2
    this._coreLight = new THREE.PointLight(COL.voidGlow, 3.2, 4, 2);
    this._coreLight.position.set(0, 1.5, 0.2);
    this.visualRoot.add(this._coreLight);

    // --- Arcane ring 1 (horizontal, waist) — slightly dimmer ---
    const ring1Geo = new THREE.TorusGeometry(0.5, 0.02, 8, 32);
    this._ownedGeometries.add(ring1Geo);
    this._ring1Mat = new THREE.MeshBasicMaterial({
      color: COL.ring, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this._ownedMaterials.add(this._ring1Mat);
    this._arcaneRing1 = new THREE.Mesh(ring1Geo, this._ring1Mat);
    this._arcaneRing1.position.set(0, 1.3, 0);
    this._arcaneRing1.rotation.x = Math.PI / 2;
    this.visualRoot.add(this._arcaneRing1);

    // --- Arcane ring 2 (tilted, upper body) — dimmer, no secondary glow ---
    const ring2Geo = new THREE.TorusGeometry(0.35, 0.015, 8, 32);
    this._ownedGeometries.add(ring2Geo);
    this._ring2Mat = new THREE.MeshBasicMaterial({
      color: COL.ring, transparent: true, opacity: 0.4,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this._ownedMaterials.add(this._ring2Mat);
    this._arcaneRing2 = new THREE.Mesh(ring2Geo, this._ring2Mat);
    this._arcaneRing2.position.set(0, 1.6, 0);
    this._arcaneRing2.rotation.x = Math.PI / 2 + 0.3;
    this._arcaneRing2.rotation.z = 0.2;
    this.visualRoot.add(this._arcaneRing2);
  }

  // ==================== Public API ====================

  get isInvincible() {
    return !this._targetable;
  }

  /** Public lifecycle: clone needs per-frame update */
  get needsUpdate() {
    return this._state !== CLONE_STATE.INACTIVE;
  }

  /** Public lifecycle: clone fully resolved (back to INACTIVE) */
  get isResolved() {
    return this._state === CLONE_STATE.INACTIVE;
  }

  /** Toggle targetability. SETUP phase: false (invincible). ACTIVE: true. */
  setTargetable(value) {
    this._targetable = value;
  }

  get headPosition() {
    return this._tmp.set(
      this.position.x,
      FLOAT_Y + this._modelHeight * 0.85,
      this.position.z
    );
  }

  getCastOrigin(out) {
    return out.set(
      this.position.x + Math.sin(this._facing) * 0.6,
      FLOAT_Y + this._modelHeight * 0.6,
      this.position.z + Math.cos(this._facing) * 0.6
    );
  }

  /**
   * Activate the clone at a position.
   * @param {THREE.Vector3} position
   * @param {number} facing — yaw angle
   * @param {number} lifetime — seconds before auto-dissolve
   */
  activate(position, facing, lifetime) {
    this.position.set(position.x, 0, position.z);
    this._facing = facing;
    this._lifetime = lifetime;
    this._state = CLONE_STATE.ACTIVE;
    this._stateT = 0;
    this.active = true;
    this.dead = false;
    this._fakeCastProgress = 0;
    this._targetable = false;
    this._floatPhase = Math.random() * Math.PI * 2;

    // Restore visuals
    this.visualRoot.scale.setScalar(1);
    this.visualRoot.position.y = FLOAT_Y;
    this._coreMat.opacity = 0.7;
    this._coreLight.intensity = 3.2;
    this._ring1Mat.opacity = 0.55;
    this._ring2Mat.opacity = 0.4;

    // Restore flash materials
    for (const mat of this._flashMaterials) {
      mat.emissiveIntensity = 0;
    }

    this.group.position.copy(this.position);
    this.group.rotation.set(0, this._facing, 0);
    this.group.visible = true;
  }

  update(dt, player) {
    if (this._state === CLONE_STATE.INACTIVE) return;

    this._stateT += dt;
    this._idleTime += dt;
    this._floatPhase += dt;

    // Face player
    if (player && !player.dead) {
      const targetYaw = Math.atan2(
        player.position.x - this.position.x,
        player.position.z - this.position.z
      );
      let diff = targetYaw - this._facing;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      this._facing += diff * Math.min(1, dt * 6);
      this.group.rotation.y = this._facing;
    }

    // Float idle
    const floatY = FLOAT_Y + Math.sin(this._floatPhase * 1.5) * 0.08;
    this.visualRoot.position.y = floatY;

    // Ring rotation
    this._ringRotation += dt * 1.8;
    this._arcaneRing1.rotation.z = this._ringRotation;
    this._arcaneRing2.rotation.y = this._ringRotation * 0.7;

    // Core pulse (slightly dimmer than boss)
    const pulse = 0.4 + Math.sin(this._idleTime * 3) * 0.2 + this._fakeCastProgress * 0.25;
    this._coreMat.opacity = pulse;
    this._coreLight.intensity = 3.2 + this._fakeCastProgress * 2;

    if (this._state === CLONE_STATE.ACTIVE) {
      // Fake cast decay
      this._fakeCastProgress = Math.max(0, this._fakeCastProgress - dt * 2);

      // Lifetime expiry
      if (this._stateT >= this._lifetime) {
        this._beginDissolve();
      }
    } else if (this._state === CLONE_STATE.DISSOLVE) {
      this._updateDissolve(dt);
    }
  }

  /**
   * One-hit decoy: any damage → dissolve.
   * Only takes damage when targetable (ACTIVE phase).
   * During SETUP, _targetable=false → isInvincible=true → projectile despawns but clone survives.
   * Never calls real boss.takeDamage().
   */
  takeDamage(amount) {
    if (this._state !== CLONE_STATE.ACTIVE) return;
    if (!this._targetable) return;
    this._beginDissolve();
  }

  /** Impact is visual-only — clone doesn't move */
  applyImpact(dir, power = 1) {
    // no-op
  }

  /** Slow is a no-op for clones */
  applySlow(mult, duration) {
    // no-op
  }

  /** Set fake cast glow progress (0→1) */
  setFakeCastProgress(p) {
    this._fakeCastProgress = Math.max(0, Math.min(1, p));
  }

  /** Reset to INACTIVE, hide visuals */
  reset() {
    this._state = CLONE_STATE.INACTIVE;
    this._stateT = 0;
    this.active = false;
    this.dead = true;
    this._targetable = false;
    this._fakeCastProgress = 0;
    this.group.visible = false;

    // Restore visuals for next use
    this.visualRoot.scale.setScalar(1);
    this._coreMat.opacity = 0.7;
    this._ring1Mat.opacity = 0.55;
    this._ring2Mat.opacity = 0.4;
    for (const mat of this._flashMaterials) {
      mat.emissiveIntensity = 0;
    }
  }

  /** Destroy: scene.remove + dispose all geometry/material */
  destroy() {
    this.reset();
    this.scene.remove(this.group);
    for (const g of this._ownedGeometries) g.dispose();
    for (const m of this._ownedMaterials) m.dispose();
    this._ownedGeometries.clear();
    this._ownedMaterials.clear();
  }

  // ==================== Internal ====================

  _beginDissolve() {
    this._state = CLONE_STATE.DISSOLVE;
    this._stateT = 0;
    this._dissolveT = 0;
    this.dead = true;
    this.active = false;

    // Purple burst on hit/dissolve
    // (caller's effects system handles the burst visual)
  }

  _updateDissolve(dt) {
    this._dissolveT += dt;
    const p = Math.min(1, this._dissolveT / DISSOLVE_DURATION);
    const fade = 1 - p;

    // Scale down + fade
    this.visualRoot.scale.setScalar(Math.max(0.01, 1 - p * 0.6));
    this._coreMat.opacity = fade * 0.7;
    this._ring1Mat.opacity = fade * 0.55;
    this._ring2Mat.opacity = fade * 0.4;

    // Core light flicker out — clamp to 0 to avoid negative intensity
    this._coreLight.intensity = Math.max(0, 3.2 * fade + Math.sin(this._dissolveT * 30) * 0.5);

    // Flash materials destabilize — clamp to avoid negative intensity
    for (const mat of this._flashMaterials) {
      mat.emissiveIntensity = Math.max(0, fade * 0.5 + Math.sin(this._dissolveT * 20) * 0.3);
    }

    if (p >= 1) {
      this.reset();
    }
  }
}
