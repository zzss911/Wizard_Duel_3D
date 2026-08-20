/**
 * BossHealthBar —— 顶部中央 Boss 血条
 * 显示 Boss 名称、英文副标题、阶段、HP 条
 */
export class BossHealthBar {
  constructor() {
    this.el = document.getElementById('boss-health-bar');
    this.nameEl = document.getElementById('boss-bar-name');
    this.subEl = document.getElementById('boss-bar-sub');
    this.phaseEl = document.getElementById('boss-bar-phase');
    this.fillEl = document.getElementById('boss-bar-fill');
  }

  show(name, subtitle, phase) {
    if (this.nameEl) this.nameEl.textContent = name;
    if (this.subEl) this.subEl.textContent = subtitle;
    if (this.phaseEl) this.phaseEl.textContent = phase;
    if (this.fillEl) this.fillEl.style.width = '100%';
    this.el.classList.add('show');
  }

  hide() {
    this.el.classList.remove('show');
  }

  updateHP(hp, maxHp) {
    if (!this.fillEl) return;
    const pct = Math.max(0, (hp / maxHp) * 100);
    this.fillEl.style.width = pct + '%';
    // 低血量变红闪烁
    if (pct < 25) {
      this.fillEl.classList.add('critical');
    } else {
      this.fillEl.classList.remove('critical');
    }
  }

  setPhase(phase) {
    if (this.phaseEl) this.phaseEl.textContent = phase;
  }
}
