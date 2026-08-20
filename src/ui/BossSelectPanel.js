/**
 * BossSelectPanel —— Boss 选择页
 * 第一版只有典狱长一个 Boss。
 */
export class BossSelectPanel {
  constructor() {
    this.el = document.getElementById('boss-select-panel');
    this.btnStart = document.getElementById('btn-boss-start');
    this.btnBack = document.getElementById('btn-boss-select-back');
  }

  show() {
    this.el.classList.add('show');
  }

  hide() {
    this.el.classList.remove('show');
  }

  setCallbacks({ onStart, onBack }) {
    if (this.btnStart) this.btnStart.onclick = () => { this.hide(); onStart && onStart(); };
    if (this.btnBack) this.btnBack.onclick = () => { this.hide(); onBack && onBack(); };
  }
}
