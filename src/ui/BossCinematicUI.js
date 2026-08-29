/**
 * BossCinematicUI —— Boss 战演出文字管理
 *
 * 统一管理所有 cinematic 文字：
 *   - Boss Title (名称 + 副标题)
 *   - FIGHT!
 *   - 技能名称提示
 *   - PHASE II
 *   - BOSS DEFEATED
 *
 * 所有文字使用 CSS 动画 (opacity + transform)，不触发布局重排。
 * 技能名称映射由 BossBattleController 通过 setSkillNames() 注入。
 */

// 默认 Warden 技能名（向后兼容）
const DEFAULT_SKILL_NAMES = {
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
    this._skillNames = { ...DEFAULT_SKILL_NAMES };
    this._dangerousSkills = ['death_cage'];
    this._init();
  }

  _init() {
    this._container = document.createElement('div');
    this._container.id = 'boss-cinematic-ui';
    this._container.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      pointer-events: none; z-index: 85;
    `;
    document.body.appendChild(this._container);
  }

  /**
   * 注入技能名称映射和危险技能列表
   * @param {object} skillNames - { skillId: { zh, en } }
   * @param {string[]} dangerousSkills - skillId list
   */
  setSkillNames(skillNames, dangerousSkills) {
    this._skillNames = skillNames || { ...DEFAULT_SKILL_NAMES };
    this._dangerousSkills = dangerousSkills || [];
  }

  // ---- Boss Title ----
  showBossTitle(titleZh = '', titleEn = '', titleSub = '') {
    const overlay = document.createElement('div');
    overlay.className = 'boss-cinematic-title';
    overlay.innerHTML = `
      <div class="boss-cinematic-title-zh">${titleZh}</div>
      <div class="boss-cinematic-title-en">${titleEn}</div>
      <div class="boss-cinematic-title-sub">${titleSub}</div>
    `;
    this._container.appendChild(overlay);

    void overlay.offsetWidth;
    overlay.classList.add('show');

    setTimeout(() => {
      overlay.classList.remove('show');
      overlay.classList.add('fade-out');
    }, 1800);
    setTimeout(() => {
      overlay.remove();
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
  showSkillName(skillId, isDangerous) {
    const info = this._skillNames[skillId];
    if (!info) return;

    // 如果未显式传入 isDangerous，查 _dangerousSkills
    if (isDangerous === undefined) {
      isDangerous = this._dangerousSkills.includes(skillId);
    }

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
  showPhase2(phase2Zh, phase2En) {
    const zh = phase2Zh || '封 锁 解 除';
    const en = phase2En || 'PHASE II';
    const overlay = document.createElement('div');
    overlay.className = 'boss-cinematic-phase2';
    overlay.innerHTML = `
      <div class="boss-phase2-zh">${zh}</div>
      <div class="boss-phase2-en">${en}</div>
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
    }, 1800);
  }

  // ---- Boss Defeated ----
  showBossDefeated(defeatedZh, defeatedName) {
    const zh = defeatedZh || 'BOSS 击破';
    const name = defeatedName || 'BOSS';
    const overlay = document.createElement('div');
    overlay.className = 'boss-cinematic-defeated';
    overlay.innerHTML = `
      <div class="boss-defeated-zh">${zh}</div>
      <div class="boss-defeated-name">${name}</div>
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
    }, 2600);
  }

  // ---- Clear all ----
  clear() {
    if (this._skillEl) { this._skillEl.remove(); this._skillEl = null; }
    if (this._skillTimer) { clearTimeout(this._skillTimer); this._skillTimer = null; }
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
