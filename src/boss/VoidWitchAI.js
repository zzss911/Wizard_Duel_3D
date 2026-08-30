import * as THREE from 'three';
import { VoidRift } from './VoidRift.js';
import { VoidClone } from './VoidClone.js';

/**
 * VoidWitchAI —— 虚空女巫 AI (Phase E)
 *
 * State machine:
 *   IDLE → MOVE → CHOOSE → TELEGRAPH → BARRAGE / BLINK / RIFT / MIRROR → RECOVER → IDLE
 *   PHASE_CHANGE (interrupt)
 *   DEAD
 *
 * Skills:
 *   1. Void Barrage   — Fan of void projectiles, no homing (snapshot player pos)
 *   2. Void Blink     — Telegraph marker → vanish → teleport → reappear
 *   3. Void Rift      — Persistent ground hazard, tick-based damage (Phase D)
 *   4. Mirror Domain  — 1 real boss + 2 clones, player must identify the real one (Phase E)
 *
 * Skill selection: distance-based weights, no 3 consecutive same skills.
 * Reuses CombatSystem projectile pool. Boss owns its projectiles for cleanup.
 * Rift pool is fixed (RIFT_POOL_SIZE) and pre-created in constructor.
 * Clone pool is fixed (MIRROR_CLONE_COUNT=2) and pre-created in constructor.
 */

const AI_STATE = {
  IDLE: 'IDLE',
  MOVE: 'MOVE',
  CHOOSE: 'CHOOSE',
  TELEGRAPH: 'TELEGRAPH',
  BARRAGE: 'BARRAGE',
  BLINK: 'BLINK',
  RIFT: 'RIFT',
  MIRROR: 'MIRROR',
  RECOVER: 'RECOVER',
  PHASE_CHANGE: 'PHASE_CHANGE',
  DEAD: 'DEAD',
};

const SKILL = {
  BARRAGE: 'void_barrage',
  BLINK: 'void_blink',
  RIFT: 'void_rift',
  MIRROR: 'mirror_domain',
};

const RIFT_POOL_SIZE = 4;
const MIRROR_CLONE_COUNT = 2;

// Mirror Domain configuration
const MIRROR_CONFIG = {
  telegraph: 0.9,
  setupDuration: 0.40,
  activeDuration: 4.8,
  recover: 0.8,
  cloneCount: 2,
  fakeCastInterval: 1.2,
  // Formation search
  radii: [6, 7, 8],
  baseRotations: [0, 30, 60, 90, 120, 150],
  // Slot validation
  minPlayerDist: 4.5,
  minSlotSeparation: 3.0,
  arenaMargin: 2.5,
  // Early end: if all clones dead after this minimum active time
  minActiveBeforeEarlyEnd: 1.0,
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
  [SKILL.RIFT]: {
    telegraph: 0.9,
    recover: 0.8,
    // Rift hazard parameters
    radius: 2.4,
    warningDuration: 0.9,
    activeDuration: 2.6,
    fadeDuration: 0.4,
    tickInterval: 0.6,
    damage: 7,
    // Phase config: count + stagger for 2nd rift
    phase1: { count: 1, stagger: 0 },
    phase2: { count: 2, stagger: 0.35 },
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
  [AI_STATE.RIFT]: 'IDLE',
  [AI_STATE.MIRROR]: 'IDLE',
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

// Mirror sub-states within the MIRROR state
const MIRROR_SUB = {
  SETUP: 'setup',
  ACTIVE: 'active',
};

const MIRROR_COOLDOWN = 15.0;

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

    // Void Rift pool (fixed size, pre-created)
    this._riftPool = [];
    for (let i = 0; i < RIFT_POOL_SIZE; i++) {
      this._riftPool.push(new VoidRift(this.scene, this.effects));
    }

    // Void Clone pool (fixed size, pre-created) — for Mirror Domain
    this._clonePool = [];
    for (let i = 0; i < MIRROR_CLONE_COUNT; i++) {
      this._clonePool.push(new VoidClone(this.scene));
    }

    // Mirror Domain state
    this._mirrorSub = null;
    this._mirrorSubT = 0;
    this._mirrorCooldown = 0;
    this._mirrorGuaranteed = false;
    this._mirrorRetryAfterNormal = false;
    this._mirrorSlots = [null, null, null]; // 3 positions: [real, clone0, clone1]
    this._mirrorRealIndex = 0; // which slot index is the real boss
    this._mirrorFakeCastT = 0;

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
    // Full lifecycle reset — clear all rifts to INACTIVE
    this._clearAllRifts();
    // Reset all clones to INACTIVE
    for (const clone of this._clonePool) {
      clone.reset();
    }
    // Reset mirror domain state
    this._mirrorSub = null;
    this._mirrorSubT = 0;
    this._mirrorCooldown = 0;
    this._mirrorGuaranteed = false;
    this._mirrorRetryAfterNormal = false;
    this._mirrorFakeCastT = 0;
    this._mirrorSlots = [null, null, null];
    this.boss.setMirrorRealTell?.(false);
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
      // Stop all skills, clear all hazards (rifts), stop firing.
      // cancelCurrentSkill handles Rift cleanup internally.
      this.cancelCurrentSkill();
      this._setState(AI_STATE.IDLE);
      this._stateT = 0;
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

    // Update all active Rifts regardless of AI state
    this._updateRifts(dt, player);

    // Update all active Clones regardless of AI state
    for (const clone of this._clonePool) {
      if (clone.needsUpdate) {
        clone.update(dt, player);
      }
    }

    // Mirror cooldown timer
    if (this._mirrorCooldown > 0) {
      this._mirrorCooldown = Math.max(0, this._mirrorCooldown - dt);
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
          const telegraphTime = this._currentSkill === SKILL.MIRROR
            ? MIRROR_CONFIG.telegraph
            : SKILL_CONFIG[this._currentSkill].telegraph;
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
            } else if (this._currentSkill === SKILL.RIFT) {
              this._setState(AI_STATE.RIFT);
              this._beginRiftSkill(player, arena);
            } else if (this._currentSkill === SKILL.MIRROR) {
              this._setState(AI_STATE.MIRROR);
              this._beginMirrorSetup(player, arena);
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

      case AI_STATE.RIFT:
        this._updateRiftSkill(dt, player, arena);
        break;

      case AI_STATE.MIRROR:
        this._updateMirror(dt, player, arena);
        break;

      case AI_STATE.RECOVER:
        b.faceTowards(player.position, dt);
        {
          const dist = b.position.distanceTo(player.position);
          if (dist > 10) {
            this._tmp.subVectors(player.position, b.position).setY(0).normalize();
            b.moveIntent.copy(this._tmp).multiplyScalar(0.3);
          }
          const recoverTime = this._currentSkill === SKILL.MIRROR
            ? MIRROR_CONFIG.recover
            : SKILL_CONFIG[this._currentSkill].recover;
          if (this._stateT >= recoverTime) {
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
    // Cancel all skills + clear all rifts via cancelCurrentSkill.
    // Then set Phase Change 3s invulnerability.
    this.cancelCurrentSkill();
    this._setState(AI_STATE.PHASE_CHANGE);
    this.boss.setInvulnerable(3.0);
  }

  setPhase2() {
    this._phase = 2;
    this._setState(AI_STATE.IDLE);
    this._mirrorGuaranteed = true;
    this.boss.setPhase2();
  }

  isAttacking() {
    return this._state === AI_STATE.TELEGRAPH ||
           this._state === AI_STATE.BARRAGE ||
           this._state === AI_STATE.BLINK ||
           this._state === AI_STATE.RIFT ||
           this._state === AI_STATE.MIRROR;
  }

  /**
   * Public contract: return additional combatants for CombatSystem.
   * Inactive clones have dead=true, so CombatSystem skips them automatically.
   * Controller only knows about "additional combatants", not clones.
   */
  getAdditionalCombatants() {
    return this._clonePool;
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
    // Mirror retry after formation failure: execute one normal skill first,
    // then guarantee Mirror on the NEXT CHOOSE.
    // Use _mirrorRetryAfterNormal to force a normal skill this round.
    const forceNormal = this._mirrorRetryAfterNormal;
    if (forceNormal) {
      this._mirrorRetryAfterNormal = false;
      // Don't set _mirrorGuaranteed here — it would trigger the check below
      // in this same call. Set it at the end of this method instead.
    }

    // Phase II guaranteed first Mirror (not forced if we need a normal skill first)
    if (!forceNormal && this._phase === 2 && this._mirrorGuaranteed) {
      this._mirrorGuaranteed = false;
      this._mirrorCooldown = MIRROR_COOLDOWN;
      return SKILL.MIRROR;
    }

    const available = [SKILL.BARRAGE, SKILL.BLINK, SKILL.RIFT];

    // Mirror Domain: Phase II only, cooldown-gated
    if (this._phase === 2 && this._mirrorCooldown <= 0) {
      available.push(SKILL.MIRROR);
    }

    // No 3 consecutive same skills (Mirror excluded — cooldown already limits it)
    const filtered = available.filter(s => {
      if (this._lastSkill === s && this._lastSkillRepeat >= 2 && s !== SKILL.MIRROR) return false;
      return true;
    });

    // Fallback: if all filtered out, just use the other skill
    const pool = filtered.length > 0 ? filtered : available;

    const weights = {};
    for (const s of pool) weights[s] = 1;

    // Distance-based weighting
    if (dist > 9) {
      // Far: prefer Barrage, Rift for area denial
      weights[SKILL.BARRAGE] = 3;
      weights[SKILL.RIFT] = 2;
      weights[SKILL.BLINK] = 1;
    } else if (dist < 6) {
      // Close: prefer Blink (reposition away), Rift for pressure
      weights[SKILL.BARRAGE] = 1;
      weights[SKILL.RIFT] = 2;
      weights[SKILL.BLINK] = 3;
    } else {
      // Mid range: Rift slightly preferred
      weights[SKILL.RIFT] = 2.5;
      weights[SKILL.BARRAGE] = 2;
      weights[SKILL.BLINK] = 2;
    }

    // Phase 2: slight preference for Blink (more aggressive repositioning)
    if (this._phase === 2) {
      weights[SKILL.BLINK] = (weights[SKILL.BLINK] || 0) * 1.2;
      weights[SKILL.RIFT] = (weights[SKILL.RIFT] || 0) * 1.15;
      // Mirror: moderate weight when available
      if (weights[SKILL.MIRROR]) {
        weights[SKILL.MIRROR] = 2.0;
      }
    }

    // If forceNormal (from Mirror retry), exclude Mirror from the pool
    let effectivePool = forceNormal ? pool.filter(s => s !== SKILL.MIRROR) : pool;
    if (effectivePool.length === 0) effectivePool = pool; // safety fallback

    let total = 0;
    for (const s of effectivePool) total += weights[s] || 1;
    let r = Math.random() * total;
    for (const s of effectivePool) {
      r -= (weights[s] || 1);
      if (r <= 0) {
        if (s === SKILL.MIRROR) {
          this._mirrorCooldown = MIRROR_COOLDOWN;
        }
        // If this was a forced normal skill from Mirror retry, guarantee Mirror next time
        if (forceNormal) this._mirrorGuaranteed = true;
        return s;
      }
    }
    if (effectivePool.includes(SKILL.MIRROR)) {
      this._mirrorCooldown = MIRROR_COOLDOWN;
    }
    // If this was a forced normal skill from Mirror retry, guarantee Mirror next time
    if (forceNormal) this._mirrorGuaranteed = true;
    return effectivePool[0];
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
    } else if (skill === SKILL.RIFT) {
      // Rift telegraph: small burst at boss to indicate charging
      this.boss.getCastOrigin(this._tmp);
      this.effects.burst(this._tmp, 0x6f3cff, 6, 0.1);
    } else if (skill === SKILL.MIRROR) {
      // Mirror telegraph: core brightens, rings accelerate, ground shimmer
      this.boss.getCastOrigin(this._tmp);
      this.effects.burst(this._tmp, 0x6f3cff, 8, 0.1);
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
      // Audio: void bolt cast
      if (this.audio) this.audio.playCast(3);
    }
    // If pool full (p === null), we skip this shot — safe degradation
  }

  // ==================== Void Blink ====================

  _beginBlinkExecute() {
    this._blinkSub = BLINK_SUB.VANISH;
    this._blinkSubT = 0;

    // Open invulnerability at the start of VANISH.
    // Window covers vanish (0.15s) + relocate (0.10s) = 0.25s.
    const cfg = SKILL_CONFIG[SKILL.BLINK];
    this.boss.setInvulnerable(cfg.invulnDuration);

    // Audio: void blink whoosh
    if (this.audio) this.audio.playVoidBlink(6);
  }

  _updateBlink(dt, player, arena) {
    const cfg = SKILL_CONFIG[SKILL.BLINK];
    this._blinkSubT += dt;

    switch (this._blinkSub) {
      case BLINK_SUB.VANISH: {
        const progress = Math.min(1, this._blinkSubT / cfg.vanishDuration);
        this.boss.setBlinkVanish(progress);

        if (this._blinkSubT >= cfg.vanishDuration) {
          // VANISH complete — finalize vanish visuals, teleport, hide marker.
          // These run exactly once at the VANISH→RELOCATE boundary.
          this.boss.setBlinkVanish(1);
          this.effects.burst(this.boss.position.clone().setY(1.0), 0x6f3cff, 14, 0.12);
          this.boss.teleportTo(this._blinkDest);
          this.boss.hideBlinkMarker();

          this._blinkSub = BLINK_SUB.RELOCATE;
          this._blinkSubT = 0;
        }
        break;
      }

      case BLINK_SUB.RELOCATE: {
        // Hold relocated state for relocateDuration (0.10s).
        // Boss stays nearly invisible; arrival burst fires once on entry.
        if (this._blinkSubT >= cfg.relocateDuration) {
          // RELOCATE complete — arrival burst, then transition to REAPPEAR.
          this.effects.burst(this.boss.position.clone().setY(1.0), 0x9a6cff, 10, 0.1);

          // Clear blink invulnerability before REAPPEAR so boss is damageable.
          this.boss.clearInvulnerability?.();

          this._blinkSub = BLINK_SUB.REAPPEAR;
          this._blinkSubT = 0;
        }
        break;
      }

      case BLINK_SUB.REAPPEAR: {
        const progress = Math.min(1, this._blinkSubT / cfg.reappearDuration);
        // Boss owns the reappear visual
        this.boss.setBlinkReappear(progress);

        if (this._blinkSubT >= cfg.reappearDuration) {
          this.boss.endBlink();
          this._setState(AI_STATE.RECOVER);
        }
        break;
      }
    }
  }

  // ==================== Void Rift ====================

  _beginRiftSkill(player, arena) {
    const cfg = SKILL_CONFIG[SKILL.RIFT];
    const phaseCfg = this._phase === 2 ? cfg.phase2 : cfg.phase1;

    // Snapshot player position at execute time — no tracking
    const snapshot = player.position.clone();

    // Spawn first Rift at/near player snapshot
    const pos1 = this._computeRiftPosition(snapshot, arena, cfg.radius, null);
    if (pos1) {
      const rift = this._riftPool.find(r => !r.active);
      if (rift) {
        rift.activate(pos1, cfg, 0);
      }
    }

    // Phase II: spawn second Rift with stagger, offset from pos1
    if (phaseCfg.count >= 2 && pos1) {
      const pos2 = this._computeRiftPosition(snapshot, arena, cfg.radius, pos1);
      if (pos2) {
        const rift2 = this._riftPool.find(r => !r.active);
        if (rift2) {
          rift2.activate(pos2, cfg, phaseCfg.stagger);
        }
      }
    }

    // Cast flash
    this.boss.getCastOrigin(this._tmp);
    this.effects.burst(this._tmp, 0x6f3cff, 8, 0.1);

    // Audio: void rift crack
    if (this.audio) this.audio.playVoidRift(6);
  }

  _updateRiftSkill(dt, player, arena) {
    const cfg = SKILL_CONFIG[SKILL.RIFT];
    // Rift execution: 0.3~0.5s, then RECOVER
    if (this._stateT >= 0.4) {
      this._setState(AI_STATE.RECOVER);
    }
  }

  /**
   * Compute rift placement using unified _isValidHazardPosition validation.
   *
   * Two modes:
   *  1. firstPos === null  →  First rift: try snapshot, then search around it.
   *  2. firstPos !== null  →  Second rift: random offset from firstPos, must be valid.
   *
   * Search strategy (deterministic + small search):
   *   angles:   0, 45, -45, 90, -90, 135, -135, 180
   *   distances: 1.5, 2.5, 3.5
   *   → 24 candidates, return first valid.
   *
   * If no valid position found → return null (safe cancel, no rift spawned).
   */
  _computeRiftPosition(snapshot, arena, radius, firstPos) {
    // --- Mode 2: second rift, offset from firstPos ---
    if (firstPos) {
      const maxAttempts = 10;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = 2.5 + Math.random() * 2.0;

        const pos = new THREE.Vector3(
          firstPos.x + Math.cos(angle) * dist,
          0,
          firstPos.z + Math.sin(angle) * dist
        );

        if (this._isValidHazardPosition(pos, arena, radius)) {
          return pos;
        }
      }
      return null;
    }

    // --- Mode 1: first rift, try snapshot then search ---

    // Candidate 0: snapshot itself
    const snapPos = snapshot.clone();
    snapPos.y = 0;
    if (this._isValidHazardPosition(snapPos, arena, radius)) {
      return snapPos;
    }

    // Deterministic search around snapshot
    const SEARCH_ANGLES = [0, 45, -45, 90, -90, 135, -135, 180];
    const SEARCH_DISTANCES = [1.5, 2.5, 3.5];

    for (const angDeg of SEARCH_ANGLES) {
      const angRad = THREE.MathUtils.degToRad(angDeg);
      for (const dist of SEARCH_DISTANCES) {
        const pos = new THREE.Vector3(
          snapPos.x + Math.cos(angRad) * dist,
          0,
          snapPos.z + Math.sin(angRad) * dist
        );

        if (this._isValidHazardPosition(pos, arena, radius)) {
          return pos;
        }
      }
    }

    // No valid position found — safe cancel
    return null;
  }

  /**
   * Unified validator for hazard placement.
   * Checks: finite coordinates, arena bounds, pillar clearance (center not inside pillar).
   */
  _isValidHazardPosition(pos, arena, radius) {
    if (!isFinite(pos.x) || !isFinite(pos.z)) return false;

    const arenaRadius = arena.radius || 18;
    const distFromCenter = Math.hypot(pos.x, pos.z);
    const maxArenaDist = arenaRadius - radius - 0.5;
    if (distFromCenter > maxArenaDist) return false;

    if (arena.pillars) {
      for (const pil of arena.pillars) {
        const d = Math.hypot(pos.x - pil.x, pos.z - pil.z);
        // Rift center cannot be inside pillar core
        if (d < pil.r + 0.5) return false;
      }
    }

    return true;
  }

  // ==================== Rift Pool Update ====================

  _updateRifts(dt, player) {
    for (const rift of this._riftPool) {
      if (rift.active) {
        rift.update(dt, player);
      }
    }
  }

  _clearAllRifts() {
    for (const rift of this._riftPool) {
      rift.reset();
    }
  }

  // ==================== Mirror Domain ====================

  /**
   * Despawn all projectiles owned by this boss.
   * Verifies ownership so pooled projectiles reused by the player are never touched.
   */
  _clearOwnedProjectiles() {
    for (const p of this._ownedProjectiles) {
      if (p && p.active && p.owner === this.boss) {
        p.despawn();
      }
    }
    this._ownedProjectiles.clear();
  }

  /**
   * Begin Mirror Domain SETUP sub-state.
   * Pre-mirror: clear owned projectiles + rifts (NOT cancelCurrentSkill).
   * Compute 3-slot formation around player snapshot. If no valid formation,
   * safe-cancel to RECOVER.
   */
  _beginMirrorSetup(player, arena) {
    // Pre-mirror cleanup: despawn boss projectiles + clear rifts
    this._clearOwnedProjectiles();
    this._clearAllRifts();

    // Compute formation around player snapshot
    const slots = this._computeMirrorFormation(player, arena);
    if (!slots) {
      // No valid formation — safe cancel to RECOVER.
      // Set retry flag: next CHOOSE executes one normal skill, then guarantees Mirror.
      // This prevents starvation loops where Mirror keeps failing repeatedly.
      this._mirrorRetryAfterNormal = true;
      this._mirrorCooldown = 0;
      this._setState(AI_STATE.RECOVER);
      return;
    }

    // Randomly assign which slot is the real boss
    this._mirrorRealIndex = Math.floor(Math.random() * 3);
    this._mirrorSlots = slots;

    // Move real boss to its slot
    const realPos = slots[this._mirrorRealIndex];
    this.boss.teleportTo(realPos);

    // Activate clones at the other 2 slots.
    // Clones start non-targetable (invincible) during SETUP.
    let cloneIdx = 0;
    for (let i = 0; i < 3; i++) {
      if (i === this._mirrorRealIndex) continue;
      if (cloneIdx >= this._clonePool.length) break;
      const clone = this._clonePool[cloneIdx];
      const slot = slots[i];
      // Face player
      const facing = Math.atan2(
        player.position.x - slot.x,
        player.position.z - slot.z
      );
      clone.activate(slot, facing, MIRROR_CONFIG.activeDuration);
      clone.setTargetable(false);
      // Clone break callback: purple burst + audio feedback
      clone.onBreak = (pos) => {
        this.effects.burst(
          this._tmp.set(pos.x, 1.0, pos.z),
          0x9a6cff, 12, 0.15
        );
        this.effects.burst(
          this._tmp.set(pos.x, 1.0, pos.z),
          0xffffff, 6, 0.08
        );
        if (this.audio) this.audio.playCloneBreak(6);
        if (this.onShake) this.onShake(0.3);
      };
      cloneIdx++;
    }

    // Activate real tell on boss
    this.boss.setMirrorRealTell(true);

    // Boss invulnerable during SETUP (brief, before ACTIVE)
    this.boss.setInvulnerable(MIRROR_CONFIG.setupDuration);

    this._mirrorSub = MIRROR_SUB.SETUP;
    this._mirrorSubT = 0;
    this._mirrorFakeCastT = 0;

    // Burst at all 3 positions for the reveal
    for (const slot of slots) {
      this.effects.burst(
        this._tmp.set(slot.x, 1.0, slot.z),
        0x9a6cff, 10, 0.12
      );
    }
    if (this.onShake) this.onShake(0.3);

    // Audio: mirror domain ethereal shatter
    if (this.audio) this.audio.playMirrorDomain(6);
  }

  /**
   * Compute 3-slot triangular formation around player snapshot.
   * 3 slots at 120° apart, radius from MIRROR_CONFIG.radii.
   * Random base rotation + small jitter.
   *
   * Validation per slot: finite, inside arena, ≥4.5m from player,
   * no pillar overlap, ≥3.0m separation between slots.
   *
   * Returns array of 3 Vector3 positions, or null if no valid formation.
   */
  _computeMirrorFormation(player, arena) {
    const playerPos = player.position;
    const arenaRadius = arena.radius || 18;
    const bossRadius = this.boss.radius || 0.8;

    // Try different radii and base rotations
    for (const radius of MIRROR_CONFIG.radii) {
      // Randomized base rotation first
      for (let attempt = 0; attempt < 6; attempt++) {
        const baseRot = Math.random() * Math.PI * 2;
        const slots = this._generateSlots(playerPos, radius, baseRot);

        if (this._validateFormation(slots, playerPos, arena, arenaRadius, bossRadius)) {
          return slots;
        }
      }

      // Deterministic fallback rotations
      for (const rotDeg of MIRROR_CONFIG.baseRotations) {
        const baseRot = THREE.MathUtils.degToRad(rotDeg);
        const slots = this._generateSlots(playerPos, radius, baseRot);

        if (this._validateFormation(slots, playerPos, arena, arenaRadius, bossRadius)) {
          return slots;
        }
      }
    }

    return null;
  }

  /**
   * Generate 3 slots at 120° apart around playerPos.
   */
  _generateSlots(playerPos, radius, baseRot) {
    const slots = [];
    for (let i = 0; i < 3; i++) {
      const angle = baseRot + (i * Math.PI * 2 / 3);
      // Small per-slot jitter
      const r = radius + (Math.random() - 0.5) * 1.0;
      slots.push(new THREE.Vector3(
        playerPos.x + Math.cos(angle) * r,
        0,
        playerPos.z + Math.sin(angle) * r
      ));
    }
    return slots;
  }

  /**
   * Validate all 3 slots:
   * - Finite coordinates
   * - Inside arena bounds (with margin)
   * - ≥ minPlayerDist from player
   * - No pillar overlap
   * - ≥ minSlotSeparation between each pair
   */
  _validateFormation(slots, playerPos, arena, arenaRadius, bossRadius) {
    for (const slot of slots) {
      if (!isFinite(slot.x) || !isFinite(slot.z)) return false;

      // Arena bounds
      const distFromCenter = Math.hypot(slot.x, slot.z);
      const maxArenaDist = arenaRadius - bossRadius - MIRROR_CONFIG.arenaMargin;
      if (distFromCenter > maxArenaDist) return false;

      // Min player distance
      const distToPlayer = Math.hypot(slot.x - playerPos.x, slot.z - playerPos.z);
      if (distToPlayer < MIRROR_CONFIG.minPlayerDist) return false;

      // Pillar clearance
      if (arena.pillars) {
        for (const pil of arena.pillars) {
          const d = Math.hypot(slot.x - pil.x, slot.z - pil.z);
          if (d < pil.r + bossRadius + 1.0) return false;
        }
      }
    }

    // Slot separation
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        const d = slots[i].distanceTo(slots[j]);
        if (d < MIRROR_CONFIG.minSlotSeparation) return false;
      }
    }

    return true;
  }

  /**
   * Update Mirror Domain state machine.
   * SETUP → ACTIVE → (RECOVER handled by main state machine)
   */
  _updateMirror(dt, player, arena) {
    const b = this.boss;
    this._mirrorSubT += dt;

    // Face player
    b.faceTowards(player.position, dt);

    // Decay boss cast glow from fake casts
    const currentGlow = b._castGlow || 0;
    if (currentGlow > 0) {
      b.setCastGlow(Math.max(0, currentGlow - dt * 2));
    }

    switch (this._mirrorSub) {
      case MIRROR_SUB.SETUP: {
        // Brief setup — clones fade in, boss repositions
        if (this._mirrorSubT >= MIRROR_CONFIG.setupDuration) {
          // Enter ACTIVE — all targets become damageable on the same frame
          this._mirrorSub = MIRROR_SUB.ACTIVE;
          this._mirrorSubT = 0;
          this._mirrorFakeCastT = 0;

          // Clear boss invulnerability — damageable during ACTIVE
          b.clearInvulnerability?.();

          // Make clones targetable — projectiles now hit and dissolve them
          for (const clone of this._clonePool) {
            if (clone.active) {
              clone.setTargetable(true);
            }
          }

          // Initial fake cast on all targets
          this._triggerFakeCast(player);
        }
        break;
      }

      case MIRROR_SUB.ACTIVE: {
        // Fake cast interval
        this._mirrorFakeCastT -= dt;
        if (this._mirrorFakeCastT <= 0) {
          this._mirrorFakeCastT += MIRROR_CONFIG.fakeCastInterval;
          this._triggerFakeCast(player);
        }

        // Check early end: all clones fully resolved (dissolve complete)
        // after the minimum active window.
        // We use isResolved so the last clone's dissolve animation
        // (0.38s) is not truncated by the domain ending.
        if (this._mirrorSubT >= MIRROR_CONFIG.minActiveBeforeEarlyEnd) {
          let allResolved = true;
          for (const clone of this._clonePool) {
            if (!clone.isResolved) {
              allResolved = false;
              break;
            }
          }
          if (allResolved) {
            this._endMirror();
            return;
          }
        }

        // Full duration end
        if (this._mirrorSubT >= MIRROR_CONFIG.activeDuration) {
          this._endMirror();
        }
        break;
      }
    }
  }

  /**
   * Trigger fake cast visual on all 3 targets (boss + clones).
   * No damaging projectiles — just visual cast glow + small burst.
   */
  _triggerFakeCast(player) {
    // Real boss fake cast
    this.boss.setCastGlow(0.6);
    this.boss.getCastOrigin(this._tmp);
    this.effects.burst(this._tmp, 0x6f3cff, 4, 0.08);
    // Decay cast glow over time (handled by next frame's update)

    // Clones fake cast
    for (const clone of this._clonePool) {
      if (clone.active) {
        clone.setFakeCastProgress(1.0);
        clone.getCastOrigin(this._tmp);
        this.effects.burst(this._tmp, 0x6f3cff, 4, 0.08);
      }
    }
  }

  /**
   * End Mirror Domain — clean up clones, tell, go to RECOVER.
   */
  _endMirror() {
    // Reset all clones
    for (const clone of this._clonePool) {
      if (clone.active) {
        // Burst on dissolve
        this.effects.burst(
          this._tmp.set(clone.position.x, 1.0, clone.position.z),
          0x9a6cff, 8, 0.1
        );
      }
      clone.reset();
    }

    // Clear real tell
    this.boss.setMirrorRealTell(false);
    this.boss.setCastGlow(0);

    // Clear invulnerability if any
    this.boss.clearInvulnerability?.();

    this._mirrorSub = null;
    this._mirrorSlots = [null, null, null];

    this._setState(AI_STATE.RECOVER);
  }

  /**
   * Emergency cancel of Mirror Domain (for interrupts).
   * Resets clones, tell, invulnerability, visuals.
   */
  _cancelMirror() {
    for (const clone of this._clonePool) {
      clone.reset();
    }
    this.boss.setMirrorRealTell?.(false);
    this.boss.setCastGlow(0);
    this.boss.clearInvulnerability?.();
    this._mirrorSub = null;
    this._mirrorSubT = 0;
    this._mirrorFakeCastT = 0;
    this._mirrorSlots = [null, null, null];
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
   * PUBLIC contract: Cancel any in-progress skill and clean up ALL persistent
   * hazards owned by this AI.
   *
   * Called by the controller on interrupts (player death, boss death, phase
   * change). The controller does NOT need to know about Rifts — this method
   * is the single cleanup entry point for every Boss skill:
   *
   *   - Blink markers / invulnerability
   *   - Barrage firing state + owned projectiles
   *   - Rift pool (all rifts reset to INACTIVE, visuals hidden)
   *   - Mirror Domain clones + real tell (Phase E)
   *
   * Idempotent: safe to call multiple times.
   */
  cancelCurrentSkill() {
    // Cancel blink visuals + clear blink invulnerability
    this.boss.cancelBlink?.();
    this.boss.clearInvulnerability?.();
    this.boss.setCastGlow(0);
    this.boss.hideBlinkMarker?.();
    this._blinkSub = null;

    // Cancel mirror domain (clones, tell, invulnerability)
    this._cancelMirror();

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

    // Clear all rifts — no hazard damage during interrupts
    this._clearAllRifts();
  }

  /**
   * Universal destroy() contract:
   * - Cancel skills, clean up projectiles
   * - Null out callbacks to prevent stale closures
   * - Does NOT call boss.destroy() — the controller handles that separately
   */
  destroy() {
    // cancelCurrentSkill clears rifts + projectiles + blink state + mirror
    this.cancelCurrentSkill();

    // Destroy rift pool (dispose geometry + materials)
    for (const rift of this._riftPool) {
      rift.destroy();
    }
    this._riftPool = [];

    // Destroy clone pool (dispose geometry + materials)
    for (const clone of this._clonePool) {
      clone.destroy();
    }
    this._clonePool = [];

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
