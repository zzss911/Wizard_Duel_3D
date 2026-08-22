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
 * - 支持程序化动画 和 GLB AnimationClip
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
  Dodge: 0.0,
  Hit: 0.50,
  Death: 0.50,
  Run: 0,
  Idle: 0,
};

export class PlayerAnimationController {
  /**
   * @param {THREE.Object3D} mixerRoot - root node for AnimationMixer
   * @param {THREE.Skeleton} skeleton
   * @param {Object} clips - { name: AnimationClip }
   * @param {boolean} isGLB - true if clips come from GLB (vs programmatic)
   */
  constructor(mixerRoot, skeleton, clips, isGLB = false) {
    this._mixer = new THREE.AnimationMixer(mixerRoot);
    this._clips = clips;
    this._isGLB = isGLB;
    this._actions = {};
    this._currentAction = null;
    this._currentAnimName = null;
    this._loopAction = null;
    this._loopAnimName = 'Idle';
    this._oneShotActive = false;
    this._oneShotName = null;
    this._oneShotPriority = 0;
    this._pendingImpact = null;
    this._fadeTime = 0.2;

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

    this._mixer.addEventListener('finished', (e) => {
      const finishedName = this._actionToName(e.action);
      if (!finishedName || finishedName !== this._oneShotName) return;

      this._oneShotActive = false;
      this._oneShotName = null;
      this._oneShotPriority = 0;
      this._pendingImpact = null;

      if (finishedName === 'Death') return;

      this._playLoopInternal(this._loopAnimName, this._fadeTime);
    });

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

  setLoopAnim(animName, fadeTime) {
    fadeTime = fadeTime !== undefined ? fadeTime : this._fadeTime;
    if (!this._actions[animName]) return;
    this._loopAnimName = animName;

    if (this._oneShotActive) return;

    this._playLoopInternal(animName, fadeTime);
  }

  playOneShot(animName, impactCallback, fadeTime) {
    const action = this._actions[animName];
    if (!action) return;

    fadeTime = fadeTime !== undefined ? fadeTime : 0.12;

    if (this._currentAnimName === 'Death' && animName !== 'Death') return;

    const myPriority = ANIM_PRIORITY[animName] || 0;
    if (this._oneShotActive && myPriority < this._oneShotPriority) return;

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

    if (impactCallback && ANIM_IMPACT_TIME[animName] > 0) {
      this._pendingImpact = {
        callback: impactCallback,
        fired: false,
        time: ANIM_IMPACT_TIME[animName],
      };
    } else if (impactCallback && ANIM_IMPACT_TIME[animName] === 0) {
      impactCallback();
      this._pendingImpact = null;
    } else {
      this._pendingImpact = null;
    }
  }

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

  reset() {
    if (this._oneShotActive) {
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

  dispose() {
    for (const action of Object.values(this._actions)) {
      action.stop();
    }
    this._actions = {};
    this._currentAction = null;
    this._mixer = null;
  }

  get currentAnimName() {
    return this._oneShotActive ? this._oneShotName : this._loopAnimName;
  }

  get hasAnims() {
    return Object.keys(this._actions).length > 0;
  }
}
