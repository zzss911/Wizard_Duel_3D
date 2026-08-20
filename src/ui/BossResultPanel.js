/**
 * BossResultPanel —— Boss 战结算页
 * 胜利：BOSS 击破 + 用时/剩余HP/评级
 * 失败：挑战失败 + 再次挑战/返回
 */
export class BossResultPanel {
  constructor() {
    this.el = document.getElementById('boss-result-panel');
    this.titleEl = document.getElementById('boss-result-title');
    this.bossNameEl = document.getElementById('boss-result-boss-name');
    this.timeEl = document.getElementById('boss-result-time');
    this.hpEl = document.getElementById('boss-result-hp');
    this.rankEl = document.getElementById('boss-result-rank');
    this.descEl = document.getElementById('boss-result-desc');
    this.btnRetry = document.getElementById('btn-boss-retry');
    this.btnSelect = document.getElementById('btn-boss-select');
    this.btnMenu = document.getElementById('btn-boss-menu');
  }

  show({ win, bossName, time, hpPercent, rank, onRetry, onBossSelect, onMainMenu }) {
    if (win) {
      this.titleEl.textContent = 'BOSS 击破';
      this.titleEl.className = 'boss-result-title win';
      this.bossNameEl.textContent = bossName;
      this.descEl.textContent = '';
      this.timeEl.textContent = `挑战用时：${this._formatTime(time)}`;
      this.hpEl.textContent = `剩余生命：${Math.round(hpPercent)}%`;
      this.rankEl.textContent = `评级：${rank}`;
      this.rankEl.className = 'boss-result-rank rank-' + rank.toLowerCase();
      // 显示所有信息行
      this.timeEl.style.display = '';
      this.hpEl.style.display = '';
      this.rankEl.style.display = '';
    } else {
      this.titleEl.textContent = '挑战失败';
      this.titleEl.className = 'boss-result-title lose';
      this.bossNameEl.textContent = bossName;
      this.descEl.textContent = `${bossName}仍在等待……`;
      this.timeEl.style.display = 'none';
      this.hpEl.style.display = 'none';
      this.rankEl.style.display = 'none';
    }

    this.btnRetry.onclick = () => { this.hide(); onRetry && onRetry(); };
    this.btnSelect.onclick = () => { this.hide(); onBossSelect && onBossSelect(); };
    this.btnMenu.onclick = () => { this.hide(); onMainMenu && onMainMenu(); };

    this.el.classList.add('show');
  }

  hide() {
    this.el.classList.remove('show');
  }

  _formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
}
