import * as THREE from 'three';

/**
 * VoidWitchAI —— 虚空女巫 AI (Phase C)
 *
 * State machine:
 *   IDLE → MOVE → CHOOSE → TELEGRAPH → BARRAGE / BLINK → RECOVER → IDLE
 *   PHASE_CHANGE (interrupt)
 *   DEAD
 *
 * Skills:
 *   1. Void Barrage — Fan of void projectiles, no homing (snapshot player pos)
 *   2. Void Blink   — Telegraph marker → vanish → teleport → reappear
 *
 * Skill selection: distance-based weights, no 3 consecutive same skills.
 * Reuses CombatSystem projectile pool. Boss owns its projectiles for cleanup.
 */

const AI_STATE = {
  IDLE: 'IDLE',
  MOVE: 'MOVE',
  CHOOSE: 'CHOOSE',
  TELEGRAPH: 'TELEGRAPH',
  BARRAGE: 'BARRAGE',
  BLINK: 'BLINK',
  RECOVER: 'RECOVER',
  PHASE_CHANGE: 'PHASE_CHANGE',
  DEAD: 'DEAD',
};

const SKILL = {
  BARRAGE: 'void_barrage',
  BLINK: 'void_blink',
};

const SKILL_CONFIG = {
  [SKILL.BARRAGE]: {
    telegraph: 0.85,
    recover: 1.0,
    damage: 8,
    projectileSpeed: 16,
    projectileTint: 0x6f3cff,
    impactTint: 0x9a6cff,
    shotInterval: 0.14,
    // Phase 1: 3 projectiles, fan [-8°, 0°, +8°]
    phase1: { count: 3, fan: [-8, 0, 8] },
    // Phase 2: 5 projectiles, fan [-14°, -7°, 0°, +7°, +14°]
    phase2: { count: 5, fan: [-14, -7, 0, 7, 14] },
  },
  [SKILL.BLINK]: {
    telegraph: 0.62,
    recover: 0.7,
    // Sub-phase durations
    vanishDuration: 0.15,
    relocateDuration: 0.10,
    reappearDuration: 0.20,
    // Invulnerability window: covers vanish + relocate
    invulnDuration: 0.25,
    // Destination constraints
    minDist: 4.5,
    maxDist: 9.0,
    phase1: { angles: [-60, 60] },
    phase2: { angles: [-120, -60, 60, 120] },
  },
};

// Boss animation state names for setBossState
const STATE_ANIM_MAP = {
  [AI_STATE.IDLE]: 'IDLE',
  [AI_STATE.MOVE]: 'IDLE',
  [AI_STATE.CHOOSE]: 'IDLE',
  [AI_STATE.TELEGRAPH]: 'IDLE',
  [AI_STATE.BARRAGE]: 'IDLE',
  [AI_STATE.BLINK]: 'IDLE',
  [AI_STATE.RECOVER]: 'IDLE',
  [AI_STATE.PHASE_CHANGE]: 'PHASE_CHANGE',
  [AI_STATE.DEAD]: 'DEAD',
};

// Blink sub-states within the BLINK state
const BLINK_SUB = {
  VANISH: 'vanish',
  RELOCATE: 'relocate',
  REAPPEAR: 'reappear',
};

// Deterministic fallback angles (degrees) for blink destination
const FALLBACK_ANGLES = [90, -90, 135, -135, 180, 0];
const FALLBACK_DISTANCES = [9, 8, 7, 6];

export class VoidWitchAI {
  /**
   * @param {object}   boss       VoidWitchBoss instance
   * @param {object}   combat     CombatSystem instance
   * @param {object}   scene      THREE.Scene
   * @param {object}   effects    Effects system
   * @param {object}   explosion  Explosion system
   */
  constructor(boss, combat, scene, effects, explosion) {
    this.boss = boss;
    this.combat = combat;
    this.scene = scene;
    this.effects = effects;
    this.explosion = explosion;
    this.audio = null;
    this.hud = null;

    // Callbacks (set by BossBattleController)
    this.onShake = null;
    this.onSkillTelegraph = null;

    // State machine
    this._state = AI_STATE.IDLE;
    this._stateT = 0;

    // Phase tracking
    this._phase = 1;

    // Movement
    this._moveDir = new THREE.Vector3();
    this._moveTimer = 0;
    this._moveDuration = 0;

    // Skill selection
    this._currentSkill = null;
    this.attackHistory = [];
    this._lastSkill = null;
    this._lastSkillRepeat = 0;

    // Barrage state
    this._barrageShotsFired = 0;
    this._barrageShotTimer = 0;
    this._barrageDirections = [];
    this._barrageCount = 0;

    // Blink state
    this._blinkSub = null;
    this._blinkSubT = 0;
    this._blinkDest = new THREE.Vector3();

    // Projectile ownership — track for cleanup.
    // We store the Projectile reference; on cleanup we verify p.owner === this.boss
    // before despawning, so a pooled projectile reused by the player is never touched.
    this._ownedProjectiles = new Set();

    // Scratch vectors (avoid per-frame allocation)
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._tmpToPlayer = new THREE.Vector3();

    // Set boss initial state
    boss.setBossState('IDLE');
  }

  // ==================== Public API ====================

  reset() {
    this._state = AI_STATE.IDLE;
    this._stateT = 0;
    this._phase = 1;
    this._moveTimer = 0;
    this._moveDuration = 0;
    this._currentSkill = null;
    this.attackHistory = [];
    this._lastSkill = null;
    this._lastSkillRepeat = 0;
    this._barrageShotsFired = 0;
    this._barrageDirections = [];
    this._barrageCount = 0;
    this._blinkSub = null;
    this._blinkSubT = 0;
    this._ownedProjectiles.clear();
    this.boss.cancelBlink?.();
    this.boss.clearInvulnerability?.();
    this.boss.setBossState('IDLE');
  }

  update(dt, player, arena) {
    const b = this.boss;
    b.moveIntent.set(0, 0, 0);

    // --- Death check ---
    if (b.dead) {
      if (this._state !== AI_STATE.DEAD) {
        this.cancelCurrentSkill();
        this._setState(AI_STATE.DEAD);
      }
      return;
    }

    // --- Player dead check ---
    if (player.dead) {
      // Stop new skills, stop firing, but don't despawn projectiles
      if (this._state === AI_STATE.TELEGRAPH ||
          this._state === AI_STATE.BARRAGE ||
          this._state === AI_STATE.BLINK) {
        this.cancelCurrentSkill();
        this._setState(AI_STATE.IDLE);
        this._stateT = 0;
      }
      return;
    }

    this._stateT += dt;

    // Clean up dead projectiles from ownership set.
    // Also remove any projectile whose owner is no longer this boss
    // (pool reused it for the player).
    if (this._ownedProjectiles.size > 0) {
      for (const p of this._ownedProjectiles) {
        if (!p.active || p.owner !== this.boss) {
          this._ownedProjectiles.delete(p);
        }
      }
    }

    switch (this._state) {
      case AI_STATE.IDLE:
        b.faceTowards(player.position, dt);
        if (this._stateT >= 0.4) {
          this._setState(AI_STATE.MOVE);
        }
        break;

      case AI_STATE.MOVE: {
        b.faceTowards(player.position, dt);

        const toPlayer = this._tmpToPlayer
          .subVectors(player.position, b.position)
          .setY(0);
        const dist = toPlayer.length();

        if (dist < 0.01) {
          const a = Math.random() * Math.PI * 2;
          this._moveDir.set(Math.cos(a), 0, Math.sin(a));
        } else if (dist < 7) {
          // Too close — move away
          this._moveDir.copy(toPlayer).normalize().negate();
        } else if (dist > 11) {
          // Too far — move toward player
          this._moveDir.copy(toPlayer).normalize();
        } else {
          // Sweet spot — strafe perpendicular
          this._moveDir.set(-toPlayer.z, 0, toPlayer.x).normalize();
          if (Math.random() < 0.01) this._moveDir.negate();
        }

        b.moveIntent.copy(this._moveDir).multiplyScalar(0.6);

        this._moveTimer += dt;
        if (this._moveTimer >= this._moveDuration) {
          this._setState(AI_STATE.CHOOSE);
        }
        break;
      }

      case AI_STATE.CHOOSE: {
        const dist = b.position.distanceTo(player.position);
        const skill = this._chooseSkill(dist);
        this._currentSkill = skill;
        this.attackHistory.push(skill);
        if (this.attackHistory.length > 6) this.attackHistory.shift();

        // Track consecutive repeats
        if (skill === this._lastSkill) {
          this._lastSkillRepeat++;
        } else {
          this._lastSkill = skill;
          this._lastSkillRepeat = 1;
        }

        this._setState(AI_STATE.TELEGRAPH);
        this._beginTelegraph(skill, player, arena);
        // Notify controller for skill name display
        if (this.onSkillTelegraph) this.onSkillTelegraph(skill);
        break;
      }

      case AI_STATE.TELEGRAPH:
        b.faceTowards(player.position, dt);
        {
          const cfg = SKILL_CONFIG[this._currentSkill];
          const telegraphTime = cfg.telegraph;
          const progress = Math.min(1, this._stateT / telegraphTime);
          // Cast glow ramps up
          let glow = progress;
          if (this._stateT > telegraphTime - 0.25) {
            glow += Math.sin((telegraphTime - this._stateT) * 30) * 0.2;
          }
          b.setCastGlow(Math.min(1, Math.max(0, glow)));

          // Blink: ramp up marker opacity
          if (this._currentSkill === SKILL.BLINK && b._blinkMarker) {
            b.setBlinkMarkerOpacity(progress * 0.8);
          }

          if (this._stateT >= telegraphTime) {
            b.setCastGlow(0);
            if (this._currentSkill === SKILL.BARRAGE) {
              this._setState(AI_STATE.BARRAGE);
              this._beginBarrage(player);
            } else if (this._currentSkill === SKILL.BLINK) {
              this._setState(AI_STATE.BLINK);
              this._beginBlinkExecute();
            }
          }
        }
        break;

      case AI_STATE.BARRAGE:
        this._updateBarrage(dt, player);
        break;

      case AI_STATE.BLINK:
        this._updateBlink(dt, player, arena);
        break;

      case AI_STATE.RECOVER:
        b.faceTowards(player.position, dt);
        {
          const dist = b.position.distanceTo(player.position);
          if (dist > 10) {
            this._tmp.subVectors(player.position, b.position).setY(0).normalize();
            b.moveIntent.copy(this._tmp).multiplyScalar(0.3);
          }
          const cfg = SKILL_CONFIG[this._currentSkill];
          if (this._stateT >= cfg.recover) {
            this._setState(AI_STATE.IDLE);
            this._stateT = 0;
          }
        }
        break;

      case AI_STATE.PHASE_CHANGE:
        b.faceTowards(player.position, dt);
        break;
    }
  }

  triggerPhaseChange() {
    if (this._state === AI_STATE.PHASE_CHANGE || this._state === AI_STATE.DEAD) return;
    // Cancel blink first — clears blink invulnerability.
    // Phase Change will then set its own 3s invulnerability.
    this.cancelCurrentSkill();
    this._setState(AI_STATE.PHASE_CHANGE);
    this.boss.setInvulnerable(3.0);
  }

  setPhase2() {
    this._phase = 2;
    this._setState(AI_STATE.IDLE);
    this.boss.setPhase2();
  }

  isAttacking() {
    return this._state === AI_STATE.TELEGRAPH ||
           this._state === AI_STATE.BARRAGE ||
           this._state === AI_STATE.BLINK;
  }

  // ==================== State Transitions ====================

  _setState(newState) {
    this._state = newState;
    this._stateT = 0;

    const animState = STATE_ANIM_MAP[newState];
    if (animState) {
      this.boss.setBossState(animState);
    }

    switch (newState) {
      case AI_STATE.IDLE:
        this.boss.setCastGlow(0);
        break;
      case AI_STATE.MOVE:
        this._moveDuration = 1.2 + Math.random() * 1.0;
        this._moveTimer = 0;
        break;
      case AI_STATE.PHASE_CHANGE:
        break;
      case AI_STATE.DEAD:
        break;
    }
  }

  // ==================== Skill Selection ====================

  _chooseSkill(dist) {
    const available = [SKILL.BARRAGE, SKILL.BLINK];

    // No 3 consecutive same skills
    const filtered = available.filter(s => {
      if (this._lastSkill === s && this._lastSkillRepeat >= 2) return false;
      return true;
    });

    // Fallback: if all filtered out, just use the other skill
    const pool = filtered.length > 0 ? filtered : available;

    const weights = {};
    for (const s of pool) weights[s] = 1;

    // Distance-based weighting
    if (dist > 9) {
      // Far: prefer Barrage
      weights[SKILL.BARRAGE] = 3;
      weights[SKILL.BLINK] = 1;
    } else if (dist < 6) {
      // Close: prefer Blink (reposition away)
      weights[SKILL.BARRAGE] = 1;
      weights[SKILL.BLINK] = 3;
    } else {
      // Mid range: balanced
      weights[SKILL.BARRAGE] = 2;
      weights[SKILL.BLINK] = 2;
    }

    // Phase 2: slight preference for Blink (more aggressive repositioning)
    if (this._phase === 2) {
      weights[SKILL.BLINK] = (weights[SKILL.BLINK] || 0) * 1.2;
    }

    let total = 0;
    for (const s of pool) total += weights[s] || 1;
    let r = Math.random() * total;
    for (const s of pool) {
      r -= (weights[s] || 1);
      if (r <= 0) return s;
    }
    return pool[0];
  }

  // ==================== Telegraph ====================

  _beginTelegraph(skill, player, arena) {
    if (skill === SKILL.BARRAGE) {
      // Barrage telegraph: cast glow ramp (handled in TELEGRAPH state)
      // Small burst at boss to indicate charging
      this.boss.getCastOrigin(this._tmp);
      this.effects.burst(this._tmp, 0x6f3cff, 6, 0.1);
    } else if (skill === SKILL.BLINK) {
      // Compute destination and show marker.
      // If no valid destination exists, safe-cancel the blink.
      const dest = this._computeBlinkDestination(player, arena);
      if (!dest) {
        // No valid blink destination — cancel and go to recover
        this.boss.setCastGlow(0);
        this.boss.hideBlinkMarker?.();
        this._setState(AI_STATE.RECOVER);
        return;
      }
      this._blinkDest.copy(dest);
      this.boss.beginBlink();
      this.boss.showBlinkMarker(dest);
    }
  }

  // ==================== Void Barrage ====================

  _beginBarrage(player) {
    const cfg = SKILL_CONFIG[SKILL.BARRAGE];
    const pattern = this._phase === 2 ? cfg.phase2 : cfg.phase1;

    // Snapshot player position at execute time — no homing
    this._tmp.copy(player.headPosition);
    this.boss.getCastOrigin(this._tmp2);
    // Direction: from cast origin → player (tmp - tmp2 = player - boss)
    const baseDir = this._tmp.sub(this._tmp2).normalize();

    // Precompute fan directions
    this._barrageDirections = [];
    for (let i = 0; i < pattern.fan.length; i++) {
      const angleDeg = pattern.fan[i];
      const angleRad = THREE.MathUtils.degToRad(angleDeg);
      const dir = baseDir.clone();
      // Rotate around Y axis
      const cos = Math.cos(angleRad);
      const sin = Math.sin(angleRad);
      const nx = dir.x * cos - dir.z * sin;
      const nz = dir.x * sin + dir.z * cos;
      dir.set(nx, dir.y, nz).normalize();
      this._barrageDirections.push(dir);
    }

    this._barrageCount = pattern.count;
    this._barrageShotsFired = 0;
    this._barrageShotTimer = 0;

    // Cast flash
    this.boss.getCastOrigin(this._tmp);
    this.effects.burst(this._tmp, 0x6f3cff, 10, 0.12);
    if (this.onShake) this.onShake(0.2);
  }

  _updateBarrage(dt, player) {
    const cfg = SKILL_CONFIG[SKILL.BARRAGE];

    if (this._barrageShotsFired < this._barrageCount) {
      this._barrageShotTimer -= dt;
      if (this._barrageShotTimer <= 0) {
        this._fireBarrageProjectile(this._barrageShotsFired);
        this._barrageShotsFired++;
        this._barrageShotTimer = cfg.shotInterval;
      }
    } else {
      // All shots fired — go to recover
      this._setState(AI_STATE.RECOVER);
    }
  }

  _fireBarrageProjectile(index) {
    if (index >= this._barrageDirections.length) return;
    const cfg = SKILL_CONFIG[SKILL.BARRAGE];
    const dir = this._barrageDirections[index];

    const p = this.combat._spawn(this.boss, dir, {
      speed: cfg.projectileSpeed,
      damage: cfg.damage,
      tint: cfg.projectileTint,
      scale: 1.0,
      power: 1,
      skillType: 'void_bolt',
      impactTint: cfg.impactTint,
    });

    if (p) {
      this._ownedProjectiles.add(p);
      // Small cast burst per shot
      this.boss.getCastOrigin(this._tmp);
      this.effects.burst(this._tmp, 0x9a6cff, 4, 0.08);
    }
    // If pool full (p === null), we skip this shot — safe degradation
  }

  // ==================== Void Blink ====================

  _beginBlinkExecute() {
    this._blinkSub = BLINK_SUB.VANISH;
    this._blinkSubT = 0;

    // P1-2: Open invulnerability at the start of VANISH.
    // Window covers vanish (0.15s) + relocate (0.10s) ≈ 0.25s.
    const cfg = SKILL_CONFIG[SKILL.BLINK];
    this.boss.setInvulnerable(cfg.invulnDuration);
  }

  _updateBlink(dt, player, arena) {
    const cfg = SKILL_CONFIG[SKILL.BLINK];
    this._blinkSubT += dt;

    switch (this._blinkSub) {
      case BLINK_SUB.VANISH: {
        const progress = Math.min(1, this._blinkSubT / cfg.vanishDuration);
        this.boss.setBlinkVanish(progress);

        // Burst at departure point
        if (this._blinkSubT >= cfg.vanishDuration) {
          this.effects.burst(this.boss.position.clone().setY(1.0), 0x6f3cff, 14, 0.12);
          this._blinkSub = BLINK_SUB.RELOCATE;
          this._blinkSubT = 0;
        }
        break;
      }

      case BLINK_SUB.RELOCATE: {
        // Instant teleport
        this.boss.teleportTo(this._blinkDest);

        // Hide marker (boss is now there)
        this.boss.hideBlinkMarker();

        // Burst at arrival point
        this.effects.burst(this.boss.position.clone().setY(1.0), 0x9a6cff, 10, 0.1);

        this._blinkSub = BLINK_SUB.REAPPEAR;
        this._blinkSubT = 0;
        break;
      }

      case BLINK_SUB.REAPPEAR: {
        const progress = Math.min(1, this._blinkSubT / cfg.reappearDuration);
        // P2-1: Boss owns the reappear visual
        this.boss.setBlinkReappear(progress);

        if (this._blinkSubT >= cfg.reappearDuration) {
          this.boss.endBlink();
          // P1-2: Clear blink invulnerability before entering RECOVER
          this.boss.clearInvulnerability?.();
          this._setState(AI_STATE.RECOVER);
        }
        break;
      }
    }
  }

  // ==================== Blink Destination ====================

  /**
   * Compute blink destination using randomized candidates first,
   * then deterministic fallback angles. Returns null if no valid
   * destination can be found (caller must safe-cancel the blink).
   */
  _computeBlinkDestination(player, arena) {
    const cfg = SKILL_CONFIG[SKILL.BLINK];
    const angleOptions = this._phase === 2 ? cfg.phase2.angles : cfg.phase1.angles;

    // Direction from player to boss
    const playerToBoss = this._tmp2
      .subVectors(this.boss.position, player.position)
      .setY(0);
    const baseAngle = Math.atan2(playerToBoss.z, playerToBoss.x);

    const result = new THREE.Vector3();

    // --- Phase 1: Random candidates ---
    const maxAttempts = 8;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const angleOffset = THREE.MathUtils.degToRad(
        angleOptions[Math.floor(Math.random() * angleOptions.length)]
      );
      const jitter = (Math.random() - 0.5) * THREE.MathUtils.degToRad(15);
      const angle = baseAngle + angleOffset + jitter;

      const dist = cfg.minDist + Math.random() * (cfg.maxDist - cfg.minDist);

      result.set(
        player.position.x + Math.cos(angle) * dist,
        0,
        player.position.z + Math.sin(angle) * dist
      );

      if (this._isValidBlinkDestination(result, player, arena)) {
        return result;
      }
    }

    // --- Phase 2: Deterministic fallback candidates ---
    for (const fbAngle of FALLBACK_ANGLES) {
      for (const fbDist of FALLBACK_DISTANCES) {
        const angle = baseAngle + THREE.MathUtils.degToRad(fbAngle);
        result.set(
          player.position.x + Math.cos(angle) * fbDist,
          0,
          player.position.z + Math.sin(angle) * fbDist
        );

        if (this._isValidBlinkDestination(result, player, arena)) {
          return result;
        }
      }
    }

    // No valid destination found
    return null;
  }

  /**
   * Unified validator for blink destination candidates.
   * Checks: finite coordinates, arena bounds, min player distance, pillar clearance.
   */
  _isValidBlinkDestination(pos, player, arena) {
    // 1. Finite coordinates
    if (!isFinite(pos.x) || !isFinite(pos.z)) return false;

    const cfg = SKILL_CONFIG[SKILL.BLINK];
    const bossRadius = this.boss.radius || 0.8;
    const arenaRadius = arena.radius || 18;

    // 2. Arena bounds
    const distFromCenter = Math.hypot(pos.x, pos.z);
    const maxArenaDist = arenaRadius - bossRadius - 1.0;
    if (distFromCenter > maxArenaDist) return false;

    // 3. Min distance from player
    const distToPlayer = pos.distanceTo(player.position);
    if (distToPlayer < cfg.minDist) return false;

    // 4. Pillar clearance
    if (arena.pillars) {
      for (const pil of arena.pillars) {
        const d = Math.hypot(pos.x - pil.x, pos.z - pil.z);
        const minPillarDist = pil.r + bossRadius + 1.0;
        if (d < minPillarDist) return false;
      }
    }

    return true;
  }

  // ==================== Interrupt / Cleanup ====================

  /**
   * PUBLIC contract: Cancel any in-progress skill.
   * Called by the controller on interrupts (player death, boss death, phase change).
   *
   * - Hides blink markers, restores visuals
   * - Clears blink invulnerability
   * - Despawns ONLY projectiles still owned by this boss
   */
  cancelCurrentSkill() {
    // Cancel blink visuals + clear blink invulnerability
    this.boss.cancelBlink?.();
    this.boss.clearInvulnerability?.();
    this.boss.setCastGlow(0);
    this.boss.hideBlinkMarker?.();
    this._blinkSub = null;

    // Cancel barrage
    this._barrageShotsFired = 0;
    this._barrageDirections = [];
    this._barrageShotTimer = 0;

    // Despawn owned projectiles — verify ownership before despawning
    // so a pooled projectile reused by the player is never touched.
    for (const p of this._ownedProjectiles) {
      if (p && p.active && p.owner === this.boss) {
        p.despawn();
      }
    }
    this._ownedProjectiles.clear();
  }

  // ==================== Cleanup ====================

  /**
   * Universal destroy() contract:
   * - Cancel skills, clean up projectiles
   * - Null out callbacks to prevent stale closures
   * - Does NOT call boss.destroy() — the controller handles that separately
   */
  destroy() {
    this.cancelCurrentSkill();

    // Null out callbacks
    this.onShake = null;
    this.onSkillTelegraph = null;
    this.audio = null;
    this.hud = null;

    // Clear references (but NOT boss — controller destroys boss)
    this.combat = null;
    this.scene = null;
    this.effects = null;
    this.explosion = null;
  }
}
