import * as THREE from 'three';

/**
 * PlayerAnimationController
 *
 * 管理 Player 的 AnimationMixer，支持：
 * - 循环动画（Idle, Run）
 * - one-shot 动画（Cast, Dodge, Hit, Death）
 * - 优先级系统（高优先级不可被低优先级打断）
 * - impact frame 回调（用于施法/伤害同步）
 * - 平滑 fade 切换
 */

const ANIM_NAMES = ['Idle', 'Run', 'Cast', 'Dodge', 'Hit', 'Death'];

const ONE_SHOT_ANIMS = ['Cast', 'Dodge', 'Hit', 'Death'];

const ANIM_PRIORITY = {
  Death: 100,
  Dodge: 80,
  Cast: 60,
  Hit: 40,
  Run: 20,
  Idle: 10,
};

// Impact time as fraction of clip duration (0~1)
const ANIM_IMPACT_TIME = {
  Cast: 0.55,
  Dodge: 0.0,   // Dodge effect is immediate (handled by Player logic)
  Hit: 0.50,
  Death: 0.50,
  Run: 0,
  Idle: 0,
};

export class PlayerAnimationController {
  /**
   * @param {THREE.Object3D} mixerRoot - root node for AnimationMixer (should be the bone hierarchy root)
   * @param {THREE.Skeleton} skeleton
   * @param {Object} clips - { name: AnimationClip }
   */
  constructor(mixerRoot, skeleton, clips) {
    this._mixer = new THREE.AnimationMixer(mixerRoot);
    this._clips = clips;
    this._actions = {};
    this._currentAction = null;
    this._currentAnimName = null;
    this._loopAction = null;     // 当前循环动画（Idle 或 Run）
    this._loopAnimName = 'Idle';
    this._oneShotActive = false;
    this._oneShotName = null;
    this._oneShotPriority = 0;
    this._oneShotFired = false;
    this._pendingImpact = null;  // { callback, fired }
    this._fadeTime = 0.2;

    // 初始化 actions
    for (const name of ANIM_NAMES) {
      const clip = clips[name];
      if (!clip) continue;
      const action = this._mixer.clipAction(clip);
      if (ONE_SHOT_ANIMS.includes(name)) {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      } else {
        action.setLoop(THREE.LoopRepeat, Infinity);
      }
      this._actions[name] = action;
    }

    // 监听 finished 事件
    this._mixer.addEventListener('finished', (e) => {
      const finishedName = this._actionToName(e.action);
      if (!finishedName || finishedName !== this._oneShotName) return;

      this._oneShotActive = false;
      this._oneShotName = null;
      this._oneShotPriority = 0;
      this._pendingImpact = null;

      // Death: 保持最终姿势，不返回循环
      if (finishedName === 'Death') return;

      // 返回循环动画
      this._playLoopInternal(this._loopAnimName, this._fadeTime);
    });

    // 初始播放 Idle
    this._playLoopInternal('Idle', 0.01);
  }

  _actionToName(action) {
    for (const [name, a] of Object.entries(this._actions)) {
      if (a === action) return name;
    }
    return null;
  }

  _playLoopInternal(animName, fadeTime) {
    const action = this._actions[animName];
    if (!action) return;
    if (this._currentAnimName === animName && this._oneShotActive === false) return;

    if (this._currentAction && this._currentAction !== action) {
      this._currentAction.fadeOut(fadeTime);
    }

    action.reset();
    action.setEffectiveWeight(1);
    action.setEffectiveTimeScale(1);
    action.fadeIn(fadeTime);
    action.play();

    this._currentAction = action;
    this._currentAnimName = animName;
    this._loopAction = action;
    this._loopAnimName = animName;
  }

  /**
   * 设置循环动画（Idle 或 Run）。
   * 如果有 one-shot 正在播放，只更新记录，等 one-shot 结束后切换。
   */
  setLoopAnim(animName, fadeTime) {
    fadeTime = fadeTime !== undefined ? fadeTime : this._fadeTime;
    if (!this._actions[animName]) return;
    this._loopAnimName = animName;

    if (this._oneShotActive) return; // 等 one-shot 结束后自动切换

    this._playLoopInternal(animName, fadeTime);
  }

  /**
   * 播放 one-shot 动画。高优先级可打断低优先级。
   * @param {string} animName - Cast / Dodge / Hit / Death
   * @param {function} impactCallback - 在 impact frame 调用
   * @param {number} fadeTime
   */
  playOneShot(animName, impactCallback, fadeTime) {
    const action = this._actions[animName];
    if (!action) return;

    fadeTime = fadeTime !== undefined ? fadeTime : 0.12;

    // Death 不可被任何动画打断
    if (this._currentAnimName === 'Death' && animName !== 'Death') return;

    // 优先级检查
    const myPriority = ANIM_PRIORITY[animName] || 0;
    if (this._oneShotActive && myPriority < this._oneShotPriority) return;

    // 淡出当前
    if (this._currentAction && this._currentAction !== action) {
      this._currentAction.fadeOut(fadeTime);
    }

    action.reset();
    action.setEffectiveWeight(1);
    action.setEffectiveTimeScale(1);
    action.fadeIn(fadeTime);
    action.play();

    this._currentAction = action;
    this._currentAnimName = animName;
    this._oneShotActive = true;
    this._oneShotName = animName;
    this._oneShotPriority = myPriority;
    this._oneShotFired = false;

    // 设置 impact 回调
    if (impactCallback && ANIM_IMPACT_TIME[animName] > 0) {
      this._pendingImpact = {
        callback: impactCallback,
        fired: false,
        time: ANIM_IMPACT_TIME[animName],
      };
    } else if (impactCallback && ANIM_IMPACT_TIME[animName] === 0) {
      // 立即触发（Dodge）
      impactCallback();
      this._pendingImpact = null;
    } else {
      this._pendingImpact = null;
    }
  }

  /**
   * 每帧调用，检查 impact frame 是否到达。
   */
  consumeImpact() {
    if (!this._pendingImpact || this._pendingImpact.fired) return;
    if (!this._oneShotActive) return;

    const action = this._actions[this._oneShotName];
    if (!action) return;

    const clip = this._clips[this._oneShotName];
    if (!clip) return;

    const duration = clip.duration;
    const currentTime = action.time;

    if (currentTime >= duration * this._pendingImpact.time) {
      this._pendingImpact.fired = true;
      this._pendingImpact.callback();
    }
  }

  update(dt) {
    this._mixer.update(dt);
    this.consumeImpact();
  }

  /** 重置到 Idle 状态 */
  reset() {
    if (this._oneShotActive) {
      // 停止当前 one-shot
      const action = this._actions[this._oneShotName];
      if (action) action.stop();
      this._oneShotActive = false;
      this._oneShotName = null;
      this._oneShotPriority = 0;
      this._pendingImpact = null;
    }
    this._loopAnimName = 'Idle';
    this._playLoopInternal('Idle', 0.01);
  }

  get currentAnimName() {
    return this._oneShotActive ? this._oneShotName : this._loopAnimName;
  }
}
