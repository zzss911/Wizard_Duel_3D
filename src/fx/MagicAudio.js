/**
 * MagicAudio —— 合成音效系统（无外部音频资源）
 *
 * playExplosion：大型爆炸，四层结构——
 *   1. 命中瞬间魔法爆裂（高通噪声，~0.15s）
 *   2. 主体低频 BOOM（正弦下扫 150→30Hz + 次低音 55→26Hz，~0.8s）
 *   3. 低频冲击噪声（低通扫频，~0.7s）
 *   4. 空间残响（反馈延迟尾音 + 金属扫频，~1.4s）
 * playHit：玩家受击闷响。playCast：短促施法破空声。
 *
 * 主链路带 DynamicsCompressor 防止破音；按距离衰减。
 * AudioContext 在首次用户交互后解锁。
 */
export class MagicAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this._noiseBuffer = null;
  }

  /** 必须在用户手势中调用一次 */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();

      // 主增益 + 压限，防爆音
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 18;
      comp.ratio.value = 10;
      comp.attack.value = 0.002;
      comp.release.value = 0.22;
      comp.connect(this.ctx.destination);

      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(comp);

      // 残响总线：反馈延迟模拟训练场空间感
      this.echo = this.ctx.createDelay(0.6);
      this.echo.delayTime.value = 0.19;
      const feedback = this.ctx.createGain();
      feedback.gain.value = 0.42;
      const echoFilter = this.ctx.createBiquadFilter();
      echoFilter.type = 'lowpass';
      echoFilter.frequency.value = 1600;
      this.echo.connect(echoFilter);
      echoFilter.connect(feedback);
      feedback.connect(this.echo);
      this.echoOut = this.ctx.createGain();
      this.echoOut.gain.value = 0.55;
      echoFilter.connect(this.echoOut);
      this.echoOut.connect(this.master);

      // 预生成 1 秒白噪声
      const len = this.ctx.sampleRate;
      this._noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this._noiseBuffer.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setVolume(v) {
    this._volume = v;
    if (this.master && this._enabled !== false) {
      this.master.gain.value = 0.9 * v;
    }
  }

  setEnabled(on) {
    this._enabled = on;
    if (this.master) {
      this.master.gain.value = on ? 0.9 * (this._volume || 0.6) : 0;
    }
  }

  _noise(dst, t0, { hp = 0, lp = 20000, lpEnd = 0, gain = 0.5, dur = 0.3, echo = 0 }) {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer;
    src.playbackRate.value = 0.7 + Math.random() * 0.6;
    let node = src;
    if (hp > 0) {
      const f = this.ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = hp;
      node.connect(f);
      node = f;
    }
    if (lp < 20000) {
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(lp, t0);
      if (lpEnd > 0) f.frequency.exponentialRampToValueAtTime(lpEnd, t0 + dur);
      node.connect(f);
      node = f;
    }
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    node.connect(g).connect(dst);
    if (echo > 0) {
      const eg = this.ctx.createGain();
      eg.gain.value = echo;
      g.connect(eg).connect(this.echo);
    }
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  _tone(dst, t0, { type = 'sine', from = 100, to = 40, gain = 0.5, dur = 0.5, echo = 0 }) {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur * 0.85);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(g).connect(dst);
    if (echo > 0) {
      const eg = this.ctx.createGain();
      eg.gain.value = echo;
      g.connect(eg).connect(this.echo);
    }
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  /**
   * 大型爆炸音。
   * @param {number} power 1 / 1.5 / 2.5
   * @param {number} distance 命中点到摄像机的距离（米）
   */
  playExplosion(power = 1, distance = 10) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t0 = this.ctx.currentTime;
    const atten = Math.max(0.12, Math.min(1, 14 / (distance + 6)));
    const vol = Math.min(1, 0.8 * Math.sqrt(power)) * atten;

    // 1. 魔法爆裂（短促高频）
    this._noise(this.master, t0, { hp: 2400, gain: vol * 0.85, dur: 0.14, echo: 0.5 });

    // 2. 主体 BOOM：低频下扫 + 次低音，厚重震感
    this._tone(this.master, t0, { type: 'sine', from: 150 * Math.min(power, 2), to: 30, gain: vol * 1.25, dur: 0.7, echo: 0.4 });
    this._tone(this.master, t0 + 0.02, { type: 'sine', from: 58, to: 26, gain: vol * 1.0, dur: 0.9, echo: 0.3 });

    // 3. 低频冲击噪声（气浪感）
    this._noise(this.master, t0, { lp: 750, lpEnd: 70, gain: vol * 1.0, dur: 0.7, echo: 0.45 });

    // 4. 魔法残响（金属质感扫频尾音，主要走残响总线）
    this._tone(this.echo, t0 + 0.03, { type: 'triangle', from: 1900, to: 280, gain: vol * 0.14, dur: 1.3 });
  }

  /** 玩家受击：短促低频闷响 + 中频拍击 */
  playHit() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t0 = this.ctx.currentTime;
    this._tone(this.master, t0, { type: 'sine', from: 210, to: 65, gain: 0.55, dur: 0.2 });
    this._noise(this.master, t0, { lp: 1400, lpEnd: 200, gain: 0.35, dur: 0.16, echo: 0.2 });
  }

  /** 闪避：快速空气切割声 */
  playDodge() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t0 = this.ctx.currentTime;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(800, t0);
    bp.frequency.exponentialRampToValueAtTime(3200, t0 + 0.12);
    bp.Q.value = 2.0;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer;
    src.playbackRate.value = 1.8;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.22, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.15);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + 0.18);
  }

  /** 施法：短促破空声 */
  playCast(distance = 4) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t0 = this.ctx.currentTime;
    const atten = Math.max(0.15, Math.min(1, 10 / (distance + 4)));
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(500, t0);
    bp.frequency.exponentialRampToValueAtTime(2100, t0 + 0.16);
    bp.Q.value = 1.2;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.16 * atten, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.18);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + 0.2);
  }
}
