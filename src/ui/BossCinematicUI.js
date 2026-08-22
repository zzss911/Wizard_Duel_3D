/**
 * BossCinematicUI —— Boss 战演出文字管理
 *
 * 统一管理所有 cinematic 文字：
 *   - Boss Title (典狱长 / THE WARDEN + 副标题)
 *   - FIGHT!
 *   - 技能名称提示
 *   - PHASE II
 *   - BOSS DEFEATED
 *
 * 所有文字使用 CSS 动画 (opacity + transform)，不触发布局重排。
 */

const SKILL_NAMES = {
  chain: { zh: '锁链禁锢', en: 'CHAIN' },
  magic_bolt: { zh: '重型魔法弹', en: 'MAGIC BOLT' },
  quake: { zh: '典狱震荡', en: 'QUAKE' },
  death_cage: { zh: '死亡牢笼', en: 'DEATH CAGE' },
};

export class BossCinematicUI {
  constructor() {
    this._container = null;
    this._skillEl = null;
    this._skillTimer = null;
    this._init();
  }

  _init() {
    // Create container for cinematic overlays
    this._container = document.createElement('div');
    this._container.id = 'boss-cinematic-ui';
    this._container.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      pointer-events: none; z-index: 85;
    `;
    document.body.appendChild(this._container);
  }

  // ---- Boss Title ----
  showBossTitle(onComplete) {
    const overlay = document.createElement('div');
    overlay.className = 'boss-cinematic-title';
    overlay.innerHTML = `
      <div class="boss-cinematic-title-zh">典 狱 长</div>
      <div class="boss-cinematic-title-en">THE WARDEN</div>
      <div class="boss-cinematic-title-sub">「罪人，不得越狱。」</div>
    `;
    this._container.appendChild(overlay);

    // Force reflow then add show class
    void overlay.offsetWidth;
    overlay.classList.add('show');

    // Auto-hide after 1.8s, remove after 2.5s
    setTimeout(() => {
      overlay.classList.remove('show');
      overlay.classList.add('fade-out');
    }, 1800);
    setTimeout(() => {
      overlay.remove();
      if (onComplete) onComplete();
    }, 2500);
  }

  // ---- FIGHT ----
  showFight() {
    const el = document.createElement('div');
    el.className = 'boss-cinematic-fight';
    el.textContent = 'FIGHT!';
    this._container.appendChild(el);

    void el.offsetWidth;
    el.classList.add('show');

    setTimeout(() => {
      el.classList.remove('show');
      el.classList.add('fade-out');
    }, 700);
    setTimeout(() => el.remove(), 1200);
  }

  // ---- Skill Name ----
  showSkillName(skillId, isDangerous = false) {
    const info = SKILL_NAMES[skillId];
    if (!info) return;

    // Remove existing skill name if still visible
    if (this._skillEl) {
      this._skillEl.remove();
      this._skillEl = null;
    }
    if (this._skillTimer) {
      clearTimeout(this._skillTimer);
      this._skillTimer = null;
    }

    const el = document.createElement('div');
    el.className = 'boss-cinematic-skill' + (isDangerous ? ' dangerous' : '');
    el.innerHTML = `
      <span class="boss-skill-zh">${info.zh}</span>
      <span class="boss-skill-en">${info.en}</span>
    `;
    this._container.appendChild(el);
    this._skillEl = el;

    void el.offsetWidth;
    el.classList.add('show');

    this._skillTimer = setTimeout(() => {
      el.classList.remove('show');
      el.classList.add('fade-out');
      setTimeout(() => {
        if (el === this._skillEl) this._skillEl = null;
        el.remove();
      }, 400);
    }, 1000);
  }

  // ---- Phase II ----
  showPhase2(onComplete) {
    const overlay = document.createElement('div');
    overlay.className = 'boss-cinematic-phase2';
    overlay.innerHTML = `
      <div class="boss-phase2-zh">封 锁 解 除</div>
      <div class="boss-phase2-en">PHASE II</div>
    `;
    this._container.appendChild(overlay);

    void overlay.offsetWidth;
    overlay.classList.add('show');

    setTimeout(() => {
      overlay.classList.remove('show');
      overlay.classList.add('fade-out');
    }, 1200);
    setTimeout(() => {
      overlay.remove();
      if (onComplete) onComplete();
    }, 1800);
  }

  // ---- Boss Defeated ----
  showBossDefeated(onComplete) {
    const overlay = document.createElement('div');
    overlay.className = 'boss-cinematic-defeated';
    overlay.innerHTML = `
      <div class="boss-defeated-zh">BOSS 击破</div>
      <div class="boss-defeated-name">典 狱 长</div>
    `;
    this._container.appendChild(overlay);

    void overlay.offsetWidth;
    overlay.classList.add('show');

    setTimeout(() => {
      overlay.classList.remove('show');
      overlay.classList.add('fade-out');
    }, 2000);
    setTimeout(() => {
      overlay.remove();
      if (onComplete) onComplete();
    }, 2600);
  }

  // ---- Clear all ----
  clear() {
    if (this._skillEl) { this._skillEl.remove(); this._skillEl = null; }
    if (this._skillTimer) { clearTimeout(this._skillTimer); this._skillTimer = null; }
    // Clear any remaining cinematic overlays
    const overlays = this._container.querySelectorAll('.boss-cinematic-title, .boss-cinematic-fight, .boss-cinematic-phase2, .boss-cinematic-defeated');
    overlays.forEach(el => el.remove());
  }

  destroy() {
    this.clear();
    if (this._container) {
      this._container.remove();
      this._container = null;
    }
  }
}
