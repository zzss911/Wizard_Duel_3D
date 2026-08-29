import * as THREE from 'three';

/**
 * VoidWitchAI —— 虚空女巫 AI (Phase B skeleton)
 *
 * State machine:
 *   IDLE → MOVE → IDLE → ...
 *   PHASE_CHANGE (interrupt, set by triggerPhaseChange)
 *   DEAD (set when boss.dead becomes true)
 *
 * Lightweight movement, no real attacks in Phase B.
 * Maintains 7-11m distance from player, occasional direction changes.
 *
 * Universal destroy() contract: clean up all timers, callbacks, and resources.
 */

const AI_STATE = {
  IDLE: 'IDLE',
  MOVE: 'MOVE',
  PHASE_CHANGE: 'PHASE_CHANGE',
  DEAD: 'DEAD',
};

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
    this.boss.setBossState('IDLE');
  }

  update(dt, player, arena) {
    const b = this.boss;
    b.moveIntent.set(0, 0, 0);

    // --- Death check ---
    if (b.dead) {
      if (this._state !== AI_STATE.DEAD) {
        this._state = AI_STATE.DEAD;
        b.setBossState('DEAD');
      }
      return;
    }

    // --- Player dead check ---
    if (player.dead) {
      return;
    }

    this._stateT += dt;

    switch (this._state) {
      case AI_STATE.IDLE:
        b.faceTowards(player.position, dt);
        if (this._stateT >= 0.5) {
          this._setState(AI_STATE.MOVE);
        }
        break;

      case AI_STATE.MOVE: {
        b.faceTowards(player.position, dt);

        const toPlayer = new THREE.Vector3()
          .subVectors(player.position, b.position)
          .setY(0);
        const dist = toPlayer.length();

        if (dist < 0.01) {
          // Player on top of boss — pick random direction
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
          // Occasionally flip strafe direction
          if (Math.random() < 0.01) this._moveDir.negate();
        }

        b.moveIntent.copy(this._moveDir).multiplyScalar(0.6);

        this._moveTimer += dt;
        if (this._moveTimer >= this._moveDuration) {
          this._setState(AI_STATE.IDLE);
        }
        break;
      }

      case AI_STATE.PHASE_CHANGE:
        // Phase change handled by controller — just wait
        b.faceTowards(player.position, dt);
        break;
    }
  }

  triggerPhaseChange() {
    if (this._state === AI_STATE.PHASE_CHANGE || this._state === AI_STATE.DEAD) return;
    this._setState(AI_STATE.PHASE_CHANGE);
    this.boss.setInvulnerable(3.0);
  }

  setPhase2() {
    this._phase = 2;
    this._setState(AI_STATE.IDLE);
    this.boss.setPhase2();
  }

  isAttacking() {
    return false; // No attacks in Phase B
  }

  // ==================== State Transitions ====================

  _setState(newState) {
    this._state = newState;
    this._stateT = 0;

    switch (newState) {
      case AI_STATE.IDLE:
        this.boss.setBossState('IDLE');
        break;
      case AI_STATE.MOVE:
        this._moveDuration = 1.5 + Math.random() * 1.5;
        this._moveTimer = 0;
        break;
      case AI_STATE.PHASE_CHANGE:
        this.boss.setBossState('PHASE_CHANGE');
        break;
      case AI_STATE.DEAD:
        this.boss.setBossState('DEAD');
        break;
    }
  }

  // ==================== Cleanup ====================

  /**
   * Universal destroy() contract:
   * - Null out callbacks to prevent stale closures
   * - Does NOT call boss.destroy() — the controller handles that separately
   */
  destroy() {
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
