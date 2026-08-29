import * as THREE from 'three';

/**
 * CameraShake —— 多段脉冲式镜头震动
 *
 * trigger(power) 触发 3 段震动：
 *   第 1 下：最大（主爆发）
 *   第 2 下：约 55%
 *   第 3 下：约 30%
 * 总时长 ~0.7s，不持续摇晃；移动端幅度 -30%。
 */
export class CameraShake {
  constructor() {
    this.active = false;
    this.time = 0;
    this.duration = 0.7;
    this.pulses = [];
    this._offset = new THREE.Vector3();
  }

  /**
   * @param {number} power 爆炸威力（1 普攻 / 1.5 重击 / 2.5 终极）
   * @param {boolean} isMobile 移动端幅度降低 30%
   */
  trigger(power = 1, isMobile = false) {
    // 堆叠保护：正在震动时，新 power 低于当前剩余峰值则忽略
    if (this.active) {
      const elapsed = this.time;
      const remainingMax = this.pulses.reduce((mx, p) => {
        if (elapsed < p.t + p.len) return Math.max(mx, p.amp * (1 - (elapsed - p.t) / p.len));
        return mx;
      }, 0);
      const newAmp = 0.30 * (isMobile ? 0.7 : 1) * power;
      if (newAmp < remainingMax * 0.8) return;
    }

    const m = (isMobile ? 0.7 : 1) * power;
    this.pulses = [
      { t: 0.0, amp: 0.30 * m, len: 0.22 },
      { t: 0.2, amp: 0.17 * m, len: 0.2 },
      { t: 0.42, amp: 0.09 * m, len: 0.18 },
    ];
    this.duration = 0.68;
    this.time = 0;
    this.active = true;

    if (isMobile && navigator.vibrate) {
      try { navigator.vibrate([40, 40, 30]); } catch (_) { /* 不支持则忽略 */ }
    }
  }

  /** 每帧调用，把震动偏移写入 out（世界单位）。 */
  update(dt, out) {
    out.set(0, 0, 0);
    if (!this.active) return out;

    this.time += dt;
    for (const p of this.pulses) {
      const local = this.time - p.t;
      if (local < 0 || local > p.len) continue;
      const env = 1 - local / p.len; // 单段内线性衰减
      const a = p.amp * env;
      out.x += (Math.random() * 2 - 1) * a;
      out.y += (Math.random() * 2 - 1) * a * 0.7;
      out.z += (Math.random() * 2 - 1) * a * 0.5;
    }
    if (this.time >= this.duration) this.active = false;
    return out;
  }
}
