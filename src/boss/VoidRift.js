import * as THREE from 'three';

/**
 * VoidRift —— 虚空裂隙 (Phase D)
 *
 * Lightweight reusable hazard object. Not an AI, not a Boss.
 * VoidWitchAI owns a fixed pool and decides when/where to spawn.
 *
 * State machine:
 *   INACTIVE → DELAY → WARNING → ACTIVE → FADING → INACTIVE
 *
 * Damage ONLY during ACTIVE. Tick-based (tickInterval), never per-frame.
 * First tick is delayed by tickInterval after ACTIVE begins so the player
 * gets a final escape window after warning ends.
 *
 * Visuals:
 *   WARNING: outer purple-blue ring + inner low-opacity disc + center glow.
 *            Opacity ramps 0→1, pulse accelerates. Last 0.2s flickers fast.
 *   ACTIVE:  dark-purple void disc, outer ring rotates, upward particles.
 *   FADING:  everything fades out over fadeDuration.
 *
 * Ownership: VoidRift owns its group (ring + disc + core + particles).
 * scene.add(group) once at construction. Reused via visible flag.
 */

const RIFT_STATE = {
  INACTIVE: 'INACTIVE',
  DELAY: 'DELAY',
  WARNING: 'WARNING',
  ACTIVE: 'ACTIVE',
  FADING: 'FADING',
};

const COL = {
  outer: 0x6f3cff,
  inner: 0x301060,
  center: 0xd5c8ff,
  particle: 0x9a6cff,
};

const PARTICLE_COUNT = 12;

export class VoidRift {
  /**
   * @param {THREE.Scene} scene
   * @param {object} effects — Effects system (for burst on WARNING→ACTIVE and tick hits)
   */
  constructor(scene, effects) {
    this.scene = scene;
    this.effects = effects;

    this._state = RIFT_STATE.INACTIVE;
    this._stateT = 0;

    // Config (set on activate)
    this._radius = 2.4;
    this._warningDuration = 0.9;
    this._activeDuration = 2.6;
    this._fadeDuration = 0.4;
    this._tickInterval = 0.6;
    this._damage = 7;

    // Delay (for Phase II stagger)
    this._delayT = 0;

    // Tick timer
    this._tickT = 0;

    // Position (XZ ground)
    this._pos = new THREE.Vector3();

    // Particle velocities
    this._partVel = new Float32Array(PARTICLE_COUNT * 3);

    // Build visual group
    this._buildVisuals();

    // Add to scene once
    this.scene.add(this._group);
    this._group.visible = false;
  }

  // ==================== Build ====================

  _buildVisuals() {
    this._group = new THREE.Group();

    // --- Outer ring (warning + active) ---
    const ringGeo = new THREE.RingGeometry(0.82, 1.0, 48);
    this._ringMat = new THREE.MeshBasicMaterial({
      color: COL.outer,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this._ring = new THREE.Mesh(ringGeo, this._ringMat);
    this._ring.rotation.x = -Math.PI / 2;
    this._group.add(this._ring);

    // --- Inner disc (void ground hazard) ---
    const discGeo = new THREE.CircleGeometry(1.0, 48);
    this._discMat = new THREE.MeshBasicMaterial({
      color: COL.inner,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this._disc = new THREE.Mesh(discGeo, this._discMat);
    this._disc.rotation.x = -Math.PI / 2;
    this._group.add(this._disc);

    // --- Center glow core ---
    const coreGeo = new THREE.CircleGeometry(0.3, 24);
    this._coreMat = new THREE.MeshBasicMaterial({
      color: COL.center,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this._core = new THREE.Mesh(coreGeo, this._coreMat);
    this._core.rotation.x = -Math.PI / 2;
    this._group.add(this._core);

    // --- Upward particles (fixed pool) ---
    const partGeo = new THREE.BufferGeometry();
    const partPos = new Float32Array(PARTICLE_COUNT * 3);
    partGeo.setAttribute('position', new THREE.BufferAttribute(partPos, 3));
    this._partMat = new THREE.PointsMaterial({
      color: COL.particle,
      size: 0.12,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this._particles = new THREE.Points(partGeo, this._partMat);
    this._particles.visible = false;
    this._group.add(this._particles);
  }

  // ==================== Public API ====================

  get active() {
    return this._state !== RIFT_STATE.INACTIVE;
  }

  /**
   * Activate this rift at a position with config.
   * @param {THREE.Vector3} position — XZ world position (y ignored, set to ground)
   * @param {object} config — { radius, warningDuration, activeDuration, fadeDuration, tickInterval, damage }
   * @param {number} delay — delay before WARNING begins (for Phase II stagger)
   */
  activate(position, config, delay = 0) {
    this._pos.set(position.x, 0, position.z);

    this._radius = config.radius ?? 2.4;
    this._warningDuration = config.warningDuration ?? 0.9;
    this._activeDuration = config.activeDuration ?? 2.6;
    this._fadeDuration = config.fadeDuration ?? 0.4;
    this._tickInterval = config.tickInterval ?? 0.6;
    this._damage = config.damage ?? 7;

    // Position the group
    this._group.position.copy(this._pos);

    // Scale ring/disc/core to match radius (built at radius 1.0)
    this._ring.scale.setScalar(this._radius);
    this._disc.scale.setScalar(this._radius);
    this._core.scale.setScalar(this._radius);

    // Reset all visual opacities
    this._ringMat.opacity = 0;
    this._discMat.opacity = 0;
    this._coreMat.opacity = 0;
    this._partMat.opacity = 0;
    this._particles.visible = false;

    // Reset timers
    this._stateT = 0;
    this._tickT = this._tickInterval; // First tick delayed by full interval

    if (delay > 0) {
      this._state = RIFT_STATE.DELAY;
      this._delayT = delay;
    } else {
      this._state = RIFT_STATE.WARNING;
    }

    this._group.visible = true;
  }

  /**
   * Update the rift.
   * @param {number} dt
   * @param {object} player — player entity (for hit test)
   * @returns {boolean} — true if rift is still active (not INACTIVE)
   */
  update(dt, player) {
    if (this._state === RIFT_STATE.INACTIVE) return false;

    this._stateT += dt;

    switch (this._state) {
      case RIFT_STATE.DELAY:
        if (this._stateT >= this._delayT) {
          this._state = RIFT_STATE.WARNING;
          this._stateT = 0;
        }
        break;

      case RIFT_STATE.WARNING:
        this._updateWarningVisuals();
        if (this._stateT >= this._warningDuration) {
          this._enterActive();
        }
        break;

      case RIFT_STATE.ACTIVE:
        this._updateActiveVisuals(dt);

        // Tick timer
        this._tickT -= dt;
        if (this._tickT <= 0) {
          this._tickT += this._tickInterval;
          this._doTick(player);
        }

        if (this._stateT >= this._activeDuration) {
          this._state = RIFT_STATE.FADING;
          this._stateT = 0;
        }
        break;

      case RIFT_STATE.FADING:
        this._updateFadingVisuals();
        if (this._stateT >= this._fadeDuration) {
          this._deactivate();
        }
        break;
    }

    return true;
  }

  /** Reset to INACTIVE, hide visuals. Safe to call any time. */
  reset() {
    this._state = RIFT_STATE.INACTIVE;
    this._stateT = 0;
    this._tickT = 0;
    this._group.visible = false;
    this._ringMat.opacity = 0;
    this._discMat.opacity = 0;
    this._coreMat.opacity = 0;
    this._partMat.opacity = 0;
    this._particles.visible = false;
  }

  /** Destroy: scene.remove + dispose all geometry/material. */
  destroy() {
    this.reset();
    this.scene.remove(this._group);

    this._ring.geometry.dispose();
    this._disc.geometry.dispose();
    this._core.geometry.dispose();
    this._particles.geometry.dispose();

    this._ringMat.dispose();
    this._discMat.dispose();
    this._coreMat.dispose();
    this._partMat.dispose();
  }

  // ==================== State Transitions ====================

  _enterActive() {
    this._state = RIFT_STATE.ACTIVE;
    this._stateT = 0;
    this._tickT = this._tickInterval; // First tick delayed by full interval

    // Flash the warning ring
    this._ringMat.opacity = 1.0;

    // Initialize particles for active phase
    this._initParticles();

    // Burst on WARNING→ACTIVE transition
    if (this.effects) {
      this.effects.burst(
        this._pos.clone().setY(0.5),
        COL.particle,
        10,
        0.12
      );
    }
  }

  _deactivate() {
    this._state = RIFT_STATE.INACTIVE;
    this._group.visible = false;
  }

  // ==================== Visual Updates ====================

  _updateWarningVisuals() {
    const progress = Math.min(1, this._stateT / this._warningDuration);
    const timeLeft = this._warningDuration - this._stateT;

    // Opacity ramps 0→1
    const baseOpacity = progress;

    // Pulse accelerates as warning progresses
    const pulseFreq = 4 + progress * 8;
    const pulse = 0.5 + Math.sin(this._stateT * pulseFreq * Math.PI * 2) * 0.3;

    // Last 0.2s: flicker fast
    let flicker = 1.0;
    if (timeLeft < 0.2) {
      flicker = 0.5 + Math.abs(Math.sin(this._stateT * 40)) * 0.5;
    }

    this._ringMat.opacity = baseOpacity * pulse * flicker * 0.8;
    this._discMat.opacity = baseOpacity * 0.15 * flicker;
    this._coreMat.opacity = baseOpacity * 0.3 * flicker;
  }

  _updateActiveVisuals(dt) {
    // Outer ring rotates
    this._ring.rotation.z += dt * 2.0;

    // Ring steady pulse
    const pulse = 0.6 + Math.sin(this._stateT * 6) * 0.2;
    this._ringMat.opacity = pulse;

    // Void disc steady
    this._discMat.opacity = 0.4 + Math.sin(this._stateT * 4) * 0.1;

    // Core bright
    this._coreMat.opacity = 0.6 + Math.sin(this._stateT * 8) * 0.2;

    // Particles
    this._updateParticles(dt);
  }

  _updateFadingVisuals() {
    const progress = Math.min(1, this._stateT / this._fadeDuration);
    const fade = 1 - progress;

    this._ringMat.opacity *= fade;
    this._discMat.opacity *= fade;
    this._coreMat.opacity *= fade;
    this._partMat.opacity *= fade;
  }

  // ==================== Particles ====================

  _initParticles() {
    const pos = this._particles.geometry.attributes.position.array;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const angle = (i / PARTICLE_COUNT) * Math.PI * 2 + Math.random() * 0.3;
      const r = Math.random() * this._radius * 0.8;
      pos[i * 3] = Math.cos(angle) * r;
      pos[i * 3 + 1] = 0;
      pos[i * 3 + 2] = Math.sin(angle) * r;

      this._partVel[i * 3] = (Math.random() - 0.5) * 0.5;
      this._partVel[i * 3 + 1] = 1.5 + Math.random() * 1.0;
      this._partVel[i * 3 + 2] = (Math.random() - 0.5) * 0.5;
    }
    this._particles.geometry.attributes.position.needsUpdate = true;
    this._particles.visible = true;
    this._partMat.opacity = 0.6;
  }

  _updateParticles(dt) {
    const pos = this._particles.geometry.attributes.position.array;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      pos[i * 3] += this._partVel[i * 3] * dt;
      pos[i * 3 + 1] += this._partVel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += this._partVel[i * 3 + 2] * dt;

      this._partVel[i * 3 + 1] -= 2 * dt; // Gravity

      // Reset particle when it rises too high
      if (pos[i * 3 + 1] > 1.5) {
        const angle = Math.random() * Math.PI * 2;
        const r = Math.random() * this._radius * 0.8;
        pos[i * 3] = Math.cos(angle) * r;
        pos[i * 3 + 1] = 0;
        pos[i * 3 + 2] = Math.sin(angle) * r;

        this._partVel[i * 3] = (Math.random() - 0.5) * 0.5;
        this._partVel[i * 3 + 1] = 1.5 + Math.random() * 1.0;
        this._partVel[i * 3 + 2] = (Math.random() - 0.5) * 0.5;
      }
    }
    this._particles.geometry.attributes.position.needsUpdate = true;
  }

  // ==================== Tick Damage ====================

  _doTick(player) {
    if (!player || player.dead) return;
    if (player.isInvincible) return;

    // XZ plane hit test
    const dx = player.position.x - this._pos.x;
    const dz = player.position.z - this._pos.z;
    const distSq = dx * dx + dz * dz;

    if (distSq < this._radius * this._radius) {
      player.takeDamage(this._damage);

      // Small burst on hit
      if (this.effects) {
        this.effects.burst(
          player.position.clone().setY(1.0),
          COL.particle,
          6,
          0.1
        );
        this.effects.impactFlash(
          player.position.clone().setY(1.0),
          COL.center,
          0.8
        );
      }
    }
  }
}
