import { BossRegistry } from '../boss/BossRegistry.js';

/**
 * BossSelectPanel —— Boss 选择页
 *
 * 从 BossRegistry 动态渲染 Boss 卡片。
 * 点击卡片仅修改 selectedBossId，点击"挑战"才开始战斗。
 */
export class BossSelectPanel {
  constructor() {
    this.el = document.getElementById('boss-select-panel');
    this.btnStart = document.getElementById('btn-boss-start');
    this.btnBack = document.getElementById('btn-boss-select-back');
    this.bossListEl = document.querySelector('.boss-list');

    this.selectedBossId = BossRegistry.getDefaultId();
    this._cardEls = {};
    this._renderCards();
  }

  _renderCards() {
    if (!this.bossListEl) return;
    this.bossListEl.innerHTML = '';
    this._cardEls = {};

    for (const entry of BossRegistry.list()) {
      const card = document.createElement('div');
      card.className = 'boss-card';
      card.dataset.bossId = entry.id;

      const available = BossRegistry.isAvailable(entry.id);
      const stars = '★'.repeat(entry.difficulty) + '☆'.repeat(5 - entry.difficulty);
      const tagsHtml = entry.tags
        .map(t => `<span class="boss-tag">${t}</span>`)
        .join('');

      card.innerHTML = `
        <div class="boss-card-portrait" style="color: ${entry.themeColor};">${entry.portrait}</div>
        <div class="boss-card-info">
          <div class="boss-card-name">${entry.name}</div>
          <div class="boss-card-sub">${entry.subtitle}</div>
          <div class="boss-card-tags">${tagsHtml}</div>
          <div class="boss-card-danger">危险等级：${stars}</div>
          <div class="boss-card-desc">${entry.description}</div>
          ${available ? '' : '<div class="boss-card-locked">即将开放</div>'}
        </div>
      `;

      card.addEventListener('click', () => {
        if (!available) return;
        this._selectBoss(entry.id);
      });

      this.bossListEl.appendChild(card);
      this._cardEls[entry.id] = card;
    }

    this._updateSelectionUI();
  }

  _selectBoss(id) {
    this.selectedBossId = id;
    this._updateSelectionUI();
  }

  _updateSelectionUI() {
    for (const [id, card] of Object.entries(this._cardEls)) {
      if (id === this.selectedBossId) {
        card.classList.add('selected');
        const entry = BossRegistry.get(id);
        if (entry) {
          card.style.borderColor = entry.themeColor;
          card.style.boxShadow = `0 0 16px ${entry.themeColor}66`;
        }
      } else {
        card.classList.remove('selected');
        card.style.borderColor = '';
        card.style.boxShadow = '';
      }
    }

    // 更新挑战按钮
    if (this.btnStart) {
      const available = BossRegistry.isAvailable(this.selectedBossId);
      this.btnStart.disabled = !available;
      this.btnStart.textContent = available ? '挑战 Boss' : '即将开放';
    }
  }

  show() {
    this.el.classList.add('show');
  }

  hide() {
    this.el.classList.remove('show');
  }

  getSelectedBossId() {
    return this.selectedBossId;
  }

  setCallbacks({ onStart, onBack }) {
    if (this.btnStart) this.btnStart.onclick = () => {
      if (this.btnStart.disabled) return;
      this.hide();
      onStart && onStart();
    };
    if (this.btnBack) this.btnBack.onclick = () => { this.hide(); onBack && onBack(); };
  }
}
