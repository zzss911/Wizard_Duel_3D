/**
 * BossCameraDirector —— Boss 战演出镜头控制
 *
 * 负责：
 *   - Intro camera (推镜头 + 仰拍)
 *   - Phase change camera (推近 + 回归)
 *   - Death camera (缓慢推进)
 *   - Return to combat camera
 *
 * 使用方式：
 *   director.startCinematic(camera, type, params)
 *   director.update(dt) → returns true if cinematic active
 *   director.cancel() → 强制结束，恢复
 *
 * 不接管正常战斗镜头。只有在 cinematic 期间覆盖 camera.position 和 lookAt。
 * cinematic 结束后 Game.updateCamera() 自然接管。
 */

import * as THREE from 'three';

const CINEMATIC = {
  NONE: 'none',
  INTRO: 'intro',
  PHASE_CHANGE: 'phase_change',
  DEATH: 'death',
};

export class BossCameraDirector {
  constructor() {
    this.active = CINEMATIC.NONE;
    this.time = 0;
    this.duration = 0;
    this._camera = null;
    this._bossPos = null;
    this._playerPos = null;
    this._origPos = new THREE.Vector3();
    this._tempVec = new THREE.Vector3();
    this._tempLookAt = new THREE.Vector3();
  }

  /**
   * Start a cinematic camera sequence.
   * @param {THREE.Camera} camera
   * @param {string} type - INTRO / PHASE_CHANGE / DEATH
   * @param {object} params - { bossPos, playerPos, duration }
   */
  startCinematic(camera, type, params) {
    this._camera = camera;
    this.active = type;
    this.time = 0;
    this.duration = params.duration || 4.5;
    this._bossPos = params.bossPos ? params.bossPos.clone() : new THREE.Vector3(0, 2, -6);
    this._playerPos = params.playerPos ? params.playerPos.clone() : new THREE.Vector3(0, 1, 6);
    this._origPos.copy(camera.position);
  }

  /**
   * Update cinematic camera. Returns true if cinematic is active.
   * When returns false, Game.updateCamera() should run normally.
   */
  update(dt) {
    if (this.active === CINEMATIC.NONE) return false;

    this.time += dt;
    const t = this.time;
    const total = this.duration;
    const progress = Math.min(1, t / total);

    if (this.active === CINEMATIC.INTRO) {
      this._updateIntro(progress, t);
    } else if (this.active === CINEMATIC.PHASE_CHANGE) {
      this._updatePhaseChange(progress, t);
    } else if (this.active === CINEMATIC.DEATH) {
      this._updateDeath(progress, t);
    }

    if (t >= total) {
      this.active = CINEMATIC.NONE;
      return false;
    }
    return true;
  }

  _updateIntro(p, t) {
    // Phase 1 (0~0.8s): Slow push from player side towards boss
    // Phase 2 (0.8~2.6s): Low angle looking up at boss
    // Phase 3 (2.6~3.6s): Title display, hold
    // Phase 4 (3.6~4.5s): Smooth return

    const boss = this._bossPos;
    const player = this._playerPos;

    if (t < 0.8) {
      // Push towards boss
      const tp = t / 0.8;
      const ease = this._easeInOut(tp);
      // Start from side, push in
      const startX = player.x * 0.5;
      const startZ = player.z * 0.6;
      const startY = 3.5;
      const endX = boss.x * 0.3;
      const endZ = boss.z + 5;
      const endY = 2.0;

      this._tempVec.set(
        THREE.MathUtils.lerp(startX, endX, ease),
        THREE.MathUtils.lerp(startY, endY, ease),
        THREE.MathUtils.lerp(startZ, endZ, ease)
      );
      this._camera.position.lerp(this._tempVec, 0.15);
      this._camera.lookAt(boss.x * 0.5, 1.5, boss.z);
    } else if (t < 2.6) {
      // Low angle hero shot
      const tp = (t - 0.8) / 1.8;
      const angle = tp * Math.PI * 0.1; // slight orbit
      const radius = 6.5 - tp * 1.0;
      const height = 1.8 + Math.sin(tp * Math.PI) * 0.5;

      this._tempVec.set(
        boss.x + Math.sin(angle) * radius,
        height,
        boss.z + Math.cos(angle) * radius
      );
      this._camera.position.lerp(this._tempVec, 0.12);
      // Look up at boss chest/head
      this._camera.lookAt(boss.x, 2.5, boss.z);
    } else if (t < 3.6) {
      // Hold on boss with title
      const tp = (t - 2.6) / 1.0;
      const radius = 5.8;
      const height = 2.2;
      this._tempVec.set(
        boss.x,
        height,
        boss.z + radius
      );
      this._camera.position.lerp(this._tempVec, 0.08);
      this._camera.lookAt(boss.x, 2.8, boss.z);
    } else {
      // Return to combat - let Game.updateCamera take over
      // Just gently lerp position, the next frame Game.updateCamera will handle
    }
  }

  _updatePhaseChange(p, t) {
    // 0~0.3s: Push closer to boss
    // 0.3~2.0s: Hold near boss
    // 2.0~2.5s: Return
    const boss = this._bossPos;

    if (t < 0.3) {
      const tp = t / 0.3;
      const ease = this._easeInOut(tp);
      const targetZ = boss.z + 4.5;
      const targetY = 2.5;
      this._tempVec.set(boss.x, targetY, targetZ);
      this._camera.position.lerp(this._tempVec, 0.1 * ease);
      this._camera.lookAt(boss.x, 2.5, boss.z);
    } else if (t < 2.0) {
      // Slight orbit + hold
      const tp = (t - 0.3) / 1.7;
      const angle = tp * 0.3;
      const radius = 4.5;
      const height = 2.3 + Math.sin(tp * Math.PI) * 0.4;
      this._tempVec.set(
        boss.x + Math.sin(angle) * radius,
        height,
        boss.z + Math.cos(angle) * radius
      );
      this._camera.position.lerp(this._tempVec, 0.06);
      this._camera.lookAt(boss.x, 2.5, boss.z);
    } else {
      // Return - gentle lerp, Game.updateCamera will take over
    }
  }

  _updateDeath(p, t) {
    // Slow push towards boss as it dies
    const boss = this._bossPos;
    const tp = Math.min(1, t / this.duration);

    // Slow push in
    const startZ = boss.z + 7;
    const endZ = boss.z + 4.5;
    const z = THREE.MathUtils.lerp(startZ, endZ, this._easeInOut(tp));
    const y = 2.5 + Math.sin(tp * Math.PI) * 0.5;

    this._tempVec.set(boss.x, y, z);
    this._camera.position.lerp(this._tempVec, 0.05);
    // Look at boss center, slightly down as he falls
    const lookY = THREE.MathUtils.lerp(2.5, 1.0, tp);
    this._camera.lookAt(boss.x, lookY, boss.z);
  }

  _easeInOut(t) {
    return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
  }

  cancel() {
    this.active = CINEMATIC.NONE;
  }

  get isActive() {
    return this.active !== CINEMATIC.NONE;
  }
}

export { CINEMATIC };
