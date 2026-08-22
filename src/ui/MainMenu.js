/**
 * MainMenu —— 主界面 UI
 * 标题 / 开始决斗 / 继续游戏 / 设置 / Boss 入口
 */
export class MainMenu {
  constructor() {
    this.el = document.getElementById('main-menu');
    this.bossPreview = document.getElementById('boss-preview-panel');
    this.btnDuel = document.getElementById('btn-menu-duel');
    this.btnContinue = document.getElementById('btn-menu-continue');
    this.btnSettings = document.getElementById('btn-menu-settings');
    this.btnBoss = document.getElementById('btn-boss-mode');
    this.btnBossBack = document.getElementById('btn-boss-back');
    this.continueToast = document.getElementById('continue-toast');
    this._hint = document.getElementById('hint-desktop');
  }

  show() {
    this.el.classList.add('show');
    if (this._hint) this._hint.style.display = 'none';
  }

  hide() {
    this.el.classList.remove('show');
    if (this._hint) this._hint.style.display = '';
  }

  showBossPreview() {
    this.bossPreview.classList.add('show');
  }

  hideBossPreview() {
    this.bossPreview.classList.remove('show');
  }

  showContinueToast() {
    if (!this.continueToast) return;
    this.continueToast.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this.continueToast.classList.remove('show');
    }, 2000);
  }

  setCallbacks({ onDuel, onContinue, onSettings, onBoss }) {
    this.btnDuel.onclick = () => { this.hide(); onDuel && onDuel(); };
    this.btnContinue.onclick = () => { onContinue && onContinue(); };
    this.btnSettings.onclick = () => { this.hide(); onSettings && onSettings(); };
    this.btnBoss.onclick = () => { this.hide(); onBoss && onBoss(); };
    this.btnBossBack.onclick = () => {
      this.hideBossPreview();
      this.show();
    };
  }
}
